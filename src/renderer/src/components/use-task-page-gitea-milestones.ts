import type { TaskPageGitLabLoadingModel } from './use-task-page-gitlab-loading'
import { useEffect } from 'react'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
export function useTaskPageGiteaMilestones(model: TaskPageGitLabLoadingModel) {
  const { taskSource, primaryRepo, selectedReposKey, setGiteaMilestones, setActiveGiteaMilestone } =
    model
  // Why: Gitea milestones are per-repo, so fetch them for the primary selected repo. Reset a stale selection to 'all' when the repo changes so a title from one project isn't sent to another.
  useEffect(() => {
    if (taskSource !== 'gitea' || !primaryRepo?.path) {
      setGiteaMilestones([])
      return
    }
    let stale = false
    void window.api.gitea
      .listMilestones({
        repoPath: primaryRepo.path,
        repoId: primaryRepo.id,
        sourceContext: getTaskPageRepoSourceContext(primaryRepo, 'gitea')
      })
      .then((milestones) => {
        if (stale) {
          return
        }
        const list = Array.isArray(milestones) ? milestones : []
        setGiteaMilestones(list)
        setActiveGiteaMilestone((current) =>
          current !== 'all' && !list.some((m) => m.title === current) ? 'all' : current
        )
      })
      .catch(() => {
        if (!stale) {
          // Why: the Select unmounts on an empty list, so a failed fetch must also drop the
          // selection — otherwise a server-side milestone filter stays applied with no UI to clear it.
          setGiteaMilestones([])
          setActiveGiteaMilestone('all')
        }
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedReposKey encodes the primaryRepo fields read above; keying off the object would re-run on every parent render.
  }, [taskSource, selectedReposKey, setGiteaMilestones, setActiveGiteaMilestone])
  return model
}
export type TaskPageGiteaMilestonesModel = ReturnType<typeof useTaskPageGiteaMilestones>
