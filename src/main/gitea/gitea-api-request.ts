// Why: the authenticated Gitea REST transport — env-configured auth, base-URL
// resolution, and the JSON readers. Split out of ./client so ./issues,
// ./issue-mutations and ./pull-request-creation read through one copy of it
// instead of each growing a private one (see also
// ../azure-devops/azure-devops-api-request.ts).
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { GiteaRepoRef } from './repository-ref'

const REQUEST_TIMEOUT_MS = 5000

export type GiteaAuthConfig = {
  apiBaseUrl: string | null
  token: string | null
}

export type GiteaRequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

export function getGiteaAuthConfig(): GiteaAuthConfig {
  const apiBaseUrl = envValue('ORCA_GITEA_API_BASE_URL')
  return {
    apiBaseUrl: apiBaseUrl ? normalizeGiteaApiBaseUrl(apiBaseUrl) : null,
    token: envValue('ORCA_GITEA_TOKEN')
  }
}

function authHeaders(config: Pick<GiteaAuthConfig, 'token'>): Record<string, string> {
  return config.token ? { Authorization: `token ${config.token}` } : {}
}

export function giteaAuthRequestHeaders(): Record<string, string> {
  return authHeaders(getGiteaAuthConfig())
}

/** An explicitly configured base URL wins over the one parsed off the remote. */
export function giteaApiBaseUrlForRepo(repo: GiteaRepoRef): string {
  return getGiteaAuthConfig().apiBaseUrl ?? repo.apiBaseUrl
}

export function giteaRepoPathSegment(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}

function apiUrl(
  baseUrl: string,
  path: string,
  searchParams?: GiteaRequestOptions['searchParams']
): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

export function buildGiteaApiUrl(
  repo: GiteaRepoRef,
  path: string,
  searchParams?: GiteaRequestOptions['searchParams']
): URL {
  return apiUrl(giteaApiBaseUrlForRepo(repo), path, searchParams)
}

export async function requestGiteaJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: GiteaRequestOptions = {},
  // Why: the existing-review lookup behind Create must distinguish a real
  // transport/auth failure from an accepted "no PR". When true, a failed request
  // throws instead of collapsing to null so callers never report false not_found.
  throwOnFailure = false
): Promise<T | null> {
  const config = getGiteaAuthConfig()
  try {
    const response = await fetch(apiUrl(baseUrl, path, options.searchParams), {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      if (throwOnFailure) {
        throw new Error(`Gitea request failed: HTTP ${response.status}`)
      }
      return null
    }
    return (await response.json()) as T
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

export function requestGiteaJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaRequestOptions = {},
  throwOnFailure = false
): Promise<T | null> {
  return requestGiteaJsonAtBase(giteaApiBaseUrlForRepo(repo), path, options, throwOnFailure)
}

// Why: the issue list has to tell "empty result" from "permission denied /
// not found" so the Task page can surface a real error instead of a bare
// "No issues" — surface the HTTP status the plain reader swallows.
export type GiteaJsonResult<T> = { ok: true; data: T } | { ok: false; status: number | null }

export async function requestGiteaJsonResult<T>(
  repo: GiteaRepoRef,
  path: string,
  options: GiteaRequestOptions = {}
): Promise<GiteaJsonResult<T>> {
  const config = getGiteaAuthConfig()
  try {
    const response = await fetch(buildGiteaApiUrl(repo, path, options.searchParams), {
      headers: {
        Accept: 'application/json',
        ...authHeaders(config)
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return { ok: false, status: response.status }
    }
    return { ok: true, data: (await response.json()) as T }
  } catch {
    return { ok: false, status: null }
  }
}
