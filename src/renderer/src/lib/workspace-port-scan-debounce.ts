import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

export type KeyedPortScan = { key: string; result: WorkspacePortScanResult }

type PortScanDebounceEntry = {
  consecutiveFailures: number
  publishedResult: WorkspacePortScanResult
}

export type PortScanDebounceState = Map<string, PortScanDebounceEntry>

/** Keeps each host's last reachable scan through brief failures; reachable empty scans apply now. */
export function reconcileTransientPortScanFailures(
  results: KeyedPortScan[],
  publishedScans: Record<string, WorkspacePortScanResult>,
  state: PortScanDebounceState,
  failureThreshold: number,
  activeKeys: ReadonlySet<string> = new Set(results.map(({ key }) => key))
): KeyedPortScan[] {
  for (const key of state.keys()) {
    if (!activeKeys.has(key)) {
      state.delete(key)
    }
  }

  return results.map(({ key, result }) => {
    // Why: a scanner that resolves without a result must not take the render tree
    // down on the first `result.unavailableReason` read — report it as unavailable.
    if (!result) {
      const missing: WorkspacePortScanResult = {
        platform: 'unknown',
        scannedAt: Date.now(),
        ports: [],
        unavailableReason: 'Workspace port scan returned no result.'
      }
      state.set(key, { consecutiveFailures: 0, publishedResult: missing })
      return { key, result: missing }
    }
    const previous = state.get(key)
    const publishedResult = publishedScans[key]
    // A different object was published by another refresh path, so it breaks this poller's streak.
    const previousFailures =
      previous && previous.publishedResult === publishedResult ? previous.consecutiveFailures : 0
    if (!result.unavailableReason) {
      state.set(key, { consecutiveFailures: 0, publishedResult: result })
      return { key, result }
    }
    const failures = previousFailures + 1
    // Why: a surface that hit the same failure first (the ports popover) republishes
    // the host's last-good ports alongside the reason. Treating that as a spent grace
    // period would drop those ports on the very next poll, undoing the retention.
    const publishedIsRetainable =
      Boolean(publishedResult) &&
      (!publishedResult.unavailableReason || publishedResult.ports.length > 0)
    const nextResult =
      failures < failureThreshold && publishedIsRetainable ? publishedResult : result
    state.set(key, { consecutiveFailures: failures, publishedResult: nextResult })
    return { key, result: nextResult }
  })
}
