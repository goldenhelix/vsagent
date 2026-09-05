// Why: Gitea issue WRITE surface (comment / update), split from ./issues so
// each stays focused and under the line cap. Parallel to gitlab/issues.ts's
// mutating helpers.
import type { GitLabCommentResult, GitLabIssueUpdate } from '../../shared/gitlab-types'
import {
  HostedReviewApiRequestError,
  requestHostedReviewJson
} from '../source-control/hosted-review-api-request'
import {
  buildGiteaApiUrl,
  giteaAuthRequestHeaders,
  giteaRepoPathSegment,
  requestGiteaJson
} from './gitea-api-request'
import {
  mapGiteaAssignees,
  mapGiteaComment,
  type RawGiteaComment,
  type RawGiteaIssue
} from './issue-mappers'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { GiteaRepoRef } from './repository-ref'
import {
  fetchGiteaLabelObjects,
  GITEA_ISSUE_READ_TIMEOUT_MS,
  resolveGiteaRepo,
  type LocalGitExecOptions
} from './issues'

const WRITE_TIMEOUT_MS = 15_000

function giteaWriteHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...giteaAuthRequestHeaders()
  }
}

async function giteaWriteJson<T>(
  repo: GiteaRepoRef,
  path: string,
  method: string,
  body: unknown
): Promise<T> {
  return requestHostedReviewJson<T>(
    buildGiteaApiUrl(repo, path),
    { method, headers: giteaWriteHeaders(), body: JSON.stringify(body) },
    WRITE_TIMEOUT_MS
  )
}

async function giteaDelete(repo: GiteaRepoRef, path: string): Promise<void> {
  const response = await fetch(buildGiteaApiUrl(repo, path), {
    method: 'DELETE',
    headers: giteaAuthRequestHeaders(),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
  })
  // Why: undici crashes the process on unread response bodies (orca#8695);
  // DELETE responses are unread on every path, so always cancel.
  await cancelUnreadResponseBody(response)
  if (!response.ok) {
    throw new HostedReviewApiRequestError(response.statusText, { status: response.status })
  }
}

function writeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Add a comment to a Gitea issue. Mirrors gitlab/addIssueComment.
 */
export async function addGiteaIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabCommentResult> {
  const repo = await resolveGiteaRepo(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return { ok: false, error: 'Could not resolve a Gitea repository for this remote.' }
  }
  try {
    const created = await giteaWriteJson<RawGiteaComment>(
      repo,
      `/repos/${giteaRepoPathSegment(repo)}/issues/${encodeURIComponent(String(issueNumber))}/comments`,
      'POST',
      { body }
    )
    return { ok: true, comment: mapGiteaComment(created) }
  } catch (error) {
    return { ok: false, error: writeErrorMessage(error) }
  }
}

/**
 * Update a Gitea issue: title/body/state via one PATCH, labels via the
 * issue-label endpoints (Gitea keys them by id), assignees via a computed
 * replacement set. Mirrors gitlab/updateIssue's parity, degrading where the
 * Gitea REST surface has no direct delta operation.
 */
export async function updateGiteaIssue(
  repoPath: string,
  issueNumber: number,
  updates: GitLabIssueUpdate,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const repo = await resolveGiteaRepo(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return { ok: false, error: 'Could not resolve a Gitea repository for this remote.' }
  }
  const encodedNumber = encodeURIComponent(String(issueNumber))
  const basePath = `/repos/${giteaRepoPathSegment(repo)}/issues/${encodedNumber}`
  const errors: string[] = []

  const patch: Record<string, unknown> = {}
  if (updates.title !== undefined) {
    patch.title = updates.title
  }
  if (updates.body !== undefined) {
    patch.body = updates.body
  }
  if (updates.state) {
    // Why: shared GitLab vocabulary is opened/closed; Gitea expects open/closed.
    patch.state = updates.state === 'closed' ? 'closed' : 'open'
  }
  if (Object.keys(patch).length > 0) {
    try {
      await giteaWriteJson<RawGiteaIssue>(repo, basePath, 'PATCH', patch)
    } catch (error) {
      errors.push(writeErrorMessage(error))
    }
  }

  const addLabels = updates.addLabels ?? []
  const removeLabels = updates.removeLabels ?? []
  if (addLabels.length > 0 || removeLabels.length > 0) {
    await applyGiteaLabelChanges(repo, encodedNumber, addLabels, removeLabels).catch((error) =>
      errors.push(writeErrorMessage(error))
    )
  }

  const addAssignees = updates.addAssignees ?? []
  const removeAssignees = updates.removeAssignees ?? []
  if (addAssignees.length > 0 || removeAssignees.length > 0) {
    await applyGiteaAssigneeChanges(repo, basePath, addAssignees, removeAssignees).catch((error) =>
      errors.push(writeErrorMessage(error))
    )
  }

  return errors.length > 0 ? { ok: false, error: errors.join('; ') } : { ok: true }
}

async function applyGiteaLabelChanges(
  repo: GiteaRepoRef,
  encodedNumber: string,
  addLabels: string[],
  removeLabels: string[]
): Promise<void> {
  // Why: Gitea's issue-label endpoints key labels by numeric id, so resolve the
  // requested names against the repo's label set before mutating.
  const labelObjects = await fetchGiteaLabelObjects(repo)
  const idByName = new Map<string, number>()
  for (const label of labelObjects) {
    const name = label?.name?.trim()
    if (name && typeof label.id === 'number') {
      idByName.set(name.toLowerCase(), label.id)
    }
  }
  const labelsPath = `/repos/${giteaRepoPathSegment(repo)}/issues/${encodedNumber}/labels`

  const addIds = addLabels
    .map((name) => idByName.get(name.trim().toLowerCase()))
    .filter((id): id is number => typeof id === 'number')
  if (addIds.length > 0) {
    await giteaWriteJson<unknown>(repo, labelsPath, 'POST', { labels: addIds })
  }
  for (const name of removeLabels) {
    const id = idByName.get(name.trim().toLowerCase())
    if (typeof id === 'number') {
      await giteaDelete(repo, `${labelsPath}/${id}`)
    }
  }
}

async function applyGiteaAssigneeChanges(
  repo: GiteaRepoRef,
  basePath: string,
  addAssignees: string[],
  removeAssignees: string[]
): Promise<void> {
  // Why: Gitea has no add/remove assignee delta on the issue PATCH — it takes
  // the full replacement set. Read the current assignees, apply the delta, and
  // PATCH the merged list.
  const current = await requestGiteaJson<RawGiteaIssue>(repo, basePath, {
    timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS
  })
  const next = new Set(mapGiteaAssignees(current ?? {}))
  for (const login of addAssignees) {
    next.add(login)
  }
  for (const login of removeAssignees) {
    next.delete(login)
  }
  await giteaWriteJson<RawGiteaIssue>(repo, basePath, 'PATCH', { assignees: [...next] })
}
