import { beforeEach, describe, expect, it } from 'vitest'

// Why: the suite runs in the node environment; the module only needs
// window.localStorage, so stub a minimal in-memory implementation.
const storage = new Map<string, string>()
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear()
  },
  location: { protocol: 'https:' }
}
import {
  createStoredWebRuntimeEnvironment,
  getActiveStoredWebRuntimeEnvironment,
  listStoredWebRuntimeEnvironments,
  readWebRuntimeEnvironmentRegistry,
  removeStoredWebRuntimeEnvironment,
  setActiveStoredWebRuntimeEnvironmentId,
  upsertStoredWebRuntimeEnvironment
} from './web-runtime-environment'

function makeOffer(endpoint: string): {
  v: 2
  endpoint: string
  deviceToken: string
  publicKeyB64: string
} {
  return { v: 2, endpoint, deviceToken: `token-${endpoint}`, publicKeyB64: 'key' }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('web runtime environment registry', () => {
  it('migrates the v1 single slot into the registry once', () => {
    const legacy = createStoredWebRuntimeEnvironment({
      name: 'rudy01',
      offer: makeOffer('wss://a:8445')
    })
    window.localStorage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(legacy))

    const registry = readWebRuntimeEnvironmentRegistry()
    expect(registry.environments.map((entry) => entry.id)).toEqual([legacy.id])
    expect(registry.activeId).toBe(legacy.id)
    expect(window.localStorage.getItem('orca.web.runtimeEnvironment.v1')).toBeNull()
  })

  it('adding a second server never removes or deactivates the first', () => {
    const first = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'rudy01', offer: makeOffer('wss://a:8445') })
    )
    const second = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'rudy03', offer: makeOffer('wss://b:8445') })
    )
    expect(listStoredWebRuntimeEnvironments().map((entry) => entry.name)).toEqual([
      'rudy01',
      'rudy03'
    ])
    // First pairing stays active (primary); the add is not a switch.
    expect(getActiveStoredWebRuntimeEnvironment()?.id).toBe(first.id)
    expect(second.id).not.toBe(first.id)
  })

  it('re-pairing the same endpoint refreshes credentials in place (stable id)', () => {
    const original = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'rudy01', offer: makeOffer('wss://a:8445') })
    )
    const repaired = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'rudy01 again',
        offer: { ...makeOffer('wss://a:8445'), deviceToken: 'fresh-token' }
      })
    )
    expect(repaired.id).toBe(original.id)
    expect(listStoredWebRuntimeEnvironments()).toHaveLength(1)
    expect(repaired.endpoints[0]?.deviceToken).toBe('fresh-token')
  })

  it('moving the active pointer never touches stored pairings', () => {
    const first = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'a', offer: makeOffer('wss://a:1') })
    )
    const second = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'b', offer: makeOffer('wss://b:1') })
    )
    expect(setActiveStoredWebRuntimeEnvironmentId(second.id)).toBe(true)
    expect(getActiveStoredWebRuntimeEnvironment()?.id).toBe(second.id)
    expect(listStoredWebRuntimeEnvironments()).toHaveLength(2)
    expect(setActiveStoredWebRuntimeEnvironmentId('missing')).toBe(false)
    expect(getActiveStoredWebRuntimeEnvironment()?.id).toBe(second.id)
    expect(setActiveStoredWebRuntimeEnvironmentId(first.id)).toBe(true)
  })

  it('removing the active environment falls back to the next stored one', () => {
    const first = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'a', offer: makeOffer('wss://a:1') })
    )
    const second = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'b', offer: makeOffer('wss://b:1') })
    )
    removeStoredWebRuntimeEnvironment(first.id)
    expect(listStoredWebRuntimeEnvironments().map((entry) => entry.id)).toEqual([second.id])
    expect(getActiveStoredWebRuntimeEnvironment()?.id).toBe(second.id)
  })
})
