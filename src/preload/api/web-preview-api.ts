// Why: web clients back browser panes with a server-side reverse proxy
// instead of an Electron webview. Optional on PreloadApi — only the web
// preload implements it; desktop panes never consult it.
export type WebPreviewSessionInfo = {
  id: string
  targetOrigin: string
  /** Absolute URL: a paired client can hold sessions across multiple runtime environments. */
  proxyPath: string
}

export type WebPreviewApi = {
  create: (args: { targetOrigin: string }) => Promise<WebPreviewSessionInfo>
  setOrigin: (args: { id: string; targetOrigin: string }) => Promise<WebPreviewSessionInfo | null>
  delete: (args: { id: string }) => Promise<void>
}
