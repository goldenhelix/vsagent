// Iframe-backed in-app browser pane for web mode. Replaces the Electron
// <webview> path entirely — that element is renderer-process-only and has
// no analogue in a regular browser tab.
//
// Architecture:
//   1. Address bar input → `window.api.webPreview.create({ targetOrigin })`
//      returns `{ id, proxyPath }`.
//   2. Iframe `src` is set to that proxyPath. The gateway proxy serves
//      the target origin and injects a URL-rewriting script so subsequent
//      in-page navigation stays in the proxy.
//   3. The injected script `postMessage`s the parent on every navigation
//      with the upstream URL — we keep the address bar in sync from those.
//
// What this does NOT do (yet):
//   - Back/forward across iframe.history (cross-origin iframe.history is
//     blocked by the browser; we'd need to track an in-pane history stack
//     and reload the iframe at the right step on Back).
//   - DevTools / view-source / find-in-page.
//   - Profile management (no Electron session partitions to share).
//   - Cookie inspection.
//
// What it DOES:
//   - Address bar: type a URL, hit Enter → loads.
//   - Reload button.
//   - URL syncs as the page navigates internally.
//   - Sensible defaults: missing `http://` is filled in.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'

export type WebBrowserPaneProps = {
  initialUrl?: string
  className?: string
}

type Session = { id: string; targetOrigin: string; proxyPath: string }

function deriveOriginFromInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  // Bare host[:port] → assume http
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

function derivePathFromInput(input: string, origin: string): string {
  if (!origin) return '/'
  try {
    const withScheme = /^https?:\/\//i.test(input) ? input : `http://${input}`
    const url = new URL(withScheme)
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

export function WebBrowserPane({
  initialUrl = 'http://localhost:3000',
  className
}: WebBrowserPaneProps): React.JSX.Element {
  const [urlInput, setUrlInput] = useState(initialUrl)
  const [displayedUrl, setDisplayedUrl] = useState(initialUrl)
  const [session, setSession] = useState<Session | null>(null)
  const [iframeSrc, setIframeSrc] = useState<string>('about:blank')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const navigate = useCallback(async (input: string) => {
    const origin = deriveOriginFromInput(input)
    if (!origin) {
      setStatus('error')
      setError('Invalid URL')
      return
    }
    const path = derivePathFromInput(input, origin)
    setStatus('loading')
    setError(null)
    try {
      const s = session
        ? await window.api.webPreview.setOrigin({ id: session.id, targetOrigin: origin })
        : await window.api.webPreview.create({ targetOrigin: origin })
      if (!s) {
        // Session was deleted out from under us; recreate.
        const fresh = await window.api.webPreview.create({ targetOrigin: origin })
        setSession(fresh)
        setIframeSrc(fresh.proxyPath + path)
      } else {
        setSession(s)
        setIframeSrc(s.proxyPath + path)
      }
      const display = origin + path
      setDisplayedUrl(display)
      setUrlInput(display)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [session])

  // Receive navigation pings from the injected script so the address bar
  // updates when the page does its own client-side routing.
  useEffect(() => {
    const handler = (e: MessageEvent): void => {
      const data = e.data
      if (!data || typeof data !== 'object') return
      if (data.type !== 'orca-webpreview-nav') return
      if (typeof data.upstreamUrl === 'string') {
        setDisplayedUrl(data.upstreamUrl)
        setUrlInput(data.upstreamUrl)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // First-mount: load the initial URL.
  useEffect(() => {
    if (session === null) {
      void navigate(initialUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tear down the proxy session when the pane unmounts.
  useEffect(() => {
    return () => {
      if (session) {
        void window.api.webPreview.delete({ id: session.id }).catch(() => {})
      }
    }
  }, [session])

  const onLoad = useCallback(() => setStatus('idle'), [])

  const reload = useCallback(() => {
    const ifr = iframeRef.current
    if (!ifr) return
    // Why: reset src to force a reload that re-runs the injected script.
    const current = ifr.src
    ifr.src = 'about:blank'
    requestAnimationFrame(() => {
      ifr.src = current
    })
  }, [])

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      void navigate(urlInput)
    },
    [navigate, urlInput]
  )

  const placeholder = useMemo(() => 'http://localhost:3000 — or paste a URL', [])

  return (
    <div className={`flex flex-col h-full min-h-0 ${className ?? ''}`}>
      <form
        className="flex items-center gap-1.5 border-b border-border bg-background px-2 py-1.5"
        onSubmit={onSubmit}
      >
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
          className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
        />
        {status === 'loading' && (
          <span className="text-xs text-muted-foreground">Loading…</span>
        )}
        {status === 'error' && error && (
          <span className="text-xs text-destructive truncate max-w-[200px]">{error}</span>
        )}
      </form>
      <div className="relative flex-1 min-h-0 bg-background">
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          onLoad={onLoad}
          // Why: a webpreview-proxied page is "trusted" in the sense that
          // the operator pointed us at it, but it may still be a third-
          // party site reached through _ext. We allow scripts + same-
          // origin + forms + popups so most apps work, but no top-
          // navigation (which would escape the iframe).
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full border-0"
          title={displayedUrl}
        />
      </div>
    </div>
  )
}
