import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { toSshExecutionHostId } from '../../shared/execution-host'

const {
  ipcHandlers,
  getGiteaAuthStatusMock,
  listGiteaIssuesMock,
  listGiteaLabelsMock,
  listGiteaMilestonesMock,
  getGiteaIssueDetailsMock,
  getGiteaWorkItemByPathMock,
  addGiteaIssueCommentMock,
  updateGiteaIssueMock
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  getGiteaAuthStatusMock: vi.fn(),
  listGiteaIssuesMock: vi.fn(),
  listGiteaLabelsMock: vi.fn(),
  listGiteaMilestonesMock: vi.fn(),
  getGiteaIssueDetailsMock: vi.fn(),
  getGiteaWorkItemByPathMock: vi.fn(),
  addGiteaIssueCommentMock: vi.fn(),
  updateGiteaIssueMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('../gitea/client', () => ({
  getGiteaAuthStatus: getGiteaAuthStatusMock
}))

vi.mock('../gitea/issues', () => ({
  getGiteaIssueDetails: getGiteaIssueDetailsMock,
  getGiteaWorkItemByPath: getGiteaWorkItemByPathMock,
  listGiteaIssues: listGiteaIssuesMock,
  listGiteaLabels: listGiteaLabelsMock,
  listGiteaMilestones: listGiteaMilestonesMock
}))

vi.mock('../gitea/issue-mutations', () => ({
  addGiteaIssueComment: addGiteaIssueCommentMock,
  updateGiteaIssue: updateGiteaIssueMock
}))

import { registerGiteaHandlers } from './gitea'

const localRepo: Repo = {
  id: 'repo-local',
  path: '/local/orca',
  displayName: 'Orca',
  badgeColor: '#737373',
  addedAt: 1
}

const sshRepo: Repo = {
  ...localRepo,
  id: 'repo-ssh',
  path: '/ssh/orca',
  connectionId: 'builder',
  executionHostId: toSshExecutionHostId('builder')
}

function storeWithRepos(repos: Repo[]): Store {
  return {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((candidate) => candidate.id === id),
    getProjects: () => [],
    getSettings: () => ({}) as ReturnType<Store['getSettings']>
  } as unknown as Store
}

function register(repos: Repo[] = [localRepo, sshRepo]): void {
  registerGiteaHandlers(storeWithRepos(repos))
}

function invoke(channel: string, args?: unknown): Promise<unknown> {
  const handler = ipcHandlers.get(channel)
  if (!handler) {
    throw new Error(`missing handler: ${channel}`)
  }
  return Promise.resolve(handler(null, args))
}

describe('Gitea IPC handlers', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    vi.clearAllMocks()
  })

  it('registers exactly the eight gitea channels', () => {
    register()
    expect([...ipcHandlers.keys()].sort()).toEqual([
      'gitea:addIssueComment',
      'gitea:diagnoseAuth',
      'gitea:listIssues',
      'gitea:listLabels',
      'gitea:listMilestones',
      'gitea:updateIssue',
      'gitea:workItemByPath',
      'gitea:workItemDetails'
    ])
  })

  it('resolves the repo from a Gitea source context and stamps mapped issue rows', async () => {
    listGiteaIssuesMock.mockResolvedValueOnce({
      items: [
        {
          number: 7,
          title: 'Broken login',
          state: 'opened',
          url: 'https://gitea.example/org/repo/issues/7',
          labels: ['bug'],
          updatedAt: '2026-01-01T00:00:00Z',
          author: 'ada'
        }
      ]
    })
    register()

    await expect(
      invoke('gitea:listIssues', {
        repoPath: '/does/not/matter',
        state: 'closed',
        assignee: '@me',
        limit: 50,
        milestone: '  v1.0  ',
        sourceContext: {
          kind: 'task-source',
          provider: 'gitea',
          projectId: 'gitea:org/repo',
          hostId: toSshExecutionHostId('builder'),
          repoId: 'repo-ssh'
        }
      })
    ).resolves.toEqual({
      items: [
        {
          id: 'gitea-issue-repo-ssh-7',
          type: 'issue',
          number: 7,
          title: 'Broken login',
          state: 'opened',
          url: 'https://gitea.example/org/repo/issues/7',
          labels: ['bug'],
          updatedAt: '2026-01-01T00:00:00Z',
          author: 'ada',
          repoId: 'repo-ssh'
        }
      ]
    })

    expect(listGiteaIssuesMock).toHaveBeenCalledWith(
      '/ssh/orca',
      50,
      'closed',
      '@me',
      'v1.0',
      'builder'
    )
  })

  it('drops a blank milestone and surfaces a listing error', async () => {
    listGiteaIssuesMock.mockResolvedValueOnce({
      items: [],
      error: { type: 'not_found', message: 'nope' }
    })
    register()

    await expect(
      invoke('gitea:listIssues', { repoPath: '/local/orca', milestone: '   ' })
    ).resolves.toEqual({ items: [], error: { type: 'not_found', message: 'nope' } })

    expect(listGiteaIssuesMock).toHaveBeenCalledWith(
      '/local/orca',
      20,
      'opened',
      undefined,
      undefined,
      null
    )
  })

  it('rejects a Gitea source whose host does not own the repo', async () => {
    register()

    await expect(
      invoke('gitea:listIssues', {
        repoPath: '/ssh/orca',
        sourceContext: {
          kind: 'task-source',
          provider: 'gitea',
          projectId: 'gitea:org/repo',
          hostId: 'local',
          repoId: 'repo-ssh'
        }
      })
    ).rejects.toThrow('Access denied: Gitea source host does not match repository host')
    expect(listGiteaIssuesMock).not.toHaveBeenCalled()
  })

  it('ignores a GitLab source context rather than gating the Gitea handler on it', async () => {
    // Why: the handler asks the shared guard for 'gitea', so a GitLab context is
    // not authoritative here — the path lookup still applies.
    listGiteaIssuesMock.mockResolvedValueOnce({ items: [] })
    register()

    await invoke('gitea:listIssues', {
      repoPath: '/ssh/orca',
      sourceContext: {
        kind: 'task-source',
        provider: 'gitlab',
        projectId: 'gitlab:org/repo',
        hostId: 'local',
        repoId: 'repo-local'
      }
    })

    expect(listGiteaIssuesMock).toHaveBeenCalledWith(
      '/ssh/orca',
      20,
      'opened',
      undefined,
      undefined,
      'builder'
    )
  })

  it('refuses an unregistered repo path', async () => {
    register()

    await expect(invoke('gitea:listLabels', { repoPath: '/not/registered' })).rejects.toThrow(
      'Access denied: unknown repository path'
    )
  })

  it('forwards the remaining operations with the resolved path and connection', async () => {
    register()

    await invoke('gitea:diagnoseAuth')
    await invoke('gitea:listLabels', { repoPath: '/ssh/orca' })
    await invoke('gitea:listMilestones', { repoPath: '/ssh/orca' })
    await invoke('gitea:updateIssue', {
      repoPath: '/ssh/orca',
      number: 7,
      updates: { state: 'closed' }
    })
    await invoke('gitea:addIssueComment', {
      repoPath: '/ssh/orca',
      number: 7,
      body: 'looks good'
    })
    await invoke('gitea:workItemDetails', { repoPath: '/ssh/orca', iid: 7 })
    await invoke('gitea:workItemByPath', { repoPath: '/ssh/orca', iid: 7 })

    expect(getGiteaAuthStatusMock).toHaveBeenCalledOnce()
    expect(listGiteaLabelsMock).toHaveBeenCalledWith('/ssh/orca', 'builder')
    expect(listGiteaMilestonesMock).toHaveBeenCalledWith('/ssh/orca', 'builder')
    expect(updateGiteaIssueMock).toHaveBeenCalledWith('/ssh/orca', 7, { state: 'closed' }, 'builder')
    expect(addGiteaIssueCommentMock).toHaveBeenCalledWith('/ssh/orca', 7, 'looks good', 'builder')
    expect(getGiteaIssueDetailsMock).toHaveBeenCalledWith('/ssh/orca', 7, 'builder')
    expect(getGiteaWorkItemByPathMock).toHaveBeenCalledWith('/ssh/orca', 7, 'builder')
  })
})
