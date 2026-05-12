import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { WorkspaceSessionState } from '../../shared/types'
import { broadcastToWebClients } from '../web-gateway/ipc-intercept'

// Why: in web mode multiple browser tabs can be connected to the same
// backend at once. When one tab mutates the session (opens a worktree
// tab, switches active tab, etc.), every other tab needs to see it
// without a full page reload. The gateway already broadcasts every
// `webContents.send(channel, args)` to all connected WS clients, so the
// simplest cross-browser sync is to fire `session:changed` after each
// `session:set` and have the renderer rehydrate on receipt.
//
// `originId`: each renderer mints a random clientId at boot and passes
// it on `session.set`. The broadcast carries it back. The originating
// renderer ignores broadcasts that match its own id — that way a
// debounced save doesn't immediately re-hydrate the local store with
// the value it just wrote (which could clobber in-progress edits that
// haven't yet entered the debounce window).
type SessionSetArgs = {
  state: WorkspaceSessionState
  originId?: string | null
}

function broadcastSessionChanged(args: SessionSetArgs): void {
  // Why: send to every real BrowserWindow (covers the Electron desktop path
  // and any future multi-window setups).
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('session:changed', args)
    } catch {
      // Destroyed window — harmless.
    }
  }
  // Why: in web-headless mode there is no real BrowserWindow registered
  // with Electron, so getAllWindows() returns []. Broadcast directly to
  // any connected WS client via the gateway's broadcaster.
  broadcastToWebClients('session:changed', [args])
}

function isLegacyPayload(args: unknown): args is WorkspaceSessionState {
  return (
    typeof args === 'object' &&
    args !== null &&
    'tabsByWorktree' in (args as Record<string, unknown>)
  )
}

function normalizeSetArgs(raw: unknown): SessionSetArgs {
  // Why: legacy callers (Electron desktop renderer pre-web-mode) pass the
  // WorkspaceSessionState directly. Web-mode renderers pass
  // `{ state, originId }`. Normalize so handlers see the same shape.
  if (isLegacyPayload(raw)) {
    return { state: raw, originId: null }
  }
  return raw as SessionSetArgs
}

export function registerSessionHandlers(store: Store): void {
  ipcMain.handle('session:get', () => {
    return store.getWorkspaceSession()
  })

  ipcMain.handle('session:set', (_event, raw: unknown) => {
    const args = normalizeSetArgs(raw)
    store.setWorkspaceSession(args.state)
    broadcastSessionChanged(args)
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, raw: unknown) => {
    const args = normalizeSetArgs(raw)
    store.setWorkspaceSession(args.state)
    store.flush()
    broadcastSessionChanged(args)
    event.returnValue = true
  })
}
