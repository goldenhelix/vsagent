import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import { RuntimeRpcCallQueuePool } from '../../../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { Worktree } from '../../../../shared/worktree/types'
import { WebRuntimeClient } from '../web-runtime-client'
import {
  getPreferredWebPairingOffer,
  updateStoredEnvironmentRuntimeId
} from '../web-runtime-environment'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import {
  readActiveStoredWebRuntimeEnvironment,
  readWebRuntimeEnvironments,
  removeStoredWebRuntimeEnvironment
} from '../web-runtime-environment-registry'
import { translate } from '@/i18n/i18n'

export const webRuntimeState: {
  activeEnvironment: StoredWebRuntimeEnvironment | null
  worktreeVisibilityDefaultsRuntimeEnvironmentId: string | null
  worktreeVisibilityDefaultsRuntimeValue: WorktreeVisibilityDefaults | null
  // Why (VSAgent): one live client per paired server, so a second server's
  // projects load without evicting the first server's socket.
  clientsByEnvironmentId: Map<string, WebRuntimeClient>
  cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
  cachedDetectedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null
} = {
  activeEnvironment: readActiveStoredWebRuntimeEnvironment(),
  worktreeVisibilityDefaultsRuntimeEnvironmentId: null,
  worktreeVisibilityDefaultsRuntimeValue: null,
  clientsByEnvironmentId: new Map(),
  cachedWorktrees: null,
  cachedDetectedWorktrees: null
}

export const manuallyDisconnectedEnvironmentIds = new Set<string>()

export const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

export function invalidateRuntimeWorktreeCaches(): void {
  webRuntimeState.cachedWorktrees = null
  webRuntimeState.cachedDetectedWorktrees = null
}

export function getClientForEnvironment(
  environment: StoredWebRuntimeEnvironment
): WebRuntimeClient {
  if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
    throw new Error('runtime_manually_disconnected')
  }
  const existing = webRuntimeState.clientsByEnvironmentId.get(environment.id)
  if (existing) {
    return existing
  }
  const client = new WebRuntimeClient(getPreferredWebPairingOffer(environment))
  webRuntimeState.clientsByEnvironmentId.set(environment.id, client)
  return client
}

export function peekRuntimeClientForEnvironment(environmentId: string): WebRuntimeClient | null {
  return webRuntimeState.clientsByEnvironmentId.get(environmentId) ?? null
}

export function closeRuntimeClientForEnvironment(environmentId: string): void {
  const client = webRuntimeState.clientsByEnvironmentId.get(environmentId)
  if (!client) {
    return
  }
  client.close()
  webRuntimeState.clientsByEnvironmentId.delete(environmentId)
  invalidateRuntimeWorktreeCaches()
}

export function disconnectRuntimeEnvironment(environmentId: string): void {
  manuallyDisconnectedEnvironmentIds.add(environmentId)
  closeRuntimeClientForEnvironment(environmentId)
}

/** Un-pair one server: drops its live client and its stored device token. */
export function forgetRuntimeEnvironment(environmentId: string): void {
  closeRuntimeClientForEnvironment(environmentId)
  manuallyDisconnectedEnvironmentIds.delete(environmentId)
  removeStoredWebRuntimeEnvironment(environmentId)
  refreshActiveRuntimeEnvironment()
}

export function refreshActiveRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  const previousId = webRuntimeState.activeEnvironment?.id ?? null
  webRuntimeState.activeEnvironment = readActiveStoredWebRuntimeEnvironment()
  if ((webRuntimeState.activeEnvironment?.id ?? null) !== previousId) {
    // Why: the worktree caches describe the focused server only.
    invalidateRuntimeWorktreeCaches()
  }
  return webRuntimeState.activeEnvironment
}

export function manuallyDisconnectedResponse(
  environment: StoredWebRuntimeEnvironment
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: translate(
        'auto.web.webPreloadApi.runtimeEnvironmentManuallyDisconnected',
        'Runtime environment is manually disconnected.'
      )
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

export function resolveEnvironment(selector: string): StoredWebRuntimeEnvironment {
  if (selector === 'active') {
    return requireActiveEnvironment()
  }
  const environments = readWebRuntimeEnvironments()
  const match =
    environments.find((entry) => entry.id === selector || entry.name === selector) ??
    // Why: a re-pair of the same server key mints a new id while persisted tab
    // and terminal selectors still name the old one.
    environments.find((entry) => entry.compatibleEnvironmentIds?.includes(selector))
  if (match) {
    return match
  }
  throw new Error(`Unknown Orca runtime environment: ${selector}`)
}

export function requireActiveEnvironment(): StoredWebRuntimeEnvironment {
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  return environment
}

export function requireActiveEnvironmentOrNull(): StoredWebRuntimeEnvironment | null {
  webRuntimeState.activeEnvironment =
    webRuntimeState.activeEnvironment ?? readActiveStoredWebRuntimeEnvironment()
  return webRuntimeState.activeEnvironment
}

export function assertActiveEnvironment(environmentId: string): void {
  if (requireActiveEnvironment().id !== environmentId) {
    throw new Error('The paired Orca server changed while the request was in progress.')
  }
}

export function updateEnvironmentFromResponse(
  environment: StoredWebRuntimeEnvironment,
  response: RuntimeRpcResponse<unknown>
): void {
  const runtimeId = response.ok ? response._meta.runtimeId : (response._meta?.runtimeId ?? null)
  const pairedDeviceId =
    response.ok &&
    typeof response.result === 'object' &&
    response.result !== null &&
    typeof (response.result as { pairedDeviceId?: unknown }).pairedDeviceId === 'string'
      ? (response.result as { pairedDeviceId: string }).pairedDeviceId
      : undefined
  // Why: every paired server keeps its own runtime metadata fresh, not just the focused one.
  const updated = updateStoredEnvironmentRuntimeId(environment, runtimeId, pairedDeviceId)
  if (webRuntimeState.activeEnvironment?.id === environment.id) {
    webRuntimeState.activeEnvironment = updated
  }
}
