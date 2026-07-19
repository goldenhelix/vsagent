import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isVSAgentWebMode } from './vsagent-web-mode'

// Why (VSAgent fork): the browser web client has no local execution host — the
// serve host (a runtime environment, e.g. "Orca Server") is the only one. The
// registry still injects a client-platform-derived "local" host (labeled e.g.
// "Local Mac" from the browser's UA, even on a Linux server), which is a phantom
// in web mode. These drop it from any host list so it never surfaces as a picker
// option, host badge, or task "project". No-ops on native.

export function dropLocalHostByKindInWebMode<T extends { kind: 'local' | 'ssh' | 'runtime' }>(
  hosts: readonly T[]
): T[] {
  if (!isVSAgentWebMode()) {
    return [...hosts]
  }
  return hosts.filter((host) => host.kind !== 'local')
}

export function dropLocalHostByIdInWebMode<T extends { id: string }>(hosts: readonly T[]): T[] {
  if (!isVSAgentWebMode()) {
    return [...hosts]
  }
  return hosts.filter((host) => host.id !== LOCAL_EXECUTION_HOST_ID)
}
