// Why: headless/web counterpart of ipc/gitea.ts — the same eight Gitea issue
// operations, resolved through the runtime's repo selector instead of a store
// lookup. Modelled on runtime-gitlab-query-commands.ts.
import type { GitLabIssueUpdate, GitLabWorkItem } from '../../shared/gitlab-types'
import type { Repo } from '../../shared/repo-types'
import { getGiteaAuthStatus } from '../gitea/client'
import { mapGiteaIssueInfoToWorkItem } from '../gitea/issue-mappers'
import { addGiteaIssueComment, updateGiteaIssue } from '../gitea/issue-mutations'
import {
  getGiteaIssueDetails,
  getGiteaWorkItemByPath,
  listGiteaIssues,
  listGiteaLabels,
  listGiteaMilestones,
  type GiteaIssueListState
} from '../gitea/issues'
import { normalizeGitLabIssueListArgs } from '../gitlab/gitlab-preload-args'

type LocalGitArgs = [] | [{ wslDistro?: string }]

export type RuntimeGiteaCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGiteaCommands {
  constructor(private readonly deps: RuntimeGiteaCommandsDeps) {}

  async listGiteaRepoIssues(
    repoSelector: string,
    state?: GiteaIssueListState,
    assignee?: string,
    limit?: number,
    milestone?: string
  ): Promise<{
    items: GitLabWorkItem[]
    error?: Awaited<ReturnType<typeof listGiteaIssues>>['error']
  }> {
    const repo = await this.deps.resolveRepo(repoSelector)
    // Why: Gitea issue filters reuse GitLab's opened/closed/all + "@me" contract
    // so the Task page source lookup is shared between the two providers.
    const normalized = normalizeGitLabIssueListArgs({ state, assignee, limit })
    const result = await listGiteaIssues(
      repo.path,
      normalized.limit,
      normalized.state,
      normalized.assignee,
      // Why: milestone is a free-text repo title, not a GitLab flag, so it is
      // threaded around normalizeGitLabIssueListArgs (which is GitLab-scoped).
      milestone?.trim() || undefined,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
    const items: GitLabWorkItem[] = result.items.map((issue) =>
      mapGiteaIssueInfoToWorkItem(issue, repo.id)
    )
    return { items, ...(result.error ? { error: result.error } : {}) }
  }

  diagnoseGiteaAuth(): Promise<Awaited<ReturnType<typeof getGiteaAuthStatus>>> {
    return getGiteaAuthStatus()
  }

  async listGiteaRepoLabels(repoSelector: string): Promise<string[]> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listGiteaLabels(repo.path, repo.connectionId ?? null, ...this.deps.getLocalGitArgs(repo))
  }

  async listGiteaRepoMilestones(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listGiteaMilestones>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return listGiteaMilestones(
      repo.path,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async updateGiteaRepoIssue(
    repoSelector: string,
    issueNumber: number,
    updates: GitLabIssueUpdate
  ): Promise<Awaited<ReturnType<typeof updateGiteaIssue>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return updateGiteaIssue(
      repo.path,
      issueNumber,
      updates,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async addGiteaRepoIssueComment(
    repoSelector: string,
    issueNumber: number,
    body: string
  ): Promise<Awaited<ReturnType<typeof addGiteaIssueComment>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return addGiteaIssueComment(
      repo.path,
      issueNumber,
      body,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getGiteaRepoWorkItemDetails(
    repoSelector: string,
    iid: number
  ): Promise<Awaited<ReturnType<typeof getGiteaIssueDetails>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getGiteaIssueDetails(
      repo.path,
      iid,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getGiteaRepoWorkItemByPath(
    repoSelector: string,
    iid: number
  ): Promise<Awaited<ReturnType<typeof getGiteaWorkItemByPath>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getGiteaWorkItemByPath(
      repo.path,
      iid,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }
}
