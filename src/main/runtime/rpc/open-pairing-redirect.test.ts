import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  deriveEndpointFromRequest,
  handleOpenPairingRedirect,
  readOpenPairingConfig
} from './open-pairing-redirect'

function fakeReq(args: {
  url?: string
  method?: string
  headers?: Record<string, string>
  encrypted?: boolean
}): IncomingMessage {
  return {
    url: args.url ?? '/',
    method: args.method ?? 'GET',
    headers: args.headers ?? { host: 'devserver:6800' },
    socket: { encrypted: args.encrypted ?? false }
  } as unknown as IncomingMessage
}

function fakeRes(): ServerResponse & { headers: Record<string, string>; ended: boolean } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    ended: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value
    },
    end() {
      res.ended = true
    }
  }
  return res as unknown as ServerResponse & { headers: Record<string, string>; ended: boolean }
}

describe('readOpenPairingConfig', () => {
  it('is disabled by default', () => {
    expect(readOpenPairingConfig({}).enabled).toBe(false)
  })

  it('enables via ORCA_SERVE_OPEN_PAIRING=1', () => {
    expect(readOpenPairingConfig({ ORCA_SERVE_OPEN_PAIRING: '1' })).toEqual({
      enabled: true,
      headerSecret: null
    })
  })

  it('enables with a header secret', () => {
    expect(readOpenPairingConfig({ ORCA_SERVE_PAIRING_PROXY_SECRET: ' s3cret ' })).toEqual({
      enabled: true,
      headerSecret: 's3cret'
    })
  })
})

describe('deriveEndpointFromRequest', () => {
  it('uses the Host header with ws scheme', () => {
    expect(deriveEndpointFromRequest(fakeReq({ headers: { host: 'devserver:6800' } }))).toBe(
      'ws://devserver:6800'
    )
  })

  it('prefers X-Forwarded-Host and upgrades to wss behind https', () => {
    expect(
      deriveEndpointFromRequest(
        fakeReq({
          headers: {
            host: '127.0.0.1:6800',
            'x-forwarded-host': 'vsw.example.com',
            'x-forwarded-proto': 'https'
          }
        })
      )
    ).toBe('wss://vsw.example.com')
  })

  it('keeps a forwarded path prefix', () => {
    expect(
      deriveEndpointFromRequest(
        fakeReq({
          headers: {
            host: 'x',
            'x-forwarded-host': 'vsw.example.com',
            'x-forwarded-proto': 'https',
            'x-forwarded-prefix': '/agent'
          }
        })
      )
    ).toBe('wss://vsw.example.com/agent')
  })

  it('upgrades to wss on a direct HTTPS (encrypted) socket without a proxy header', () => {
    expect(
      deriveEndpointFromRequest(fakeReq({ headers: { host: '127.0.0.1:6801' }, encrypted: true }))
    ).toBe('wss://127.0.0.1:6801')
  })

  it('returns null without a host', () => {
    expect(deriveEndpointFromRequest(fakeReq({ headers: {} }))).toBeNull()
  })
})

describe('handleOpenPairingRedirect', () => {
  const enabled = { enabled: true, headerSecret: null }

  it('redirects GET / to the web client with the offer in the fragment', () => {
    const res = fakeRes()
    const handled = handleOpenPairingRedirect(fakeReq({}), res, enabled, () => 'orca://pair?code=x')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      `web-index.html#pairing=${encodeURIComponent('orca://pair?code=x')}`
    )
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.ended).toBe(true)
  })

  it('ignores non-root paths so web-index.html cannot redirect-loop', () => {
    const res = fakeRes()
    expect(
      handleOpenPairingRedirect(fakeReq({ url: '/web-index.html' }), res, enabled, () => 'o')
    ).toBe(false)
    expect(res.ended).toBe(false)
  })

  it('does nothing when disabled', () => {
    const res = fakeRes()
    expect(
      handleOpenPairingRedirect(fakeReq({}), res, { enabled: false, headerSecret: null }, () => 'o')
    ).toBe(false)
  })

  it('requires the proxy auth header when a secret is configured', () => {
    const config = { enabled: true, headerSecret: 's3cret' }
    const resDenied = fakeRes()
    expect(handleOpenPairingRedirect(fakeReq({}), resDenied, config, () => 'o')).toBe(false)

    const resAllowed = fakeRes()
    const handled = handleOpenPairingRedirect(
      fakeReq({ headers: { host: 'devserver:6800', 'x-vsagent-proxy-auth': 's3cret' } }),
      resAllowed,
      config,
      () => 'o'
    )
    expect(handled).toBe(true)
    expect(resAllowed.statusCode).toBe(302)
  })

  it('falls through when the runtime cannot mint an offer yet', () => {
    const res = fakeRes()
    expect(handleOpenPairingRedirect(fakeReq({}), res, enabled, () => null)).toBe(false)
    expect(res.ended).toBe(false)
  })

  it('ignores POST requests', () => {
    const res = fakeRes()
    expect(handleOpenPairingRedirect(fakeReq({ method: 'POST' }), res, enabled, () => 'o')).toBe(
      false
    )
  })
})
