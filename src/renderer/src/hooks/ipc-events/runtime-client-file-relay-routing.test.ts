import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { WorktreeEventRuntime } from './worktree-event-runtime'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'

const mocks = vi.hoisted(() => ({
  storeState: {
    repos: [],
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    removedRuntimeEnvironmentIds: new Set<string>(),
    settings: undefined,
    sshStateByEnvironment: undefined,
    markEnvironmentSshStateStale: vi.fn(),
    fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
    refreshRuntimeEnvironmentStatus: vi.fn(async () => true),
    openFile: vi.fn<EditorFilesSlice['openFile']>(() => 'file-1'),
    openDiff: vi.fn<EditorFilesSlice['openDiff']>(() => 'file-2'),
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    setActiveView: vi.fn(),
    setActiveTabType: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  },
  onEventCaptures: [] as ((environmentId: string, event: RuntimeClientEvent) => void)[]
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => mocks.storeState, subscribe: () => () => {} }
}))
vi.mock('../runtime-client-events-sync', () => ({
  createRuntimeClientEventsSync: (deps: {
    onEvent: (environmentId: string, event: RuntimeClientEvent) => void
  }) => {
    mocks.onEventCaptures.push(deps.onEvent)
    return { sync: vi.fn(), stop: vi.fn() }
  }
}))

const worktreeRuntime = {
  worktreeChangeRefreshQueue: { enqueue: vi.fn() },
  activateNotifiedWorktree: vi.fn()
} as unknown as WorktreeEventRuntime

/** Registers the bridge and hands back the event handler it wired into the subscription sync. */
function registerBridge(): (environmentId: string, event: RuntimeClientEvent) => void {
  const unsubs: (() => void)[] = []
  registerRuntimeClientIpcBridge(unsubs, worktreeRuntime)
  const handler = mocks.onEventCaptures.at(-1)
  if (!handler) {
    throw new Error('Expected the bridge to register a client-event handler')
  }
  return handler
}

describe('runtime client-event file relay routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onEventCaptures.length = 0
  })

  it('opens a relayed file on the emitting environment by default', () => {
    registerBridge()('env-serve', {
      type: 'openFile',
      worktreeId: 'worktree-1',
      filePath: '/srv/repo/README.md',
      relativePath: 'README.md'
    })

    expect(mocks.storeState.setActiveWorktree).toHaveBeenCalledWith('worktree-1')
    expect(mocks.storeState.openFile).toHaveBeenCalledWith({
      filePath: '/srv/repo/README.md',
      relativePath: 'README.md',
      worktreeId: 'worktree-1',
      language: 'markdown',
      runtimeEnvironmentId: 'env-serve',
      mode: 'edit'
    })
    expect(mocks.storeState.setActiveTabType).toHaveBeenCalledWith('editor')
  })

  it('opens a relayed diff and keeps an explicit environment named by the host', () => {
    registerBridge()('env-serve', {
      type: 'openDiff',
      worktreeId: 'worktree-1',
      filePath: '/srv/repo/README.md',
      relativePath: 'README.md',
      staged: true,
      runtimeEnvironmentId: 'env-other'
    })

    expect(mocks.storeState.openDiff).toHaveBeenCalledWith(
      'worktree-1',
      '/srv/repo/README.md',
      'README.md',
      'markdown',
      true,
      { runtimeEnvironmentId: 'env-other' }
    )
  })

  it('leaves unrelated events on their own branches', () => {
    registerBridge()('env-serve', { type: 'reposChanged' })

    expect(mocks.storeState.openFile).not.toHaveBeenCalled()
    expect(mocks.storeState.openDiff).not.toHaveBeenCalled()
  })
})
