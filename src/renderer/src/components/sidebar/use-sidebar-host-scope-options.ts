import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { isVSAgentWebMode } from '@/lib/vsagent-web-mode'
import {
  buildSidebarHostOptions,
  buildSidebarHostScopeOptions,
  type SidebarHostOption,
  type SidebarHostScopeOption
} from './sidebar-host-options'

/** Shared host-scope derivation for the sidebar scope strip and the workspace
 * options menu so both surfaces consume the same live runtime status without
 * duplicating store wiring. */
export function useSidebarHostScopeOptions(): {
  hostOptions: SidebarHostOption[]
  hostScopeOptions: SidebarHostScopeOption[]
} {
  const repos = useAppStore((s) => s.repos)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)

  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const hostOptions = useMemo(
    () =>
      buildSidebarHostOptions({
        repos,
        sshTargetLabels,
        sshConnectionStates,
        settings,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
        // Why (VSAgent fork): the browser has no "local" host — the serve host
        // is the only host — so drop it from the picker and scope strip. This
        // stops new repos being pinned to a dead local execution host.
      }).filter((host) => !(isVSAgentWebMode() && host.kind === 'local')),
    [
      repos,
      sshTargetLabels,
      sshConnectionStates,
      settings,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides
    ]
  )
  const hostScopeOptions = useMemo(() => buildSidebarHostScopeOptions(hostOptions), [hostOptions])

  return { hostOptions, hostScopeOptions }
}
