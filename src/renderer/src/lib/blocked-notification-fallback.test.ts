import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ warning: vi.fn() }))
const webClientState = vi.hoisted(() => ({ isWebClient: false }))

vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => webClientState.isWebClient
}))

async function importFresh() {
  vi.resetModules()
  return import('./blocked-notification-fallback')
}

describe('showBlockedNotificationFallbackToast', () => {
  beforeEach(() => {
    toast.warning.mockClear()
    webClientState.isWebClient = false
    vi.unstubAllGlobals()
  })

  it('points macOS users at System Settings on the desktop client', async () => {
    const openSystemSettings = vi.fn().mockResolvedValue(undefined)
    ;(
      globalThis as unknown as { window: { api: { notifications: { openSystemSettings: () => void } } } }
    ).window = { api: { notifications: { openSystemSettings } } }

    const { showBlockedNotificationFallbackToast } = await importFresh()
    showBlockedNotificationFallbackToast()

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, options] = toast.warning.mock.calls[0]
    expect(title).toBe('macOS is blocking Orca notifications')
    options.action.onClick()
    expect(openSystemSettings).toHaveBeenCalledTimes(1)
  })

  it('shows the browser-blocked copy with an Enable-notifications action when the prompt can still be asked', async () => {
    webClientState.isWebClient = true
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })

    const { showBlockedNotificationFallbackToast } = await importFresh()
    showBlockedNotificationFallbackToast()

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, options] = toast.warning.mock.calls[0]
    expect(title).toBe('Your browser is blocking notifications')
    expect(options.description).toBe('Allow notifications for this site to get agent alerts.')
    expect(options.action.label).toBe('Enable notifications')

    options.action.onClick()
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('drops the action once the browser permission has already been decided', async () => {
    webClientState.isWebClient = true
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() })

    const { showBlockedNotificationFallbackToast } = await importFresh()
    showBlockedNotificationFallbackToast()

    const [, options] = toast.warning.mock.calls[0]
    expect(options.description).toBe(
      'Re-enable notifications for this site in your browser settings.'
    )
    expect(options.action).toBeUndefined()
  })

  it('only shows once per session', async () => {
    const openSystemSettings = vi.fn().mockResolvedValue(undefined)
    ;(
      globalThis as unknown as { window: { api: { notifications: { openSystemSettings: () => void } } } }
    ).window = { api: { notifications: { openSystemSettings } } }

    const { showBlockedNotificationFallbackToast } = await importFresh()
    showBlockedNotificationFallbackToast()
    showBlockedNotificationFallbackToast()

    expect(toast.warning).toHaveBeenCalledTimes(1)
  })
})
