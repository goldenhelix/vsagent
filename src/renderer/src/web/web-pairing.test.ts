import { describe, expect, it } from 'vitest'
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
})

describe('pairing offer server name', () => {
  const encode = (offer: object): string =>
    `orca://pair?code=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`

  it('decodes the optional server name from the offer', () => {
    const offer = parseWebPairingInput(
      encode({ v: 2, endpoint: 'ws://a:1', deviceToken: 't', publicKeyB64: 'k', name: 'rudy01' })
    )
    expect(offer?.name).toBe('rudy01')
  })

  it('ignores a missing/blank name and caps long names', () => {
    const noName = parseWebPairingInput(
      encode({ v: 2, endpoint: 'ws://a:1', deviceToken: 't', publicKeyB64: 'k' })
    )
    expect(noName?.name).toBeUndefined()
    const long = parseWebPairingInput(
      encode({
        v: 2,
        endpoint: 'ws://a:1',
        deviceToken: 't',
        publicKeyB64: 'k',
        name: 'x'.repeat(200)
      })
    )
    expect(long?.name).toHaveLength(64)
  })

  it('defaultWebEnvironmentName prefers offer name, then endpoint host', () => {
    const base: WebPairingOffer = {
      v: 2,
      endpoint: 'wss://dev-rudy01.ts.net:8445',
      deviceToken: 't',
      publicKeyB64: 'k'
    }
    expect(defaultWebEnvironmentName({ ...base, name: 'VSWarehouse' })).toBe('VSWarehouse')
    expect(defaultWebEnvironmentName(base)).toBe('dev-rudy01.ts.net')
    expect(defaultWebEnvironmentName({ ...base, endpoint: 'ws://127.0.0.1:6768' })).toBe(
      'VSAgent Server'
    )
  })
})
