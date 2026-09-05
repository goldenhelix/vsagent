import { isVSAgentWebMode } from './vsagent-web-mode'

export type SingleRuntimeLegacyOwnerState = {
  settings?: { activeRuntimeEnvironmentId?: string | null } | null
  runtimeEnvironments?: readonly { id: string }[]
}

export function getSingleFocusedRuntimeEnvironmentId(
  state: SingleRuntimeLegacyOwnerState,
  webMode = isVSAgentWebMode()
): string | null {
  const focused = state.settings?.activeRuntimeEnvironmentId?.trim()
  if (!focused) {
    return null
  }
  const savedIds = state.runtimeEnvironments?.map((environment) => environment.id.trim())
  if (savedIds === undefined) {
    return focused
  }
  // Why (VSAgent web): the browser client has no local execution host, so an
  // unowned workspace must still inherit the focused server once a second one
  // is paired — desktop keeps the stricter single-environment rule because
  // there "unowned" legitimately means local.
  if (webMode) {
    return savedIds.includes(focused) ? focused : null
  }
  return savedIds.length === 1 && savedIds[0] === focused ? focused : null
}
