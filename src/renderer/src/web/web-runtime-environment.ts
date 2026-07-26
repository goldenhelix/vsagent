import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WebPairingOffer } from './web-pairing'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'

export type StoredWebRuntimeEnvironment = Omit<PublicKnownRuntimeEnvironment, 'endpoints'> & {
  endpoints: {
    id: string
    kind: 'websocket'
    label: string
    endpoint: string
    deviceToken: string
    publicKeyB64: string
  }[]
  // Why: 'origin' = paired from the page's own pairing fragment/redirect (the
  // serving app itself); 'manual' = deliberately added via Add Server.
  // Origin pairings from ephemeral app instances are prunable lineage; manual
  // pairings must survive re-pairs. Absent on pre-v0.6.10 entries.
  pairedVia?: 'origin' | 'manual'
}

// Why (VSAgent fork): the web client stores a REGISTRY of paired servers plus
// an active ("primary") pointer, so one browser can hold projects from several
// servers at once. activeId is a focus pointer only — moving or clearing it
// must never destroy a stored pairing (the v1 single-slot model destroyed the
// previous server's device token on every switch/add).
export type WebRuntimeEnvironmentRegistry = {
  environments: StoredWebRuntimeEnvironment[]
  activeId: string | null
}

// Why: `orca*` keys are transparently scoped per app namespace/path at the
// storage boundary (web-storage-scope-install.ts), so a scoped app never sees
// another app's registry — including the legacy v1 slot, which resolves to a
// scoped name that never existed and therefore migrates nothing there.
const LEGACY_ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'
const REGISTRY_STORAGE_KEY = 'orca.web.runtimeEnvironments.v2'

function parseStoredEnvironment(raw: string): StoredWebRuntimeEnvironment | null {
  try {
    const parsed = JSON.parse(raw) as StoredWebRuntimeEnvironment
    if (!parsed.id || !parsed.name || parsed.endpoints.length === 0) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function readWebRuntimeEnvironmentRegistry(): WebRuntimeEnvironmentRegistry {
  const raw = window.localStorage.getItem(REGISTRY_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WebRuntimeEnvironmentRegistry
      const environments = (parsed.environments ?? []).filter(
        (entry) => entry?.id && entry.name && entry.endpoints?.length > 0
      )
      const activeId = environments.some((entry) => entry.id === parsed.activeId)
        ? parsed.activeId
        : (environments[0]?.id ?? null)
      return { environments, activeId }
    } catch {
      // fall through to the legacy slot
    }
  }
  // One-time migration from the v1 single-slot schema.
  const legacyRaw = window.localStorage.getItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
  const legacy = legacyRaw ? parseStoredEnvironment(legacyRaw) : null
  if (legacy) {
    const registry: WebRuntimeEnvironmentRegistry = {
      environments: [legacy],
      activeId: legacy.id
    }
    saveWebRuntimeEnvironmentRegistry(registry)
    window.localStorage.removeItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
    return registry
  }
  return { environments: [], activeId: null }
}

export function saveWebRuntimeEnvironmentRegistry(registry: WebRuntimeEnvironmentRegistry): void {
  window.localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(registry))
}

export function listStoredWebRuntimeEnvironments(): StoredWebRuntimeEnvironment[] {
  return readWebRuntimeEnvironmentRegistry().environments
}

export function getActiveStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  const registry = readWebRuntimeEnvironmentRegistry()
  return registry.environments.find((entry) => entry.id === registry.activeId) ?? null
}

/** Move the active ("primary") pointer. Never touches stored pairings. */
export function setActiveStoredWebRuntimeEnvironmentId(id: string): boolean {
  const registry = readWebRuntimeEnvironmentRegistry()
  if (!registry.environments.some((entry) => entry.id === id)) {
    return false
  }
  saveWebRuntimeEnvironmentRegistry({ ...registry, activeId: id })
  return true
}

/**
 * Insert or refresh a pairing. When an environment for the same endpoint
 * already exists, its credentials are refreshed IN PLACE (same environment
 * id), so persisted terminal/tab ids survive a re-pair of the same server.
 */
export function upsertStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment,
  options: { makeActive?: boolean } = {}
): StoredWebRuntimeEnvironment {
  const registry = readWebRuntimeEnvironmentRegistry()
  const endpoint = environment.endpoints[0]?.endpoint
  const existing = registry.environments.find(
    (entry) =>
      entry.id === environment.id ||
      (endpoint !== undefined && entry.endpoints.some((e) => e.endpoint === endpoint))
  )
  let stored = environment
  if (existing) {
    stored = {
      ...existing,
      name: environment.name,
      pairedVia: environment.pairedVia ?? existing.pairedVia,
      runtimeId: environment.runtimeId ?? existing.runtimeId,
      updatedAt: Date.now(),
      preferredEndpointId: existing.preferredEndpointId,
      endpoints: existing.endpoints.map((entry) => {
        const replacement = environment.endpoints.find((e) => e.endpoint === entry.endpoint)
        return replacement ? { ...replacement, id: entry.id } : entry
      })
    }
  }
  const environments = existing
    ? registry.environments.map((entry) => (entry.id === existing.id ? stored : entry))
    : [...registry.environments, stored]
  const makeActive = options.makeActive === true || registry.activeId === null
  saveWebRuntimeEnvironmentRegistry({
    environments,
    activeId: makeActive ? stored.id : registry.activeId
  })
  return stored
}

/**
 * Prune stale lineage after an origin (page-fragment) pairing: ephemeral app
 * deployments mint a NEW backend per rebuild, so earlier origin pairings for
 * the same endpoint host are dead instances of the same app. Removes stored
 * environments that share the kept pairing's endpoint host (hostname:port)
 * unless they were added manually (Add Server), and returns the removed ids
 * so the caller can clean their per-environment session keys.
 */
export function pruneStaleOriginPairings(keepId: string): string[] {
  const registry = readWebRuntimeEnvironmentRegistry()
  const keep = registry.environments.find((entry) => entry.id === keepId)
  const keepHost = keep ? endpointHost(keep) : null
  if (!keep || !keepHost) {
    return []
  }
  const removedIds: string[] = []
  const environments = registry.environments.filter((entry) => {
    if (entry.id === keepId || entry.pairedVia === 'manual') {
      return true
    }
    if (endpointHost(entry) !== keepHost) {
      return true
    }
    removedIds.push(entry.id)
    return false
  })
  if (removedIds.length === 0) {
    return []
  }
  saveWebRuntimeEnvironmentRegistry({
    environments,
    activeId: environments.some((entry) => entry.id === registry.activeId)
      ? registry.activeId
      : keepId
  })
  return removedIds
}

function endpointHost(environment: StoredWebRuntimeEnvironment): string | null {
  const endpoint = environment.endpoints[0]?.endpoint
  if (!endpoint) {
    return null
  }
  try {
    return new URL(endpoint).host
  } catch {
    return null
  }
}

/** Remove a pairing entirely (destroys the stored device token). */
export function removeStoredWebRuntimeEnvironment(id: string): void {
  const registry = readWebRuntimeEnvironmentRegistry()
  const environments = registry.environments.filter((entry) => entry.id !== id)
  saveWebRuntimeEnvironmentRegistry({
    environments,
    activeId: registry.activeId === id ? (environments[0]?.id ?? null) : registry.activeId
  })
}

export function createStoredWebRuntimeEnvironment(args: {
  name: string
  offer: WebPairingOffer
  pairedVia?: 'origin' | 'manual'
}): StoredWebRuntimeEnvironment {
  const id = `web-${createBrowserUuid()}`
  const now = Date.now()
  return {
    id,
    ...(args.pairedVia ? { pairedVia: args.pairedVia } : {}),
    name: args.name.trim() || 'Orca Server',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    runtimeId: null,
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

export function redactStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  return {
    ...environment,
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
    publicKeyB64: endpoint.publicKeyB64
  }
}

export function updateStoredEnvironmentRuntimeId(
  environment: StoredWebRuntimeEnvironment,
  runtimeId: string | null
): StoredWebRuntimeEnvironment {
  const registry = readWebRuntimeEnvironmentRegistry()
  const stored = registry.environments.find((entry) => entry.id === environment.id)
  const next = {
    ...(stored ?? environment),
    runtimeId,
    updatedAt: Date.now(),
    lastUsedAt: Date.now()
  }
  saveWebRuntimeEnvironmentRegistry({
    ...registry,
    environments: stored
      ? registry.environments.map((entry) => (entry.id === environment.id ? next : entry))
      : [...registry.environments, next]
  })
  return next
}

export function isMixedContentWebSocket(endpoint: string): boolean {
  return window.location.protocol === 'https:' && endpoint.startsWith('ws://')
}
