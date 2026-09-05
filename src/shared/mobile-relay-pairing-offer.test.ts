import { describe, expect, it } from 'vitest'
import { boundedPairingOfferName, createPairingOfferSchema } from './mobile-relay-pairing-offer'
import { createMobileRelayPairingFixtures } from './mobile-relay-pairing-fixtures'
import { encodePairingOffer, parsePairingCode } from './pairing'

describe('desktop mobile-relay pairing contract', () => {
  const now = Date.UTC(2026, 6, 12, 16)
  const schema = createPairingOfferSchema(() => now)

  for (const fixture of createMobileRelayPairingFixtures(now)) {
    it(fixture.name, () => {
      const result = schema.safeParse(fixture.payload)
      expect(result.success ? result.data : null).toEqual(fixture.expected)
    })
  }

  it('preserves optional paired device identity', () => {
    const fixture = createMobileRelayPairingFixtures(now)[0]!
    if (!fixture.expected) {
      throw new Error('Expected a valid direct pairing fixture')
    }
    const payload = { ...fixture.expected, pairedDeviceId: 'paired-device-a' }

    expect(schema.parse(payload)).toMatchObject({ pairedDeviceId: 'paired-device-a' })
  })

  it('preserves an optional server display name and rejects an over-long one', () => {
    const fixture = createMobileRelayPairingFixtures(now)[0]!
    if (!fixture.expected) {
      throw new Error('Expected a valid direct pairing fixture')
    }

    expect(schema.parse({ ...fixture.expected, name: 'rudy01' })).toMatchObject({ name: 'rudy01' })
    expect(schema.safeParse({ ...fixture.expected, name: '' }).success).toBe(false)
    expect(schema.safeParse({ ...fixture.expected, name: 'x'.repeat(65) }).success).toBe(false)
  })
})

describe('boundedPairingOfferName', () => {
  it('caps, trims, and drops blank names', () => {
    expect(boundedPairingOfferName('x'.repeat(200))).toHaveLength(64)
    expect(boundedPairingOfferName('  build-box  ')).toBe('build-box')
    expect(boundedPairingOfferName('   ')).toBeUndefined()
    expect(boundedPairingOfferName(null)).toBeUndefined()
    expect(boundedPairingOfferName(undefined)).toBeUndefined()
  })

  // Why: encodePairingOffer runs the schema, which throws past 64 chars — the
  // producer bound is what keeps a long --serve-name from breaking pairing.
  it('keeps a 200-character name encodable and round-trippable', () => {
    const name = boundedPairingOfferName('x'.repeat(200))
    const url = encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      scope: 'runtime',
      ...(name ? { name } : {})
    })

    expect(parsePairingCode(url)?.name).toBe('x'.repeat(64))
  })
})
