import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  getUsageProviderStore,
  type UsageProviderPrefix
} from '../../../usage/usage-provider-store-registry'

// Why (VSAgent fork): the Stats & Usage panes read agent transcript usage through
// Electron-only IPC, so in a paired web client every provider reported "not
// supported here" and Enable was a silent no-op. The transcripts live on the host
// that runs the agents, so these mirror the IPC handlers one-for-one over RPC.

const PREFIXES: UsageProviderPrefix[] = ['claudeUsage', 'codexUsage', 'openCodeUsage']

// Scope/range/kind stay permissive strings: each provider owns its own union and
// the store is the authority, so a narrower schema here would only add drift.
const UsageQueryParams = z.object({
  scope: z.string(),
  range: z.string()
})
const UsageSnapshotParams = UsageQueryParams.extend({
  limit: z.number().int().positive().optional()
})
const UsageBreakdownParams = UsageQueryParams.extend({ kind: z.string() })
const UsageSetEnabledParams = z.object({ enabled: z.boolean() })
const UsageRefreshParams = z.object({ force: z.boolean().optional() }).nullish()

type UsageQuery = { scope: never; range: never }

function requireStore(
  prefix: UsageProviderPrefix
): NonNullable<ReturnType<typeof getUsageProviderStore>> {
  const store = getUsageProviderStore(prefix)
  if (!store) {
    throw new Error(`${prefix} is unavailable on this host`)
  }
  return store
}

function methodsForPrefix(prefix: UsageProviderPrefix): RpcMethod[] {
  return [
    defineMethod({
      name: `${prefix}.getScanState`,
      params: null,
      handler: () => requireStore(prefix).getScanState()
    }),
    defineMethod({
      name: `${prefix}.setEnabled`,
      params: UsageSetEnabledParams,
      handler: (params) => requireStore(prefix).setEnabled(params.enabled)
    }),
    defineMethod({
      name: `${prefix}.refresh`,
      params: UsageRefreshParams,
      handler: (params) => requireStore(prefix).refresh(params?.force ?? false)
    }),
    defineMethod({
      name: `${prefix}.getSnapshot`,
      params: UsageSnapshotParams,
      handler: (params) => {
        const query = params as unknown as UsageQuery
        return requireStore(prefix).getSnapshot(query.scope, query.range, params.limit)
      }
    }),
    defineMethod({
      name: `${prefix}.getSummary`,
      params: UsageQueryParams,
      handler: (params) => {
        const query = params as unknown as UsageQuery
        return requireStore(prefix).getSummary(query.scope, query.range)
      }
    }),
    defineMethod({
      name: `${prefix}.getDaily`,
      params: UsageQueryParams,
      handler: (params) => {
        const query = params as unknown as UsageQuery
        return requireStore(prefix).getDaily(query.scope, query.range)
      }
    }),
    defineMethod({
      name: `${prefix}.getBreakdown`,
      params: UsageBreakdownParams,
      handler: (params) => {
        const query = params as unknown as UsageQuery & { kind: never }
        return requireStore(prefix).getBreakdown(query.scope, query.range, query.kind)
      }
    }),
    defineMethod({
      name: `${prefix}.getRecentSessions`,
      params: UsageSnapshotParams,
      handler: (params) => {
        const query = params as unknown as UsageQuery
        return requireStore(prefix).getRecentSessions(query.scope, query.range, params.limit)
      }
    })
  ]
}

export const USAGE_PROVIDER_METHODS: RpcMethod[] = PREFIXES.flatMap(methodsForPrefix)
