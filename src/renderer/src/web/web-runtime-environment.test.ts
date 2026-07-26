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
  location: { protocol: 'https:', pathname: '/web-index.html' }
}
import { installScopedWebStorage } from './web-storage-scope-install'
import {
  createStoredWebRuntimeEnvironment,
  pruneStaleOriginPairings,
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

function makeScopedStorageView(shared: Map<string, string>, scope: string): Storage {
  const view = {
    getItem: (key: string) => shared.get(key) ?? null,
    setItem: (key: string, value: string) => void shared.set(key, value),
    removeItem: (key: string) => void shared.delete(key),
    clear: () => shared.clear()
  } as unknown as Storage
  installScopedWebStorage(view, scope)
  return view
}

describe('web runtime environment registry', () => {
  it('isolates registries between namespaced apps sharing one origin store', () => {
    const win = (globalThis as { window: { localStorage: Storage } }).window
    const shared = new Map<string, string>()
    // Workspace A's page: storage boundary scoped to its namespace
    win.localStorage = makeScopedStorageView(shared, 'data_curation')
    upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'ws-a', offer: makeOffer('wss://a:1') })
    )
    // Workspace B's page over the SAME underlying origin storage
    win.localStorage = makeScopedStorageView(shared, 'test_automation')
    expect(listStoredWebRuntimeEnvironments()).toEqual([])
    upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({ name: 'ws-b', offer: makeOffer('wss://b:1') })
    )
    expect(listStoredWebRuntimeEnvironments().map((e) => e.name)).toEqual(['ws-b'])
    // Back on workspace A's page
    win.localStorage = makeScopedStorageView(shared, 'data_curation')
    expect(listStoredWebRuntimeEnvironments().map((e) => e.name)).toEqual(['ws-a'])
    // Restore the plain unscoped stub for the remaining tests
    win.localStorage = makeScopedStorageView(new Map(), '')
  })

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

describe('pruneStaleOriginPairings', () => {
  it('removes dead same-host origin pairings from earlier app instances', () => {
    // Rebuild lineage: same host, different app_instance paths.
    const old1 = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'VSAgent',
        offer: makeOffer('wss://nightly.example.com/w/hg19/app_instance/app_OLD1'),
        pairedVia: 'origin'
      })
    )
    const old2 = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'VSAgent',
        offer: makeOffer('wss://nightly.example.com/w/hg19/app_instance/app_OLD2'),
        pairedVia: 'origin'
      })
    )
    const fresh = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'VSAgent',
        offer: makeOffer('wss://nightly.example.com/w/hg19/app_instance/app_NEW'),
        pairedVia: 'origin'
      }),
      { makeActive: true }
    )
    const removed = pruneStaleOriginPairings(fresh.id)
    expect(removed.sort()).toEqual([old1.id, old2.id].sort())
    expect(listStoredWebRuntimeEnvironments().map((e) => e.id)).toEqual([fresh.id])
    expect(getActiveStoredWebRuntimeEnvironment()?.id).toBe(fresh.id)
  })

  it('keeps manually added servers, even on the same host', () => {
    const manual = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'server2',
        offer: makeOffer('wss://nightly.example.com/w/other/app_instance/app_X'),
        pairedVia: 'manual'
      })
    )
    const fresh = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'VSAgent',
        offer: makeOffer('wss://nightly.example.com/w/hg19/app_instance/app_NEW'),
        pairedVia: 'origin'
      })
    )
    expect(pruneStaleOriginPairings(fresh.id)).toEqual([])
    expect(
      listStoredWebRuntimeEnvironments()
        .map((e) => e.id)
        .sort()
    ).toEqual([manual.id, fresh.id].sort())
  })

  it('keeps cross-host servers regardless of provenance (legacy entries)', () => {
    const rudy02 = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'rudy02',
        offer: makeOffer('wss://dev-rudy02.ts.net:8445')
      })
    )
    const fresh = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'rudy01',
        offer: makeOffer('wss://dev-rudy01.ts.net:8445'),
        pairedVia: 'origin'
      })
    )
    expect(pruneStaleOriginPairings(fresh.id)).toEqual([])
    expect(listStoredWebRuntimeEnvironments()).toHaveLength(2)
    void rudy02
  })

  it('distinguishes ports on the same hostname', () => {
    const otherPort = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'srv-6801',
        offer: makeOffer('ws://devserver:6801')
      })
    )
    const fresh = upsertStoredWebRuntimeEnvironment(
      createStoredWebRuntimeEnvironment({
        name: 'srv-6800',
        offer: makeOffer('ws://devserver:6800'),
        pairedVia: 'origin'
      })
    )
    expect(pruneStaleOriginPairings(fresh.id)).toEqual([])
    expect(listStoredWebRuntimeEnvironments()).toHaveLength(2)
    void otherPort
  })
})
