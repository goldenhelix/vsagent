import { describe, expect, it } from 'vitest'
import { isWebClientLocation } from './web-client-location'

describe('isWebClientLocation', () => {
  it('returns false when window is undefined (non-browser host)', () => {
    expect(typeof window).toBe('undefined')
    expect(isWebClientLocation()).toBe(false)
  })

  it('returns false when window has no usable location (test/node polyfills, SSR)', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })

    try {
      expect(isWebClientLocation()).toBe(false)
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('returns true when __ORCA_WEB_CLIENT__ is set, even without a matching path', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __ORCA_WEB_CLIENT__: true, location: { pathname: '/other.html' } }
    })

    try {
      expect(isWebClientLocation()).toBe(true)
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('returns true when the location pathname ends with /web-index.html', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { pathname: '/some/nested/web-index.html' } }
    })

    try {
      expect(isWebClientLocation()).toBe(true)
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('returns false for a desktop-shaped path with no web-client marker', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { pathname: '/index.html' } }
    })

    try {
      expect(isWebClientLocation()).toBe(false)
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })
})
