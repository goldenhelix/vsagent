// URL derivation and proxy-session plumbing for the web client's iframe-backed
// browser pane (WebBrowserPane). Navigation targets are turned into an origin
// (owned by a webpreview proxy session on the serve host) plus a path appended
// to the session's proxyPath.
import type { WebPreviewSessionInfo } from '../../../../preload/api/web-preview-api'

/** The preload session shape; `proxyPath` is an absolute URL on the owning host's gateway. */
export type WebPreviewSession = WebPreviewSessionInfo

export function isBlankBrowserUrl(url: string | null | undefined): boolean {
  // Why: ORCA_BROWSER_BLANK_URL is a data: bootstrap; neither it nor
  // about:blank is a navigable upstream origin for the proxy.
  return !url || url === 'about:blank' || url.startsWith('data:')
}

export function deriveOriginFromInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed || isBlankBrowserUrl(trimmed)) {
    return ''
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).origin
    } catch {
      return ''
    }
  }
  // Why: bare "localhost:3000" style input defaults to http, matching how dev
  // servers are reached on the serve host.
  try {
    return new URL(`http://${trimmed}`).origin
  } catch {
    return ''
  }
}

export function derivePathFromInput(input: string): string {
  try {
    const withScheme = /^https?:\/\//i.test(input) ? input : `http://${input}`
    const url = new URL(withScheme)
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

export async function acquireWebPreviewSession(
  current: WebPreviewSession | null,
  targetOrigin: string
): Promise<WebPreviewSession> {
  const webPreview = window.api.webPreview
  if (!webPreview) {
    throw new Error('Web preview is unavailable in this client.')
  }
  if (current) {
    // Why: reuse the existing session so the iframe's proxy path stays stable
    // across origin changes; recreate only when the session expired server-side.
    const updated = await webPreview.setOrigin({ id: current.id, targetOrigin })
    if (updated) {
      return updated
    }
  }
  return webPreview.create({ targetOrigin })
}

export function releaseWebPreviewSession(id: string): void {
  void window.api.webPreview?.delete({ id }).catch(() => {})
}

// Navigate an already-mounted iframe to the typed proxy path. Assigning .src
// navigates reliably when the attribute differs; when it already equals nextSrc
// (same URL retyped, or the page SPA-routed away so the src attribute is stale
// relative to the live location) an about:blank round-trip forces a fresh fetch
// of the TYPED path — never a reload of whatever path the page wandered to
// (the stale-path leak). Using .src (not contentWindow.location) avoids relying
// on cross-document navigation of the live location, which did not reliably
// repaint the frame.
export function navigateProxyIframe(ifr: HTMLIFrameElement | null, nextSrc: string): void {
  if (!ifr) {
    return
  }
  if (ifr.getAttribute('src') === nextSrc) {
    ifr.src = 'about:blank'
    requestAnimationFrame(() => {
      ifr.src = nextSrc
    })
    return
  }
  ifr.src = nextSrc
}
