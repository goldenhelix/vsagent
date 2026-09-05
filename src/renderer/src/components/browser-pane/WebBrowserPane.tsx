// Iframe-backed in-app browser pane for web clients. Replaces both the
// Electron <webview> path (no webviews in a plain browser) and the remote
// screencast path (needs Xvfb on the serve host). Navigation goes through the
// server-side webpreview reverse proxy: window.api.webPreview mints a session
// whose proxyPath serves the target origin from the gateway's own origin, and
// the proxy's injected script postMessages navigation events back up so the
// address bar and store stay in sync (see src/main/webpreview/rewrite-script.ts).
import { useCallback } from 'react'
import { Copy, ExternalLink, MoreHorizontal } from 'lucide-react'
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
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { BrowserChromeShortcutScope } from './describe-page/browser-page-types'
import BrowserAddressBar from './assemble-chrome/BrowserAddressBar'
import { BrowserNavigationControlRow } from './assemble-chrome/browser-navigation-control-row'
import { getBrowserPagesForWorkspace } from './assemble-chrome/browser-pane-page-selection'
import { useWebPreviewBrowserPage } from './use-webpreview-browser-page'

const QUICK_NAVIGATION_URLS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080'
]

export default function WebBrowserPane({
  browserTab
}: {
  browserTab: BrowserWorkspace
  // Accepted and ignored so this pane is a drop-in for the chrome panes: an iframe
  // has no guest to focus and no host-side chrome shortcuts to scope.
  isActive?: boolean
  chromeShortcutScope?: BrowserChromeShortcutScope
}): React.JSX.Element {
  const activePage = useAppStore((s) => {
    const pages = getBrowserPagesForWorkspace(s.browserPagesByWorkspace, browserTab.id)
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
  const {
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
  } = useWebPreviewBrowserPage(page)

  const copyUrl = useCallback(() => {
    void navigator.clipboard.writeText(displayedUrl).catch(() => {})
  }, [displayedUrl])

  const openInNewTab = useCallback(() => {
    // Why: open the PROXY path, not the upstream URL — upstream origins are
    // usually the serve host's loopback, unreachable from the user's machine.
    // The proxy path shares the gateway origin (and its auth) so a plain new
    // tab works, with real DevTools and downloads. Prefer the iframe's LIVE
    // location — the page may have client-routed since src was set.
    let target = iframeSrc
    try {
      const live = iframeRef.current?.contentWindow?.location?.href
      if (live && live !== 'about:blank') {
        target = live
      }
    } catch {
      // cross-origin fallback: keep the last src we set
    }
    if (target && target !== 'about:blank') {
      window.open(target, '_blank', 'noopener,noreferrer')
    }
  }, [iframeSrc, iframeRef])

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col bg-background">
      <BrowserNavigationControlRow
        controls={{
          canGoBack,
          canGoForward,
          loading: status === 'loading',
          goBack,
          goForward,
          reload,
          navigate
        }}
        addressSlot={
          <BrowserAddressBar
            value={urlInput}
            onChange={setUrlInput}
            onSubmit={() => navigate(urlInput)}
            onNavigate={navigate}
            inputRef={addressInputRef}
          />
        }
      >
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
            {QUICK_NAVIGATION_URLS.map((quickUrl) => (
              <DropdownMenuItem key={quickUrl} onSelect={() => navigate(quickUrl)}>
                {translate('auto.components.browser.pane.WebBrowserPane.go.to', 'Go to')}
                <span className="ml-2 font-mono">{quickUrl.replace('http://', '')}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BrowserNavigationControlRow>
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
          // Why: a referrer would make the gateway's own /assets/** requests look
          // like they came from the proxied page, and handleLeakedPreviewRequest
          // would hijack them back into the proxy.
          referrerPolicy="no-referrer"
          allow="clipboard-write; fullscreen; autoplay; geolocation; microphone; camera"
          className="absolute inset-0 h-full w-full border-0"
          title={
            displayedUrl ||
            translate('auto.components.browser.pane.WebBrowserPane.frame.title', 'Browser')
          }
        />
      </div>
    </div>
  )
}
