import { translate } from '@/i18n/i18n'

export type RepoBackedTaskEmptyStateProvider = 'github' | 'gitlab' | 'gitea'

export type RepoBackedTaskEmptyState = {
  title: string
  description: string
}

export function getRepoBackedTaskEmptyState(args: {
  provider: RepoBackedTaskEmptyStateProvider
  selectedRepoCount: number
  gitlabView?: 'issues' | 'mrs' | 'todos'
}): RepoBackedTaskEmptyState {
  if (args.selectedRepoCount === 0) {
    return {
      title: translate(
        'auto.components.taskPageEmptyState.noProjectSourcesTitle',
        'No project sources selected'
      ),
      description: translate(
        'auto.components.taskPageEmptyState.noProjectSourcesDescription',
        'Select at least one project source so Orca knows which host/account to fetch tasks from.'
      )
    }
  }
  if (args.provider === 'github') {
    return {
      title: translate(
        'auto.components.taskPageEmptyState.noMatchingGitHubWorkTitle',
        'No matching GitHub work'
      ),
      description: translate(
        'auto.components.taskPageEmptyState.changeQueryDescription',
        'Change the query or clear it.'
      )
    }
  }
  if (args.provider === 'gitea') {
    // Why: Gitea is issues-only on the Task page (no MRs/todos), so its empty
    // state is a single issue message rather than the GitLab view switch.
    return {
      title: translate('auto.components.taskPageEmptyState.noGiteaIssuesTitle', 'No Gitea issues'),
      description: translate(
        'auto.components.taskPageEmptyState.noGiteaIssuesDescription',
        'No Gitea issues match this filter.'
      )
    }
  }
  switch (args.gitlabView) {
    case 'issues':
      return {
        title: translate(
          'auto.components.taskPageEmptyState.noGitLabIssuesTitle',
          'No GitLab issues'
        ),
        description: translate(
          'auto.components.taskPageEmptyState.noGitLabIssuesDescription',
          'No GitLab issues match this filter.'
        )
      }
    case 'mrs':
      return {
        title: translate(
          'auto.components.taskPageEmptyState.noGitLabMrsTitle',
          'No GitLab merge requests'
        ),
        description: translate(
          'auto.components.taskPageEmptyState.noGitLabMrsDescription',
          'No GitLab MRs match this filter.'
        )
      }
    case 'todos':
    case undefined:
      return {
        title: translate('auto.components.taskPageEmptyState.noGitLabWorkTitle', 'No GitLab work'),
        description: translate(
          'auto.components.taskPageEmptyState.noGitLabWorkDescription',
          'No GitLab work matches this filter.'
        )
      }
  }
}
