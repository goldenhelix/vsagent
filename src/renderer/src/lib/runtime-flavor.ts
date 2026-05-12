// Reads the backend's runtime flavor once at boot. `web === true` means the
// renderer is talking to the Orca web gateway and is running inside a regular
// browser tab; native-only UI (window controls, native dialog pickers, the
// auto-updater card, etc.) must be hidden.
//
// Why a sync getter + a one-shot promise: most callers need a sync answer
// during render (`isWebMode ? null : <NativeControls/>`). We resolve the
// flavor exactly once at app boot before the first useful render via
// `loadRuntimeFlavor()`; subsequent reads hit an in-memory cache.

let cached: { web: boolean; platform: string } | null = null
let inflight: Promise<{ web: boolean; platform: string }> | null = null

export async function loadRuntimeFlavor(): Promise<{ web: boolean; platform: string }> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const value = await window.api.app.getRuntimeFlavor()
      cached = value
      return value
    } catch (err) {
      // Why: failure means the backend predates the runtime-flavor IPC. The
      // safe default is "desktop" — we'd rather render native controls that
      // don't work than hide a critical close button.
      console.warn('[runtime-flavor] failed to read; defaulting to desktop:', err)
      cached = { web: false, platform: 'unknown' }
      return cached
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function isWebMode(): boolean {
  return cached?.web ?? false
}

export function getRuntimeFlavor(): { web: boolean; platform: string } | null {
  return cached
}
