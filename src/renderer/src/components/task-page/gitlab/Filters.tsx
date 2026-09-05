import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { cn } from '@/lib/utils'
import TaskProjectSourceCombobox from '@/components/task-project-source-combobox'
import { normalizeTaskRepoSelection } from '@/components/task-page-default-repo-selection'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
export function TaskPageGitLabFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    updateSettings,
    eligibleRepos,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    gitLabIssueFilters,
    gitLabMRFilters,
    getTaskPickerRepoHostLabel,
    setGitlabFilter,
    gitlabLoading,
    setGitlabRefreshNonce,
    gitlabView,
    setGitlabView,
    gitlabTodosLoading,
    activeGitlabFilter,
    taskSource,
    gitlabSearchInput,
    setGitlabSearchInput,
    giteaMilestones,
    activeGiteaMilestone,
    setActiveGiteaMilestone
  } = model
  const isGitea = taskSource === 'gitea'
  const refreshLabel = isGitea
    ? translate('auto.components.TaskPage.gitea.refreshIssues', 'Refresh Gitea issues')
    : gitlabView === 'todos'
      ? translate('auto.components.TaskPage.c679af7ad9', 'Refresh My Todos')
      : translate('auto.components.TaskPage.d4c2830063', 'Refresh GitLab work items')
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* Why: Gitea is issues-only, so hide the GitLab issues/MRs/todos view switch. */}
        {isGitea ? null : (
          <div className="flex items-center gap-1 text-xs">
            {(['issues', 'mrs', 'todos'] as const).map((view) => {
              const active = gitlabView === view
              const label = view === 'issues' ? 'Issues' : view === 'mrs' ? 'MRs' : 'My Todos'
              return (
                <button
                  key={view}
                  type="button"
                  onClick={() => setGitlabView(view)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition',
                    active
                      ? 'border-foreground/40 bg-foreground/90 text-background'
                      : 'border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
        <div className="min-w-0 w-full sm:w-[200px]">
          <TaskProjectSourceCombobox
            groups={taskPickerGroups}
            selected={repoSelection}
            getRepoHostLabel={getTaskPickerRepoHostLabel}
            onChange={(next) => {
              const normalized = normalizeTaskRepoSelection(eligibleRepos, next)
              setRepoSelection(normalized)
              void updateSettings({
                defaultRepoSelection: [...normalized]
              }).catch(() => {
                toast.error(
                  translate(
                    'auto.components.TaskPage.dfd72673e7',
                    'Failed to save project selection.'
                  )
                )
              })
            }}
            onSelectAll={() => {
              const allIds = new Set(taskPickerRepos.map((r) => r.id))
              setRepoSelection(allIds)
              void updateSettings({
                defaultRepoSelection: null
              }).catch(() => {
                toast.error(
                  translate(
                    'auto.components.TaskPage.dfd72673e7',
                    'Failed to save project selection.'
                  )
                )
              })
            }}
            triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
          />
        </div>
      </div>
      <div
        className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm"
        data-contextual-tour-target="tasks-search-presets"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2">
              {gitlabView === 'issues' || gitlabView === 'mrs'
                ? (gitlabView === 'issues' ? gitLabIssueFilters : gitLabMRFilters).map(
                    ({ id, label }) => {
                      const active = activeGitlabFilter === id
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => {
                            setGitlabFilter(id)
                            setGitlabRefreshNonce((n) => n + 1)
                          }}
                          className={cn(
                            'rounded-md border px-2 py-1 text-xs transition',
                            active
                              ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                              : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                          )}
                        >
                          {label}
                        </button>
                      )
                    }
                  )
                : null}
            </div>
            {isGitea && giteaMilestones.length > 0 ? (
              <Select
                value={activeGiteaMilestone}
                onValueChange={(value) => {
                  setActiveGiteaMilestone(value)
                  setGitlabRefreshNonce((n) => n + 1)
                }}
              >
                <SelectTrigger className="h-8 w-[170px] rounded-md border-border/50 bg-transparent text-xs font-medium shadow-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {translate('auto.components.TaskPage.gitea.allMilestones', 'All milestones')}
                  </SelectItem>
                  {giteaMilestones.map((milestone) => (
                    <SelectItem key={milestone.id} value={milestone.title}>
                      {milestone.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {/* Why: the box filters displayedGitLabItems, which the Todos view never renders — same gate as the chip row above. */}
            {gitlabView === 'todos' ? null : (
              <div className="relative min-w-0 flex-1 basis-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-gitlab-items-search-input
                  value={gitlabSearchInput}
                  onChange={(e) => setGitlabSearchInput(e.target.value)}
                  placeholder={
                    isGitea
                      ? translate('auto.components.TaskPage.gitea.searchIssues', 'Search issues...')
                      : translate('auto.components.TaskPage.gitlab.searchItems', 'Search items...')
                  }
                  className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
                />
                {gitlabSearchInput ? (
                  <button
                    type="button"
                    aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
                    onClick={() => setGitlabSearchInput('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <div
            className="flex shrink-0 items-center gap-2"
            data-contextual-tour-target="tasks-actions"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setGitlabRefreshNonce((n) => n + 1)}
                  disabled={gitlabLoading || gitlabTodosLoading}
                  aria-label={refreshLabel}
                  className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                >
                  {gitlabLoading || gitlabTodosLoading ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {refreshLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </>
  )
}
