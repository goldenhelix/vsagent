import { spawnSync } from 'node:child_process'

// Why: Electron's `Notification.isSupported()` only reports whether the
// platform's notification class is wired up — on Linux it returns true as
// long as libnotify is present. It does NOT check whether the DBus
// `org.freedesktop.Notifications` service has a live owner. In headless
// sessions (KasmVNC, SSH X-forwarding, server boxes) no notification daemon
// runs, and the first `new Notification(...)` call triggers a DBus
// `StartServiceByName` activation that waits ~120 seconds before giving up,
// blocking the synchronous `ipcMain.handle` reply path and every queued
// IPC behind it. We probe once at first use and cache the result.

let cached: boolean | null = null

function detect(): boolean {
  // macOS and Windows use OS-native notification APIs that bypass DBus, so
  // the libnotify activation timeout cannot occur there.
  if (process.platform !== 'linux') {
    return true
  }
  // No display server at all → desktop notifications dead-end. Skip the
  // DBus probe entirely; this catches the common `pnpm web:serve` case where
  // we run headless without even a virtual display.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false
  }
  // Probe org.freedesktop.Notifications via dbus-send with a hard reply
  // timeout. The 1500ms outer process timeout ensures we cannot inherit a
  // wedged DBus into the main thread.
  try {
    const result = spawnSync(
      'dbus-send',
      [
        '--session',
        '--print-reply',
        '--reply-timeout=1000',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.NameHasOwner',
        'string:org.freedesktop.Notifications'
      ],
      { timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    // dbus-send not installed → we don't actually know. Real desktop
    // sessions without dbus-send still have libnotify wired up directly, so
    // fall back to "available" rather than disabling notifications for
    // working users.
    if (result.error) {
      return true
    }
    if (result.status !== 0) {
      return false
    }
    return /boolean\s+true/i.test(result.stdout ?? '')
  } catch {
    return true
  }
}

export function isNotificationDaemonAvailable(): boolean {
  if (cached === null) {
    cached = detect()
    if (!cached) {
      console.log(
        '[notifications] desktop notification daemon unavailable; suppressing libnotify dispatch'
      )
    }
  }
  return cached
}

// Test-only: reset the cached probe result.
export function _resetNotificationDaemonProbeForTests(): void {
  cached = null
}
