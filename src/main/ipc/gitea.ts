// Why: parallel to ipc/gitlab.ts — keeping all Gitea issue IPC handlers
// co-located keeps the repo-path validation pattern reviewable as one surface.
// Desktop-mode counterpart of the web runtime's gitea.* RPC methods.
import { ipcMain } from 'electron'
import type { GitLabIssueUpdate, GitLabWorkItem } from '../../shared/gitlab-types'
import type { Store } from '../persistence'
import { normalizeGitLabIssueListArgs } from '../gitlab/gitlab-preload-args'
import { getGiteaAuthStatus } from '../gitea/client'
import { mapGiteaIssueInfoToWorkItem } from '../gitea/issue-mappers'
import {
  getGiteaIssueDetails,
  getGiteaWorkItemByPath,
  listGiteaIssues,
  listGiteaLabels,
  listGiteaMilestones
} from '../gitea/issues'
import { addGiteaIssueComment, updateGiteaIssue } from '../gitea/issue-mutations'
// Why: Gitea shares GitLab's selector contract, so it also inherits the
// registered-repo and owner-host guards rather than re-declaring them.
import type { GitLabRepoSelectorArgs as GiteaRepoSelectorArgs } from './gitlab-repo-access'
import { assertRegisteredRepo, localGitOptionArgs, repoConnectionId } from './gitlab-repo-access'

function assertRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store) {
  return assertRegisteredRepo(args, store, 'gitea')
}

export function registerGiteaHandlers(store: Store): void {
  ipcMain.handle('gitea:diagnoseAuth', async () => getGiteaAuthStatus())

  ipcMain.handle(
    'gitea:listIssues',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        state?: string
        assignee?: string
        limit?: number
        milestone?: string
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      const normalized = normalizeGitLabIssueListArgs(args)
      const result = await listGiteaIssues(
        repo.path,
        normalized.limit,
        normalized.state,
        normalized.assignee,
        args.milestone?.trim() || undefined,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
      const items: GitLabWorkItem[] = result.items.map((issue) =>
        mapGiteaIssueInfoToWorkItem(issue, repo.id)
      )
      return { items, ...(result.error ? { error: result.error } : {}) }
    }
  )

  ipcMain.handle('gitea:listLabels', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredGiteaRepo(args, store)
    return listGiteaLabels(repo.path, repoConnectionId(repo), ...localGitOptionArgs(store, repo))
  })

  ipcMain.handle('gitea:listMilestones', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredGiteaRepo(args, store)
    return listGiteaMilestones(
      repo.path,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle(
    'gitea:updateIssue',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { number: number; updates: GitLabIssueUpdate }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return updateGiteaIssue(
        repo.path,
        args.number,
        args.updates,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:addIssueComment',
    async (_event, args: GiteaRepoSelectorArgs & { number: number; body: string }) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return addGiteaIssueComment(
        repo.path,
        args.number,
        args.body,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:workItemDetails',
    async (_event, args: GiteaRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return getGiteaIssueDetails(
        repo.path,
        args.iid,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:workItemByPath',
    async (_event, args: GiteaRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return getGiteaWorkItemByPath(
        repo.path,
        args.iid,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )
}
