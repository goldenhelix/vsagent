import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from './web-preload-api-test-harness'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import {
  findWebRuntimeEnvironmentByOfferKey,
  pruneStaleOriginPairings,
  readActiveStoredWebRuntimeEnvironment,
  readActiveWebRuntimeEnvironmentId,
  readWebRuntimeEnvironments,
  removeStoredWebRuntimeEnvironment,
  saveWebRuntimeEnvironments,
  upsertStoredWebRuntimeEnvironment,
  writeActiveWebRuntimeEnvironmentId
} from './web-runtime-environment-registry'

const REGISTRY_KEY = 'orca.web.runtimeEnvironments.v2'
const LEGACY_KEY = 'orca.web.runtimeEnvironment.v1'
const SETTINGS_KEY = 'orca.web.settings.v1'

function environment(
  id: string,
  overrides: Partial<StoredWebRuntimeEnvironment> = {},
  endpoint = 'wss://server-a.example:443',
  publicKeyB64 = `${id}-key`
): StoredWebRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint,
        deviceToken: `${id}-token`,
        publicKeyB64
      }
    ],
    ...overrides
  }
}

describe('web runtime environment registry', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage } as unknown as Window & typeof globalThis)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('migrates the legacy single slot exactly once and then forgets it', () => {
    storage.setItem(LEGACY_KEY, JSON.stringify(environment('web-legacy')))

    expect(readWebRuntimeEnvironments()).toMatchObject([{ id: 'web-legacy' }])
    expect(storage.getItem(LEGACY_KEY)).toBeNull()

    removeStoredWebRuntimeEnvironment('web-legacy')
    expect(readWebRuntimeEnvironments()).toEqual([])
  })

  it('drops malformed persisted fields while migrating', () => {
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        ...environment('web-legacy'),
        compatibleEnvironmentIds: { old: 'web-old' },
        pairedDeviceId: { invalid: true },
        pairedVia: 'somewhere-else'
      })
    )

    const [migrated] = readWebRuntimeEnvironments()
    expect(migrated).not.toHaveProperty('compatibleEnvironmentIds')
    expect(migrated).not.toHaveProperty('pairedDeviceId')
    expect(migrated).not.toHaveProperty('pairedVia')
  })

  it('reports no paired servers for an unreadable legacy slot', () => {
    storage.setItem(LEGACY_KEY, '{not json')
    expect(readWebRuntimeEnvironments()).toEqual([])
    expect(storage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('adds a differently keyed server without evicting the paired ones', () => {
    saveWebRuntimeEnvironments([environment('web-a')])

    upsertStoredWebRuntimeEnvironment(environment('web-b', {}, 'wss://server-b.example:443'))

    expect(readWebRuntimeEnvironments().map((entry) => entry.id)).toEqual(['web-a', 'web-b'])
  })

  it('replaces the predecessor a re-pair supersedes and keeps its slot order', () => {
    saveWebRuntimeEnvironments([
      environment('web-a'),
      environment('web-b', {}, 'wss://server-b.example:443')
    ])

    upsertStoredWebRuntimeEnvironment(
      environment('web-a2', { compatibleEnvironmentIds: ['web-a'] })
    )

    expect(readWebRuntimeEnvironments().map((entry) => entry.id)).toEqual(['web-a2', 'web-b'])
  })

  it('moves the Active Server pointer onto the entry that superseded it', () => {
    saveWebRuntimeEnvironments([environment('web-a')])
    writeActiveWebRuntimeEnvironmentId('web-a')

    upsertStoredWebRuntimeEnvironment(
      environment('web-a2', { compatibleEnvironmentIds: ['web-a'] })
    )

    expect(readActiveWebRuntimeEnvironmentId()).toBe('web-a2')
  })

  it('leaves an explicit Active Server pointer alone when another server is added', () => {
    saveWebRuntimeEnvironments([environment('web-a')])
    writeActiveWebRuntimeEnvironmentId('web-a')

    upsertStoredWebRuntimeEnvironment(environment('web-b', {}, 'wss://server-b.example:443'))

    expect(readActiveWebRuntimeEnvironmentId()).toBe('web-a')
    expect(readActiveStoredWebRuntimeEnvironment()?.id).toBe('web-a')
  })

  it('preserves unrelated settings when moving the Active Server pointer', () => {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ terminalFontSize: 15 }))

    writeActiveWebRuntimeEnvironmentId('web-a')

    expect(JSON.parse(storage.getItem(SETTINGS_KEY) ?? '{}')).toEqual({
      terminalFontSize: 15,
      activeRuntimeEnvironmentId: 'web-a'
    })
  })

  it('falls back to the first paired server when the pointer is unset or stale', () => {
    saveWebRuntimeEnvironments([environment('web-a'), environment('web-b')])
    expect(readActiveStoredWebRuntimeEnvironment()?.id).toBe('web-a')

    writeActiveWebRuntimeEnvironmentId('web-gone')
    expect(readActiveStoredWebRuntimeEnvironment()?.id).toBe('web-a')
  })

  it('hands the pointer to a survivor when the active server is removed', () => {
    saveWebRuntimeEnvironments([environment('web-a'), environment('web-b')])
    writeActiveWebRuntimeEnvironmentId('web-a')

    removeStoredWebRuntimeEnvironment('web-a')

    expect(readActiveWebRuntimeEnvironmentId()).toBe('web-b')
    expect(readWebRuntimeEnvironments().map((entry) => entry.id)).toEqual(['web-b'])
  })

  it('finds the predecessor to re-pair by server key, not by endpoint', () => {
    saveWebRuntimeEnvironments([
      environment('web-a', {}, 'wss://server-a.example:443', 'shared-key')
    ])

    expect(findWebRuntimeEnvironmentByOfferKey('shared-key')?.id).toBe('web-a')
    expect(findWebRuntimeEnvironmentByOfferKey('other-key')).toBeNull()
  })

  it('prunes dead same-host origin pairings and keeps manual ones', () => {
    saveWebRuntimeEnvironments([
      environment('web-dead', { pairedVia: 'origin' }, 'wss://app.example:443'),
      environment('web-manual', { pairedVia: 'manual' }, 'wss://app.example:443'),
      environment('web-other-host', { pairedVia: 'origin' }, 'wss://other.example:443'),
      environment('web-live', { pairedVia: 'origin' }, 'wss://app.example:443')
    ])
    writeActiveWebRuntimeEnvironmentId('web-dead')

    expect(pruneStaleOriginPairings('web-live')).toEqual(['web-dead'])
    expect(readWebRuntimeEnvironments().map((entry) => entry.id)).toEqual([
      'web-manual',
      'web-other-host',
      'web-live'
    ])
    expect(readActiveWebRuntimeEnvironmentId()).toBe('web-live')
  })

  it('prunes nothing when the kept pairing is unknown or has no endpoint host', () => {
    saveWebRuntimeEnvironments([
      environment('web-dead', { pairedVia: 'origin' }, 'not-a-url'),
      environment('web-live', { pairedVia: 'origin' }, 'not-a-url')
    ])

    expect(pruneStaleOriginPairings('web-missing')).toEqual([])
    expect(pruneStaleOriginPairings('web-live')).toEqual([])
    expect(readWebRuntimeEnvironments()).toHaveLength(2)
  })

  it('reports no paired servers when the registry blob is corrupt and no legacy slot survives', () => {
    storage.setItem(REGISTRY_KEY, '{not json')
    expect(readWebRuntimeEnvironments()).toEqual([])
  })
})
