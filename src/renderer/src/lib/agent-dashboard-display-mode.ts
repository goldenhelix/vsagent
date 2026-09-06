import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isVSAgentWebMode } from './vsagent-web-mode'

export type AgentDashboardDisplayMode = NonNullable<
  GlobalSettings['experimentalAgentDashboardMode']
>

/**
 * The dashboard mode actually reachable on this client. Why (VSAgent fork): the
 * pop-out is a second Electron window, which a browser tab cannot open — asking
 * for it there leaves the entry point a silent no-op, so web mode stays in-window.
 */
export function effectiveAgentDashboardDisplayMode(
  mode: AgentDashboardDisplayMode | undefined
): AgentDashboardDisplayMode {
  if (isVSAgentWebMode()) {
    return 'in-window'
  }
  return mode ?? 'in-window'
}

export function agentDashboardPopoutSupported(): boolean {
  return !isVSAgentWebMode()
}
