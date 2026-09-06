import type {
  ClaudeUsageApi,
  CodexUsageApi,
  OpenCodeUsageApi
} from '../../../../preload/api/agent-usage-api'
import { callRuntimeResult } from './web-runtime-calls'

// Why (VSAgent fork): usage scanning reads the agent transcripts on the machine
// that runs the agents, so the browser client routes the desktop's usage IPC to
// the paired host. A host too old to know these methods rejects the call; that
// resolves undefined, which upstream's store slice already reads as "not
// supported here" and leaves the panes in their disabled state.

type UsageProviderPrefix = 'claudeUsage' | 'codexUsage' | 'openCodeUsage'

// Enabling a provider kicks off a full transcript scan on the host.
const USAGE_SCAN_TIMEOUT_MS = 120_000

async function callUsage<TResult>(
  prefix: UsageProviderPrefix,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<TResult | undefined> {
  try {
    return await callRuntimeResult<TResult>(`${prefix}.${method}`, params, timeoutMs)
  } catch {
    return undefined
  }
}

function createUsageProviderApi(prefix: UsageProviderPrefix): ClaudeUsageApi {
  return {
    getScanState: () => callUsage(prefix, 'getScanState'),
    setEnabled: (args) => callUsage(prefix, 'setEnabled', args, USAGE_SCAN_TIMEOUT_MS),
    refresh: (args) => callUsage(prefix, 'refresh', args ?? {}, USAGE_SCAN_TIMEOUT_MS),
    getSnapshot: (args) => callUsage(prefix, 'getSnapshot', args, USAGE_SCAN_TIMEOUT_MS),
    getSummary: (args) => callUsage(prefix, 'getSummary', args, USAGE_SCAN_TIMEOUT_MS),
    getDaily: (args) => callUsage(prefix, 'getDaily', args, USAGE_SCAN_TIMEOUT_MS),
    getBreakdown: (args) => callUsage(prefix, 'getBreakdown', args, USAGE_SCAN_TIMEOUT_MS),
    getRecentSessions: (args) => callUsage(prefix, 'getRecentSessions', args, USAGE_SCAN_TIMEOUT_MS)
  } as ClaudeUsageApi
}

export function createWebClaudeUsageApi(): ClaudeUsageApi {
  return createUsageProviderApi('claudeUsage')
}

export function createWebCodexUsageApi(): CodexUsageApi {
  return createUsageProviderApi('codexUsage') as unknown as CodexUsageApi
}

export function createWebOpenCodeUsageApi(): OpenCodeUsageApi {
  return createUsageProviderApi('openCodeUsage') as unknown as OpenCodeUsageApi
}
