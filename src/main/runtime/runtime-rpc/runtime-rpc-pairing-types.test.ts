import { describe, expect, it } from 'vitest'
import { httpOriginFromWsEndpoint } from './runtime-rpc-pairing-types'

describe('httpOriginFromWsEndpoint', () => {
  it('maps ws:// to http://', () => {
    expect(httpOriginFromWsEndpoint('ws://127.0.0.1:6768')).toBe('http://127.0.0.1:6768')
  })

  it('maps wss:// to https://', () => {
    expect(httpOriginFromWsEndpoint('wss://serve.example:443')).toBe('https://serve.example:443')
  })

  it('preserves a bracketed IPv6 host', () => {
    expect(httpOriginFromWsEndpoint('wss://[::1]:6768')).toBe('https://[::1]:6768')
  })
})
