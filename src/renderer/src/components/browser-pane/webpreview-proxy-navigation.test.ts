// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deriveOriginFromInput,
  derivePathFromInput,
  navigateProxyIframe
} from './webpreview-proxy-navigation'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('navigateProxyIframe', () => {
  it('assigns the typed src when it differs from the current attribute', () => {
    const ifr = document.createElement('iframe')
    ifr.setAttribute('src', 'https://gateway.example:6768/__orca/webpreview/s1/old')
    navigateProxyIframe(ifr, 'https://gateway.example:6768/__orca/webpreview/s1/new')
    expect(ifr.getAttribute('src')).toBe('https://gateway.example:6768/__orca/webpreview/s1/new')
  })

  it('force-reloads via about:blank when the src attribute already matches', () => {
    // Why: covers the "type the same URL / SPA-wandered page" case where a bare
    // .src assignment to an unchanged value would not re-fetch.
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    const ifr = document.createElement('iframe')
    const target = 'https://gateway.example:6768/__orca/webpreview/s1/page'
    ifr.setAttribute('src', target)

    navigateProxyIframe(ifr, target)
    expect(ifr.getAttribute('src')).toBe('about:blank')

    rafCallbacks.forEach((cb) => cb(0))
    expect(ifr.getAttribute('src')).toBe(target)
  })

  it('is a no-op for a null iframe', () => {
    expect(() => navigateProxyIframe(null, '/whatever')).not.toThrow()
  })
})

describe('input derivation stays origin/path-consistent', () => {
  it('splits a full URL into origin and path', () => {
    expect(deriveOriginFromInput('https://www.goldenhelix.com/platform/x?a=1')).toBe(
      'https://www.goldenhelix.com'
    )
    expect(derivePathFromInput('https://www.goldenhelix.com/platform/x?a=1')).toBe(
      '/platform/x?a=1'
    )
  })

  it('defaults a bare host to http and root path', () => {
    expect(deriveOriginFromInput('localhost:8080')).toBe('http://localhost:8080')
    expect(derivePathFromInput('localhost:8080')).toBe('/')
  })
})
