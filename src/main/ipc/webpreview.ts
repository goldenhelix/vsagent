// IPC bridge for the iframe-backed in-app browser. The renderer creates a
// session for a target origin (e.g. http://localhost:3000), gets back a
// proxy path it can drop into an <iframe src=...>, and updates the
// session's origin when the user types a new URL into the address bar.
import { ipcMain } from 'electron'
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSessionOrigin
} from '../web-gateway/webpreview/registry'

export type WebPreviewSessionInfo = {
  id: string
  targetOrigin: string
  proxyPath: string
}

function toPublic(s: { id: string; targetOrigin: string }): WebPreviewSessionInfo {
  return {
    id: s.id,
    targetOrigin: s.targetOrigin,
    proxyPath: `/__orca/webpreview/${s.id}`
  }
}

export function registerWebPreviewHandlers(): void {
  ipcMain.removeHandler('webpreview:create')
  ipcMain.handle(
    'webpreview:create',
    (_event, args: { targetOrigin: string }): WebPreviewSessionInfo => {
      const s = createSession(args.targetOrigin)
      return toPublic(s)
    }
  )
  ipcMain.removeHandler('webpreview:setOrigin')
  ipcMain.handle(
    'webpreview:setOrigin',
    (_event, args: { id: string; targetOrigin: string }): WebPreviewSessionInfo | null => {
      const updated = updateSessionOrigin(args.id, args.targetOrigin)
      return updated ? toPublic(updated) : null
    }
  )
  ipcMain.removeHandler('webpreview:get')
  ipcMain.handle('webpreview:get', (_event, args: { id: string }): WebPreviewSessionInfo | null => {
    const s = getSession(args.id)
    return s ? toPublic(s) : null
  })
  ipcMain.removeHandler('webpreview:list')
  ipcMain.handle('webpreview:list', (): WebPreviewSessionInfo[] =>
    listSessions().map(toPublic)
  )
  ipcMain.removeHandler('webpreview:delete')
  ipcMain.handle('webpreview:delete', (_event, args: { id: string }): void => {
    deleteSession(args.id)
  })
}
