// Why (VSAgent fork): localStorage is ORIGIN-scoped, but one origin can host
// many independent VSAgent apps under sub-URL routes (e.g. a workspace proxy
// serving /w/<ws>/app_instance/<id>/web-index.html per workspace). Unscoped
// keys made those apps share pairings/settings — a front-end in one workspace
// connected to every workspace's backend. The scope is:
//   1. an explicit namespace injected by the serve (--serve-storage-namespace /
//      VSAGENT_STORAGE_NAMESPACE), stable across app-instance restarts; else
//   2. the app's base URL path (zero-config isolation); else
//   3. '' for root-path serves — legacy unscoped keys, nothing migrates.

type NamespacedWindow = { __VSAGENT_STORAGE_NAMESPACE__?: string }

export function getWebClientStorageScope(
  // Why: tolerate partial window stubs (tests, non-browser contexts).
  pathname: string = (typeof window !== 'undefined' && window.location?.pathname) || '/'
): string {
  const explicit =
    typeof window !== 'undefined'
      ? (window as unknown as NamespacedWindow).__VSAGENT_STORAGE_NAMESPACE__?.trim()
      : undefined
  if (explicit) {
    return explicit
  }
  const base = pathname.replace(/\/web-index\.html$/, '').replace(/\/+$/, '')
  return base === '' ? '' : base
}

export function scopeWebStorageKey(key: string, pathname?: string): string {
  const scope = getWebClientStorageScope(pathname)
  return scope ? `${key}:${scope}` : key
}
