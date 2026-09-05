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

export function getRuntimeAutomationAvailability(
  environmentId: string,
  runtimeStatusByEnvironmentId:
    | ReadonlyMap<string, { status: RuntimeStatus | null; checkedAt: number }>
    | undefined
): AutomationTargetAvailability {
  const entry = runtimeStatusByEnvironmentId?.get(environmentId)
  if (!entry) {
    return {
      canRunNow: false,
      reason: 'runtime-checking',
      message: 'Checking the selected remote server before running manually.'
    }
  }
  if (!entry.status) {
    return {
      canRunNow: false,
      reason: 'runtime-unavailable',
      message: 'Reconnect this remote server before running manually.'
    }
  }
  if (entry.status.graphStatus !== 'ready') {
    return {
      canRunNow: false,
      reason: 'runtime-unavailable',
      message: 'The selected remote server is not ready to run automations yet.'
    }
  }
  const compat = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: entry.status.runtimeProtocolVersion ?? entry.status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      entry.status.minCompatibleRuntimeClientVersion ?? entry.status.minCompatibleMobileVersion
  })
  if (compat.kind === 'blocked') {
    return {
      canRunNow: false,
      reason: 'runtime-update-required',
      message: describeRuntimeCompatBlock(compat)
    }
  }
  return { canRunNow: true, reason: 'available', message: null }
}
