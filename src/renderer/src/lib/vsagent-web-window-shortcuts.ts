import type {
  KeybindingActionId,
  KeybindingMatchOptions,
  KeybindingOverrides
} from '../../../shared/keybindings'
import {
  getWindowShortcutActionId,
  resolveWindowShortcutAction,
  windowShortcutActionCapturesTerminal,
  type WindowShortcutAction,
  type WindowShortcutInput
} from '../../../shared/window-shortcut-policy'

// Why (VSAgent fork): these chords reach the desktop renderer through the main
// process before-input-event allowlist (main-window-shortcut-actions.ts), which a
// browser tab has no equivalent of — the web preload stubs the listeners as
// no-ops, so the shortcut silently does nothing while the UI still advertises it.
// The web client resolves the same allowlist itself and replays the action into
// the very channels upstream's IPC bridges already listen on, so the handlers,
// keybinding registry and shortcut labels all stay upstream's.

export type WebWindowShortcutChannel =
  | 'ui:openSettings'
  | 'ui:toggleWorktreePalette'
  | 'ui:toggleFloatingTerminal'
  | 'ui:openQuickOpen'
  | 'ui:openNewWorkspace'
  | 'ui:toggleAgentDashboard'

/**
 * The subset of the window-shortcut allowlist a browser tab can honor. Everything
 * else is deliberately unmapped:
 * - zoom / forceReload: the browser's own Ctrl/Cmd+± and reload must keep working.
 * - switchRecentTab, jumpToWorktreeIndex, jumpToTabIndex: the browser owns
 *   Ctrl+Tab and Mod+digit for its own tabs and does not let a page take them.
 * - dictationKeyDown: main gates it on voice settings the web client cannot read.
 * - toggleLeft/RightSidebar, openQuickCommandsMenu, openWorkspaceBoard, openTasks,
 *   deleteCurrentWorkspace, worktreeHistoryNavigate: these already have renderer
 *   keydown handlers that fire in the browser, so replaying would double-fire.
 */
export function webWindowShortcutChannelFor(
  action: WindowShortcutAction
): WebWindowShortcutChannel | null {
  switch (action.type) {
    case 'openSettings':
      return 'ui:openSettings'
    case 'toggleWorktreePalette':
      return 'ui:toggleWorktreePalette'
    case 'toggleFloatingTerminal':
      return 'ui:toggleFloatingTerminal'
    case 'openQuickOpen':
      return 'ui:openQuickOpen'
    case 'openNewWorkspace':
      return 'ui:openNewWorkspace'
    case 'toggleAgentDashboard':
      return 'ui:toggleAgentDashboard'
    // Enumerated rather than defaulted so a new upstream action has to be classified here.
    case 'zoom':
    case 'forceReload':
    case 'switchRecentTab':
    case 'jumpToWorktreeIndex':
    case 'jumpToTabIndex':
    case 'dictationKeyDown':
    case 'toggleLeftSidebar':
    case 'toggleRightSidebar':
    case 'toggleQuickCommandsMenu':
    case 'openWorkspaceBoard':
    case 'openTasks':
    case 'deleteCurrentWorkspace':
    case 'worktreeHistoryNavigate':
      return null
  }
}

const listenersByChannel = new Map<WebWindowShortcutChannel, Set<() => void>>()

export function subscribeWebWindowShortcut(
  channel: WebWindowShortcutChannel,
  listener: () => void
): () => void {
  const listeners = listenersByChannel.get(channel) ?? new Set<() => void>()
  listeners.add(listener)
  listenersByChannel.set(channel, listeners)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Resolves a keydown against the window-shortcut allowlist and replays the action,
 * the way the desktop main process would. Returns whether the chord was consumed.
 */
export function dispatchWebWindowShortcut(args: {
  input: WindowShortcutInput & { preventDefault: () => void }
  platform: NodeJS.Platform
  keybindings: KeybindingOverrides | undefined
  matchOptions: KeybindingMatchOptions
  onTerminalCapture: (actionId: KeybindingActionId) => void
}): boolean {
  const action = resolveWindowShortcutAction(
    args.input,
    args.platform,
    args.keybindings,
    args.matchOptions
  )
  const channel = action ? webWindowShortcutChannelFor(action) : null
  if (!action || !channel) {
    return false
  }
  args.input.preventDefault()
  const capturedActionId = windowShortcutActionCapturesTerminal(action)
    ? getWindowShortcutActionId(action)
    : null
  if (capturedActionId) {
    args.onTerminalCapture(capturedActionId)
  }
  emitWebWindowShortcut(channel)
  return true
}

export function emitWebWindowShortcut(channel: WebWindowShortcutChannel): void {
  const listeners = listenersByChannel.get(channel)
  if (!listeners) {
    return
  }
  // Snapshot: a bridge may unsubscribe itself while handling its own action.
  for (const listener of Array.from(listeners)) {
    listener()
  }
}
