// Why (VSAgent fork): one origin can host many independent VSAgent apps under
// sub-URL routes (workspace proxy: /w/<ws>/app_instance/<id>/web-index.html),
// but localStorage is origin-scoped — unscoped keys made those apps share
// pairings/settings (a front-end in one workspace connected to every
// workspace's backend). Rather than scoping each key at its call site (and
// re-leaking on every new upstream key), transparently rewrite EVERY
// `orca*`-prefixed key at the storage boundary. Root-path serves have no
// scope, so the patch is inert there and legacy keys stay untouched.
import { getWebClientStorageScope } from './web-storage-scope'

const SCOPED_KEY_PREFIX = 'orca'
// Why: these two PetOverlay keys don't follow the `orca*` naming convention
// but are still per-app-instance renderer state, so they need the same scope.
const ADDITIONAL_SCOPED_KEYS = new Set(['pet-overlay-position', 'sidekick-overlay-position'])

export function installScopedWebStorage(
  storage: Storage = window.localStorage,
  scope: string = getWebClientStorageScope()
): void {
  if (!scope) {
    return
  }
  const map = (key: string): string =>
    key.startsWith(SCOPED_KEY_PREFIX) || ADDITIONAL_SCOPED_KEYS.has(key)
      ? `${key}:${scope}`
      : key

  if (typeof Storage !== 'undefined' && storage instanceof Storage) {
    // Why: real Storage objects turn instance property definitions into
    // stored items (the named-setter trap), so patch the PROTOTYPE, gated to
    // this instance — sessionStorage and other Storage objects are untouched.
    const proto = Object.getPrototypeOf(storage) as Storage
    const original = {
      getItem: proto.getItem,
      setItem: proto.setItem,
      removeItem: proto.removeItem
    }
    proto.getItem = function (key: string) {
      return original.getItem.call(this, this === storage ? map(key) : key)
    }
    proto.setItem = function (key: string, value: string) {
      original.setItem.call(this, this === storage ? map(key) : key, value)
    }
    proto.removeItem = function (key: string) {
      original.removeItem.call(this, this === storage ? map(key) : key)
    }
    return
  }
  // Plain-object storage (tests, non-browser stubs): wrap instance methods.
  const original = {
    getItem: storage.getItem.bind(storage),
    setItem: storage.setItem.bind(storage),
    removeItem: storage.removeItem.bind(storage)
  }
  storage.getItem = (key: string) => original.getItem(map(key))
  storage.setItem = (key: string, value: string) => original.setItem(map(key), value)
  storage.removeItem = (key: string) => original.removeItem(map(key))
}
