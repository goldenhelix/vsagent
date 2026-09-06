import { WEBPREVIEW_PROXY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { isWebClientLocation } from './web-client-location'

// Why (VSAgent fork): browser tabs in the web client render as iframes served by the
// host's webpreview proxy (WebBrowserPane), so they need webpreview.proxy.v1 — not
// browser.screencast.v1, which a displayless serve host never advertises. One selector
// so the pane guard and the creation policy cannot drift.

export function clientCanUseWebPreviewProxy(): boolean {
  // Location check first: it is the one that guards `typeof window`, so this stays
  // safe wherever window is undefined. Only the web preload defines webPreview.
  return isWebClientLocation() && Boolean(window.api?.webPreview)
}

export function hostAdvertisesWebPreviewProxy(
  runtimeStatus: Pick<RuntimeStatus, 'capabilities'> | null | undefined
): boolean {
  return runtimeStatus?.capabilities?.includes(WEBPREVIEW_PROXY_RUNTIME_CAPABILITY) ?? false
}

export function canRenderWebPreviewBrowserPane(
  runtimeStatus: Pick<RuntimeStatus, 'capabilities'> | null | undefined
): boolean {
  return clientCanUseWebPreviewProxy() && hostAdvertisesWebPreviewProxy(runtimeStatus)
}
