// Why: a runtime pairing offer mints a fresh per-device grant that lets another
// VSAgent (CLI `environment add`, web client, or mobile) connect to this
// runtime over the E2EE WebSocket. Shared between the RPC method, the CLI
// `pairing-url` command, and the web-client generator.

export type RuntimePairingOfferParams = {
  /** Host/URL advertised in the pairing endpoint. Falls back to the serve
   *  pairing address, else 127.0.0.1. */
  address?: string | null
  /** Mint a new device token instead of reusing the pending one. */
  rotate?: boolean
}

export type RuntimePairingOfferResult =
  | { available: false }
  | {
      available: true
      pairingUrl: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
    }
