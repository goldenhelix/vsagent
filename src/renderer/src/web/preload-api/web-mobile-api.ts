import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimePairingOfferResult } from '../../../../shared/runtime-pairing-offer'
import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'
import { callRuntimeResult } from './web-runtime-calls'
import { webRuntimeState } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'

type PreloadRuntimePairingUrl = Awaited<
  ReturnType<NonNullable<PreloadApi['mobile']>['getRuntimePairingUrl']>
>

// Why: "Share this Orca server" is the same offer the CLI's `pairing-url` mints, so a browser client
// asks its host for one over RPC instead of the desktop-only IPC channel. A host too old to know the
// method (or one that refuses a non-runtime-scope caller) reports unavailable rather than throwing.
async function requestRuntimePairingOffer(args?: {
  address?: string
  rotate?: boolean
  reach?: RuntimePairingReach
}): Promise<PreloadRuntimePairingUrl> {
  let offer: RuntimePairingOfferResult
  try {
    offer = await callRuntimeResult<RuntimePairingOfferResult>('pairing.createRuntimeOffer', {
      address: args?.address ?? null,
      rotate: args?.rotate ?? false,
      // Why: STA-2370 — the declared reach is the whole difference between "This computer only" and a
      // grant that republishes the runtime on every interface, so it must not be dropped at this hop.
      ...(args?.reach ? { reach: args.reach } : {})
    })
  } catch {
    return { available: false }
  }
  if (!offer.available) {
    // Why narrowed: the preload contract only names the network-exposure reason; the guidance string
    // is what the UI actually shows, and it survives every reason.
    return offer.reason === 'network_exposure_failed'
      ? { available: false, reason: offer.reason, guidance: offer.guidance }
      : { available: false, guidance: offer.guidance }
  }
  return offer
}

export function createWebMobileApi(): Partial<PreloadApi> {
  return {
    mobile: {
      listNetworkInterfaces: () => Promise.resolve({ interfaces: [] }),
      getPairingQR: () => Promise.resolve({ available: false }),
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      getRuntimePairingUrl: requestRuntimePairingOffer,
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: () =>
        Promise.resolve({ ready: Boolean(webRuntimeState.activeEnvironment), endpoint: null }),
      getRelayStatus: () => Promise.resolve({ status: 'offline' as const }),
      onRelayStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
