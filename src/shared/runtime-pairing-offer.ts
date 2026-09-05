// Why: a runtime pairing offer mints a per-device grant that lets another Orca client (the CLI's
// `environment add`, a browser web client, or the desktop app) reach this runtime over the E2EE
// WebSocket. The shapes live in shared/ because three layers speak them — the RPC method in
// src/main, the `pairing-url` command in src/cli, and the web client — and src/cli must never
// import src/main.
import type { MobileRelayMintFailure } from './mobile-relay-mint-failure'
import type { RuntimePairingReach } from './runtime-pairing-reach'

export type RuntimePairingOfferParams = {
  /** Host/URL advertised in the pairing endpoint. Falls back to the serve's configured pairing address. */
  address?: string | null
  /** Mint a fresh device token instead of reusing the pending one. */
  rotate?: boolean
  // Why: STA-2370 — the grant records the reach the caller declared, and a "This computer only" grant is
  // excluded from the next launch's wide rebind. Omitted means network reach, which is what `pairing-url`
  // and every other minting caller means.
  reach?: RuntimePairingReach
}

export type PairingOfferUnavailableReason =
  | 'websocket_unavailable'
  | 'device_registry_unavailable'
  | 'e2ee_key_unavailable'
  | 'invalid_advertised_endpoint'
  | 'relay_mint_failed'
  | 'network_exposure_failed'

export type PairingOfferUnavailable = {
  available: false
  reason: PairingOfferUnavailableReason
  // Why: the operator-facing recovery step; `orca serve` and the pairing UI both print it verbatim
  // rather than mapping the reason code themselves.
  guidance: string
  /** Present when an Anywhere mint refused to silently fall back to LAN-only. */
  relayFailure?: MobileRelayMintFailure
}

export type RuntimePairingOfferAvailable = {
  available: true
  pairingUrl: string
  endpoint: string
  deviceId: string
  webClientUrl: string | null
  /** Server display name (`--serve-name` / the host's hostname) so a client can label this server. */
  serverName: string | null
}

export type RuntimePairingOfferResult = PairingOfferUnavailable | RuntimePairingOfferAvailable
