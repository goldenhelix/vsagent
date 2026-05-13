// Why: cross-browser session sync uses last-writer-wins on whole-state
// snapshots. That model loses concurrent structural changes: if browser A
// opens a tab while browser B is broadcasting its (older) state, A's hydrate
// replaces A's tabs with B's tabs and the just-opened tab disappears.
//
// The hydrators avoid that wipe by treating each Tab / BrowserWorkspace /
// BrowserPage as "kept" if it isn't in the incoming payload AND was created
// after the last time WE successfully applied a remote hydrate. That lets
// local creations survive an interleaved remote broadcast (the remote was
// built without seeing them) while still letting genuine remote closures
// propagate (a tab created before our last hydrate that the remote no longer
// includes is assumed to have been closed there).
//
// One renderer-wide clock value is enough; every hydrator pipes through this.
let lastHydrateAt = 0

export function getLastHydrateAt(): number {
  return lastHydrateAt
}

export function markHydrateApplied(): void {
  lastHydrateAt = Date.now()
}

// Test hook — reset the clock so test ordering isn't dependent on import order.
export function __resetLastHydrateAtForTests(): void {
  lastHydrateAt = 0
}
