import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WebPairingOffer } from './web-pairing'
import {
  readWebRuntimeEnvironments,
  saveWebRuntimeEnvironments
} from './web-runtime-environment-registry'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'

export type StoredWebRuntimeEnvironment = Omit<PublicKnownRuntimeEnvironment, 'endpoints'> & {
  compatibleEnvironmentIds?: string[]
  // Why: 'origin' = paired from this page's own pairing fragment (the serving
  // app itself), 'manual' = deliberately added via Add Server. Origin pairings
  // of an ephemeral deployment are prunable lineage; manual ones must survive.
  pairedVia?: 'origin' | 'manual'
  endpoints: {
    id: string
    kind: 'websocket'
    label: string
    endpoint: string
    deviceToken: string
    publicKeyB64: string
  }[]
}

export function createStoredWebRuntimeEnvironment(args: {
  name: string
  offer: WebPairingOffer
  previousEnvironment?: StoredWebRuntimeEnvironment | null
  connectionDependency?: 'ssh-tunnel'
  pairedVia?: 'origin' | 'manual'
}): StoredWebRuntimeEnvironment {
  const id = `web-${createBrowserUuid()}`
  const now = Date.now()
  const compatibleEnvironmentIds = getCompatibleEnvironmentIds(args.previousEnvironment, args.offer)
  return {
    id,
    name: args.name.trim() || 'Orca Server',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    runtimeId: null,
    ...(args.pairedVia ? { pairedVia: args.pairedVia } : {}),
    ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}),
    ...(args.connectionDependency ? { connectionDependency: args.connectionDependency } : {}),
    ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {}),
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: translate('auto.web.web.runtime.environment.07f788de83', 'WebSocket'),
        endpoint: args.offer.endpoint,
        deviceToken: args.offer.deviceToken,
        publicKeyB64: args.offer.publicKeyB64
      }
    ]
  }
}

function getCompatibleEnvironmentIds(
  previous: StoredWebRuntimeEnvironment | null | undefined,
  offer: WebPairingOffer
): string[] {
  if (!previous?.endpoints.some((endpoint) => endpoint.publicKeyB64 === offer.publicKeyB64)) {
    return []
  }
  return [...new Set([...(previous.compatibleEnvironmentIds ?? []), previous.id])]
}

export function redactStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  const {
    compatibleEnvironmentIds: _compatibleEnvironmentIds,
    pairedVia: _pairedVia,
    ...publicEnvironment
  } = environment
  return {
    ...publicEnvironment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _token, publicKeyB64: _key, ...rest }) => ({
        ...rest
      })
    )
  }
}

export function getPreferredWebPairingOffer(
  environment: StoredWebRuntimeEnvironment
): WebPairingOffer {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error('No runtime endpoint is stored for this web client.')
  }
  return {
    v: 2,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
  }
}

export function updateStoredEnvironmentRuntimeId(
  environment: StoredWebRuntimeEnvironment,
  runtimeId: string | null,
  pairedDeviceId?: string
): StoredWebRuntimeEnvironment {
  const next = {
    ...environment,
    runtimeId,
    ...(pairedDeviceId ? { pairedDeviceId } : {}),
    updatedAt: Date.now(),
    lastUsedAt: Date.now()
  }
  const environments = readWebRuntimeEnvironments()
  // Why: a response that lands after its server was removed must not resurrect the pairing.
  if (!environments.some((entry) => entry.id === environment.id)) {
    return next
  }
  saveWebRuntimeEnvironments(
    environments.map((entry) => (entry.id === environment.id ? next : entry))
  )
  return next
}

export function isMixedContentWebSocket(endpoint: string): boolean {
  return window.location.protocol === 'https:' && endpoint.startsWith('ws://')
}
