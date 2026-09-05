// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'

type MockNotificationInstance = {
  title: string
  options: NotificationOptions
  onclick: (() => void) | null
  close: () => void
}

class MockNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>(() =>
    Promise.resolve('granted')
  )
  static instances: MockNotificationInstance[] = []

  onclick: (() => void) | null = null
  close = vi.fn()

  constructor(
    public title: string,
    public options: NotificationOptions = {}
  ) {
    MockNotification.instances.push(this as unknown as MockNotificationInstance)
  }
}

function installMockNotification(permission: NotificationPermission = 'default'): void {
  MockNotification.permission = permission
  MockNotification.instances = []
  MockNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', MockNotification)
}

async function importModule() {
  vi.resetModules()
  return import('./web-browser-notifications')
}

describe('web-browser-notifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('browserNotificationsSupported', () => {
    it('is false when Notification is not defined', async () => {
      vi.unstubAllGlobals()
      const mod = await importModule()
      expect(mod.browserNotificationsSupported()).toBe(false)
    })

    it('is true once Notification is defined', async () => {
      installMockNotification()
      const mod = await importModule()
      expect(mod.browserNotificationsSupported()).toBe(true)
    })
  })

  describe('browserNotificationPermissionGranted / Requested', () => {
    it('reports granted only when the browser permission is granted', async () => {
      installMockNotification('granted')
      const mod = await importModule()
      expect(mod.browserNotificationPermissionGranted()).toBe(true)
      expect(mod.browserNotificationPermissionRequested()).toBe(true)
    })

    it('reports not-requested while permission is still default', async () => {
      installMockNotification('default')
      const mod = await importModule()
      expect(mod.browserNotificationPermissionGranted()).toBe(false)
      expect(mod.browserNotificationPermissionRequested()).toBe(false)
    })

    it('reports requested-but-not-granted when denied', async () => {
      installMockNotification('denied')
      const mod = await importModule()
      expect(mod.browserNotificationPermissionGranted()).toBe(false)
      expect(mod.browserNotificationPermissionRequested()).toBe(true)
    })
  })

  describe('armBrowserNotificationPermissionPrompt', () => {
    it('requests permission on the first pointerdown once armed', async () => {
      installMockNotification('default')
      const mod = await importModule()
      mod.armBrowserNotificationPermissionPrompt()

      window.dispatchEvent(new Event('pointerdown'))

      expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1)
    })

    it('is a no-op once the user already decided', async () => {
      installMockNotification('granted')
      const mod = await importModule()
      mod.armBrowserNotificationPermissionPrompt()

      window.dispatchEvent(new Event('pointerdown'))

      expect(MockNotification.requestPermission).not.toHaveBeenCalled()
    })

    it('only arms the listener once per module lifetime', async () => {
      installMockNotification('default')
      const mod = await importModule()
      mod.armBrowserNotificationPermissionPrompt()
      mod.armBrowserNotificationPermissionPrompt()

      window.dispatchEvent(new Event('pointerdown'))
      window.dispatchEvent(new Event('pointerdown'))

      expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1)
    })
  })

  describe('isWebTabForeground', () => {
    it('is true when the document is visible and focused', async () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible'
      })
      const mod = await importModule()
      expect(mod.isWebTabForeground()).toBe(true)
    })

    it('is false when the tab is hidden', async () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      const mod = await importModule()
      expect(mod.isWebTabForeground()).toBe(false)
    })
  })

  describe('showBrowserNotification', () => {
    const baseArgs: NotificationDispatchRequest = {
      source: 'terminal-bell',
      worktreeId: 'worktree-1',
      worktreeLabel: 'my-worktree',
      repoLabel: 'my-repo'
    }

    beforeEach(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible'
      })
    })

    it('returns false without constructing a Notification when permission is not granted', async () => {
      installMockNotification('default')
      const mod = await importModule()

      expect(mod.showBrowserNotification(baseArgs)).toBe(false)
      expect(MockNotification.instances).toHaveLength(0)
    })

    it('shows a tagged, non-silent Notification when permission is granted', async () => {
      installMockNotification('granted')
      const mod = await importModule()

      const result = mod.showBrowserNotification(baseArgs)

      expect(result).toBe(true)
      expect(MockNotification.instances).toHaveLength(1)
      const [instance] = MockNotification.instances
      expect(instance.title).toBe('Bell in my-worktree')
      expect(instance.options).toMatchObject({
        body: 'my-repo · Attention requested',
        tag: 'worktree-1',
        silent: false
      })
    })

    it('focuses the window and closes the toast on click', async () => {
      installMockNotification('granted')
      const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {})
      const mod = await importModule()

      mod.showBrowserNotification(baseArgs)
      const [instance] = MockNotification.instances
      instance.onclick?.()

      expect(focusSpy).toHaveBeenCalledTimes(1)
      expect(instance.close).toHaveBeenCalledTimes(1)
    })
  })
})
