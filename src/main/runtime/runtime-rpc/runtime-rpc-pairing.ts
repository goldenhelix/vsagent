import type { DeviceEntry, DeviceRegistry, DeviceScope } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import type {
  RelayDeviceBinding,
  RelayRevokeOutbox,
  RelayRevokeOutboxItem
} from '../relay/relay-revoke-outbox'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import { boundedPairingOfferName } from '../../../shared/mobile-relay-pairing-offer'
import type { RuntimePairingReach } from '../../../shared/runtime-pairing-reach'
import type {
  RuntimePairingOfferParams,
  RuntimePairingOfferResult
} from '../../../shared/runtime-pairing-offer'
import { resolveAdvertisedPairingEndpoint } from '../pairing-endpoint'
import { RuntimeRpcNetworkExposure } from './runtime-rpc-network-exposure'
import {
  createWebClientUrl,
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  E2EE_KEY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  SHARED_ACCESS_DEVICE_NAME,
  type MobileRelayPairingProvider
} from './runtime-rpc-pairing-types'

export class RuntimeRpcPairing extends RuntimeRpcNetworkExposure {
  // Why: publishes this mixin's minting ability to the dispatch layers above it (see RuntimeRpcState).
  // Always runtime scope — the callers that receive it already hold a runtime-scope credential.
  protected override mintRuntimePairingOffer = (
    args: RuntimePairingOfferParams
  ): RuntimePairingOfferResult =>
    this.createPairingOffer({
      address: args.address,
      rotate: args.rotate,
      scope: 'runtime',
      // Why: STA-2370 — a caller that declined off-host reach must not have that choice dropped on the
      // way in, or its grant re-publishes the runtime on every interface one restart later.
      ...(args.reach ? { reach: args.reach } : {})
    })

  // Why (VSAgent fork): the trusted-proxy redirect is served by the lifecycle mixin below this one,
  // so the minting ability is published the same way `mintRuntimePairingOffer` is.
  protected override mintSharedAccessPairingUrl = (endpoint: string): string | null =>
    this.createSharedAccessPairingUrl(endpoint)

  getDeviceRegistry(): DeviceRegistry | null {
    return this.deviceRegistry
  }

  getTlsFingerprint(): string | null {
    return this.tlsFingerprint
  }

  getE2EEPublicKey(): string | null {
    return this.e2eeKeypair?.publicKeyB64 ?? null
  }

  getE2EEKeypair(): E2EEKeypair | null {
    return this.e2eeKeypair
  }

  getMobileSocketWiring(): MobileSocketWiring | null {
    return this.mobileSocketWiring
  }

  getRelayRevokeOutbox(): RelayRevokeOutbox {
    return this.relayRevokeOutbox
  }

  setMobileRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    const current = this.deviceRegistry?.getDevice(deviceId)
    if (
      current?.scope !== 'mobile' ||
      this.deviceRegistry?.getMobilePairingConnectionMode(deviceId) === 'local-only'
    ) {
      return false
    }
    if (
      current.relayBinding &&
      (current.relayBinding.relayHostId !== binding.relayHostId ||
        current.relayBinding.ownerIdentityKey !== binding.ownerIdentityKey)
    ) {
      // Why: switching the owning account/host must not strand the old cloud credential family, even if that account is offline.
      if (!this.queueRelayDeviceRevoke(current.relayBinding)) {
        return false
      }
    }
    const updated = this.deviceRegistry?.setRelayBinding(deviceId, binding) ?? false
    if (updated) {
      this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    }
    return updated
  }

  // Why: only the desktop shell can surface UI; headless serve leaves this unset.
  setOnUnpairedDeviceAuthFailure(callback: (() => void) | null): void {
    this.onUnpairedDeviceAuthFailure = callback
  }

  setMobileRelayPairingProvider(provider: MobileRelayPairingProvider | null): void {
    this.mobileRelayPairingProvider = provider
  }

  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'mobile') {
      return false
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return false
      }
    }
    if (!this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  revokeRuntimeAccess(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'runtime' || !this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  getWebSocketEndpoint(): string | null {
    const ws = this.transports.find((t) => t.kind === 'websocket')
    return ws?.endpoint ?? null
  }

  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: DeviceScope
    // Why: STA-2370 — recorded on the grant so a "This computer only" client reconnecting cannot make the
    // next launch bind every interface. Defaults to network reach, which is what every other caller means.
    reach?: RuntimePairingReach
  }): RuntimePairingOfferResult {
    if (this.pairingInitializationFailure) {
      return this.pairingInitializationFailure
    }
    const rawEndpoint = this.getWebSocketEndpoint()
    if (!rawEndpoint) {
      return pairingUnavailable(
        'websocket_unavailable',
        'WebSocket pairing is unavailable. Inspect preceding runtime errors and choose an unused --port if the listener failed.'
      )
    }
    if (!this.deviceRegistry) {
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!publicKeyB64) {
      return pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
    }

    // Why: an offer minted after startup (`orca pairing-url`, the web client's Share button) carries no
    // address of its own; without the serve's configured one it would advertise an unreachable 127.0.0.1.
    // Blank counts as absent — a caller with nothing to advertise sends '' (an empty picker), not null.
    const advertised = resolveAdvertisedPairingEndpoint(
      rawEndpoint,
      args.address?.trim() ? args.address : this.defaultPairingAddress
    )
    if (!advertised.ok) {
      return pairingUnavailable(advertised.reason, advertised.guidance)
    }
    const endpoint = advertised.endpoint
    const deviceName = args.name ?? `CLI ${new Date().toLocaleDateString()}`
    const scope = args.scope ?? 'runtime'
    let device: DeviceEntry
    try {
      const reach = args.reach ?? 'network'
      device = args.rotate
        ? this.deviceRegistry.rotatePendingDevice(deviceName, scope, reach)
        : this.deviceRegistry.getOrCreatePendingDevice(deviceName, scope, reach)
    } catch (error) {
      console.error('[runtime] Failed to persist pairing credential:', error)
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    // Why (VSAgent fork): `--serve-name` / hostname rides along so a paired web
    // client can label the server without asking the operator to retype it.
    const serverName = boundedPairingOfferName(this.serverDisplayName)
    const pairingUrl = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: device.token,
      publicKeyB64,
      pairedDeviceId: device.deviceId,
      ...(serverName ? { name: serverName } : {}),
      scope
    })
    return {
      available: true,
      pairingUrl,
      endpoint,
      deviceId: device.deviceId,
      serverName: serverName ?? null,
      webClientUrl:
        this.webClientRoot && scope === 'runtime' ? createWebClientUrl(endpoint, pairingUrl) : null
    }
  }

  // Why (VSAgent fork): trusted-reverse-proxy deployments redirect `GET /` to the web client with a
  // pairing offer baked in. Every visitor shares ONE persistent device so the registry does not gain
  // an entry per page load and the operator has a single revocation unit; the endpoint comes from the
  // proxied request, so the same serve works through any hostname that reaches it.
  // SECURITY: this hands a full runtime-scope credential to anyone who can reach `GET /`. Only the
  // header-secret mode (ORCA_SERVE_PAIRING_PROXY_SECRET) is safe on a shared network.
  createSharedAccessPairingUrl(endpoint: string): string | null {
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!this.deviceRegistry || !publicKeyB64 || !this.getWebSocketEndpoint()) {
      return null
    }
    try {
      // Why synchronous end to end: concurrent `GET /` requests cannot interleave between the lookup
      // and the mint, so the shared entry stays unique without a lock.
      const device =
        this.deviceRegistry
          .listDevices()
          .find((entry) => entry.scope === 'runtime' && entry.name === SHARED_ACCESS_DEVICE_NAME) ??
        // Why 'network' explicitly: STA-2370 counts it at the next launch, so the listener stays wide
        // for a trusted-proxy deployment even if `--serve-host` is later dropped. That is the intent
        // here — the proxy, not the bind host, is the access boundary.
        this.deviceRegistry.addDevice(SHARED_ACCESS_DEVICE_NAME, 'runtime', 'network')
      const serverName = boundedPairingOfferName(this.serverDisplayName)
      return encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken: device.token,
        publicKeyB64,
        pairedDeviceId: device.deviceId,
        ...(serverName ? { name: serverName } : {}),
        scope: 'runtime'
      })
    } catch (error) {
      // Why: the endpoint is attacker-influenced (Host / X-Forwarded-*), so a registry write failure or
      // a rejected offer must fall through to the static handler rather than 502 the whole page load.
      console.error('[runtime] Failed to mint the shared web-access pairing offer:', error)
      return null
    }
  }

  protected queueOrRetainRelayDeviceRevoke(deviceId: string, binding: RelayDeviceBinding): void {
    if (this.queueRelayDeviceRevoke(binding)) {
      return
    }
    try {
      this.deviceRegistry?.setRelayBinding(deviceId, binding)
    } catch (error) {
      console.error('[runtime] Failed to retain an unrevoked Relay binding:', error)
    }
  }

  protected queueRelayDeviceRevoke(binding: RelayDeviceBinding): boolean {
    let item: RelayRevokeOutboxItem
    try {
      item = this.relayRevokeOutbox.enqueue(binding)
    } catch (error) {
      console.error('[runtime] Failed to persist Relay device cleanup:', error)
      return false
    }
    try {
      this.mobileRelayPairingProvider?.onDeviceRevokeQueued(item)
    } catch (error) {
      console.warn('[runtime] Failed to notify Relay cleanup worker:', error)
    }
    return true
  }
}
