import type {
  Tab,
  TabGroup,
  TabGroupLayoutNode,
  WorkspaceSessionState
} from '../../../../shared/types'
import { getLastHydrateAt } from '../../lib/session-hydrate-clock'
import {
  dedupeTabOrder,
  getPersistedEditFileIdsByWorktree,
  isTransientEditorContentType,
  sanitizeRecentTabIds,
  selectHydratedActiveGroupId
} from './tab-group-state'

type HydratedTabState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
}

// Why: when a cross-browser hydrate lands, any local-only tab created after
// our last hydrate hasn't been seen by the remote yet. Keeping it (rather
// than replacing with the remote's state) lets concurrent tab opens survive
// the broadcast round-trip. Genuine remote closures of older tabs (created
// before our last hydrate) still propagate — those get filtered out by the
// normal "not in incoming" path.
export type LocalTabSnapshotForMerge = {
  unifiedTabs: Record<string, Tab[]>
  tabGroups: Record<string, TabGroup[]>
}

function pruneLayoutForGroups(
  root: TabGroupLayoutNode,
  validGroupIds: Set<string>
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return validGroupIds.has(root.groupId) ? root : null
  }

  const first = pruneLayoutForGroups(root.first, validGroupIds)
  const second = pruneLayoutForGroups(root.second, validGroupIds)

  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }

  return { ...root, first, second }
}

function hydrateUnifiedFormat(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}
  const persistedEditFileIdsByWorktree = getPersistedEditFileIdsByWorktree(session)

  for (const [worktreeId, tabs] of Object.entries(session.unifiedTabs!)) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (tabs.length === 0) {
      continue
    }
    const persistedEditFileIds = persistedEditFileIdsByWorktree[worktreeId] ?? new Set<string>()
    tabsByWorktree[worktreeId] = [...tabs]
      .map((tab) => ({
        ...tab,
        entityId: tab.entityId ?? tab.id
      }))
      .filter((tab) => {
        if (!isTransientEditorContentType(tab.contentType)) {
          return true
        }
        // Why: restore skips backing editor state for transient diff/conflict
        // items. Hydration must drop their tab chrome too or the split group
        // comes back pointing at a document that no longer exists.
        return persistedEditFileIds.has(tab.entityId)
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  }

  for (const [worktreeId, groups] of Object.entries(session.tabGroups!)) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (groups.length === 0) {
      continue
    }

    const validTabIds = new Set((tabsByWorktree[worktreeId] ?? []).map((t) => t.id))
    const validatedGroups = groups.map((g) => {
      // Why: persisted tabOrder can contain duplicates from older buggy
      // writes. Deduping during hydration restores the store invariant before
      // later group operations branch on tab counts or neighbors.
      const tabOrder = dedupeTabOrder(g.tabOrder.filter((tid) => validTabIds.has(tid)))
      const activeTabId = g.activeTabId && validTabIds.has(g.activeTabId) ? g.activeTabId : null
      // Why: persisted MRU may reference tabs that no longer exist. Sanitize
      // against the live tabOrder, then ensure the current active tab sits at
      // the tail so the first close after restore jumps back to the previous
      // tab rather than falling through to neighbor selection.
      const sanitizedRecent = sanitizeRecentTabIds(g.recentTabIds, tabOrder)
      const recentTabIds =
        activeTabId && sanitizedRecent.at(-1) !== activeTabId
          ? [...sanitizedRecent.filter((id) => id !== activeTabId), activeTabId]
          : sanitizedRecent
      return {
        ...g,
        tabOrder,
        activeTabId,
        recentTabIds
      }
    })
    const hydratedGroups = validatedGroups.filter((group, index) => {
      const hadTabsBeforeHydration = groups[index]?.tabOrder.length > 0
      return !hadTabsBeforeHydration || group.tabOrder.length > 0
    })
    if (hydratedGroups.length === 0) {
      if ((tabsByWorktree[worktreeId] ?? []).length === 0) {
        delete tabsByWorktree[worktreeId]
      }
      continue
    }

    groupsByWorktree[worktreeId] = hydratedGroups
    const activeGroupId = selectHydratedActiveGroupId(
      hydratedGroups,
      session.activeGroupIdByWorktree?.[worktreeId]
    )
    if (activeGroupId) {
      activeGroupIdByWorktree[worktreeId] = activeGroupId
    }
    const hydratedGroupIds = new Set(hydratedGroups.map((group) => group.id))
    const hydratedLayout = session.tabGroupLayouts?.[worktreeId]
      ? pruneLayoutForGroups(session.tabGroupLayouts[worktreeId], hydratedGroupIds)
      : null
    layoutByWorktree[worktreeId] = hydratedLayout ?? {
      type: 'leaf',
      // Why: if transient-only groups were removed during hydration, the
      // persisted split tree can collapse to a single surviving group. The
      // fallback leaf keeps restore aligned with the remaining real tabs.
      groupId: hydratedGroups[0].id
    }
  }

  return {
    unifiedTabsByWorktree: tabsByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree,
    layoutByWorktree
  }
}

function hydrateLegacyFormat(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}

  for (const worktreeId of validWorktreeIds) {
    const terminalTabs = session.tabsByWorktree[worktreeId] ?? []
    const editorFiles = session.openFilesByWorktree?.[worktreeId] ?? []

    if (terminalTabs.length === 0 && editorFiles.length === 0) {
      continue
    }

    const groupId = globalThis.crypto.randomUUID()
    const tabs: Tab[] = []
    const tabOrder: string[] = []

    for (const tt of terminalTabs) {
      tabs.push({
        id: tt.id,
        entityId: tt.id,
        groupId,
        worktreeId,
        contentType: 'terminal',
        label: tt.title,
        customLabel: tt.customTitle,
        color: tt.color,
        sortOrder: tt.sortOrder,
        createdAt: tt.createdAt,
        isPreview: false,
        isPinned: false
      })
      tabOrder.push(tt.id)
    }

    for (const ef of editorFiles) {
      tabs.push({
        id: ef.filePath,
        entityId: ef.filePath,
        groupId,
        worktreeId,
        contentType: 'editor',
        label: ef.relativePath,
        customLabel: null,
        color: null,
        sortOrder: tabs.length,
        createdAt: Date.now(),
        isPreview: ef.isPreview,
        isPinned: false
      })
      tabOrder.push(ef.filePath)
    }

    const activeTabType = session.activeTabTypeByWorktree?.[worktreeId] ?? 'terminal'
    let activeTabId: string | null = null
    if (activeTabType === 'editor') {
      activeTabId = session.activeFileIdByWorktree?.[worktreeId] ?? null
    } else if (session.activeTabId && terminalTabs.some((t) => t.id === session.activeTabId)) {
      activeTabId = session.activeTabId
    }
    if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
      activeTabId = tabs[0]?.id ?? null
    }

    tabsByWorktree[worktreeId] = tabs
    groupsByWorktree[worktreeId] = [
      {
        id: groupId,
        worktreeId,
        activeTabId,
        tabOrder,
        // Why: legacy sessions don't persist MRU; seed with the active tab so
        // the first close after a legacy restore still behaves MRU-ish (falls
        // back to neighbor selection if only one tab is in the stack).
        recentTabIds: activeTabId ? [activeTabId] : []
      }
    ]
    activeGroupIdByWorktree[worktreeId] = groupId
    layoutByWorktree[worktreeId] = { type: 'leaf', groupId }
  }

  return {
    unifiedTabsByWorktree: tabsByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree,
    layoutByWorktree
  }
}

export function buildHydratedTabState(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>,
  localSnapshot?: LocalTabSnapshotForMerge
): HydratedTabState {
  const hydrated =
    session.unifiedTabs && session.tabGroups
      ? hydrateUnifiedFormat(session, validWorktreeIds)
      : hydrateLegacyFormat(session, validWorktreeIds)
  if (!localSnapshot) {
    return hydrated
  }
  return mergeLocalOnlyTabs(hydrated, localSnapshot, validWorktreeIds)
}

function mergeLocalOnlyTabs(
  hydrated: HydratedTabState,
  local: LocalTabSnapshotForMerge,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const cutoff = getLastHydrateAt()
  const mergedTabs: Record<string, Tab[]> = { ...hydrated.unifiedTabsByWorktree }
  const mergedGroups: Record<string, TabGroup[]> = { ...hydrated.groupsByWorktree }

  for (const [worktreeId, localTabs] of Object.entries(local.unifiedTabs)) {
    if (!validWorktreeIds.has(worktreeId)) continue
    const hydratedTabs = mergedTabs[worktreeId] ?? []
    const hydratedIds = new Set(hydratedTabs.map((t) => t.id))
    const toAdd = localTabs.filter((t) => !hydratedIds.has(t.id) && t.createdAt > cutoff)
    if (toAdd.length === 0) continue

    // Re-sort so newly merged local tabs land in createdAt order at the end.
    mergedTabs[worktreeId] = [...hydratedTabs, ...toAdd].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
    )

    // Restore each tab's group membership. The local-only tabs reference
    // groupIds that exist either in the hydrated groups or only locally.
    const groupsForWorktree = [...(mergedGroups[worktreeId] ?? [])]
    const localGroups = local.tabGroups[worktreeId] ?? []
    for (const tab of toAdd) {
      let group = groupsForWorktree.find((g) => g.id === tab.groupId)
      if (!group) {
        const localGroup = localGroups.find((g) => g.id === tab.groupId)
        if (localGroup) {
          group = { ...localGroup, tabOrder: [], recentTabIds: [] }
          groupsForWorktree.push(group)
        } else if (groupsForWorktree.length > 0) {
          group = groupsForWorktree[0]
        }
      }
      if (group && !group.tabOrder.includes(tab.id)) {
        const next = [...group.tabOrder, tab.id]
        const idx = groupsForWorktree.findIndex((g) => g.id === group!.id)
        if (idx !== -1) {
          groupsForWorktree[idx] = { ...group, tabOrder: next }
        }
      }
    }
    mergedGroups[worktreeId] = groupsForWorktree
  }

  return {
    unifiedTabsByWorktree: mergedTabs,
    groupsByWorktree: mergedGroups,
    activeGroupIdByWorktree: hydrated.activeGroupIdByWorktree,
    layoutByWorktree: hydrated.layoutByWorktree
  }
}
