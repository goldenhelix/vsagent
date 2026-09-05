import { _resetGitRemoteNameListingCache, listGitRemoteNames } from '../git/remote-name-listing'
import {
  createRemoteRefProbeCache,
  type RemoteRefLocalGitOptions
} from '../git/remote-ref-probe-cache'

export type GiteaRepoRef = {
  host: string
  owner: string
  repo: string
  apiBaseUrl: string
  webBaseUrl: string
}

// Why: callers already pass the probe cache's own option bag (hosted review
// threads an `admissionTier` through it), so name it as such — the remote-name
// listing has to spend the same git admission budget as the ref probes.
type LocalGitExecOptions = RemoteRefLocalGitOptions

const KNOWN_NON_GITEA_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
  'ssh.dev.azure.com'
])
const repoRefProbeCache = createRemoteRefProbeCache(parseGiteaRepoRef)

/** @internal - exposed for tests only. Clears the remote-name listing too, since
 *  the non-origin scan resolves through both caches. */
export function _resetGiteaRepoRefCache(): void {
  repoRefProbeCache.clear()
  _resetGitRemoteNameListingCache()
}

/** @internal - exposed for tests only */
export function _getGiteaRepoRefCacheSize(): number {
  return repoRefProbeCache.size()
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parsePath(pathname: string): { owner: string; repo: string; basePath: string } | null {
  const withoutSuffix = pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = withoutSuffix
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) {
    return null
  }

  const owner = decodeSegment(parts.at(-2) ?? '')
  const repo = decodeSegment(parts.at(-1) ?? '')
  if (!owner || !repo) {
    return null
  }

  return {
    owner,
    repo,
    basePath: parts.slice(0, -2).join('/')
  }
}

function apiBaseUrlFromWebBase(webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/api/v1`
}

function makeRepoRef(host: string, path: string, webOrigin: string): GiteaRepoRef | null {
  const normalizedHost = host.toLowerCase()
  if (
    !normalizedHost ||
    KNOWN_NON_GITEA_HOSTS.has(normalizedHost) ||
    normalizedHost.endsWith('.visualstudio.com')
  ) {
    return null
  }

  const parsed = parsePath(path)
  if (!parsed) {
    return null
  }

  // Why: Gitea/Forgejo can be hosted below a URL subpath. SSH-style remotes
  // carry that base path in the repo path, so derive the web/API base here.
  const webBaseUrl = parsed.basePath
    ? `${webOrigin.replace(/\/+$/, '')}/${parsed.basePath}`
    : webOrigin
  return {
    host: normalizedHost,
    owner: parsed.owner,
    repo: parsed.repo,
    apiBaseUrl: apiBaseUrlFromWebBase(webBaseUrl),
    webBaseUrl
  }
}

export function parseGiteaRepoRef(remoteUrl: string): GiteaRepoRef | null {
  const trimmed = remoteUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
    if (scpLike) {
      const host = scpLike[1]
      const path = scpLike[2]
      return makeRepoRef(host, path, `https://${host.toLowerCase()}`)
    }
  }

  try {
    const url = new URL(trimmed)
    const protocol = url.protocol.toLowerCase()
    if (!['http:', 'https:', 'ssh:', 'git+ssh:'].includes(protocol)) {
      return null
    }

    const parsed = parsePath(url.pathname)
    if (!parsed) {
      return null
    }

    const webOrigin =
      protocol === 'http:' || protocol === 'https:'
        ? `${protocol}//${url.host}`
        : `https://${url.hostname.toLowerCase()}`
    return makeRepoRef(url.hostname, url.pathname, webOrigin)
  } catch {
    return null
  }
}

export async function getGiteaRepoRefForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  return repoRefProbeCache.get(repoPath, remoteName, connectionId, localGitOptions)
}

/**
 * Resolve the repo's Gitea ref from whichever remote carries it.
 *
 * Why: the forge remote is not always `origin` — a repo can review on a `gitea`
 * remote while `origin` points at a GitHub mirror, or have no `origin` at all.
 * `origin` stays the fast path so the common case still costs one probe, and
 * each per-remote probe goes through the shared cache, so scanning inherits its
 * TTL, coalescing and SSH-generation stamping.
 *
 * TODO(upstream): "the forge remote is named origin" is assumed by every
 * provider, not just this one — the same fallback belongs in
 * `src/main/gitlab/gitlab-project-ref-resolution.ts` and the GitHub ref path.
 */
export async function getGiteaRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  const fromOrigin = await getGiteaRepoRefForRemote(
    repoPath,
    'origin',
    connectionId,
    localGitOptions
  )
  if (fromOrigin) {
    return fromOrigin
  }
  const remoteNames = await listGitRemoteNames({
    repoPath,
    connectionId,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
    ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
  })
  for (const remoteName of remoteNames) {
    if (remoteName === 'origin') {
      continue
    }
    const ref = await getGiteaRepoRefForRemote(repoPath, remoteName, connectionId, localGitOptions)
    if (ref) {
      return ref
    }
  }
  return null
}
