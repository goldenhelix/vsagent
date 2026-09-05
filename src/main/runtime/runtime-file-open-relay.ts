import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeNotifier } from './runtime-notifier-contract'

/** Only the two notifier calls this relay can take over. */
export type RuntimeFileOpenNotifier = Pick<RuntimeNotifier, 'openFile' | 'openDiff'>

export type RuntimeFileOpenRelayPorts = {
  getNotifier: () => RuntimeFileOpenNotifier | null
  hasClientEventListeners: () => boolean
  emitClientEvent: (event: RuntimeClientEvent) => void
}

export type RuntimeFileOpenRelay = {
  openFile: (
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null
  ) => void
  openDiff: (
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null
  ) => void
}

/**
 * Routes `orca file open` / `file diff` to whoever can render it: the desktop
 * window when this process has one, otherwise the paired clients on the runtime
 * client-event stream (a headless `orca serve` has no window at all). Still
 * throws `renderer_unavailable` when nothing is listening, so the CLI reports a
 * real failure instead of silently succeeding against an empty server.
 */
export function createRuntimeFileOpenRelay(ports: RuntimeFileOpenRelayPorts): RuntimeFileOpenRelay {
  return {
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId) => {
      const notifier = ports.getNotifier()
      if (notifier?.openFile) {
        notifier.openFile(worktreeId, filePath, relativePath, runtimeEnvironmentId)
        return
      }
      if (!ports.hasClientEventListeners()) {
        throw new Error('renderer_unavailable')
      }
      ports.emitClientEvent({
        type: 'openFile',
        worktreeId,
        filePath,
        relativePath,
        ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
      })
    },
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId) => {
      const notifier = ports.getNotifier()
      if (notifier?.openDiff) {
        notifier.openDiff(worktreeId, filePath, relativePath, staged, runtimeEnvironmentId)
        return
      }
      if (!ports.hasClientEventListeners()) {
        throw new Error('renderer_unavailable')
      }
      ports.emitClientEvent({
        type: 'openDiff',
        worktreeId,
        filePath,
        relativePath,
        staged,
        ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
      })
    }
  }
}
