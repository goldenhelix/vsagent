// Why: src/preload/index.ts reads `process.contextIsolated` to decide whether
// to use `contextBridge.exposeInMainWorld` or assign directly to `window.*`.
// In a browser there is no Node `process` global. Defining the minimum
// surface here means the preload's `else` branch runs and assigns to
// `window.api` / `window.electron` directly, which is exactly what we want.
type MinimalProcess = {
  contextIsolated: boolean
  env: Record<string, string | undefined>
  platform: string
  versions: Record<string, string | undefined>
}

const w = window as unknown as { process?: MinimalProcess }
if (!w.process) {
  const ua = navigator.userAgent
  const platform = ua.includes('Mac') ? 'darwin' : ua.includes('Windows') ? 'win32' : 'linux'
  w.process = {
    contextIsolated: false,
    env: {},
    platform,
    versions: {}
  }
}
