/* Gitea preload bindings — split out of `src/preload/index.ts` (like
   `./gitlab`) so adding or changing a `gitea.*` channel doesn't surface as a
   merge conflict on every upstream sync of the central preload file. Composed
   back into `api.gitea` from `index.ts`. */
import { ipcRenderer } from 'electron'
import type { TaskSourceContext } from '../shared/task-source-context'
import type { GitLabIssueUpdate } from '../shared/gitlab-types'

type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

export const giteaApi = {
  diagnoseAuth: () => ipcRenderer.invoke('gitea:diagnoseAuth'),

  listIssues: (
    args: GiteaRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'all'
      assignee?: string
      limit?: number
      milestone?: string
    }
  ) => ipcRenderer.invoke('gitea:listIssues', args),

  listLabels: (args: GiteaRepoSelectorArgs): Promise<string[]> =>
    ipcRenderer.invoke('gitea:listLabels', args),

  listMilestones: (args: GiteaRepoSelectorArgs): Promise<{ id: number; title: string }[]> =>
    ipcRenderer.invoke('gitea:listMilestones', args),

  updateIssue: (
    args: GiteaRepoSelectorArgs & { number: number; updates: GitLabIssueUpdate }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gitea:updateIssue', args),

  addIssueComment: (args: GiteaRepoSelectorArgs & { number: number; body: string }) =>
    ipcRenderer.invoke('gitea:addIssueComment', args),

  workItemDetails: (args: GiteaRepoSelectorArgs & { iid: number }) =>
    ipcRenderer.invoke('gitea:workItemDetails', args),

  workItemByPath: (args: GiteaRepoSelectorArgs & { iid: number }) =>
    ipcRenderer.invoke('gitea:workItemByPath', args)
}
