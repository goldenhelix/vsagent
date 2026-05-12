// Browser polyfill for @electron-toolkit/preload — mirrors the package's
// runtime exports against our `electron-shim.ts`. Aliased in via Vite when
// building the web bundle.
import { ipcRenderer, webFrame, webUtils, contextBridge } from './electron-shim'

type Listener = (event: { sender: unknown }, ...args: unknown[]) => void

export const electronAPI = {
  ipcRenderer: {
    send(channel: string, ...args: unknown[]): void {
      ipcRenderer.send(channel, ...args)
    },
    sendTo(): void {
      throw new Error('"sendTo" is not supported in the Orca web bridge.')
    },
    sendSync(): unknown {
      // Why: synchronous IPC is impossible over a network socket. The Orca
      // renderer doesn't actually call sendSync today; this stub fails loudly
      // if that changes so the regression is obvious.
      throw new Error('sendSync is not supported in the Orca web bridge.')
    },
    sendToHost(channel: string, ...args: unknown[]): void {
      ipcRenderer.send(channel, ...args)
    },
    postMessage(): void {
      throw new Error('postMessage is not supported in the Orca web bridge.')
    },
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      return ipcRenderer.invoke(channel, ...args)
    },
    on(channel: string, listener: Listener): () => void {
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    },
    once(channel: string, listener: Listener): () => void {
      ipcRenderer.once(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    },
    removeAllListeners(channel: string): void {
      ipcRenderer.removeAllListeners(channel)
    },
    removeListener(channel: string, listener: Listener): unknown {
      ipcRenderer.removeListener(channel, listener)
      return electronAPI.ipcRenderer
    }
  },
  webFrame,
  webUtils,
  // Why: the renderer reads `electron.process.platform` to choose macOS vs.
  // Windows vs. Linux affordances. We surface the navigator-derived guess
  // here so callers see a sensible value in the browser. The remote backend's
  // real platform is exposed elsewhere through dedicated IPC calls if needed.
  process: {
    get platform(): string {
      const ua = navigator.userAgent
      if (ua.includes('Mac')) return 'darwin'
      if (ua.includes('Windows')) return 'win32'
      return 'linux'
    },
    versions: {} as Record<string, string | undefined>,
    env: {} as Record<string, string | undefined>
  }
}

export function exposeElectronAPI(): void {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (err) {
    console.error('exposeElectronAPI failed', err)
  }
}

export default { electronAPI, exposeElectronAPI }
