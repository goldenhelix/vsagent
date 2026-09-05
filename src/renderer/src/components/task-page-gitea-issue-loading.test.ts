// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageProviderMetadataModel } from './use-task-page-provider-metadata'
import type { TaskPageGitLabLoadingModel } from './use-task-page-gitlab-loading'
import type { TaskPageSourceAvailabilityModel } from './use-task-page-source-availability'
import { useTaskPageGitLabLoading } from './use-task-page-gitlab-loading'
import { useTaskPageGiteaMilestones } from './use-task-page-gitea-milestones'
import { useTaskPageProviderState } from './use-task-page-provider-state'

type FakeRepo = { id: string; path: string; name: string }

const repoA: FakeRepo = { id: 'repo-a', path: '/src/a', name: 'a' }
const repoB: FakeRepo = { id: 'repo-b', path: '/src/b', name: 'b' }

function issue(number: number, url: string) {
  return { id: `issue-${number}`, number, title: `Issue ${number}`, type: 'issue', url }
}

const giteaApi = {
  listIssues: vi.fn(),
  listMilestones: vi.fn()
}
const glApi = {
  listIssues: vi.fn(),
  listMRs: vi.fn(),
  todos: vi.fn()
}

function loadingModel(overrides: Record<string, unknown>) {
  return {
    selectedRepos: [repoA],
    selectedReposKey: 'repo-a',
    primaryRepo: repoA,
    taskSource: 'gitea',
    gitlabView: 'issues',
    activeGitlabFilter: 'opened',
    activeGiteaMilestone: 'all',
    gitlabRefreshNonce: 0,
    setGitlabItems: vi.fn(),
    setGitlabLoading: vi.fn(),
    setGitlabError: vi.fn(),
    setGitlabTodos: vi.fn(),
    setGitlabTodosLoading: vi.fn(),
    ...overrides
  } as unknown as TaskPageProviderMetadataModel
}

function milestonesModel(overrides: Record<string, unknown>) {
  return {
    taskSource: 'gitea',
    primaryRepo: repoA,
    selectedReposKey: 'repo-a',
    setGiteaMilestones: vi.fn(),
    setActiveGiteaMilestone: vi.fn(),
    ...overrides
  } as unknown as TaskPageGitLabLoadingModel
}

beforeEach(() => {
  vi.clearAllMocks()
  giteaApi.listIssues.mockResolvedValue({ items: [] })
  giteaApi.listMilestones.mockResolvedValue([])
  glApi.listIssues.mockResolvedValue({ items: [] })
  glApi.listMRs.mockResolvedValue({ items: [] })
  Object.defineProperty(globalThis, 'window', {
    value: Object.assign(globalThis.window ?? {}, {
      api: { gitea: giteaApi, gl: glApi }
    }),
    configurable: true,
    writable: true
  })
})

describe('useTaskPageGitLabLoading — Gitea routing', () => {
  it('fetches Gitea issues through window.api.gitea with the active milestone', async () => {
    const setGitlabItems = vi.fn()
    giteaApi.listIssues.mockResolvedValue({
      items: [issue(7, 'https://gitea.example/o/r/issues/7')]
    })

    renderHook(() =>
      useTaskPageGitLabLoading(
        loadingModel({ activeGiteaMilestone: 'v1.2', setGitlabItems })
      )
    )

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(glApi.listIssues).not.toHaveBeenCalled()
    expect(giteaApi.listIssues).toHaveBeenCalledOnce()
    expect(giteaApi.listIssues.mock.calls[0][0]).toMatchObject({
      repoPath: '/src/a',
      milestone: 'v1.2',
      state: 'opened',
      limit: 50
    })
    expect(giteaApi.listIssues.mock.calls[0][0].sourceContext).toMatchObject({ provider: 'gitea' })
  })

  it('omits milestone when the filter is "all"', async () => {
    const setGitlabItems = vi.fn()

    renderHook(() => useTaskPageGitLabLoading(loadingModel({ setGitlabItems })))

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(giteaApi.listIssues.mock.calls[0][0]).not.toHaveProperty('milestone')
  })

  it('pins the view to issues so a stale "mrs" view never fetches Gitea MRs', async () => {
    const setGitlabItems = vi.fn()

    renderHook(() =>
      useTaskPageGitLabLoading(loadingModel({ gitlabView: 'mrs', setGitlabItems }))
    )

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(giteaApi.listIssues).toHaveBeenCalledOnce()
    expect(glApi.listMRs).not.toHaveBeenCalled()
  })

  it('dedups one issue reached through two repo entries by its URL', async () => {
    const setGitlabItems = vi.fn()
    const shared = issue(11, 'https://gitea.example/o/r/issues/11')
    giteaApi.listIssues.mockResolvedValue({ items: [shared] })

    renderHook(() =>
      useTaskPageGitLabLoading(
        loadingModel({
          selectedRepos: [repoA, repoB],
          selectedReposKey: 'repo-a|repo-b',
          setGitlabItems
        })
      )
    )

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(giteaApi.listIssues).toHaveBeenCalledTimes(2)
    const merged = setGitlabItems.mock.calls.at(-1)?.[0] as { id: string; repoId: string }[]
    expect(merged).toHaveLength(1)
    expect(merged[0].repoId).toBe('repo-a')
  })

  it('keeps distinct issues that share no URL', async () => {
    const setGitlabItems = vi.fn()
    giteaApi.listIssues
      .mockResolvedValueOnce({ items: [issue(1, 'https://gitea.example/o/r/issues/1')] })
      .mockResolvedValueOnce({ items: [issue(2, 'https://gitea.example/o/r/issues/2')] })

    renderHook(() =>
      useTaskPageGitLabLoading(
        loadingModel({
          selectedRepos: [repoA, repoB],
          selectedReposKey: 'repo-a|repo-b',
          setGitlabItems
        })
      )
    )

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    const merged = setGitlabItems.mock.calls.at(-1)?.[0] as unknown[]
    expect(merged).toHaveLength(2)
  })

  it('still routes GitLab issues to window.api.gl without a milestone', async () => {
    const setGitlabItems = vi.fn()

    renderHook(() =>
      useTaskPageGitLabLoading(
        loadingModel({ taskSource: 'gitlab', activeGiteaMilestone: 'v1.2', setGitlabItems })
      )
    )

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(giteaApi.listIssues).not.toHaveBeenCalled()
    expect(glApi.listIssues).toHaveBeenCalledOnce()
    expect(glApi.listIssues.mock.calls[0][0]).not.toHaveProperty('milestone')
  })
})

function providerStateModel(taskSource: string) {
  return {
    settings: null,
    pageData: { taskSource: null },
    selectedRepos: [repoA],
    visibleTaskProviders: ['github', 'gitlab', 'gitea'],
    preferredTaskSource: 'github',
    taskSource,
    setTaskSource: vi.fn()
  } as unknown as TaskPageSourceAvailabilityModel
}

describe('useTaskPageProviderState — Gitea view + search', () => {
  it('pins the shared GitLab view to issues on the Gitea tab without clobbering the GitLab view', () => {
    const view = renderHook(({ source }) => useTaskPageProviderState(providerStateModel(source)), {
      initialProps: { source: 'gitea' }
    })

    expect(view.result.current.gitlabView).toBe('issues')
    expect(view.result.current.gitlabEmptyState.title).toBe('No Gitea issues')

    view.rerender({ source: 'gitlab' })

    expect(view.result.current.gitlabView).toBe('mrs')
    expect(view.result.current.gitlabEmptyState.title).toBe('No GitLab merge requests')
  })

  it('filters the displayed rows by the shared search box', () => {
    const view = renderHook(() => useTaskPageProviderState(providerStateModel('gitea')))

    act(() => {
      view.result.current.setGitlabItems([
        issue(1, 'https://gitea.example/o/r/issues/1'),
        issue(2, 'https://gitea.example/o/r/issues/2')
      ] as never)
    })
    expect(view.result.current.displayedGitLabItems).toHaveLength(2)

    act(() => {
      view.result.current.setGitlabSearchInput('issue 2')
    })
    expect(view.result.current.displayedGitLabItems.map((item) => item.number)).toEqual([2])
  })
})

describe('useTaskPageGiteaMilestones', () => {
  it('loads milestones for the primary repo and keeps a still-valid selection', async () => {
    const setGiteaMilestones = vi.fn()
    const setActiveGiteaMilestone = vi.fn()
    giteaApi.listMilestones.mockResolvedValue([{ id: 1, title: 'v1.2' }])

    renderHook(() =>
      useTaskPageGiteaMilestones(milestonesModel({ setGiteaMilestones, setActiveGiteaMilestone }))
    )

    await waitFor(() => expect(setGiteaMilestones).toHaveBeenCalledWith([{ id: 1, title: 'v1.2' }]))
    const resolve = setActiveGiteaMilestone.mock.calls[0][0] as (current: string) => string
    expect(resolve('v1.2')).toBe('v1.2')
    expect(resolve('all')).toBe('all')
  })

  it('resets a milestone the newly selected repo does not have', async () => {
    const setActiveGiteaMilestone = vi.fn()
    giteaApi.listMilestones.mockResolvedValue([{ id: 2, title: 'v2.0' }])

    renderHook(() => useTaskPageGiteaMilestones(milestonesModel({ setActiveGiteaMilestone })))

    await waitFor(() => expect(setActiveGiteaMilestone).toHaveBeenCalled())
    const resolve = setActiveGiteaMilestone.mock.calls[0][0] as (current: string) => string
    expect(resolve('v1.2')).toBe('all')
  })

  it('drops the milestone selection when the fetch fails so no hidden server filter survives', async () => {
    const setGiteaMilestones = vi.fn()
    const setActiveGiteaMilestone = vi.fn()
    giteaApi.listMilestones.mockRejectedValue(new Error('offline'))

    renderHook(() =>
      useTaskPageGiteaMilestones(milestonesModel({ setGiteaMilestones, setActiveGiteaMilestone }))
    )

    await waitFor(() => expect(setActiveGiteaMilestone).toHaveBeenCalledWith('all'))
    expect(setGiteaMilestones).toHaveBeenLastCalledWith([])
  })

  it('clears milestones and issues no request off the Gitea tab', () => {
    const setGiteaMilestones = vi.fn()

    renderHook(() =>
      useTaskPageGiteaMilestones(milestonesModel({ taskSource: 'gitlab', setGiteaMilestones }))
    )

    expect(setGiteaMilestones).toHaveBeenCalledWith([])
    expect(giteaApi.listMilestones).not.toHaveBeenCalled()
  })
})
