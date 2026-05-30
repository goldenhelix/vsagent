// Browser-side notification runtime for the web client (`pnpm web:serve`).
// Desktop/SSH show notifications from the Electron main process; in the browser
// the main process is headless (no notification daemon), so the toast has to be
// shown client-side here. Sound is NOT handled here — it plays through
// `window.api.notifications.playSound`, which works over the WS bridge (Web
// Audio + main-resolved sound bytes) for both built-in and custom sounds.
import type { NotificationDispatchRequest } from '../../../shared/types'
import { buildNotificationOptions } from '../../../shared/notification-options'

// Why: browsers gate audio playback behind a prior user gesture. We arm a
// one-shot pointer/key listener so the page records user activation early,
// letting the bridge's event-driven `playSound()` calls (which carry no gesture
// of their own) succeed once the user has interacted with Orca at all.
let audioUnlockArmed = false

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
