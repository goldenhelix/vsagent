import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import GitLabItemDialog from '@/components/GitLabItemDialog'
export function TaskPageGitLabDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    gitlabDialogItem,
    setGitlabDialogItem,
    gitlabDialogRepo,
    gitlabDialogSourceContext,
    handleUseGitLabItem
  } = model
  return (
    <GitLabItemDialog
      item={gitlabDialogItem}
      // Why: repoPath comes from the clicked item's own repo, not primaryRepo — the GitLab fetch is now multi-repo.
      repoPath={gitlabDialogRepo?.path ?? null}
      repoId={gitlabDialogItem?.repoId ?? null}
      sourceContext={gitlabDialogSourceContext}
      // Why: Gitea reuses this dialog; route its issue detail/comment calls to
      // the gitea preload namespace instead of gl.*.
      provider={gitlabDialogSourceContext?.provider === 'gitea' ? 'gitea' : 'gitlab'}
      onCreateWorkspace={(item) => {
        setGitlabDialogItem(null)
        handleUseGitLabItem(item)
      }}
      onClose={() => setGitlabDialogItem(null)}
    />
  )
}
