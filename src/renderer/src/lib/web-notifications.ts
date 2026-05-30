// Browser-side notification runtime for the web client (`pnpm web:serve`).
// Desktop/SSH show notifications from the Electron main process; in the browser
// the main process is headless (no notification daemon), so the toast has to be
// shown client-side here. Sound is handled here too: the bytes can't ride the
// WS bridge (JSON serialization mangles the Uint8Array), so the sound is fetched
// over HTTP from the gateway's /__orca/notification-sound route and played with
// the Web Audio <Audio> element.
import type { NotificationDispatchRequest } from '../../../shared/types'
import { buildNotificationOptions } from '../../../shared/notification-options'

// Why: browsers gate audio playback behind a prior user gesture. We arm a
// one-shot pointer/key listener so the page records user activation early,
// letting event-driven sound plays (which carry no gesture of their own)
// succeed once the user has interacted with Orca at all.
let audioUnlockArmed = false

// Why: the gateway streams the *currently selected* sound from one stable URL.
// A changed selection would otherwise be masked by the HTTP cache, so we append
// a per-call cache-busting counter to force a fresh fetch each time.
let soundFetchCounter = 0

export function notificationsSupported(): boolean {
  // Why: secure-context only; Notification is undefined on plain http (except
  // localhost) and inside the SSR/test environment that stubs window.
  return typeof Notification !== 'undefined'
}

export function notificationPermissionGranted(): boolean {
  return notificationsSupported() && Notification.permission === 'granted'
}

export function notificationPermissionRequested(): boolean {
  return notificationsSupported() && Notification.permission !== 'default'
}

export async function requestNotificationPermission(): Promise<void> {
  if (!notificationsSupported()) {
    return
  }
  // Why: must be invoked from a user gesture (the Settings button) or the
  // browser silently resolves to the current permission without prompting.
  try {
    await Notification.requestPermission()
  } catch {
    // Older Safari throws on the promise form; the callback form is not worth
    // shimming for the settings affordance.
  }
}

// Why: the tab's own focus is only knowable in the browser, so the
// suppress-when-focused gate is enforced client-side rather than in the
// headless main process.
export function isWebTabForeground(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function ensureAudioUnlockListeners(): void {
  if (audioUnlockArmed || typeof window === 'undefined') {
    return
  }
  audioUnlockArmed = true
  // Why: the gesture itself grants the page audio activation; this listener
  // only needs to exist on the first interaction, so it removes itself.
  const unlock = (): void => {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
}

export function showWebNotification(args: NotificationDispatchRequest): boolean {
  if (!notificationPermissionGranted()) {
    return false
  }
  const { title, body } = buildNotificationOptions(args)
  // Why: tag de-dupes the OS-level stack by worktree; silent because Orca plays
  // its own selected sound rather than the browser's default chime.
  const tag = args.worktreeId ?? args.worktreeLabel ?? args.paneKey ?? undefined
  const notification = new Notification(title, { body, tag, silent: true })
  notification.onclick = () => {
    // Why: web has no main-process worktree activation; at minimum focus the
    // tab so a click brings Orca forward. Pane routing would need a renderer
    // event bus the web build doesn't expose yet.
    try {
      window.focus()
    } catch {
      // focus() can throw under strict popup policies; the toast still cleared.
    }
    notification.close()
  }
  return true
}

// Why: web-only sound playback. Fetches the gateway-resolved sound over HTTP
// (binary can't ride the JSON WS bridge) and plays it. Resolves false on
// autoplay rejection / 404 (no/invalid sound) / network error so callers can
// decide whether to surface an error. Event-driven plays succeed once the user
// has interacted with Orca at all (browser audio activation), which the
// audio-unlock listeners arm.
export async function playWebNotificationSound(volumePercent?: number): Promise<boolean> {
  if (typeof Audio === 'undefined') {
    return false
  }
  ensureAudioUnlockListeners()
  soundFetchCounter += 1
  const url = `/__orca/notification-sound?v=${soundFetchCounter}`
  try {
    const audio = new Audio(url)
    if (volumePercent !== undefined) {
      audio.volume = Math.min(1, Math.max(0, volumePercent / 100))
    }
    await audio.play()
    return true
  } catch {
    // Autoplay policy rejection, a 404 (missing/invalid/too-large sound), or a
    // network error all reject here — the caller treats it as "not played".
    return false
  }
}
