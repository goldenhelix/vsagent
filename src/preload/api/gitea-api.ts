import type { TaskSourceContext } from '../../shared/task-source-context'
import type { ClassifiedError } from '../../shared/classified-error'
import type {
  GitLabCommentResult,
  GitLabIssueUpdate,
  GitLabWorkItem,
  GitLabWorkItemDetails
} from '../../shared/gitlab-types'
import type { PreflightStatus } from './preflight-api'

export type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  /** Desktop IPC-only owner guard; web adapters remove it before runtime RPC. */
  repoOwnerExecutionHostId?: string
}

// Why: Gitea issues reuse the shared GitLab work-item shapes on the Task page,
// so its preload surface mirrors `gl` (issue subset) with the same selector.
// Gitea is issues-only (no MRs/pipelines/todos here) — reuse the preflight
// status shape instead of redeclaring an auth-diagnostic type.
export type GiteaApi = {
  diagnoseAuth: () => Promise<NonNullable<PreflightStatus['gitea']>>
  listIssues: (
    args: GiteaRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'all'
      assignee?: string
      limit?: number
      milestone?: string
    }
  ) => Promise<{ items: GitLabWorkItem[]; error?: ClassifiedError }>
  listLabels: (args: GiteaRepoSelectorArgs) => Promise<string[]>
  listMilestones: (args: GiteaRepoSelectorArgs) => Promise<{ id: number; title: string }[]>
  updateIssue: (
    args: GiteaRepoSelectorArgs & {
      number: number
      updates: GitLabIssueUpdate
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  addIssueComment: (
    args: GiteaRepoSelectorArgs & {
      number: number
      body: string
    }
  ) => Promise<GitLabCommentResult>
  workItemDetails: (
    args: GiteaRepoSelectorArgs & { iid: number }
  ) => Promise<GitLabWorkItemDetails | null>
  workItemByPath: (
    args: GiteaRepoSelectorArgs & { iid: number }
  ) => Promise<Omit<GitLabWorkItem, 'repoId'> | null>
}
