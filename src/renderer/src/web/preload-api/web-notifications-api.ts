import type { PreloadApi } from '../../../../preload/api-types'
import {
  armBrowserNotificationPermissionPrompt,
  browserNotificationPermissionGranted,
  browserNotificationPermissionRequested,
  browserNotificationsSupported,
  isWebTabForeground,
  showBrowserNotification
} from './web-browser-notifications'
import { getBrowserPlatform } from './web-storage'

// Why (VSAgent fork): the serve host is headless — desktop toasts go nowhere.
// Surface notifications through the browser's Notification API instead, with
// the focus-suppression gate applied client-side (only the browser knows tab
// focus). Permission is requested on the user's first interaction.
export function createNotificationsApi(): NonNullable<Partial<PreloadApi>['notifications']> {
  armBrowserNotificationPermissionPrompt()
  return {
    dispatch: (args) => {
      if (!browserNotificationsSupported()) {
        return Promise.resolve({ delivered: false, reason: 'not-supported' as const })
      }
      if (!browserNotificationPermissionGranted()) {
        return Promise.resolve({ delivered: false, reason: 'blocked-by-system' as const })
      }
      if (isWebTabForeground()) {
        return Promise.resolve({ delivered: false, reason: 'suppressed-focus' as const })
      }
      const delivered = showBrowserNotification(args)
      return Promise.resolve(
        delivered ? { delivered } : { delivered, reason: 'not-displayed' as const }
      )
    },
    dismiss: () => Promise.resolve({ dismissed: 0 }),
    openSystemSettings: () => Promise.resolve(),
    getPermissionStatus: () =>
      Promise.resolve({
        supported: browserNotificationsSupported(),
        platform: getBrowserPlatform(),
        requested: browserNotificationPermissionRequested()
      }),
    probeDelivery: () => {
      if (!browserNotificationsSupported()) {
        return Promise.resolve({ state: 'unsupported' as const, authoritative: false })
      }
      const state =
        Notification.permission === 'granted'
          ? ('delivered' as const)
          : Notification.permission === 'denied'
            ? ('blocked' as const)
            : ('awaiting-decision' as const)
      return Promise.resolve({ state, authoritative: false })
    },
    // Why: no local audio pipeline in the web client; the Notification itself
    // plays the browser's default chime (silent: false in the dispatcher).
    playSound: () => Promise.resolve({ played: false, reason: 'missing-path' })
  }
}
