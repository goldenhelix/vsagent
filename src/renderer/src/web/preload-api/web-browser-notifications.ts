// Why (VSAgent fork): in the browser-hosted web client there is no desktop
// notification daemon — the headless serve host cannot toast anything the user
// can see. Notifications must come from the browser's own Notification API on
// the client machine. Ported from the old fork's web-notifications module.
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'
import { buildNotificationOptions } from '../../../../shared/notification-options'

export function browserNotificationsSupported(): boolean {
  // Why: secure-context only; Notification is undefined on plain http (except
  // localhost) and inside test environments that stub window.
  return typeof Notification !== 'undefined'
}

export function browserNotificationPermissionGranted(): boolean {
  return browserNotificationsSupported() && Notification.permission === 'granted'
}

export function browserNotificationPermissionRequested(): boolean {
  return browserNotificationsSupported() && Notification.permission !== 'default'
}

// Why: browsers require a user gesture to show the permission prompt. Arm a
// one-shot pointer/key listener so the first interaction with the app asks
// once, without needing a dedicated settings affordance.
let permissionPromptArmed = false
export function armBrowserNotificationPermissionPrompt(): void {
  if (
    permissionPromptArmed ||
    typeof window === 'undefined' ||
    !browserNotificationsSupported() ||
    Notification.permission !== 'default'
  ) {
    return
  }
  permissionPromptArmed = true
  const request = (): void => {
    window.removeEventListener('pointerdown', request)
    window.removeEventListener('keydown', request)
    Notification.requestPermission().catch(() => {
      // Older Safari rejects the promise form; nothing actionable.
    })
  }
  window.addEventListener('pointerdown', request, { once: true })
  window.addEventListener('keydown', request, { once: true })
}

// Why: the tab's own focus is only knowable in the browser, so the
// suppress-when-focused gate is enforced client-side rather than by the
// headless main process.
export function isWebTabForeground(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function showBrowserNotification(args: NotificationDispatchRequest): boolean {
  if (!browserNotificationPermissionGranted()) {
    return false
  }
  const { title, body } = buildNotificationOptions(args)
  // Why: tag de-dupes the OS-level stack by worktree; silent stays false so
  // the browser's default chime substitutes for Orca's own sound pipeline,
  // which has no local audio path in the web client.
  const tag = args.worktreeId ?? args.worktreeLabel ?? args.paneKey ?? undefined
  const notification = new Notification(title, { body, tag, silent: false })
  notification.onclick = () => {
    // Why: web has no main-process worktree activation; at minimum focus the
    // tab so a click brings Orca forward.
    try {
      window.focus()
    } catch {
      // focus() can throw under strict popup policies; the toast still cleared.
    }
    notification.close()
  }
  return true
}
