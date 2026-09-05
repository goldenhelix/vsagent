import { beforeEach, describe, expect, it, vi } from 'vitest'

const browserNotifications = vi.hoisted(() => ({
  armBrowserNotificationPermissionPrompt: vi.fn(),
  browserNotificationPermissionGranted: vi.fn(() => false),
  browserNotificationPermissionRequested: vi.fn(() => false),
  browserNotificationsSupported: vi.fn(() => false),
  isWebTabForeground: vi.fn(() => false),
  showBrowserNotification: vi.fn(() => true)
}))

vi.mock('./web-browser-notifications', () => browserNotifications)
vi.mock('./web-storage', () => ({ getBrowserPlatform: () => 'linux' }))

import { createNotificationsApi } from './web-notifications-api'

describe('web notifications API', () => {
  beforeEach(() => {
    browserNotifications.armBrowserNotificationPermissionPrompt.mockClear()
    browserNotifications.browserNotificationPermissionGranted.mockReset().mockReturnValue(false)
    browserNotifications.browserNotificationPermissionRequested.mockReset().mockReturnValue(false)
    browserNotifications.browserNotificationsSupported.mockReset().mockReturnValue(false)
    browserNotifications.isWebTabForeground.mockReset().mockReturnValue(false)
    browserNotifications.showBrowserNotification.mockReset().mockReturnValue(true)
    ;(globalThis as { Notification?: { permission: NotificationPermission } }).Notification = {
      permission: 'default'
    }
  })

  it('arms the browser permission prompt at factory time', () => {
    createNotificationsApi()

    expect(browserNotifications.armBrowserNotificationPermissionPrompt).toHaveBeenCalledTimes(1)
  })

  describe('dispatch', () => {
    it('reports not-supported when the browser has no Notification API', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(false)

      const result = await createNotificationsApi().dispatch({ source: 'terminal-bell' })

      expect(result).toEqual({ delivered: false, reason: 'not-supported' })
      expect(browserNotifications.showBrowserNotification).not.toHaveBeenCalled()
    })

    it('reports blocked-by-system when supported but permission is not granted', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(true)
      browserNotifications.browserNotificationPermissionGranted.mockReturnValue(false)

      const result = await createNotificationsApi().dispatch({ source: 'terminal-bell' })

      expect(result).toEqual({ delivered: false, reason: 'blocked-by-system' })
    })

    it('reports suppressed-focus when the tab is foregrounded', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(true)
      browserNotifications.browserNotificationPermissionGranted.mockReturnValue(true)
      browserNotifications.isWebTabForeground.mockReturnValue(true)

      const result = await createNotificationsApi().dispatch({ source: 'terminal-bell' })

      expect(result).toEqual({ delivered: false, reason: 'suppressed-focus' })
      expect(browserNotifications.showBrowserNotification).not.toHaveBeenCalled()
    })

    it('delivers through showBrowserNotification when every gate passes', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(true)
      browserNotifications.browserNotificationPermissionGranted.mockReturnValue(true)
      browserNotifications.isWebTabForeground.mockReturnValue(false)
      browserNotifications.showBrowserNotification.mockReturnValue(true)

      const args = { source: 'terminal-bell' as const }
      const result = await createNotificationsApi().dispatch(args)

      expect(browserNotifications.showBrowserNotification).toHaveBeenCalledWith(args)
      expect(result).toEqual({ delivered: true })
    })

    it('reports not-displayed when showBrowserNotification declines', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(true)
      browserNotifications.browserNotificationPermissionGranted.mockReturnValue(true)
      browserNotifications.isWebTabForeground.mockReturnValue(false)
      browserNotifications.showBrowserNotification.mockReturnValue(false)

      const result = await createNotificationsApi().dispatch({ source: 'terminal-bell' })

      expect(result).toEqual({ delivered: false, reason: 'not-displayed' })
    })
  })

  it('getPermissionStatus reflects support and request state', async () => {
    browserNotifications.browserNotificationsSupported.mockReturnValue(true)
    browserNotifications.browserNotificationPermissionRequested.mockReturnValue(true)

    const result = await createNotificationsApi().getPermissionStatus()

    expect(result).toEqual({ supported: true, platform: 'linux', requested: true })
  })

  describe('probeDelivery', () => {
    it('reports unsupported when the browser has no Notification API', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(false)

      const result = await createNotificationsApi().probeDelivery()

      expect(result).toEqual({ state: 'unsupported', authoritative: false })
    })

    it('reports delivered when permission is granted', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(true)
      ;(globalThis as unknown as { Notification: { permission: string } }).Notification = {
        permission: 'granted'
      }

      const result = await createNotificationsApi().probeDelivery()

      expect(result).toEqual({ state: 'delivered', authoritative: false })
    })

    it('reports blocked when permission is denied', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(true)
      ;(globalThis as unknown as { Notification: { permission: string } }).Notification = {
        permission: 'denied'
      }

      const result = await createNotificationsApi().probeDelivery()

      expect(result).toEqual({ state: 'blocked', authoritative: false })
    })

    it('reports awaiting-decision while permission is still default', async () => {
      browserNotifications.browserNotificationsSupported.mockReturnValue(true)
      ;(globalThis as unknown as { Notification: { permission: string } }).Notification = {
        permission: 'default'
      }

      const result = await createNotificationsApi().probeDelivery()

      expect(result).toEqual({ state: 'awaiting-decision', authoritative: false })
    })
  })

  it('playSound stays a no-op (no local audio pipeline in the web client)', async () => {
    const result = await createNotificationsApi().playSound()

    expect(result).toEqual({ played: false, reason: 'missing-path' })
  })

  it('dismiss and openSystemSettings remain inert stand-ins', async () => {
    const api = createNotificationsApi()

    await expect(api.dismiss(['id-1'])).resolves.toEqual({ dismissed: 0 })
    await expect(api.openSystemSettings()).resolves.toBeUndefined()
  })
})
