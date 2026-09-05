// Why: Gitea issue READ surface (list / details / labels / single-issue
// lookup), parallel to src/main/gitlab/issues.ts. The mutating surface lives in
// ./issue-mutations to keep each file focused and under the line cap.
import type { ClassifiedError } from '../../shared/classified-error'
import type {
  GitLabIssueInfo,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  MRComment
} from '../../shared/gitlab-types'
import { giteaRepoPathSegment, requestGiteaJson, requestGiteaJsonResult } from './gitea-api-request'
import {
  isGiteaPullRequestRow,
  mapGiteaAssignees,
  mapGiteaComment,
  mapGiteaIssueInfo,
  mapGiteaIssueToWorkItemDetail,
  mapGiteaLabelNames,
  mapGiteaMilestones,
  type GiteaMilestone,
  type RawGiteaComment,
  type RawGiteaIssue,
  type RawGiteaLabel,
  type RawGiteaMilestone
} from './issue-mappers'
import { getGiteaRepoRef, type GiteaRepoRef } from './repository-ref'

// Why: same shape the repository-ref resolver accepts — carries the WSL distro
// through so a Windows host runs git in the right environment.
export type LocalGitExecOptions = { wslDistro?: string }

export const GITEA_ISSUE_READ_TIMEOUT_MS = 8000
const LABEL_PAGE_LIMIT = 100

// Why: the renderer only exposes "opened / closed / all"; keep the same
// vocabulary the GitLab issue list uses so the source lookup can be shared.
export type GiteaIssueListState = 'opened' | 'closed' | 'all'

export type GiteaIssueListResult = {
  items: GitLabIssueInfo[]
  error?: ClassifiedError
}

export function resolveGiteaRepo(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRef(repoPath, connectionId, localGitOptions)
}

function classifyGiteaHttpError(status: number | null): ClassifiedError {
  if (status === 401 || status === 403) {
    return { type: 'permission_denied', message: 'Not authorized to access this Gitea repository.' }
  }
  if (status === 404) {
    return { type: 'not_found', message: 'Gitea repository or issues not found.' }
  }
  if (status === 429) {
    return { type: 'rate_limited', message: 'Gitea rate limit reached. Try again shortly.' }
  }
  if (status === null) {
    return { type: 'network_error', message: 'Could not reach the Gitea server.' }
  }
  return { type: 'unknown', message: `Gitea request failed (HTTP ${status}).` }
}

function giteaStateParam(state: GiteaIssueListState): 'open' | 'closed' | 'all' {
  if (state === 'closed') {
    return 'closed'
  }
  return state === 'all' ? 'all' : 'open'
}

/** Resolve the token's own login so an "@me" assignee filter can map onto
 *  Gitea's username-based `assigned_by` query param. */
async function resolveViewerLogin(repo: GiteaRepoRef): Promise<string | null> {
  const user = await requestGiteaJson<{ login?: string | null; username?: string | null }>(
    repo,
    '/user',
    { timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS }
  )
  return user?.login?.trim() || user?.username?.trim() || null
}

/**
 * List issues for a Gitea repo. Mirrors gitlab/listIssues — returns a
 * structured result so permission/not-found errors surface in the UI instead
 * of collapsing to "No issues".
 */
export async function listGiteaIssues(
  repoPath: string,
  limit = 20,
  state: GiteaIssueListState = 'opened',
  assignee?: string,
  milestone?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaIssueListResult> {
  const repo = await resolveGiteaRepo(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return {
      items: [],
      error: { type: 'not_found', message: 'Could not resolve a Gitea repository for this remote.' }
    }
  }

  const searchParams: Record<string, string | number> = {
    // Why: Gitea returns PRs in the issues list too; `type=issues` filters them
    // server-side (we also drop any stray pull_request rows defensively).
    type: 'issues',
    state: giteaStateParam(state),
    sort: 'recentupdate',
    page: 1,
    limit
  }
  if (assignee === '@me') {
    const login = await resolveViewerLogin(repo)
    if (login) {
      searchParams.assigned_by = login
    }
  }
  // Why: Gitea's `milestones` param accepts comma-separated titles (unique per
  // repo); a single selected title scopes the issue list server-side.
  if (milestone) {
    searchParams.milestones = milestone
  }

  const result = await requestGiteaJsonResult<RawGiteaIssue[]>(
    repo,
    `/repos/${giteaRepoPathSegment(repo)}/issues`,
    { searchParams, timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS }
  )
  if (!result.ok) {
    return { items: [], error: classifyGiteaHttpError(result.status) }
  }

  const items: GitLabIssueInfo[] = []
  for (const raw of result.data) {
    if (isGiteaPullRequestRow(raw)) {
      continue
    }
    const mapped = mapGiteaIssueInfo(raw)
    if (mapped) {
      items.push(mapped)
    }
  }
  return { items }
}

/**
 * Aggregated issue detail for the item dialog: the work item, its markdown
 * body, and the comment thread. Parallel to gitlab getWorkItemDetails, issue
 * branch only (Gitea PRs are handled by the pull-request client).
 */
export async function getGiteaIssueDetails(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabWorkItemDetails | null> {
  const repo = await resolveGiteaRepo(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return null
  }
  const encodedNumber = encodeURIComponent(String(issueNumber))
  const [issueRaw, commentsRaw] = await Promise.all([
    requestGiteaJson<RawGiteaIssue>(
      repo,
      `/repos/${giteaRepoPathSegment(repo)}/issues/${encodedNumber}`,
      { timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS }
    ),
    requestGiteaJson<RawGiteaComment[]>(
      repo,
      `/repos/${giteaRepoPathSegment(repo)}/issues/${encodedNumber}/comments`,
      { timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS }
    )
  ])
  if (!issueRaw) {
    return null
  }
  const item = mapGiteaIssueToWorkItemDetail(issueRaw)
  if (!item) {
    return null
  }
  const comments: MRComment[] = (commentsRaw ?? [])
    .map(mapGiteaComment)
    // Why: oldest-first matches Gitea's own conversation ordering and makes
    // "what's new" intuitive when re-fetching.
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  return {
    item,
    body: issueRaw.body ?? '',
    comments,
    assignees: mapGiteaAssignees(issueRaw)
  }
}

/** Shared with ./issue-mutations so label edits can resolve names → ids. */
export async function fetchGiteaLabelObjects(repo: GiteaRepoRef): Promise<RawGiteaLabel[]> {
  const raw = await requestGiteaJson<RawGiteaLabel[]>(
    repo,
    `/repos/${giteaRepoPathSegment(repo)}/labels`,
    { searchParams: { page: 1, limit: LABEL_PAGE_LIMIT }, timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS }
  )
  return raw ?? []
}

export async function listGiteaLabels(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string[]> {
  const repo = await resolveGiteaRepo(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return []
  }
  return mapGiteaLabelNames(await fetchGiteaLabelObjects(repo))
}

export async function listGiteaMilestones(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaMilestone[]> {
  const repo = await resolveGiteaRepo(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return []
  }
  const raw = await requestGiteaJson<RawGiteaMilestone[]>(
    repo,
    `/repos/${giteaRepoPathSegment(repo)}/milestones`,
    {
      searchParams: { state: 'open', page: 1, limit: LABEL_PAGE_LIMIT },
      timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS
    }
  )
  return mapGiteaMilestones(raw)
}

/**
 * Resolve a single issue from an explicit Gitea repo remote (used by the
 * pasted-URL / smart-workspace lookup). Returns the detail-row shape without a
 * renderer repoId, matching gitlab getWorkItemByProjectRef's issue branch.
 */
export async function getGiteaWorkItemByPath(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<Omit<GitLabWorkItem, 'repoId'> | null> {
  const repo = await resolveGiteaRepo(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return null
  }
  const raw = await requestGiteaJson<RawGiteaIssue>(
    repo,
    `/repos/${giteaRepoPathSegment(repo)}/issues/${encodeURIComponent(String(issueNumber))}`,
    { timeoutMs: GITEA_ISSUE_READ_TIMEOUT_MS }
  )
  if (!raw || isGiteaPullRequestRow(raw)) {
    return null
  }
  return mapGiteaIssueToWorkItemDetail(raw)
}
