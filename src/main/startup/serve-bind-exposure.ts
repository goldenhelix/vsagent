import { isPairingWildcardHostname } from '../../shared/network/pairing-url'
import { bindHostIsNetworkExposed } from '../orcad/orcad-bind-address'

/**
 * One log line describing what `orca serve` actually bound, so an exposed deployment is never a
 * silent default. Mirrors orcad's `describeOrcadBindExposure`, with serve's own flag name — serve
 * defaults to every interface, where orcad defaults to loopback, so the advice is the inverse.
 */
export function describeServeBindExposure(bindHost: string): string {
  const host = bindHost.replace(/^\[|\]$/g, '')
  if (!bindHostIsNetworkExposed(host)) {
    return (
      `Bound to ${host}: local only. Reach it from another machine with an SSH local port-forward, ` +
      'or re-launch with a different --host to expose it.'
    )
  }
  const exposed =
    `Bound to ${host}: reachable from the network. Anything that can reach this port can attempt ` +
    'pairing.'
  // Why only for a wildcard: on a host the operator already chose with --host, telling them to pass
  // --host contradicts what they just asked for; the narrowing advice only fits the wide default.
  return isPairingWildcardHostname(host)
    ? `${exposed} Pass --host <address> to bind one interface instead.`
    : exposed
}
