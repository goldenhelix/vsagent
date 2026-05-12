// Browser-side polyfill for the parts of the Electron module the preload
// touches. Vite aliases `electron` → this file when building the web bundle so
// the existing `src/preload/index.ts` can run unchanged inside the browser.
import { bridge } from './ws-bridge'

type Listener = (event: { sender: unknown }, ...args: unknown[]) => void

export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    bridge.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]): void => bridge.sendChannel(channel, ...args),
  on: (channel: string, listener: Listener): typeof ipcRenderer => {
    bridge.on(channel, listener)
    return ipcRenderer
  },
  once: (channel: string, listener: Listener): typeof ipcRenderer => {
    const wrapped: Listener = (event, ...args) => {
      bridge.removeListener(channel, wrapped)
      listener(event, ...args)
    }
    bridge.on(channel, wrapped)
    return ipcRenderer
  },
  removeListener: (channel: string, listener: Listener): typeof ipcRenderer => {
    bridge.removeListener(channel, listener)
    return ipcRenderer
  },
  removeAllListeners: (channel?: string): typeof ipcRenderer => {
    bridge.removeAllListeners(channel)
    return ipcRenderer
  }
}

// Why: context isolation is an Electron primitive that has no analogue in the
// browser. The preload's `if (process.contextIsolated)` branch tries to call
// `contextBridge.exposeInMainWorld(name, value)`; we make that simply assign
// to `window[name]` so the public surface (`window.api`, `window.electron`)
// matches what the renderer expects.
export const contextBridge = {
  exposeInMainWorld(name: string, value: unknown): void {
    ;(window as unknown as Record<string, unknown>)[name] = value
  }
}

// Why: `webFrame.setZoomLevel(level)` is approximated using CSS zoom on the
// document root so renderer-side zoom UI stays interactive in the browser. A
// proper implementation would also re-flow xterm/monaco; for the PoC we
// accept the visual approximation.
export const webFrame = {
  setZoomLevel(level: number): void {
    const factor = Math.pow(1.2, level)
    ;(document.documentElement.style as unknown as { zoom: string }).zoom = String(factor)
  },
  getZoomLevel(): number {
    const factor = parseFloat(
      (document.documentElement.style as unknown as { zoom: string }).zoom || '1'
    )
    return Math.log(factor || 1) / Math.log(1.2)
  },
  setVisualZoomLevelLimits(): void {},
  setLayoutZoomLevelLimits(): void {}
}

// Why: browsers no longer expose File.path for security reasons and have no
// analogue for `webUtils.getPathForFile`. Returning '' makes the renderer's
// drag-drop path-collection silently produce zero paths — the renderer
// already guards on `paths.length === 0` so this is harmless degradation
// (the right long-term fix is a file-upload IPC).
export const webUtils = {
  getPathForFile(_file: File): string {
    return ''
  }
}

export default { ipcRenderer, contextBridge, webFrame, webUtils }
