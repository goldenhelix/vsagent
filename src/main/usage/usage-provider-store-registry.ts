// Why (VSAgent fork): usage stores are reachable only over Electron IPC upstream,
// so a paired web client sees nothing. The runtime RPC layer must not import
// electron (check:runtime-electron-ratchet) and the stores do, so they register
// themselves here structurally and the RPC methods resolve them by prefix.

export type UsageProviderPrefix = 'claudeUsage' | 'codexUsage' | 'openCodeUsage'

export type UsageProviderQueryStore = {
  getScanState: () => unknown
  setEnabled: (enabled: boolean) => unknown
  refresh: (force?: boolean) => unknown
  getSnapshot: (scope: never, range: never, limit?: number) => unknown
  getSummary: (scope: never, range: never) => unknown
  getDaily: (scope: never, range: never) => unknown
  getBreakdown: (scope: never, range: never, kind: never) => unknown
  getRecentSessions: (scope: never, range: never, limit?: number) => unknown
}

const stores = new Map<UsageProviderPrefix, UsageProviderQueryStore>()

export function setUsageProviderStores(
  registered: Record<UsageProviderPrefix, UsageProviderQueryStore>
): void {
  for (const [prefix, store] of Object.entries(registered)) {
    stores.set(prefix as UsageProviderPrefix, store)
  }
}

export function getUsageProviderStore(prefix: UsageProviderPrefix): UsageProviderQueryStore | null {
  return stores.get(prefix) ?? null
}

export function clearUsageProviderStores(): void {
  stores.clear()
}
