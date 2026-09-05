import { detectLanguage } from '@/lib/language-detect'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { useAppStore } from '../../store'

export type RemoteOpenFileRequest = {
  worktreeId: string
  filePath: string
  relativePath: string
  runtimeEnvironmentId?: string
}

export type RemoteOpenDiffRequest = RemoteOpenFileRequest & { staged: boolean }

/**
 * Shared by the mobile IPC relay (desktop window) and the runtime client-event
 * stream (paired web clients), so both open editor tabs through the same store
 * path as the desktop File Explorer — grouped tab order and markdown bridges
 * depend on it.
 */
export function openFileFromRemote({
  worktreeId,
  filePath,
  relativePath,
  runtimeEnvironmentId
}: RemoteOpenFileRequest): void {
  const store = useAppStore.getState()
  const basename = relativePath.split(/[\\/]/).pop() || relativePath
  store.setActiveWorktree(worktreeId)
  store.markWorktreeVisited(worktreeId)
  store.setActiveView('terminal')
  store.openFile({
    filePath,
    relativePath,
    worktreeId,
    language: detectLanguage(basename),
    runtimeEnvironmentId,
    mode: 'edit'
  })
  store.setActiveTabType('editor')
  store.revealWorktreeInSidebar(worktreeId)
}

/** Diffs render from diff metadata; the editor-local Changes shortcut would send plain markdown back. */
export function openDiffFromRemote({
  worktreeId,
  filePath,
  relativePath,
  staged,
  runtimeEnvironmentId
}: RemoteOpenDiffRequest): void {
  const store = useAppStore.getState()
  const language = detectLanguage(relativePath)
  store.setActiveWorktree(worktreeId)
  store.markWorktreeVisited(worktreeId)
  store.setActiveView('terminal')
  store.openDiff(worktreeId, filePath, relativePath, language, staged, {
    runtimeEnvironmentId
  })
  store.setActiveTabType('editor')
  store.revealWorktreeInSidebar(worktreeId)
}

/** `orca file open` / `file diff` relayed from a host with no desktop window of its own. */
export type RelayedFileOpenEvent = Extract<RuntimeClientEvent, { type: 'openFile' | 'openDiff' }>

export function isRelayedFileOpenEvent(event: RuntimeClientEvent): event is RelayedFileOpenEvent {
  return event.type === 'openFile' || event.type === 'openDiff'
}

/** The emitting environment owns the worktree unless the host named another one. */
export function openRelayedFileTab(environmentId: string, event: RelayedFileOpenEvent): void {
  const runtimeEnvironmentId = event.runtimeEnvironmentId ?? environmentId
  if (event.type === 'openDiff') {
    openDiffFromRemote({
      worktreeId: event.worktreeId,
      filePath: event.filePath,
      relativePath: event.relativePath,
      staged: event.staged,
      runtimeEnvironmentId
    })
    return
  }
  openFileFromRemote({
    worktreeId: event.worktreeId,
    filePath: event.filePath,
    relativePath: event.relativePath,
    runtimeEnvironmentId
  })
}
