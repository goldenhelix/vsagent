import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import { SETTINGS_STORAGE_KEY } from './preload-api/web-storage'

// Why (VSAgent): the browser client keeps a REGISTRY of paired servers so one
// tab can hold projects from several at once. Focus is NOT stored here — it is
// `settings.activeRuntimeEnvironmentId`, so moving or clearing focus can never
// destroy a stored device token the way the v1 single slot did.
const REGISTRY_STORAGE_KEY = 'orca.web.runtimeEnvironments.v2'
// Why: `orca*` keys are scoped per app namespace at the storage boundary
// (web-storage-scope-install.ts), so a scoped deployment resolves a legacy slot
// name that never existed there and therefore migrates nothing.
const LEGACY_ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'

function sanitizeStoredEnvironment(value: unknown): StoredWebRuntimeEnvironment | null {
  const parsed = value as StoredWebRuntimeEnvironment | null
  if (
    !parsed?.id ||
    !parsed.name ||
    !Array.isArray(parsed.endpoints) ||
    parsed.endpoints.length === 0
  ) {
    return null
  }
  const compatibleEnvironmentIds = Array.isArray(parsed.compatibleEnvironmentIds)
    ? parsed.compatibleEnvironmentIds.filter(
        (environmentId): environmentId is string => typeof environmentId === 'string'
      )
    : []
  const pairedDeviceId =
    typeof parsed.pairedDeviceId === 'string' && parsed.pairedDeviceId.trim().length > 0
      ? parsed.pairedDeviceId.trim()
      : null
  const pairedVia =
    parsed.pairedVia === 'origin' || parsed.pairedVia === 'manual' ? parsed.pairedVia : null
  const {
    compatibleEnvironmentIds: _unvalidatedIds,
    pairedDeviceId: _unvalidatedDeviceId,
    pairedVia: _unvalidatedPairedVia,
    ...environment
  } = parsed
  return {
    ...environment,
    ...(pairedDeviceId ? { pairedDeviceId } : {}),
    ...(pairedVia ? { pairedVia } : {}),
    ...(compatibleEnvironmentIds.length > 0 ? { compatibleEnvironmentIds } : {})
  }
}

export function readWebRuntimeEnvironments(): StoredWebRuntimeEnvironment[] {
  const raw = window.localStorage.getItem(REGISTRY_STORAGE_KEY)
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return parsed
          .map(sanitizeStoredEnvironment)
          .filter((entry): entry is StoredWebRuntimeEnvironment => entry !== null)
      }
    } catch {
      // A corrupt registry falls through to the legacy slot below.
    }
  }
  return migrateLegacySingleEnvironment()
}

function migrateLegacySingleEnvironment(): StoredWebRuntimeEnvironment[] {
  const raw = window.localStorage.getItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
  if (raw === null) {
    return []
  }
  let legacy: StoredWebRuntimeEnvironment | null = null
  try {
    legacy = sanitizeStoredEnvironment(JSON.parse(raw))
  } catch {
    legacy = null
  }
  const environments = legacy ? [legacy] : []
  try {
    saveWebRuntimeEnvironments(environments)
    window.localStorage.removeItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
  } catch {
    // Why: full or blocked browser storage must not unpair an already-paired client.
  }
  return environments
}

export function saveWebRuntimeEnvironments(
  environments: readonly StoredWebRuntimeEnvironment[]
): void {
  window.localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(environments))
}

export function readActiveWebRuntimeEnvironmentId(): string | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as { activeRuntimeEnvironmentId?: unknown }) : null
    return typeof parsed?.activeRuntimeEnvironmentId === 'string'
      ? parsed.activeRuntimeEnvironmentId.trim() || null
      : null
  } catch {
    return null
  }
}

export function writeActiveWebRuntimeEnvironmentId(environmentId: string | null): void {
  let settings: Record<string, unknown> = {}
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    settings = {}
  }
  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...settings, activeRuntimeEnvironmentId: environmentId })
  )
}

export function readActiveStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  const environments = readWebRuntimeEnvironments()
  const activeId = readActiveWebRuntimeEnvironmentId()
  // Why: focus is a preference, not the pairing — an unset or stale pointer
  // still resolves to a paired server instead of reporting the client unpaired.
  return environments.find((entry) => entry.id === activeId) ?? environments[0] ?? null
}

export function findWebRuntimeEnvironmentByOfferKey(
  publicKeyB64: string
): StoredWebRuntimeEnvironment | null {
  return (
    readWebRuntimeEnvironments().find((environment) =>
      environment.endpoints.some((endpoint) => endpoint.publicKeyB64 === publicKeyB64)
    ) ?? null
  )
}

/**
 * Insert a pairing, replacing only the entry it supersedes — its own id, or the
 * predecessor ids `createStoredWebRuntimeEnvironment` proved compatible by
 * server key. Every other paired server is left untouched.
 */
export function upsertStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): StoredWebRuntimeEnvironment {
  const supersededIds = getSupersededEnvironmentIds(environment)
  const environments = readWebRuntimeEnvironments()
  const insertAt = environments.findIndex((entry) => supersededIds.has(entry.id))
  const remaining = environments.filter((entry) => !supersededIds.has(entry.id))
  saveWebRuntimeEnvironments(
    insertAt === -1
      ? [...remaining, environment]
      : [...remaining.slice(0, insertAt), environment, ...remaining.slice(insertAt)]
  )
  const activeId = readActiveWebRuntimeEnvironmentId()
  if (activeId !== null && supersededIds.has(activeId)) {
    writeActiveWebRuntimeEnvironmentId(environment.id)
  }
  return environment
}

export function getSupersededEnvironmentIds(
  environment: StoredWebRuntimeEnvironment
): Set<string> {
  return new Set([environment.id, ...(environment.compatibleEnvironmentIds ?? [])])
}

/** Remove a pairing entirely (destroys the stored device token). */
export function removeStoredWebRuntimeEnvironment(environmentId: string): void {
  const environments = readWebRuntimeEnvironments()
  const remaining = environments.filter((entry) => entry.id !== environmentId)
  if (remaining.length === environments.length) {
    return
  }
  saveWebRuntimeEnvironments(remaining)
  if (readActiveWebRuntimeEnvironmentId() === environmentId) {
    writeActiveWebRuntimeEnvironmentId(remaining[0]?.id ?? null)
  }
}

/**
 * Prune dead lineage after an origin (page-fragment) pairing: ephemeral app
 * deployments mint a new backend per rebuild, so earlier origin pairings for
 * the same endpoint host are corpses of the same app. Manually added servers
 * always survive. Returns the removed ids so the caller can drop their session
 * keys.
 */
export function pruneStaleOriginPairings(keepId: string): string[] {
  const environments = readWebRuntimeEnvironments()
  const keep = environments.find((entry) => entry.id === keepId)
  const keepHost = keep ? endpointHost(keep) : null
  if (!keep || !keepHost) {
    return []
  }
  const removedIds: string[] = []
  const remaining = environments.filter((entry) => {
    if (entry.id === keepId || entry.pairedVia === 'manual' || endpointHost(entry) !== keepHost) {
      return true
    }
    removedIds.push(entry.id)
    return false
  })
  if (removedIds.length === 0) {
    return []
  }
  saveWebRuntimeEnvironments(remaining)
  const activeId = readActiveWebRuntimeEnvironmentId()
  if (activeId !== null && removedIds.includes(activeId)) {
    writeActiveWebRuntimeEnvironmentId(keepId)
  }
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
