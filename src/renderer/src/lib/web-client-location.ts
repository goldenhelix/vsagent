export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    // Why: some non-browser hosts (test/node polyfills, SSR) define `window`
    // without a usable `location`; optional chaining keeps this false-safe.
    (window.location?.pathname?.endsWith('/web-index.html') ?? false)
  )
}
