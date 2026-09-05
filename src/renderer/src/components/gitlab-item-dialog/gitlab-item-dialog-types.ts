import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type GitLabItemDialogProps = {
  item: GitLabWorkItem | null
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  // Why: Gitea reuses this dialog for its issues. Issue detail/comment calls
  // route to the gitea preload namespace; MR-only actions never fire for Gitea
  // (its items are always type 'issue').
  provider?: 'gitlab' | 'gitea'
  onClose: () => void
  onCreateWorkspace?: (item: GitLabWorkItem) => void
}

export type GitLabDialogRepoSelector = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}
