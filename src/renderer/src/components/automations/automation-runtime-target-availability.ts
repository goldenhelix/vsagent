import {
  describeRuntimeCompatBlock,
  evaluateRuntimeCompat
} from '../../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { AutomationTargetAvailability } from './automation-target-availability'
import { unavailable } from './automation-target-unavailable'

export function getRuntimeAutomationAvailability(
  environmentId: string,
  runtimeStatusByEnvironmentId:
    | ReadonlyMap<string, { status: RuntimeStatus | null; checkedAt: number }>
    | undefined
): AutomationTargetAvailability {
  const entry = runtimeStatusByEnvironmentId?.get(environmentId)
  if (!entry) {
    return unavailable(
      'runtime-checking',
      'Checking the selected remote server before running manually.'
    )
  }
  if (!entry.status) {
    return unavailable(
      'runtime-unavailable',
      'Reconnect this remote server before running manually.'
    )
  }
  if (entry.status.graphStatus !== 'ready') {
    return unavailable(
      'runtime-unavailable',
      'The selected remote server is not ready to run automations yet.'
    )
  }
  const compat = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: entry.status.runtimeProtocolVersion ?? entry.status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      entry.status.minCompatibleRuntimeClientVersion ?? entry.status.minCompatibleMobileVersion
  })
  if (compat.kind === 'blocked') {
    return unavailable('runtime-update-required', describeRuntimeCompatBlock(compat))
  }
  return { canRunNow: true, reason: 'available', message: null }
}
