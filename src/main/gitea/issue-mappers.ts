// Why: Gitea's REST issue payloads are GitHub-shaped, but Orca's Task page
// consumes the GitLab work-item/issue types. Map Gitea JSON straight onto
// those shared shapes so the existing GitLab list + dialog UI can render
// Gitea issues with no new renderer surface.
import type { GitLabIssueInfo, GitLabWorkItem, MRComment } from '../../shared/gitlab-types'

export type RawGiteaUser = {
  login?: string | null
  username?: string | null
  full_name?: string | null
  avatar_url?: string | null
  is_bot?: boolean | null
}

export type RawGiteaLabel = {
  id?: number
  name?: string | null
}

export type RawGiteaMilestone = {
  id?: number
  title?: string | null
} | null

export type RawGiteaIssue = {
  id?: number
  number?: number
  title?: string | null
  body?: string | null
  state?: string | null
  html_url?: string | null
  user?: RawGiteaUser | null
  labels?: RawGiteaLabel[] | null
  assignees?: RawGiteaUser[] | null
  milestone?: RawGiteaMilestone
  updated_at?: string | null
  // Why: Gitea returns PRs in the issues list too; a present `pull_request`
  // object is the GitHub-compatible marker that a row is actually a PR.
  pull_request?: unknown
}

export type RawGiteaComment = {
  id?: number
  html_url?: string | null
  user?: RawGiteaUser | null
  body?: string | null
  created_at?: string | null
}

export function giteaUserLogin(user: RawGiteaUser | null | undefined): string | null {
  const login = user?.login?.trim() || user?.username?.trim()
  return login && login.length > 0 ? login : null
}

/** Present `pull_request` marks a Gitea "issue" row that is really a PR. */
export function isGiteaPullRequestRow(raw: Pick<RawGiteaIssue, 'pull_request'>): boolean {
  return raw.pull_request != null
}

// Why: Gitea uses GitHub's `open`/`closed`; the shared issue type uses
// GitLab's `opened`/`closed`. Normalize so the renderer stays on one vocabulary.
export function mapGiteaIssueState(state: string | null | undefined): 'opened' | 'closed' {
  return state?.trim().toLowerCase() === 'closed' ? 'closed' : 'opened'
}

export function mapGiteaLabelNames(labels: RawGiteaLabel[] | null | undefined): string[] {
  return (labels ?? [])
    .map((label) => label?.name?.trim())
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

export type GiteaMilestone = { id: number; title: string }

export function mapGiteaMilestones(
  milestones: readonly RawGiteaMilestone[] | null | undefined
): GiteaMilestone[] {
  return (milestones ?? [])
    .map((m) =>
      m && typeof m.id === 'number' && m.title?.trim() ? { id: m.id, title: m.title.trim() } : null
    )
    .filter((m): m is GiteaMilestone => m !== null)
}

/** Single-issue shape used by pasted-URL lookups and detail fetches. */
export function mapGiteaIssueInfo(raw: RawGiteaIssue): GitLabIssueInfo | null {
  if (typeof raw.number !== 'number' || !raw.html_url) {
    return null
  }
  const author = giteaUserLogin(raw.user)
  return {
    number: raw.number,
    title: raw.title ?? '',
    state: mapGiteaIssueState(raw.state),
    url: raw.html_url,
    labels: mapGiteaLabelNames(raw.labels),
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    ...(typeof raw.body === 'string' ? { description: raw.body } : {}),
    ...(author ? { author } : {}),
    ...(raw.user?.avatar_url ? { authorAvatarUrl: raw.user.avatar_url } : {})
  }
}

function giteaWorkItemId(repoId: string, issueNumber: number): string {
  return `gitea-issue-${repoId}-${issueNumber}`
}

/** List-row shape shared with GitLab MRs on the Task page. `repoId` is stamped
 *  by the caller (runtime) so this file stays independent of Orca's Repo.id. */
export function mapGiteaIssueToWorkItem(raw: RawGiteaIssue, repoId: string): GitLabWorkItem | null {
  if (typeof raw.number !== 'number' || !raw.html_url) {
    return null
  }
  return {
    id: giteaWorkItemId(repoId, raw.number),
    type: 'issue',
    number: raw.number,
    title: raw.title ?? '',
    state: mapGiteaIssueState(raw.state),
    url: raw.html_url,
    labels: mapGiteaLabelNames(raw.labels),
    updatedAt: raw.updated_at ?? '',
    author: giteaUserLogin(raw.user),
    repoId
  }
}

/** Stamps Orca's Repo.id onto a listed issue. The desktop IPC handler and the
 *  runtime command both serve the same Task page rows, so they share this. */
export function mapGiteaIssueInfoToWorkItem(
  issue: GitLabIssueInfo,
  repoId: string
): GitLabWorkItem {
  return {
    id: giteaWorkItemId(repoId, issue.number),
    type: 'issue',
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    labels: issue.labels,
    updatedAt: issue.updatedAt ?? '',
    author: issue.author ?? null,
    repoId
  }
}

/** Detail-drawer row shape without the renderer-stamped repoId. */
export function mapGiteaIssueToWorkItemDetail(
  raw: RawGiteaIssue
): Omit<GitLabWorkItem, 'repoId'> | null {
  const full = mapGiteaIssueToWorkItem(raw, '')
  if (!full) {
    return null
  }
  const { repoId: _repoId, ...rest } = full
  return rest
}

export function mapGiteaComment(raw: RawGiteaComment): MRComment {
  return {
    id: raw.id ?? Date.now(),
    author: giteaUserLogin(raw.user) ?? 'unknown',
    authorAvatarUrl: raw.user?.avatar_url ?? '',
    body: raw.body ?? '',
    createdAt: raw.created_at ?? '',
    url: raw.html_url ?? '',
    isBot: raw.user?.is_bot === true
  }
}

export function mapGiteaAssignees(raw: RawGiteaIssue): string[] {
  return (raw.assignees ?? [])
    .map((user) => giteaUserLogin(user))
    .filter((login): login is string => typeof login === 'string')
}
