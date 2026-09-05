import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function stubLocationSearch(search: string): void {
  vi.stubGlobal('window', { location: { search } } as unknown as Window & typeof globalThis)
}

describe('webE2EConfig', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('honours ?orcaExposeStore=1 with VITE_EXPOSE_STORE unset', async () => {
    stubLocationSearch('?orcaExposeStore=1')

    const { webE2EConfig } = await import('./web-e2e-config')

    expect(webE2EConfig.exposeStore).toBe(true)
  })

  it('stays off with neither the query flag nor the env var set', async () => {
    stubLocationSearch('')

    const { webE2EConfig } = await import('./web-e2e-config')

    expect(webE2EConfig.exposeStore).toBe(false)
  })

  it('still honours VITE_EXPOSE_STORE=true with no query string (regression)', async () => {
    vi.stubEnv('VITE_EXPOSE_STORE', 'true')
    stubLocationSearch('')

    const { webE2EConfig } = await import('./web-e2e-config')

    expect(webE2EConfig.exposeStore).toBe(true)
  })

  it('ignores an unrecognized orcaExposeStore value', async () => {
    stubLocationSearch('?orcaExposeStore=0')

    const { webE2EConfig } = await import('./web-e2e-config')

    expect(webE2EConfig.exposeStore).toBe(false)
  })

  it('reads terminal overrides from the query string once the store is exposed', async () => {
    stubLocationSearch(
      '?orcaExposeStore=1&orcaE2ETerminalParkingDelayMs=23&orcaE2ETerminalRetentionLimit=7'
    )

    const { webE2EConfig } = await import('./web-e2e-config')

    expect(webE2EConfig).toEqual({
      enabled: true,
      headless: false,
      exposeStore: true,
      userDataDir: null,
      terminalParkingDelayMs: 23,
      terminalRetentionLimit: 7
    })
  })
})
