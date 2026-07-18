// Why: parallel to ipc/gitlab.ts — keeping all Gitea issue IPC handlers
// co-located keeps the repo-path validation pattern reviewable as one surface.
// Desktop-mode counterpart of the web runtime's gitea.* RPC methods.
import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import type { GitLabIssueUpdate, Repo } from '../../shared/types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import { normalizeGitLabIssueListArgs } from '../gitlab/gitlab-preload-args'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getGiteaAuthStatus } from '../gitea/client'
import {
  getGiteaIssueDetails,
  getGiteaWorkItemByPath,
  listGiteaIssues,
  listGiteaLabels
} from '../gitea/issues'
import { addGiteaIssueComment, updateGiteaIssue } from '../gitea/issue-mutations'
import type { GitLabWorkItem } from '../../shared/types'

type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

function findRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store): Repo | undefined {
  const sourceRepoId =
    args.sourceContext?.provider === 'gitea' ? args.sourceContext.repoId?.trim() : null
  const repoId = args.repoId?.trim() || sourceRepoId || null
  if (repoId) {
    const repo = store.getRepo(repoId)
    if (repo) {
      return repo
    }
  }
  const resolvedRepoPath = resolve(args.repoPath)
  return store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
}

// Why: mirror gitlab.ts assertRegisteredRepo — handlers must never operate on a
// path the user hasn't registered as a repo (filesystem-auth boundary).
function assertRegisteredRepo(args: GiteaRepoSelectorArgs, store: Store): Repo {
  const repo = findRegisteredGiteaRepo(args, store)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  if (
    args.sourceContext?.provider === 'gitea' &&
    args.sourceContext.hostId !== getRepoExecutionHostId(repo)
  ) {
    throw new Error('Access denied: Gitea source host does not match repository host')
  }
  return repo
}

function localGitOptionArgs(store: Store, repo: Repo): [] | [{ wslDistro?: string }] {
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return localGitOptions.wslDistro ? [{ wslDistro: localGitOptions.wslDistro }] : []
}

export function registerGiteaHandlers(store: Store): void {
  ipcMain.handle('gitea:diagnoseAuth', async () => getGiteaAuthStatus())

  ipcMain.handle(
    'gitea:listIssues',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { state?: string; assignee?: string; limit?: number }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const normalized = normalizeGitLabIssueListArgs(args)
      const result = await listGiteaIssues(
        repo.path,
        normalized.limit,
        normalized.state,
        normalized.assignee,
        repo.connectionId ?? null,
        ...localGitOptionArgs(store, repo)
      )
      const items: GitLabWorkItem[] = result.items.map((issue) => ({
        id: `gitea-issue-${repo.id}-${issue.number}`,
        type: 'issue' as const,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.url,
        labels: issue.labels,
        updatedAt: issue.updatedAt ?? '',
        author: issue.author ?? null,
        repoId: repo.id
      }))
      return { items, ...(result.error ? { error: result.error } : {}) }
    }
  )

  ipcMain.handle('gitea:listLabels', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listGiteaLabels(repo.path, repo.connectionId ?? null, ...localGitOptionArgs(store, repo))
  })

  ipcMain.handle(
    'gitea:updateIssue',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { number: number; updates: GitLabIssueUpdate }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return updateGiteaIssue(
        repo.path,
        args.number,
        args.updates,
        repo.connectionId ?? null,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:addIssueComment',
    async (_event, args: GiteaRepoSelectorArgs & { number: number; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return addGiteaIssueComment(
        repo.path,
        args.number,
        args.body,
        repo.connectionId ?? null,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:workItemDetails',
    async (_event, args: GiteaRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return getGiteaIssueDetails(
        repo.path,
        args.iid,
        repo.connectionId ?? null,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:workItemByPath',
    async (_event, args: GiteaRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return getGiteaWorkItemByPath(
        repo.path,
        args.iid,
        repo.connectionId ?? null,
        ...localGitOptionArgs(store, repo)
      )
    }
  )
}
