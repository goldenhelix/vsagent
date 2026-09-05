// The CLI/runtime RPC used to refuse `--host ssh:*` with "set the project up from the Orca desktop
// app" — while the desktop IPC handler in the *same process* routed it correctly through
// addRemoteRepoFromPath. Safe but wrong: the process refusing is the one that owns the connection.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { isGitRepoMock } = vi.hoisted(() => ({ isGitRepoMock: vi.fn() }))
vi.mock('../git/repo-detection', () => ({ isGitRepo: isGitRepoMock }))

import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'

const TARGET_ID = 'target-1'
const REMOTE_PATH = '/srv/app'

const remoteRepo = {
  id: 'repo-remote',
  path: REMOTE_PATH,
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  connectionId: TARGET_ID
} as unknown as Repo

function makeController(): {
  controller: RuntimeProjectHostSetupController
  addRepo: ReturnType<typeof vi.fn>
  addRemoteRepo: ReturnType<typeof vi.fn>
  cloneRepo: ReturnType<typeof vi.fn>
  projectId: string
} {
  const store = {
    getProjects: () => projectHostSetupProjectionFromRepos([remoteRepo]).projects,
    getProjectHostSetups: () => [],
    updateRepo: (_id: string, updates: Record<string, unknown>) => ({ ...remoteRepo, ...updates })
  }
  const addRepo = vi.fn().mockResolvedValue(remoteRepo)
  const addRemoteRepo = vi.fn().mockResolvedValue(remoteRepo)
  const cloneRepo = vi.fn().mockResolvedValue(remoteRepo)
  const controller = new RuntimeProjectHostSetupController({
    getStore: () => store as never,
    listRepos: () => [remoteRepo],
    addRepo,
    addRemoteRepo,
    cloneRepo,
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn()
  })
  return {
    controller,
    addRepo,
    addRemoteRepo,
    cloneRepo,
    projectId: getProjectHostSetupForRepo([], remoteRepo).projectId
  }
}

describe('RuntimeProjectHostSetupController host routing', () => {
  it('registers an existing folder on an SSH host instead of refusing it (#11163)', async () => {
    const { controller, addRepo, addRemoteRepo, projectId } = makeController()

    const result = await controller.setupExistingFolder({
      projectId,
      hostId: `ssh:${TARGET_ID}`,
      path: REMOTE_PATH,
      kind: 'git'
    })

    expect(addRemoteRepo).toHaveBeenCalledWith({
      connectionId: TARGET_ID,
      remotePath: REMOTE_PATH,
      kind: 'git'
    })
    // The local registration path validates the path against the client filesystem.
    expect(addRepo).not.toHaveBeenCalled()
    expect(result.repo.id).toBe(remoteRepo.id)
  })

  it('decodes a percent-encoded SSH target back to its connection id', async () => {
    const { controller, addRemoteRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'ssh:my%20host',
      path: REMOTE_PATH,
      kind: 'folder'
    })

    expect(addRemoteRepo).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'my host', kind: 'folder' })
    )
  })

  it('still uses the local registration for local and runtime hosts', async () => {
    const { controller, addRepo, addRemoteRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'local',
      path: REMOTE_PATH,
      kind: 'git'
    })

    expect(addRepo).toHaveBeenCalledWith(REMOTE_PATH, 'git', 'local')
    expect(addRemoteRepo).not.toHaveBeenCalled()
  })

  it('refuses to clone onto an SSH host, because nothing here clones remotely', async () => {
    const { controller, cloneRepo, projectId } = makeController()

    await expect(
      controller.setupClone({
        projectId,
        hostId: `ssh:${TARGET_ID}`,
        url: 'https://example.com/app.git',
        destination: REMOTE_PATH
      })
    ).rejects.toThrow(/Cloning onto an SSH host is not supported/)
    expect(cloneRepo).not.toHaveBeenCalled()
  })
})

// VSAgent fork (B2.6): `--project` is optional — server-side deployments import a folder before
// they know which project it belongs to, so the identity derived from the folder is used instead.
describe('RuntimeProjectHostSetupController identity-free upsert', () => {
  beforeEach(() => {
    isGitRepoMock.mockReset()
  })

  it('upserts idempotently when projectId is omitted, deriving the identity from the folder', async () => {
    const { controller, projectId } = makeController()

    const first = await controller.setupExistingFolder({
      hostId: 'local',
      path: REMOTE_PATH,
      kind: 'git'
    })
    const second = await controller.setupExistingFolder({
      hostId: 'local',
      path: REMOTE_PATH,
      kind: 'git'
    })

    expect(first.project.id).toBe(projectId)
    expect(second.project.id).toBe(projectId)
  })

  it('still throws when the given projectId does not match the derived identity', async () => {
    const { controller } = makeController()

    await expect(
      controller.setupExistingFolder({
        projectId: 'not-the-real-project',
        hostId: 'local',
        path: REMOTE_PATH,
        kind: 'git'
      })
    ).rejects.toThrow(/Imported folder does not match the selected project identity/)
  })

  it('auto-detects kind from the local filesystem when the host is local and kind is omitted', async () => {
    const { controller, addRepo, projectId } = makeController()
    isGitRepoMock.mockReturnValue(false)

    await controller.setupExistingFolder({ projectId, hostId: 'local', path: REMOTE_PATH })

    expect(isGitRepoMock).toHaveBeenCalledWith(REMOTE_PATH)
    expect(addRepo).toHaveBeenCalledWith(REMOTE_PATH, 'folder', 'local')
  })

  it('does not auto-detect kind on an SSH host, defaulting to git instead of probing the client filesystem', async () => {
    const { controller, addRemoteRepo, projectId } = makeController()
    isGitRepoMock.mockReturnValue(false)

    await controller.setupExistingFolder({
      projectId,
      hostId: `ssh:${TARGET_ID}`,
      path: REMOTE_PATH
    })

    expect(isGitRepoMock).not.toHaveBeenCalled()
    expect(addRemoteRepo).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: TARGET_ID, kind: 'git' })
    )
  })
})
