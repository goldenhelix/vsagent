// Why: `crypto.randomUUID` requires a secure context. The Orca web bundle is
// served over plain HTTP for on-LAN testing, so `crypto.randomUUID` is
// `undefined` in the browser (`crypto` still exists, just without that
// method). Many renderer call sites — every new tab, every browser-tab
// spawn, every diff-comment — depend on it. Polyfill the method from
// `crypto.getRandomValues` (which works in non-secure contexts) so a single
// shim covers all of them without touching renderer code.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(crypto as any).randomUUID = function randomUUIDFallback(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    // Why: bake in RFC4122 v4 version + variant bits so consumers that
    // parse the UUID into version/variant get the right answer.
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex: string[] = []
    for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'))
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    )
  }
}

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
