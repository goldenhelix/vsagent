import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import { openDiffFromRemote, openFileFromRemote } from './remote-open-file-tab'

const mocks = vi.hoisted(() => ({
  openFile: vi.fn<EditorFilesSlice['openFile']>(() => 'file-1'),
  openDiff: vi.fn<EditorFilesSlice['openDiff']>(() => 'file-2'),
  setActiveWorktree: vi.fn(),
  markWorktreeVisited: vi.fn(),
  setActiveView: vi.fn(),
  setActiveTabType: vi.fn(),
  revealWorktreeInSidebar: vi.fn()
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks } }))

describe('remote open-file relay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens an editor tab through the same store path as the File Explorer', () => {
    openFileFromRemote({
      worktreeId: 'worktree-1',
      filePath: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      runtimeEnvironmentId: 'env-1'
    })

    expect(mocks.setActiveWorktree).toHaveBeenCalledWith('worktree-1')
    expect(mocks.markWorktreeVisited).toHaveBeenCalledWith('worktree-1')
    expect(mocks.setActiveView).toHaveBeenCalledWith('terminal')
    expect(mocks.openFile).toHaveBeenCalledWith({
      filePath: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      worktreeId: 'worktree-1',
      language: 'typescript',
      runtimeEnvironmentId: 'env-1',
      mode: 'edit'
    })
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('editor')
    expect(mocks.revealWorktreeInSidebar).toHaveBeenCalledWith('worktree-1')
  })

  it('detects the language from the basename, not the whole relative path', () => {
    openFileFromRemote({
      worktreeId: 'worktree-1',
      filePath: '/repo/docs.ts/notes.md',
      relativePath: 'docs.ts/notes.md'
    })

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'markdown', runtimeEnvironmentId: undefined })
    )
  })

  it('opens a diff tab with the staged flag and owning environment', () => {
    openDiffFromRemote({
      worktreeId: 'worktree-1',
      filePath: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      staged: true,
      runtimeEnvironmentId: 'env-1'
    })

    expect(mocks.openDiff).toHaveBeenCalledWith(
      'worktree-1',
      '/repo/src/app.ts',
      'src/app.ts',
      'typescript',
      true,
      { runtimeEnvironmentId: 'env-1' }
    )
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('editor')
    expect(mocks.revealWorktreeInSidebar).toHaveBeenCalledWith('worktree-1')
  })
})
