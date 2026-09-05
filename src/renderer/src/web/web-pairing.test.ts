import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decideWebPairingStartup,
  defaultWebEnvironmentName,
  parseWebPairingInput,
  type WebPairingOffer
} from './web-pairing'

describe('web pairing input', () => {
  const offer: WebPairingOffer = {
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }

  function encodeOffer(overrides: Record<string, unknown> = {}) {
    return Buffer.from(JSON.stringify({ ...offer, ...overrides }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  it('parses query-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer()}`)).toEqual(offer)
  })

  it('still parses legacy hash-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair#${encodeOffer()}`)).toEqual(offer)
  })

  it('preserves optional device scope metadata', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ scope: 'mobile' })}`)).toEqual({
      ...offer,
      scope: 'mobile'
    })
  })

  it('preserves optional paired device identity', () => {
    expect(
      parseWebPairingInput(`orca://pair?code=${encodeOffer({ pairedDeviceId: 'paired-device-a' })}`)
    ).toEqual({
      ...offer,
      pairedDeviceId: 'paired-device-a'
    })
  })

  it.each([
    ['wss://proxy.example:443/orca/runtime', 'wss://proxy.example:443/orca/runtime'],
    ['https://proxy.example/orca/runtime', 'wss://proxy.example/orca/runtime'],
    ['http://proxy.example:8080/orca/runtime', 'ws://proxy.example:8080/orca/runtime']
  ])('preserves reverse-proxy endpoint routing for %s', (endpoint, expected) => {
    expect(parseWebPairingInput(encodeOffer({ endpoint }))).toMatchObject({ endpoint: expected })
  })

  it('treats invalid device scope metadata as unknown', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ scope: 'admin' })}`)).toEqual(
      offer
    )
  })

  it('rejects orca URLs outside the exact pairing route', () => {
    expect(parseWebPairingInput(`orca://pairing?code=${encodeOffer()}`)).toBeNull()
    expect(parseWebPairingInput(`orca://pair-extra?code=${encodeOffer()}`)).toBeNull()
  })

  it('auto-saves scoped runtime offers during web startup', () => {
    const input = `orca://pair?code=${encodeOffer({ scope: 'runtime' })}`
    expect(
      decideWebPairingStartup({ initialPairingInput: input, hasStoredEnvironment: false })
    ).toEqual({
      kind: 'auto-save-runtime-offer',
      offer: { ...offer, scope: 'runtime' }
    })
  })

  it('shows the connect screen for mobile-scope and legacy unknown-scope offers', () => {
    const mobileInput = `orca://pair?code=${encodeOffer({ scope: 'mobile' })}`
    const legacyInput = `orca://pair?code=${encodeOffer()}`

    expect(
      decideWebPairingStartup({ initialPairingInput: mobileInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: mobileInput })
    expect(
      decideWebPairingStartup({ initialPairingInput: legacyInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: legacyInput })
  })

  it('uses a stored environment when no fresh valid pairing offer is present', () => {
    expect(
      decideWebPairingStartup({ initialPairingInput: null, hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
    expect(
      decideWebPairingStartup({ initialPairingInput: 'not a code', hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
  })

  it('decodes the optional server display name', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ name: 'rudy01' })}`)).toEqual({
      ...offer,
      name: 'rudy01'
    })
  })

  it('drops a blank server name and caps an over-long one', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer()}`)?.name).toBeUndefined()
    expect(
      parseWebPairingInput(`orca://pair?code=${encodeOffer({ name: '   ' })}`)?.name
    ).toBeUndefined()
    expect(
      parseWebPairingInput(`orca://pair?code=${encodeOffer({ name: 42 })}`)?.name
    ).toBeUndefined()
    expect(
      parseWebPairingInput(`orca://pair?code=${encodeOffer({ name: 'x'.repeat(200) })}`)?.name
    ).toHaveLength(64)
  })
})

describe('defaultWebEnvironmentName', () => {
  const offer: WebPairingOffer = {
    v: 2,
    endpoint: 'wss://dev-rudy01.ts.net:8445',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers the offer name, then the endpoint hostname', () => {
    expect(defaultWebEnvironmentName({ ...offer, name: 'VSWarehouse' })).toBe('VSWarehouse')
    expect(defaultWebEnvironmentName(offer)).toBe('dev-rudy01.ts.net')
  })

  it('falls back to the generic label for loopback endpoints and no offer', () => {
    expect(defaultWebEnvironmentName({ ...offer, endpoint: 'ws://127.0.0.1:6768' })).toBe(
      'Orca Server'
    )
    expect(defaultWebEnvironmentName({ ...offer, endpoint: 'ws://localhost:6768' })).toBe(
      'Orca Server'
    )
    expect(defaultWebEnvironmentName({ ...offer, endpoint: 'not a url' })).toBe('Orca Server')
    expect(defaultWebEnvironmentName(null)).toBe('Orca Server')
  })

  it('brands the generic label through the web-mode i18n seam', () => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })

    expect(defaultWebEnvironmentName(null)).toBe('VSAgent Server')
    // Why: a server-supplied name is a real identity, never rebranded.
    expect(defaultWebEnvironmentName({ ...offer, name: 'Orca box' })).toBe('Orca box')
  })
})
