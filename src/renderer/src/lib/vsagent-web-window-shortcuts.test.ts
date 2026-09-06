import { describe, expect, it, vi } from 'vitest'
import type { WindowShortcutAction } from '../../../shared/window-shortcut-policy'
import {
  emitWebWindowShortcut,
  subscribeWebWindowShortcut,
  webWindowShortcutChannelFor
} from './vsagent-web-window-shortcuts'

describe('webWindowShortcutChannelFor', () => {
  it('maps the chords a browser tab can honor onto their desktop IPC channels', () => {
    const mapped: [WindowShortcutAction, string][] = [
      [{ type: 'toggleWorktreePalette' }, 'ui:toggleWorktreePalette'],
      [{ type: 'openQuickOpen' }, 'ui:openQuickOpen'],
      [{ type: 'openSettings' }, 'ui:openSettings'],
      [{ type: 'toggleFloatingTerminal' }, 'ui:toggleFloatingTerminal'],
      [{ type: 'openNewWorkspace' }, 'ui:openNewWorkspace'],
      [{ type: 'toggleAgentDashboard' }, 'ui:toggleAgentDashboard']
    ]

    for (const [action, channel] of mapped) {
      expect(webWindowShortcutChannelFor(action)).toBe(channel)
    }
  })

  // Why: replaying a chord the browser owns, or one a renderer handler already
  // serves, would either be swallowed for nothing or fire the action twice.
  it('leaves browser-owned and renderer-served actions unmapped', () => {
    const unmapped: WindowShortcutAction[] = [
      { type: 'zoom', direction: 'in' },
      { type: 'forceReload' },
      { type: 'switchRecentTab' },
      { type: 'jumpToWorktreeIndex', index: 2 },
      { type: 'jumpToTabIndex', index: 2 },
      { type: 'dictationKeyDown' },
      { type: 'toggleLeftSidebar' },
      { type: 'toggleRightSidebar' },
      { type: 'toggleQuickCommandsMenu' },
      { type: 'openWorkspaceBoard' },
      { type: 'openTasks' },
      { type: 'deleteCurrentWorkspace' },
      { type: 'worktreeHistoryNavigate', direction: 'back' }
    ]

    for (const action of unmapped) {
      expect(webWindowShortcutChannelFor(action)).toBeNull()
    }
  })
})

describe('web window shortcut bus', () => {
  it('delivers to current subscribers only, and survives unsubscribe during dispatch', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = subscribeWebWindowShortcut('ui:toggleWorktreePalette', () => {
      first()
      unsubscribeFirst()
    })
    const unsubscribeSecond = subscribeWebWindowShortcut('ui:toggleWorktreePalette', second)

    emitWebWindowShortcut('ui:toggleWorktreePalette')
    emitWebWindowShortcut('ui:openQuickOpen')
    emitWebWindowShortcut('ui:toggleWorktreePalette')

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)

    unsubscribeSecond()
    emitWebWindowShortcut('ui:toggleWorktreePalette')
    expect(second).toHaveBeenCalledTimes(2)
  })
})
