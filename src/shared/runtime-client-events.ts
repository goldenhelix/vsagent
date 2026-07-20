import type {
  CreateWorktreeResult,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './types'
import type { SshConnectionState } from './ssh-types'

export type RuntimeClientEvent =
  | { type: 'reposChanged' }
  | { type: 'worktreesChanged'; repoId: string }
  // Why: SSH connections live on the runtime host; paired clients have no IPC
  // channel for ssh:state-changed, so without this event their reconnect
  // overlays never learn the host connected (STA-1468).
  | { type: 'sshStateChanged'; targetId: string; state: SshConnectionState }
  | {
      type: 'linearLinkedIssueUpdated'
      worktreeId: string
      identifier: string
      workspaceId: string
    }
  | {
      type: 'activateWorktree'
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: WorktreeStartupLaunch
      defaultTabs?: WorktreeDefaultTabsLaunch
    }
  // Why (VSAgent fork): headless serve has no desktop window to receive
  // `orca file open` / `file diff` notifier calls; these relay them to paired
  // clients so the web client opens the editor/diff tab (feedback: the CLI
  // file surface was desktop-only).
  | {
      type: 'openFile'
      worktreeId: string
      filePath: string
      relativePath: string
      runtimeEnvironmentId?: string
    }
  | {
      type: 'openDiff'
      worktreeId: string
      filePath: string
      relativePath: string
      staged: boolean
      runtimeEnvironmentId?: string
    }

export type RuntimeClientEventStreamMessage =
  | ({ type: 'ready'; subscriptionId: string } & {
      snapshot?: {
        // Reserved for future hydration. Current clients refresh through the
        // existing repo/worktree RPCs after receiving server events.
        repos?: unknown[]
      }
    })
  | RuntimeClientEvent
  | { type: 'end' }

export type RuntimeActivateWorktreeEvent = Extract<RuntimeClientEvent, { type: 'activateWorktree' }>

export function toRuntimeActivateWorktreeEvent(
  repoId: string,
  worktreeId: string,
  setup?: CreateWorktreeResult['setup'],
  startup?: WorktreeStartupLaunch,
  defaultTabs?: CreateWorktreeResult['defaultTabs']
): RuntimeActivateWorktreeEvent {
  return {
    type: 'activateWorktree',
    repoId,
    worktreeId,
    ...(setup ? { setup } : {}),
    ...(startup ? { startup } : {}),
    ...(defaultTabs ? { defaultTabs } : {})
  }
}
