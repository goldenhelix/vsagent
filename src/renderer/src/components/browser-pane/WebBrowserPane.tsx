// Iframe-backed in-app browser pane for web mode. Replaces the Electron
// <webview> path entirely.
//
// What this provides:
//   - Back / Forward buttons driven by iframe.contentWindow.history.
//   - Reload.
//   - Address bar with selectable text, paste-and-go, Enter to navigate.
//   - Open-externally button (opens the upstream URL in a real new tab so
//     downloads / extension UIs / DevTools all work like a normal browser).
//   - "Copy URL" item in a kebab menu.
//   - Navigation sync from the injected proxy script's postMessage.
//
// Not yet:
//   - DevTools (no analogue without Electron WebContents).
//   - In-page find (could ship Ctrl+F → iframe.focus + browser's native
//     find, but it's blocked by sandbox attributes in some configs).
//   - Cookie inspection.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  MoreHorizontal,
  RotateCcw,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'

export type WebBrowserPaneProps = {
  /** Browser-workspace (tab) id. The pane reads the current URL from the
   *  store via this id and writes navigations back so cross-browser
   *  session-sync can broadcast them to other tabs. */
  workspaceId?: string
  /** URL to navigate to when the store has no URL for this workspace yet
   *  (fresh browser tabs default to localhost:3000). */
  fallbackUrl?: string
  className?: string
}

type Session = { id: string; targetOrigin: string; proxyPath: string }

function deriveOriginFromInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin
    } catch {
      return ''
    }
  }
  try {
    return new URL(`http://${trimmed}`).origin
  } catch {
    return ''
  }
}

function derivePathFromInput(input: string): string {
  try {
    const withScheme = /^https?:\/\//i.test(input) ? input : `http://${input}`
    const url = new URL(withScheme)
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

export function WebBrowserPane({
  workspaceId,
  fallbackUrl = 'http://localhost:3000',
  className
}: WebBrowserPaneProps): React.JSX.Element {
  // Why: drive both the displayed URL and any cross-browser sync through
  // the store's BrowserWorkspace.url. A remote browser navigating updates
  // the store via session:set → broadcast → other browsers re-hydrate →
  // this selector fires → local iframe navigates. Local nav also pushes
  // back into the store so OTHER browsers see it.
  const storeUrl = useAppStore((s) => {
    if (!workspaceId) return undefined
    for (const list of Object.values(s.browserTabsByWorktree)) {
      for (const ws of list) if (ws.id === workspaceId) return ws.url
    }
    return undefined
  })
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)
  const activePageId = useAppStore((s) => {
    if (!workspaceId) return null
    for (const list of Object.values(s.browserTabsByWorktree)) {
      for (const ws of list)
        if (ws.id === workspaceId) return ws.activePageId ?? ws.pageIds?.[0] ?? null
    }
    return null
  })
  const initialUrl = storeUrl && storeUrl.length > 0 ? storeUrl : fallbackUrl
  const [urlInput, setUrlInput] = useState(initialUrl)
  const [displayedUrl, setDisplayedUrl] = useState(initialUrl)
  const [session, setSession] = useState<Session | null>(null)
  // Why: dedupe the store→pane echo. When this pane navigates locally it
  // writes to the store, the store broadcasts to other clients, those
  // clients re-hydrate, and on THIS client the selector fires with the
  // same URL we just set. Skip those self-echoes by recording the URL we
  // most recently pushed.
  const lastPushedUrlRef = useRef<string>('')
  const [iframeSrc, setIframeSrc] = useState<string>('about:blank')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  // Why: track an in-pane navigation history independent of iframe.history.
  // Cross-origin iframe.history is opaque to us — but same-origin (proxy
  // path) navigations DO update iframe.contentWindow.history, so for the
  // common case (SPA in-iframe routing) the iframe API also works. We
  // mirror them here so the Back/Forward buttons can fall back to
  // setting the iframe src directly when history APIs aren't available.
  const [historyStack, setHistoryStack] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  // Why: monotonic request seq so a stale autocomplete-like async response
  // can't clobber a newer navigation.
  const navSeq = useRef(0)
  // Why: a navigate() call sets a fresh iframe src and waits for the page
  // to load. The injected script then posts back the real upstream URL
  // (which may differ from what was typed because of a server-side 30x).
  // We treat that first postNav as the load-completion echo: REPLACE the
  // current history entry with the final URL rather than PUSH a new one,
  // so Back doesn't take the user to the pre-redirect URL they never
  // actually visited. Subsequent postNavs (link clicks, history.pushState)
  // push normally.
  const expectingLoadEchoRef = useRef(false)

  const pushHistory = useCallback(
    (upstreamUrl: string) => {
      setHistoryStack((prev) => {
        // Why: replace the entry rather than push when the new URL equals
        // the current one — happens when the proxy posts a nav event with
        // the same path the user just typed.
        if (historyIdx >= 0 && prev[historyIdx] === upstreamUrl) return prev
        const truncated = historyIdx + 1 >= prev.length ? prev : prev.slice(0, historyIdx + 1)
        const next = [...truncated, upstreamUrl]
        // Trim to a max — unbounded would leak memory on chatty sites.
        const MAX = 100
        return next.length > MAX ? next.slice(next.length - MAX) : next
      })
      setHistoryIdx((idx) => Math.min(idx + 1, 99))
    },
    [historyIdx]
  )

  const navigate = useCallback(
    async (input: string, opts?: { fromHistory?: boolean }) => {
      const origin = deriveOriginFromInput(input)
      if (!origin) {
        setStatus('error')
        setError('Invalid URL')
        return
      }
      const path = derivePathFromInput(input)
      const seq = ++navSeq.current
      setStatus('loading')
      setError(null)
      try {
        let s: Session | null
        if (session) {
          s = await window.api.webPreview.setOrigin({
            id: session.id,
            targetOrigin: origin
          })
          if (!s) {
            s = await window.api.webPreview.create({ targetOrigin: origin })
          }
        } else {
          s = await window.api.webPreview.create({ targetOrigin: origin })
        }
        if (seq !== navSeq.current) return
        setSession(s)
        const nextIframeSrc = s.proxyPath + path
        // Why: when nextIframeSrc equals the current iframe src, React
        // won't touch the DOM attribute so the iframe never refetches.
        // This bites two flows: (a) typing the SAME URL twice and hitting
        // Enter; (b) navigating Back to a URL that resolves to the same
        // proxy path (e.g. after a top-level cross-origin redirect-follow
        // updated the session and both history entries map to the same
        // proxy path). Force a reload via about:blank → src round-trip
        // when the src is unchanged so the user always gets a fresh fetch.
        if (iframeSrc === nextIframeSrc) {
          // Why: the iframe is always served from the gateway origin
          // (same-origin with the renderer), so contentWindow.location
          // is reachable. Reload through there to refetch — the about:blank
          // round-trip via direct .src= assignment loses to React's
          // reconciler resetting .src back to the unchanged iframeSrc.
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
        if (!opts?.fromHistory) pushHistory(display)
        // Why: push the new URL into the workspace's store entry so the
        // backend's session-set broadcaster carries it to other browsers.
        // Record the URL in lastPushedUrlRef so the storeUrl→pane echo
        // can recognise its own write and skip a no-op iframe nav.
        if (workspaceId && activePageId && display !== lastPushedUrlRef.current) {
          lastPushedUrlRef.current = display
          setBrowserPageUrl(activePageId, display)
        }
      } catch (err) {
        if (seq !== navSeq.current) return
        setStatus('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [session, pushHistory, workspaceId, activePageId, setBrowserPageUrl]
  )

  // Navigation pings from the injected script keep the address bar in sync
  // when the page client-routes internally.
  useEffect(() => {
    const handler = (e: MessageEvent): void => {
      const data = e.data
      if (!data || typeof data !== 'object') return
      if (data.type !== 'orca-webpreview-nav') return
      if (typeof data.upstreamUrl !== 'string') return
      const next = data.upstreamUrl
      setDisplayedUrl(next)
      // Don't overwrite the user's typing if the address bar is focused.
      if (document.activeElement !== addressInputRef.current) {
        setUrlInput(next)
      }
      if (expectingLoadEchoRef.current) {
        // First echo after navigate(): replace the current entry with the
        // post-redirect URL rather than pushing a new one. See the ref
        // declaration for the rationale.
        expectingLoadEchoRef.current = false
        setHistoryStack((prev) => {
          if (prev.length === 0) return [next]
          if (prev[historyIdx] === next) return prev
          const copy = [...prev]
          copy[historyIdx] = next
          return copy
        })
      } else {
        pushHistory(next)
      }
      // Why: also push client-side route changes (SPA navigation inside
      // the proxied page) into the store so OTHER browsers see them.
      if (workspaceId && activePageId && next !== lastPushedUrlRef.current) {
        lastPushedUrlRef.current = next
        setBrowserPageUrl(activePageId, next)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [pushHistory, workspaceId, activePageId, setBrowserPageUrl, historyIdx])

  // First-mount: load the initial URL.
  useEffect(() => {
    if (session === null) {
      void navigate(initialUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Why: react to remote URL changes. When another browser navigates and
  // the broadcast lands here, the store's BrowserWorkspace.url updates.
  // Compare it to lastPushedUrlRef — if it's not what we just wrote
  // ourselves, the change came from elsewhere and we should navigate.
  // We also compare against displayedUrl to skip when the iframe is
  // already pointing at the same URL (e.g. on initial hydrate).
  useEffect(() => {
    if (!storeUrl || !workspaceId) return
    if (storeUrl === lastPushedUrlRef.current) return
    if (storeUrl === displayedUrl) return
    // Don't yank the user out of an in-progress edit — only navigate
    // when the address bar isn't focused.
    if (document.activeElement === addressInputRef.current) return
    lastPushedUrlRef.current = storeUrl
    void navigate(storeUrl, { fromHistory: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeUrl])

  // Why: tear down the proxy session ONLY when the pane truly unmounts.
  // The earlier version watched [session] as a dependency, which fired
  // its cleanup every time `session` re-identified (e.g. setOrigin
  // returning the same id but a new object). That deleted the live
  // session moments before the iframe loaded it, producing
  // "webpreview: unknown session …". Tracking the id in a ref keeps the
  // cleanup tied to the component lifecycle, not to React's object
  // identity changes.
  const activeSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeSessionIdRef.current = session?.id ?? null
  }, [session])
  useEffect(() => {
    return () => {
      const id = activeSessionIdRef.current
      if (id) {
        void window.api.webPreview.delete({ id }).catch(() => {})
      }
    }
  }, [])

  const onLoad = useCallback(() => setStatus('idle'), [])

  const reload = useCallback(() => {
    const ifr = iframeRef.current
    if (!ifr) return
    // Why: try iframe-history reload first (preserves scroll on same-origin
    // proxy responses). Fall back to forcing the src round-trip.
    try {
      ifr.contentWindow?.location?.reload()
      return
    } catch {
      // cross-origin: fall through
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
    if (!canGoBack) return
    const nextIdx = historyIdx - 1
    setHistoryIdx(nextIdx)
    const target = historyStack[nextIdx]
    if (target) void navigate(target, { fromHistory: true })
  }, [canGoBack, historyIdx, historyStack, navigate])

  const goForward = useCallback(() => {
    if (!canGoForward) return
    const nextIdx = historyIdx + 1
    setHistoryIdx(nextIdx)
    const target = historyStack[nextIdx]
    if (target) void navigate(target, { fromHistory: true })
  }, [canGoForward, historyIdx, historyStack, navigate])

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      void navigate(urlInput)
    },
    [navigate, urlInput]
  )

  const copyUrl = useCallback(() => {
    void navigator.clipboard.writeText(displayedUrl).catch(() => {})
  }, [displayedUrl])

  const openExternal = useCallback(() => {
    // Why: opens the *upstream* URL in a real new tab — that bypasses the
    // proxy entirely. Useful when the user needs DevTools, extensions, or
    // direct access. Browsers may pop this as a new tab in the user's
    // default browser when window.open is allowed.
    window.open(displayedUrl, '_blank', 'noopener,noreferrer')
  }, [displayedUrl])

  const placeholder = useMemo(() => 'http://localhost:3000 — or paste a URL', [])

  return (
    <div className={`flex flex-col h-full w-full min-h-0 min-w-0 bg-background ${className ?? ''}`}>
      <form
        className="flex items-center gap-1 border-b border-border bg-card px-1.5 py-1"
        onSubmit={onSubmit}
      >
        <button
          type="button"
          onClick={goBack}
          disabled={!canGoBack}
          aria-label="Go back"
          title="Back"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={!canGoForward}
          aria-label="Go forward"
          title="Forward"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={reload}
          aria-label="Reload"
          title="Reload"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
        >
          <RotateCcw className="size-3.5" />
        </button>
        <input
          ref={addressInputRef}
          className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[12px] font-mono outline-none focus:ring-2 focus:ring-ring selection:bg-primary/40"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          // Why: handle Enter directly on the input rather than relying on
          // <form onSubmit>. The form's submit event was being swallowed
          // somewhere up the React tree (a parent onKeyDown / stopPropagation
          // in the workspace surface intercepts Enter before the form sees
          // it), so users had to click Reload to re-trigger the load. A
          // direct keydown handler bypasses that path. `stopPropagation`
          // also prevents the typed URL from being interpreted as a tab-
          // bar Enter (which would refocus the active terminal).
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.stopPropagation()
              void navigate(urlInput)
              addressInputRef.current?.blur()
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          aria-label="Address bar"
        />
        {status === 'loading' && <span className="text-xs text-muted-foreground px-1">…</span>}
        {status === 'error' && error && (
          <span
            className="text-xs text-destructive truncate max-w-[200px]"
            title={error}
          >
            {error}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              title="More"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem onSelect={copyUrl}>
              <Copy className="size-3.5 mr-2" />
              Copy URL
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openExternal}>
              <ExternalLink className="size-3.5 mr-2" />
              Open in browser tab
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void navigate('http://localhost:3000')}
            >
              Go to <span className="font-mono ml-2">localhost:3000</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void navigate('http://localhost:5173')}
            >
              Go to <span className="font-mono ml-2">localhost:5173</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void navigate('http://localhost:8080')}
            >
              Go to <span className="font-mono ml-2">localhost:8080</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </form>
      <div className="relative flex-1 min-h-0 min-w-0 bg-background">
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          onLoad={onLoad}
          // Why: sandbox is permissive — allow-same-origin so the proxy
          // path appears same-origin to the iframe (it actually IS same-
          // origin from the browser's perspective, because everything is
          // served by the gateway), and allow-scripts so SPAs run. We omit
          // allow-top-navigation so a malicious page can't navigate the
          // outer Orca renderer. allow-popups + allow-downloads cover the
          // common "click a link to open in new tab" flows.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          // Why: allow common embedded media APIs that SPAs use. The
          // browser still gates these on user permission per origin.
          allow="clipboard-write; fullscreen; autoplay; geolocation; microphone; camera"
          className="absolute inset-0 w-full h-full border-0"
          title={displayedUrl}
        />
      </div>
    </div>
  )
}
