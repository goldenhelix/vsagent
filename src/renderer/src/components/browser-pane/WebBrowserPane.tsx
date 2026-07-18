// Iframe-backed in-app browser pane for web clients. Replaces both the
// Electron <webview> path (no webviews in a plain browser) and the remote
// screencast path (needs Xvfb on the serve host). Navigation goes through the
// server-side webpreview reverse proxy: window.api.webPreview mints a session
// whose proxyPath serves the target origin from the gateway's own origin, and
// the proxy's injected script postMessages navigation events back up so the
// address bar and store stay in sync (see src/main/webpreview/rewrite-script.ts).
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  RefreshCw
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'
import BrowserAddressBar from './BrowserAddressBar'
import {
  acquireWebPreviewSession,
  deriveOriginFromInput,
  derivePathFromInput,
  isBlankBrowserUrl,
  releaseWebPreviewSession,
  type WebPreviewSession
} from './webpreview-proxy-navigation'

export default function WebBrowserPane({
  browserTab
}: {
  browserTab: BrowserWorkspace
}): React.JSX.Element {
  const activePage = useAppStore((s) => {
    const pages = s.browserPagesByWorkspace[browserTab.id] ?? []
    return pages.find((page) => page.id === browserTab.activePageId) ?? pages[0] ?? null
  })
  if (!activePage) {
    return <div className="flex h-full min-h-0 flex-1 bg-background" />
  }
  // Why: key by page id so switching the workspace's active page tears down
  // the proxy session and boots a fresh one for the newly active page.
  return <WebBrowserPagePane key={activePage.id} page={activePage} />
}

function WebBrowserPagePane({ page }: { page: BrowserPage }): React.JSX.Element {
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)
  const updateBrowserPageState = useAppStore((s) => s.updateBrowserPageState)
  const addBrowserHistoryEntry = useAppStore((s) => s.addBrowserHistoryEntry)
  const consumeAddressBarFocusRequest = useAppStore((s) => s.consumeAddressBarFocusRequest)
  // Why: the store is the URL authority. Local navigation writes back via
  // setBrowserPageUrl so tab title/url persist; a store URL that changes from
  // elsewhere (session hydration, another client) re-navigates the iframe.
  const storeUrl = page.url
  const initialUrl = isBlankBrowserUrl(storeUrl) ? '' : storeUrl
  const [urlInput, setUrlInput] = useState(initialUrl)
  const [displayedUrl, setDisplayedUrl] = useState(initialUrl)
  const [session, setSession] = useState<WebPreviewSession | null>(null)
  // Why: dedupe the store→pane echo. Local navigation writes to the store,
  // which fires this pane's storeUrl subscription with the URL it just set.
  // Recording the last pushed URL lets that self-echo skip a no-op reload.
  const lastPushedUrlRef = useRef<string>('')
  const [iframeSrc, setIframeSrc] = useState<string>('about:blank')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  // Why: in-pane navigation history independent of iframe.history. The proxy
  // serves everything same-origin, but Back/Forward through iframe history is
  // unreliable across proxy-session origin changes, so we replay src changes.
  const [historyStack, setHistoryStack] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  // Why: monotonic request seq so a stale async session response can't
  // clobber a newer navigation.
  const navSeq = useRef(0)
  // Why: the first injected-script nav event after navigate() is the load
  // echo for that navigation (it may carry a post-redirect URL). REPLACE the
  // current history entry with it instead of pushing, so Back never lands on
  // a pre-redirect URL the user never actually visited.
  const expectingLoadEchoRef = useRef(false)
  const displayedUrlRef = useRef(displayedUrl)
  displayedUrlRef.current = displayedUrl

  const pushHistory = useCallback(
    (upstreamUrl: string) => {
      setHistoryStack((prev) => {
        if (historyIdx >= 0 && prev[historyIdx] === upstreamUrl) {
          return prev
        }
        const truncated = historyIdx + 1 >= prev.length ? prev : prev.slice(0, historyIdx + 1)
        const next = [...truncated, upstreamUrl]
        // Why: unbounded history would leak memory on chatty SPAs.
        const MAX = 100
        return next.length > MAX ? next.slice(next.length - MAX) : next
      })
      setHistoryIdx((idx) => Math.min(idx + 1, 99))
    },
    [historyIdx]
  )

  const syncTitleToStore = useCallback(() => {
    // Why: the proxied document is same-origin with the gateway, so its title
    // is readable; mirroring it keeps the tab strip label meaningful.
    let title: string | undefined
    try {
      title = iframeRef.current?.contentDocument?.title || undefined
    } catch {
      title = undefined
    }
    updateBrowserPageState(page.id, { loading: false, ...(title ? { title } : {}) })
    return title
  }, [page.id, updateBrowserPageState])

  const navigate = useCallback(
    async (input: string, opts?: { fromHistory?: boolean }) => {
      const origin = deriveOriginFromInput(input)
      if (!origin) {
        setStatus('error')
        setError(
          translate('auto.components.browser.pane.WebBrowserPane.invalid.url', 'Invalid URL')
        )
        return
      }
      const path = derivePathFromInput(input)
      const seq = ++navSeq.current
      setStatus('loading')
      setError(null)
      try {
        const s = await acquireWebPreviewSession(session, origin)
        if (seq !== navSeq.current) {
          return
        }
        setSession(s)
        const nextIframeSrc = s.proxyPath + path
        if (iframeSrc === nextIframeSrc) {
          // Why: React won't touch an unchanged src attribute, so the iframe
          // never refetches (same URL typed twice, Back across a redirect that
          // maps to the same proxy path). The proxy path is same-origin with
          // the renderer, so reload through contentWindow; the about:blank
          // round-trip is the fallback when that is somehow unreachable.
          const ifr = iframeRef.current
          try {
            ifr?.contentWindow?.location?.reload()
          } catch {
            if (ifr) {
              ifr.src = 'about:blank'
              requestAnimationFrame(() => {
                ifr.src = nextIframeSrc
              })
            }
          }
        } else {
          setIframeSrc(nextIframeSrc)
        }
        expectingLoadEchoRef.current = true
        const display = origin + path
        setDisplayedUrl(display)
        setUrlInput(display)
        if (!opts?.fromHistory) {
          pushHistory(display)
        }
        // Why: persist the navigation so the tab strip and session restore see
        // it; lastPushedUrlRef lets the resulting store echo recognise itself.
        if (display !== lastPushedUrlRef.current) {
          lastPushedUrlRef.current = display
          setBrowserPageUrl(page.id, display)
        }
      } catch (err) {
        if (seq !== navSeq.current) {
          return
        }
        setStatus('error')
        setError(err instanceof Error ? err.message : String(err))
        updateBrowserPageState(page.id, { loading: false })
      }
    },
    [session, iframeSrc, pushHistory, page.id, setBrowserPageUrl, updateBrowserPageState]
  )

  // Navigation pings from the proxy's injected script keep the address bar and
  // store in sync when the page client-routes internally.
  useEffect(() => {
    const handler = (e: MessageEvent): void => {
      // Why: every WebBrowserPane listens on window; only accept events from
      // THIS pane's iframe so parallel browser tabs don't cross-contaminate.
      if (e.source !== iframeRef.current?.contentWindow) {
        return
      }
      const data = e.data
      if (!data || typeof data !== 'object' || data.type !== 'orca-webpreview-nav') {
        return
      }
      if (typeof data.upstreamUrl !== 'string') {
        return
      }
      const next = data.upstreamUrl
      setDisplayedUrl(next)
      // Don't overwrite the user's typing while the address bar is focused.
      if (document.activeElement !== addressInputRef.current) {
        setUrlInput(next)
      }
      if (expectingLoadEchoRef.current) {
        expectingLoadEchoRef.current = false
        setHistoryStack((prev) => {
          if (prev.length === 0) {
            return [next]
          }
          if (prev[historyIdx] === next) {
            return prev
          }
          const copy = [...prev]
          copy[historyIdx] = next
          return copy
        })
      } else {
        pushHistory(next)
      }
      if (next !== lastPushedUrlRef.current) {
        lastPushedUrlRef.current = next
        setBrowserPageUrl(page.id, next)
      }
      // Why: SPA routers set document.title after the nav event; give them a
      // beat before mirroring the title into the store.
      window.setTimeout(syncTitleToStore, 250)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [pushHistory, page.id, setBrowserPageUrl, historyIdx, syncTitleToStore])

  // First mount: load the page's stored URL, or focus the address bar for
  // blank (new) tabs the way desktop tabs do.
  useEffect(() => {
    if (isBlankBrowserUrl(storeUrl)) {
      consumeAddressBarFocusRequest(page.id)
      addressInputRef.current?.focus()
    } else {
      if (consumeAddressBarFocusRequest(page.id)) {
        addressInputRef.current?.focus()
      }
      void navigate(storeUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only bootstrap
  }, [])

  // Why: react to store URL changes that did not come from this pane (session
  // hydration, other clients, port-open actions targeting an existing tab).
  useEffect(() => {
    if (isBlankBrowserUrl(storeUrl)) {
      return
    }
    if (storeUrl === lastPushedUrlRef.current || storeUrl === displayedUrlRef.current) {
      return
    }
    // Don't yank the user out of an in-progress address bar edit.
    if (document.activeElement === addressInputRef.current) {
      return
    }
    lastPushedUrlRef.current = storeUrl
    void navigate(storeUrl, { fromHistory: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only external URL changes should re-navigate
  }, [storeUrl])

  // Why: tear down the proxy session only when the pane truly unmounts.
  // Watching [session] would delete a live session whenever setOrigin returns
  // a new object for the same id, killing the load in flight.
  const activeSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeSessionIdRef.current = session?.id ?? null
  }, [session])
  useEffect(() => {
    return () => {
      const id = activeSessionIdRef.current
      if (id) {
        releaseWebPreviewSession(id)
      }
    }
  }, [])

  const onLoad = useCallback(() => {
    setStatus('idle')
    const title = syncTitleToStore()
    const loadedUrl = displayedUrlRef.current
    if (loadedUrl && !isBlankBrowserUrl(loadedUrl)) {
      addBrowserHistoryEntry(loadedUrl, title ?? loadedUrl)
    }
  }, [syncTitleToStore, addBrowserHistoryEntry])

  const reload = useCallback(() => {
    const ifr = iframeRef.current
    if (!ifr) {
      return
    }
    // Why: contentWindow reload preserves scroll; fall back to the src
    // round-trip if the frame is unexpectedly inaccessible.
    try {
      ifr.contentWindow?.location?.reload()
      return
    } catch {
      // fall through
    }
    const current = ifr.src
    ifr.src = 'about:blank'
    requestAnimationFrame(() => {
      ifr.src = current
    })
  }, [])

  const canGoBack = historyIdx > 0
  const canGoForward = historyIdx >= 0 && historyIdx < historyStack.length - 1

  const goBack = useCallback(() => {
    if (!canGoBack) {
      return
    }
    const nextIdx = historyIdx - 1
    setHistoryIdx(nextIdx)
    const target = historyStack[nextIdx]
    if (target) {
      void navigate(target, { fromHistory: true })
    }
  }, [canGoBack, historyIdx, historyStack, navigate])

  const goForward = useCallback(() => {
    if (!canGoForward) {
      return
    }
    const nextIdx = historyIdx + 1
    setHistoryIdx(nextIdx)
    const target = historyStack[nextIdx]
    if (target) {
      void navigate(target, { fromHistory: true })
    }
  }, [canGoForward, historyIdx, historyStack, navigate])

  const copyUrl = useCallback(() => {
    void navigator.clipboard.writeText(displayedUrl).catch(() => {})
  }, [displayedUrl])

  const openInNewTab = useCallback(() => {
    // Why: open the PROXY path, not the upstream URL — upstream origins are
    // usually the serve host's loopback, unreachable from the user's machine.
    // The proxy path shares the gateway origin (and its auth) so a plain new
    // tab works, with real DevTools and downloads.
    if (iframeSrc && iframeSrc !== 'about:blank') {
      window.open(iframeSrc, '_blank', 'noopener,noreferrer')
    }
  }, [iframeSrc])

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col bg-background">
      <div
        className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
        data-contextual-tour-target="browser-toolbar"
      >
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={goBack}
          disabled={!canGoBack}
          aria-label={translate('auto.components.browser.pane.WebBrowserPane.back', 'Go back')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={goForward}
          disabled={!canGoForward}
          aria-label={translate(
            'auto.components.browser.pane.WebBrowserPane.forward',
            'Go forward'
          )}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={reload}
          aria-label={translate('auto.components.browser.pane.WebBrowserPane.reload', 'Reload')}
        >
          {status === 'loading' ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
        <BrowserAddressBar
          value={urlInput}
          onChange={setUrlInput}
          onSubmit={() => void navigate(urlInput)}
          onNavigate={(url) => void navigate(url)}
          inputRef={addressInputRef}
        />
        {status === 'error' && error ? (
          <span className="max-w-[200px] truncate text-xs text-destructive" title={error}>
            {error}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={translate(
                'auto.components.browser.pane.WebBrowserPane.more',
                'More options'
              )}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem onSelect={copyUrl}>
              <Copy className="mr-2 size-3.5" />
              {translate('auto.components.browser.pane.WebBrowserPane.copy.url', 'Copy URL')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openInNewTab}>
              <ExternalLink className="mr-2 size-3.5" />
              {translate(
                'auto.components.browser.pane.WebBrowserPane.open.tab',
                'Open in browser tab'
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'].map(
              (quickUrl) => (
                <DropdownMenuItem key={quickUrl} onSelect={() => void navigate(quickUrl)}>
                  {translate('auto.components.browser.pane.WebBrowserPane.go.to', 'Go to')}
                  <span className="ml-2 font-mono">{quickUrl.replace('http://', '')}</span>
                </DropdownMenuItem>
              )
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 bg-background">
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          onLoad={onLoad}
          // Why: allow-same-origin is safe AND required — the proxy serves the
          // page from the gateway origin, and the injected nav-sync script
          // needs same-origin postMessage back to this renderer. We omit
          // allow-top-navigation so a hostile page can't navigate Orca itself.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          allow="clipboard-write; fullscreen; autoplay; geolocation; microphone; camera"
          className="absolute inset-0 h-full w-full border-0"
          title={displayedUrl || 'Browser'}
        />
      </div>
    </div>
  )
}
