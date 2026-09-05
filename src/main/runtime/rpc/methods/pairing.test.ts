import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { PAIRING_METHODS } from './pairing'

function dispatchPairing(
  method: string,
  params: unknown,
  pairing: NonNullable<Parameters<RpcDispatcher['dispatchStreaming']>[2]>['pairing']
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: PAIRING_METHODS
    })
    void dispatcher.dispatchStreaming(
      { id: 'request-1', authToken: '', method, params },
      (response) => resolve(JSON.parse(response) as Record<string, unknown>),
      { pairing }
    )
  })
}

function dispatchCreateOffer(
  params: unknown,
  createRuntimePairingOffer?: NonNullable<
    Parameters<RpcDispatcher['dispatchStreaming']>[2]
  >['createRuntimePairingOffer']
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: PAIRING_METHODS
    })
    void dispatcher.dispatchStreaming(
      { id: 'request-1', authToken: '', method: 'pairing.createRuntimeOffer', params },
      (response) => resolve(JSON.parse(response) as Record<string, unknown>),
      createRuntimePairingOffer ? { createRuntimePairingOffer } : {}
    )
  })
}

describe('pairing.createRuntimeOffer', () => {
  it('forwards address/rotate to the offer provider and returns its result', async () => {
    const offer = {
      available: true as const,
      pairingUrl: 'orca://pair?code=abc',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'device-1',
      serverName: 'build-box',
      webClientUrl: 'http://100.64.1.20:6768/web-index.html#pairing=x'
    }
    const createRuntimePairingOffer = vi.fn().mockReturnValue(offer)

    await expect(
      dispatchCreateOffer({ address: '100.64.1.20', rotate: true }, createRuntimePairingOffer)
    ).resolves.toMatchObject({ ok: true, result: offer })
    expect(createRuntimePairingOffer).toHaveBeenCalledWith({ address: '100.64.1.20', rotate: true })
  })

  it('defaults address to null and rotate to false when omitted', async () => {
    const createRuntimePairingOffer = vi.fn().mockReturnValue({
      available: false,
      reason: 'websocket_unavailable',
      guidance: 'Start the server first.'
    })
    await dispatchCreateOffer({}, createRuntimePairingOffer)
    expect(createRuntimePairingOffer).toHaveBeenCalledWith({ address: null, rotate: false })
  })

  it('forwards a declared reach and rejects one the registry does not know', async () => {
    const createRuntimePairingOffer = vi.fn().mockReturnValue({
      available: false,
      reason: 'websocket_unavailable',
      guidance: 'Start the server first.'
    })
    await dispatchCreateOffer({ reach: 'this-computer' }, createRuntimePairingOffer)
    expect(createRuntimePairingOffer).toHaveBeenCalledWith({
      address: null,
      rotate: false,
      reach: 'this-computer'
    })

    await expect(
      dispatchCreateOffer({ reach: 'everywhere' }, createRuntimePairingOffer)
    ).resolves.toMatchObject({ ok: false })
    expect(createRuntimePairingOffer).toHaveBeenCalledTimes(1)
  })

  it('passes the structured unavailable branch through to the caller', async () => {
    const createRuntimePairingOffer = vi.fn().mockReturnValue({
      available: false,
      reason: 'invalid_advertised_endpoint',
      guidance: 'Pass --address with a routable host.'
    })
    await expect(
      dispatchCreateOffer({ address: '0.0.0.0' }, createRuntimePairingOffer)
    ).resolves.toMatchObject({
      ok: true,
      result: {
        available: false,
        reason: 'invalid_advertised_endpoint',
        guidance: 'Pass --address with a routable host.'
      }
    })
  })

  it('fails when the transport did not grant offer minting (mobile scope)', async () => {
    await expect(dispatchCreateOffer({}, undefined)).resolves.toMatchObject({
      ok: false,
      error: { message: 'pairing_offer_unavailable' }
    })
  })
})

describe('pairing RPC methods', () => {
  it('passes only phone-owned credential material to the server-bound provider', async () => {
    const provisionRelay = vi.fn().mockResolvedValue({
      v: 1,
      reqId: 'install-1',
      authorizationMode: 'authenticated-direct',
      currentVersion: 1,
      resumeExpiresAt: Date.now() + 60_000
    })
    const pairing = { getEndpoints: vi.fn(), provisionRelay }

    await expect(
      dispatchPairing(
        'pairing.provisionRelay',
        { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43) },
        pairing
      )
    ).resolves.toMatchObject({ ok: true })
    expect(provisionRelay).toHaveBeenCalledWith({
      reqId: 'install-1',
      newResumeTokenHash: 'A'.repeat(43)
    })
  })

  it('rejects caller-selected identity and authorization metadata', async () => {
    const pairing = { getEndpoints: vi.fn(), provisionRelay: vi.fn() }

    for (const injected of [
      { relayDeviceId: 'attacker-device' },
      { authorization: { mode: 'relay-basis', basisConnId: 'attacker-basis' } },
      { directAuthId: 'attacker-direct' },
      { acceptedCredentialVersion: 99 }
    ]) {
      await expect(
        dispatchPairing(
          'pairing.provisionRelay',
          { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43), ...injected },
          pairing
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    await expect(
      dispatchPairing(
        'pairing.getEndpoints',
        { installReqId: 'status-1', basisConnId: 'injected' },
        pairing
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(pairing.provisionRelay).not.toHaveBeenCalled()
    expect(pairing.getEndpoints).not.toHaveBeenCalled()
  })
})
