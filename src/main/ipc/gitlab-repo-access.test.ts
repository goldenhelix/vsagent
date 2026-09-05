import { describe, expect, it, vi } from 'vitest'
import { assertRegisteredRepo } from './gitlab-repo-access'

const repoPath = '/workspace/repo'
const localRepo = {
  id: 'repo-1',
  path: repoPath,
  displayName: 'local',
  badgeColor: '#000',
  addedAt: 0
}
const sshRepo = { ...localRepo, displayName: 'ssh', connectionId: 'ssh-1' }

function makeStore() {
  return {
    getRepo: vi.fn(() => localRepo),
    getRepos: vi.fn(() => [localRepo, sshRepo])
  }
}

describe('GitLab repo owner selection', () => {
  it('selects the exact owner when ids and paths collide', () => {
    expect(
      assertRegisteredRepo(
        {
          repoPath,
          repoId: 'repo-1',
          repoOwnerExecutionHostId: 'ssh:ssh-1'
        },
        makeStore() as never
      )
    ).toBe(sshRepo)
  })

  it('fails closed when the explicit owner is absent', () => {
    expect(() =>
      assertRegisteredRepo(
        {
          repoPath,
          repoId: 'repo-1',
          repoOwnerExecutionHostId: 'runtime:missing'
        },
        makeStore() as never
      )
    ).toThrow('Access denied: unknown repository path')
  })
})

describe('forge source provider guard', () => {
  const giteaContext = {
    kind: 'task-source',
    provider: 'gitea',
    projectId: 'project-1',
    hostId: 'ssh:other',
    repoId: 'repo-1'
  } as const

  it('rejects a Gitea source whose host does not own the repo', () => {
    expect(() =>
      assertRegisteredRepo({ repoPath, sourceContext: giteaContext }, makeStore() as never, 'gitea')
    ).toThrow('Access denied: Gitea source host does not match repository host')
  })

  it('ignores a Gitea source context when the caller asks for GitLab', () => {
    // Why: the provider selects which source context is authoritative; a Gitea
    // context must not silently gate a GitLab handler (and vice versa).
    expect(
      assertRegisteredRepo({ repoPath, sourceContext: giteaContext }, makeStore() as never)
    ).toBe(localRepo)
  })

  it('resolves a Gitea source context repo id when no explicit repoId is given', () => {
    const store = makeStore()
    expect(
      assertRegisteredRepo(
        { repoPath, sourceContext: { ...giteaContext, hostId: 'local' } },
        store as never,
        'gitea'
      )
    ).toBe(localRepo)
    expect(store.getRepo).toHaveBeenCalledWith('repo-1')
  })
})
