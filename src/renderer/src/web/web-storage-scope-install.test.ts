// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installScopedWebStorage } from './web-storage-scope-install'

// Why a real Storage subclass, not window.localStorage: happy-dom's
// localStorage/sessionStorage are Proxy-backed and always resolve
// getItem/setItem/removeItem to their own native implementation regardless
// of what the prototype currently holds, so mutating Storage.prototype there
// is not observable through calls on the object (unlike a real browser,
// where Storage.prototype governs method dispatch normally). Stubbing the
// global `Storage` with this faithful, non-Proxied class lets `instanceof
// Storage` still route through the prototype-patch branch while making the
// mutation's effect observable, matching real-browser behavior.
class FakeRealStorage {
  private backing = new Map<string, string>()
  getItem(key: string): string | null {
    return this.backing.has(key) ? (this.backing.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.backing.set(key, value)
  }
  removeItem(key: string): void {
    this.backing.delete(key)
  }
}
const originalMethods = {
  getItem: FakeRealStorage.prototype.getItem,
  setItem: FakeRealStorage.prototype.setItem,
  removeItem: FakeRealStorage.prototype.removeItem
}

describe('installScopedWebStorage — real Storage-instance branch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeRealStorage.prototype.getItem = originalMethods.getItem
    FakeRealStorage.prototype.setItem = originalMethods.setItem
    FakeRealStorage.prototype.removeItem = originalMethods.removeItem
  })

  it('is inert when the scope is empty (root-path serve)', () => {
    vi.stubGlobal('Storage', FakeRealStorage)
    const storage = new FakeRealStorage()
    installScopedWebStorage(storage as unknown as Storage, '')
    storage.setItem('orca.web.settings.v1', 'value')
    expect(storage.getItem('orca.web.settings.v1')).toBe('value')
    expect(originalMethods.getItem.call(storage, 'orca.web.settings.v1')).toBe('value')
  })

  it('scopes every orca-prefixed key transparently for callers', () => {
    vi.stubGlobal('Storage', FakeRealStorage)
    const storage = new FakeRealStorage()
    installScopedWebStorage(storage as unknown as Storage, '/w/ws/app_instance/app_A')
    storage.setItem('orca.web.settings.v1', 'value')

    expect(storage.getItem('orca.web.settings.v1')).toBe('value')
    // The real backing store holds the SCOPED key, not the raw one.
    expect(originalMethods.getItem.call(storage, 'orca.web.settings.v1')).toBeNull()
    expect(
      originalMethods.getItem.call(storage, 'orca.web.settings.v1:/w/ws/app_instance/app_A')
    ).toBe('value')
  })

  it('scopes the two un-namespaced PetOverlay keys (C25/Q10)', () => {
    vi.stubGlobal('Storage', FakeRealStorage)
    const storage = new FakeRealStorage()
    installScopedWebStorage(storage as unknown as Storage, '/w/ws/app_instance/app_A')
    storage.setItem('pet-overlay-position', '{"x":1}')
    storage.setItem('sidekick-overlay-position', '{"x":2}')

    expect(storage.getItem('pet-overlay-position')).toBe('{"x":1}')
    expect(storage.getItem('sidekick-overlay-position')).toBe('{"x":2}')
    expect(
      originalMethods.getItem.call(storage, 'pet-overlay-position:/w/ws/app_instance/app_A')
    ).toBe('{"x":1}')
    expect(
      originalMethods.getItem.call(storage, 'sidekick-overlay-position:/w/ws/app_instance/app_A')
    ).toBe('{"x":2}')
  })

  it('leaves a non-orca, non-allowlisted key unscoped', () => {
    vi.stubGlobal('Storage', FakeRealStorage)
    const storage = new FakeRealStorage()
    installScopedWebStorage(storage as unknown as Storage, '/w/ws/app_instance/app_A')
    storage.setItem('some-other-key', 'value')

    expect(originalMethods.getItem.call(storage, 'some-other-key')).toBe('value')
  })

  it('removeItem is scoped the same way as getItem/setItem', () => {
    vi.stubGlobal('Storage', FakeRealStorage)
    const storage = new FakeRealStorage()
    installScopedWebStorage(storage as unknown as Storage, '/w/ws/app_instance/app_A')
    storage.setItem('orca.web.settings.v1', 'value')
    storage.removeItem('orca.web.settings.v1')

    expect(storage.getItem('orca.web.settings.v1')).toBeNull()
  })

  it('is gated on `this === storage`: another Storage instance is untouched', () => {
    // Why: sessionStorage shares Storage.prototype with localStorage in a
    // real browser (and `feature-wall-completion-persistence.ts` reads the
    // bare `localStorage` global rather than `window.localStorage` — same
    // object, different identifier). Scoping must key off object identity,
    // not the reference/variable used to reach it, and must not leak onto a
    // different Storage instance sharing the same prototype.
    vi.stubGlobal('Storage', FakeRealStorage)
    const scoped = new FakeRealStorage()
    const other = new FakeRealStorage()
    installScopedWebStorage(scoped as unknown as Storage, '/w/ws/app_instance/app_A')

    const bareAlias = scoped
    bareAlias.setItem('orca.web.settings.v1', 'via-alias')
    expect(
      originalMethods.getItem.call(scoped, 'orca.web.settings.v1:/w/ws/app_instance/app_A')
    ).toBe('via-alias')

    other.setItem('orca.other.v1', 'value')
    expect(originalMethods.getItem.call(other, 'orca.other.v1')).toBe('value')
  })
})

describe('installScopedWebStorage — plain-object storage branch', () => {
  function createStub(): Storage {
    const backing = new Map<string, string>()
    return {
      getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        backing.set(key, value)
      },
      removeItem: (key: string) => {
        backing.delete(key)
      }
    } as unknown as Storage
  }

  it('wraps instance methods directly for a non-Storage stub', () => {
    const stub = createStub()
    installScopedWebStorage(stub, '/w/ws/app_instance/app_A')
    stub.setItem('orca.web.settings.v1', 'value')
    expect(stub.getItem('orca.web.settings.v1')).toBe('value')
  })

  it('scopes the two un-namespaced PetOverlay keys (C25/Q10)', () => {
    const stub = createStub()
    installScopedWebStorage(stub, '/w/ws/app_instance/app_A')
    stub.setItem('pet-overlay-position', '{"x":1}')
    expect(stub.getItem('pet-overlay-position')).toBe('{"x":1}')
  })

  it('is inert when the scope is empty', () => {
    const stub = createStub()
    installScopedWebStorage(stub, '')
    stub.setItem('orca.web.settings.v1', 'value')
    expect(stub.getItem('orca.web.settings.v1')).toBe('value')
  })
})
