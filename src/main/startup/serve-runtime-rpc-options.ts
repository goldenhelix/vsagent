import type { OrcaRuntimeRpcServerOptions } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import type { ServeOptions } from './serve-options'

export type ServeRuntimeRpcOptions = Pick<
  OrcaRuntimeRpcServerOptions,
  | 'pinnedBindHost'
  | 'defaultPairingAddress'
  | 'serverDisplayName'
  | 'serveTls'
  | 'serveTlsCertPath'
  | 'serveTlsKeyPath'
>

/**
 * Translate `orca serve` flags into the runtime RPC server's transport options.
 *
 * Why a pin rather than leaving `exposeNetworkByDefault` to decide: `--serve-host` is the operator's
 * exact answer for the process's whole life, so it has to outrank both the serve-mode wide default
 * and the connected-device widen — and make `ensureNetworkExposure()` refuse instead of widening.
 */
export function buildServeRuntimeRpcOptions(
  serveOptions: ServeOptions | null
): ServeRuntimeRpcOptions {
  if (!serveOptions) {
    return {}
  }
  return {
    ...(serveOptions.bindHost ? { pinnedBindHost: serveOptions.bindHost } : {}),
    // Why: without it an offer minted after startup advertises 127.0.0.1 rather than the address the
    // serve was configured to be reached at.
    ...(serveOptions.pairingAddress ? { defaultPairingAddress: serveOptions.pairingAddress } : {}),
    ...(serveOptions.serverName ? { serverDisplayName: serveOptions.serverName } : {}),
    // Why gated on https: the certificate paths are read only while TLS is on, and
    // getServeOptionValidationError already refuses --cert/--key without --https.
    ...(serveOptions.https
      ? {
          serveTls: true,
          ...(serveOptions.tlsCertPath ? { serveTlsCertPath: serveOptions.tlsCertPath } : {}),
          ...(serveOptions.tlsKeyPath ? { serveTlsKeyPath: serveOptions.tlsKeyPath } : {})
        }
      : {})
  }
}
