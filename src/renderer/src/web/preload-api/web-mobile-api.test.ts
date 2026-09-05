// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

import { createWebMobileApi } from './web-mobile-api'

function getRuntimePairingUrl(): NonNullable<
  ReturnType<typeof createWebMobileApi>['mobile']
>['getRuntimePairingUrl'] {
  return createWebMobileApi().mobile!.getRuntimePairingUrl
}

describe('web client "Share this Orca server"', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })

  it('mints the offer through the runtime RPC the CLI also uses', async () => {
    const offer = {
      available: true,
      pairingUrl: 'orca://pair?code=abc',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'device-1',
      serverName: 'build-box',
      webClientUrl: 'https://100.64.1.20:6768/web-index.html#pairing=abc'
    }
    callRuntimeResult.mockResolvedValue(offer)

    await expect(
      getRuntimePairingUrl()({ address: '100.64.1.20', rotate: true })
    ).resolves.toMatchObject(offer)
    expect(callRuntimeResult).toHaveBeenCalledWith('pairing.createRuntimeOffer', {
      address: '100.64.1.20',
      rotate: true
    })
  })

  // Why: STA-2370 — the Settings generator's "This computer only" pick travels as `reach`; dropping it
  // here would mint a network grant that rebinds every interface on the host's next launch.
  it('forwards the declared reach to the host', async () => {
    callRuntimeResult.mockResolvedValue({ available: false, reason: 'e2ee_key_unavailable', guidance: 'x' })

    await getRuntimePairingUrl()({ address: '127.0.0.1', reach: 'this-computer' })

    expect(callRuntimeResult).toHaveBeenCalledWith('pairing.createRuntimeOffer', {
      address: '127.0.0.1',
      rotate: false,
      reach: 'this-computer'
    })
  })

  it('defaults address and rotate when the caller passes no arguments', async () => {
    callRuntimeResult.mockResolvedValue({ available: false, reason: 'e2ee_key_unavailable', guidance: 'x' })

    await getRuntimePairingUrl()()

    expect(callRuntimeResult).toHaveBeenCalledWith('pairing.createRuntimeOffer', {
      address: null,
      rotate: false
    })
  })

  it('keeps the operator guidance but drops a reason the desktop contract does not name', async () => {
    callRuntimeResult.mockResolvedValue({
      available: false,
      reason: 'invalid_advertised_endpoint',
      guidance: 'Pass a routable host.'
    })

    await expect(getRuntimePairingUrl()()).resolves.toEqual({
      available: false,
      guidance: 'Pass a routable host.'
    })
  })

  it('passes the network-exposure reason through unchanged', async () => {
    callRuntimeResult.mockResolvedValue({
      available: false,
      reason: 'network_exposure_failed',
      guidance: 'The listener could not widen.'
    })

    await expect(getRuntimePairingUrl()()).resolves.toEqual({
      available: false,
      reason: 'network_exposure_failed',
      guidance: 'The listener could not widen.'
    })
  })

  it('reports unavailable instead of throwing when the host does not know the method', async () => {
    callRuntimeResult.mockRejectedValue(
      Object.assign(new Error('Unknown method: pairing.createRuntimeOffer'), {
        code: 'method_not_found'
      })
    )

    await expect(getRuntimePairingUrl()()).resolves.toEqual({ available: false })
  })
})
