// Web-client routing for the ports panel's "open in browser" action. A workspace
// port listens on the serve host's loopback, so the browser client can only reach
// it through the server-side webpreview proxy WebBrowserPane already uses.
// Split out of workspace-port-actions.ts, which has no room for these bodies.
import { acquireWebPreviewSession } from '@/components/browser-pane/webpreview-proxy-navigation'
import { clientCanUseWebPreviewProxy } from './webpreview-browser-availability'

export function canRoutePortThroughWebPreview(): boolean {
  return clientCanUseWebPreviewProxy()
}

/**
 * Opens a port in a real browser tab through a fresh webpreview session.
 * Why: shell.openUrl would hand the serve host's loopback URL to the user's own
 * machine, where nothing is listening on that port.
 */
export async function openPortThroughWebPreviewWindow(
  url: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const target = new URL(url)
    const session = await acquireWebPreviewSession(null, target.origin)
    // proxyPath is absolute, so it already names the host that minted the session.
    window.open(
      session.proxyPath + target.pathname + target.search + target.hash,
      '_blank',
      'noopener,noreferrer'
    )
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message || 'Failed to open port preview.' }
  }
}
