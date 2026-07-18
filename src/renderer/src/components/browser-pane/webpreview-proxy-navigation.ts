// URL derivation and proxy-session plumbing for the web client's iframe-backed
// browser pane (WebBrowserPane). Navigation targets are turned into an origin
// (owned by a webpreview proxy session on the serve host) plus a path appended
// to the session's proxyPath.

export type WebPreviewSession = { id: string; targetOrigin: string; proxyPath: string }

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

// Navigate an already-mounted iframe to the typed proxy path. A bare reload()
// would replay whatever path the page client-routed to — wrong the moment the
// session was retargeted to a new origin (stale-path leak). replace() of an
// identical URL still refetches, covering the same-URL-retyped case.
export function navigateProxyIframe(ifr: HTMLIFrameElement | null, nextSrc: string): void {
  if (!ifr) {
    return
  }
  try {
    ifr.contentWindow?.location?.replace(nextSrc)
  } catch {
    ifr.src = 'about:blank'
    requestAnimationFrame(() => {
      ifr.src = nextSrc
    })
  }
}

// True when a nav ping (whose reporting page baked in the session origin at
// response time) belongs to the session's CURRENT origin. Pings from a page
// predating an address-bar origin change must not relabel the tab.
export function isNavPingForOrigin(
  upstreamUrl: string,
  sessionOrigin: string | undefined
): boolean {
  if (!sessionOrigin) {
    return true
  }
  try {
    return new URL(upstreamUrl).origin === sessionOrigin
  } catch {
    return false
  }
}
