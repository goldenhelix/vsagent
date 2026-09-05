// Navigation, proxy-session lifecycle and in-pane history for the web client's
// iframe-backed browser pane. Split out of WebBrowserPane.tsx so the component
// stays chrome + iframe; every behavioural comment below records a real bug.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import {
  acquireWebPreviewSession,
  deriveOriginFromInput,
  derivePathFromInput,
  isBlankBrowserUrl,
  navigateProxyIframe,
  releaseWebPreviewSession,
  type WebPreviewSession
} from './webpreview-proxy-navigation'

// Why: unbounded history would leak memory on chatty SPAs.
const MAX_HISTORY_ENTRIES = 100

export type WebPreviewBrowserPageStatus = 'idle' | 'loading' | 'error'

export type WebPreviewBrowserPageModel = {
  urlInput: string
  setUrlInput: (value: string) => void
  displayedUrl: string
  status: WebPreviewBrowserPageStatus
  error: string | null
  canGoBack: boolean
  canGoForward: boolean
  navigate: (input: string) => void
  goBack: () => void
  goForward: () => void
  reload: () => void
  onLoad: () => void
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  addressInputRef: React.RefObject<HTMLInputElement | null>
  iframeSrc: string
}

export function useWebPreviewBrowserPage(page: BrowserPage): WebPreviewBrowserPageModel {
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
  const [status, setStatus] = useState<WebPreviewBrowserPageStatus>('idle')
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
  // Synced in an effect (declared before the effects below, so it lands first in the
  // same commit) because a render-phase write can leak from a render React discards.
  useEffect(() => {
    displayedUrlRef.current = displayedUrl
  }, [displayedUrl])

  const pushHistory = useCallback(
    (upstreamUrl: string) => {
      setHistoryStack((prev) => {
        if (historyIdx >= 0 && prev[historyIdx] === upstreamUrl) {
          return prev
        }
        const truncated = historyIdx + 1 >= prev.length ? prev : prev.slice(0, historyIdx + 1)
        const next = [...truncated, upstreamUrl]
        return next.length > MAX_HISTORY_ENTRIES
          ? next.slice(next.length - MAX_HISTORY_ENTRIES)
          : next
      })
      setHistoryIdx((idx) => Math.min(idx + 1, MAX_HISTORY_ENTRIES - 1))
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

  const navigateTo = useCallback(
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
          // Why: React won't re-set an unchanged src attribute, so the iframe
          // never refetches — this is the "typed a URL, Enter does nothing"
          // case (same URL retyped, or the page SPA-routed away leaving this
          // state stale while the live location moved). Force the TYPED path
          // via navigateProxyIframe's about:blank round-trip — never a reload
          // of whatever path the page wandered to (stale-path leak).
          navigateProxyIframe(iframeRef.current, nextIframeSrc)
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
      if (!data || typeof data !== 'object') {
        return
      }
      // A cross-origin top-level link click, forwarded by the injected script:
      // retarget the proxy session to the new site (like typing a new address)
      // so it loads proxied — rewritten, nav-tracked, and X-Frame-Options safe.
      if (data.type === 'orca-webpreview-navigate' && typeof data.url === 'string') {
        void navigateTo(data.url)
        return
      }
      if (data.type !== 'orca-webpreview-nav') {
        return
      }
      if (typeof data.upstreamUrl !== 'string') {
        return
      }
      // Why: reflect wherever the page actually is (SPA routes, server-side
      // redirects that retargeted the session origin). We deliberately do NOT
      // filter by the client's session origin — the server can retarget on a
      // redirect, leaving that copy stale, which would drop legitimate pings
      // and freeze the address bar. A late ping from an outgoing page is
      // superseded by the next real load's echo.
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
  }, [navigateTo, pushHistory, page.id, setBrowserPageUrl, historyIdx, syncTitleToStore])

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
      void navigateTo(storeUrl)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-only bootstrap
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
    void navigateTo(storeUrl, { fromHistory: true })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only external URL changes should re-navigate
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
      void navigateTo(target, { fromHistory: true })
    }
  }, [canGoBack, historyIdx, historyStack, navigateTo])

  const goForward = useCallback(() => {
    if (!canGoForward) {
      return
    }
    const nextIdx = historyIdx + 1
    setHistoryIdx(nextIdx)
    const target = historyStack[nextIdx]
    if (target) {
      void navigateTo(target, { fromHistory: true })
    }
  }, [canGoForward, historyIdx, historyStack, navigateTo])

  const navigate = useCallback(
    (input: string): void => {
      void navigateTo(input)
    },
    [navigateTo]
  )

  return {
    urlInput,
    setUrlInput,
    displayedUrl,
    status,
    error,
    canGoBack,
    canGoForward,
    navigate,
    goBack,
    goForward,
    reload,
    onLoad,
    iframeRef,
    addressInputRef,
    iframeSrc
  }
}
