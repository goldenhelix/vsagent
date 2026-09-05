import { getSshGitProvider, getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { runCoalescedProbe, type CoalescedProbes } from './coalesced-probe'
import { REMOTE_URL_PROBE_TIMEOUT_MS, type RemoteUrlProbeContext } from './remote-url-probe'
import { gitExecFileAsync } from './runner'

/**
 * `git remote` for the forge resolvers: which remotes are worth probing when the
 * repo's forge remote is not named `origin` (a GitHub mirror on `origin` beside
 * the Gitea remote work actually happens on).
 *
 * Why it caches: the resolvers run per branch, so a worktree-list poll arrives as
 * a burst of identical listings — the same fan-out `remote-ref-probe-cache.ts`
 * exists to absorb. It shares that cache's bound and deadline, and expires
 * positives too, since a remote added mid-session must be picked up without a
 * restart.
 */

const REMOTE_NAMES_CACHE_MAX_ENTRIES = 512
const REMOTE_NAMES_TTL_MS = 5 * 60_000

type CachedRemoteNames = { names: string[]; expiresAt: number }

const remoteNamesCache = new Map<string, CachedRemoteNames>()
const inFlight: CoalescedProbes<string[]> = new Map()

/** @internal - exposed for tests only */
export function _resetGitRemoteNameListingCache(): void {
  remoteNamesCache.clear()
  inFlight.clear()
}

function remember(cacheKey: string, names: string[]): void {
  remoteNamesCache.set(cacheKey, { names, expiresAt: Date.now() + REMOTE_NAMES_TTL_MS })
  while (remoteNamesCache.size > REMOTE_NAMES_CACHE_MAX_ENTRIES) {
    const oldestKey = remoteNamesCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    remoteNamesCache.delete(oldestKey)
  }
}

function splitRemoteNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
}

/** Null is the SSH runtime being disconnected — not an answer about the repo. */
async function readRemoteNames(context: RemoteUrlProbeContext): Promise<string[] | null> {
  if (context.connectionId) {
    const provider = getSshGitProvider(context.connectionId)
    if (!provider) {
      return null
    }
    const { stdout } = await provider.exec(['remote'], context.repoPath, {
      signal: AbortSignal.timeout(REMOTE_URL_PROBE_TIMEOUT_MS)
    })
    return splitRemoteNames(stdout)
  }
  const { stdout } = await gitExecFileAsync(['remote'], {
    cwd: context.repoPath,
    timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
    ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
    ...(context.admissionTier ? { admissionTier: context.admissionTier } : {})
  })
  return splitRemoteNames(stdout)
}

/**
 * The repo's remote names, or `[]` when the listing could not be read. A failed
 * or unanswered listing is never cached: it says nothing about the remotes, and
 * caching it would hide them for the whole TTL.
 */
export async function listGitRemoteNames(context: RemoteUrlProbeContext): Promise<string[]> {
  // Why: a reconnect retires the connection an answer came from, so stamp the
  // generation the same way the ref probe cache does.
  const runtimeKey = context.connectionId
    ? `${context.connectionId}:${getSshGitProviderGeneration(context.connectionId)}`
    : `local:${context.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${context.repoPath}`
  const cached = remoteNamesCache.get(cacheKey)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.names
    }
    remoteNamesCache.delete(cacheKey)
  }
  return runCoalescedProbe(inFlight, cacheKey, async (ownsKey) => {
    try {
      const names = await readRemoteNames(context)
      if (names === null) {
        return []
      }
      // Why: a probe abandoned as stale describes an older repo state than the
      // successor already stored — it may answer its callers, not publish.
      if (ownsKey()) {
        remember(cacheKey, names)
      }
      return names
    } catch {
      return []
    }
  })
}
