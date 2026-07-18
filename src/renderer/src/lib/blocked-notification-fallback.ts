import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'

// Why: agent completions can dispatch in bursts; one in-app pointer at the
// broken OS setting per session teaches the fix without nagging.
let shownThisSession = false

/**
 * In-app stand-in for a native notification that macOS silently swallowed
 * (dispatch returned 'blocked-by-system'): tells the user notifications are
 * off at the OS level and deep-links to the app's System Settings pane.
 */
export function showBlockedNotificationFallbackToast(): void {
  if (shownThisSession) {
    return
  }
  shownThisSession = true
  // Why (VSAgent fork): in the browser web client 'blocked-by-system' means
  // the BROWSER's notification permission, not macOS — pointing users at
  // System Settings is wrong, and the browser prompt needs a user gesture,
  // which the toast button provides.
  if (isWebClientLocation()) {
    const canPrompt = typeof Notification !== 'undefined' && Notification.permission === 'default'
    toast.warning(
      translate(
        'auto.lib.blocked.notification.fallback.web.blocked',
        'Your browser is blocking notifications'
      ),
      {
        description: canPrompt
          ? translate(
              'auto.lib.blocked.notification.fallback.web.allow',
              'Allow notifications for this site to get agent alerts.'
            )
          : translate(
              'auto.lib.blocked.notification.fallback.web.reenable',
              'Re-enable notifications for this site in your browser settings.'
            ),
        ...(canPrompt
          ? {
              action: {
                label: translate(
                  'auto.lib.blocked.notification.fallback.web.enable',
                  'Enable notifications'
                ),
                onClick: () => {
                  void Notification.requestPermission().catch(() => {})
                }
              }
            }
          : {})
      }
    )
    return
  }
  toast.warning(
    translate(
      'auto.lib.blocked.notification.fallback.de50bef680',
      'macOS is blocking Orca notifications'
    ),
    {
      description: translate(
        'auto.components.onboarding.mac.notification.permission.card.721d2bedb6',
        'Turn on Allow notifications for Orca in System Settings.'
      ),
      action: {
        label: translate(
          'auto.components.onboarding.NotificationStep.4f6a1da718',
          'Open System Settings'
        ),
        onClick: () => {
          void window.api.notifications.openSystemSettings()
        }
      }
    }
  )
}
