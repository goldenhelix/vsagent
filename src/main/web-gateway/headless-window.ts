// FakeBrowserWindow — minimum surface area to substitute for an Electron
// BrowserWindow in headless web-mode. Linux servers without X cannot create
// a real BrowserWindow even with `--ozone-platform=headless` (Gtk still
// initialises at construction time and crashes), so we cannot rely on a real
// window. The IPC layer only touches a handful of BrowserWindow methods —
// `.isDestroyed`, `.on(event)`, `.webContents.send`, `.webContents.id`,
// `.webContents.on`, `.webContents.setZoomLevel`, etc. — and the
// gateway-side webContents.send patch already broadcasts events to
// connected browser clients. So a typed-as-BrowserWindow stub is enough
// for handler registration to succeed and broadcasts to land in the right
// place.

import type { BrowserWindow, WebContents } from 'electron'
import { EventEmitter } from 'events'

let nextFakeId = 1
let activeBroadcaster: ((channel: string, args: unknown[]) => void) | null = null
const fakeWindowsByWcId = new Map<number, BrowserWindow>()

export function setHeadlessBroadcaster(
  fn: ((channel: string, args: unknown[]) => void) | null
): void {
  activeBroadcaster = fn
}

// Why: patch Electron's `BrowserWindow.fromWebContents` so it resolves our
// fake webContents back to its fake owner. Several handlers (runtime sync,
// dialog parent, browser-view embed) rely on this lookup; without the patch
// they throw and the renderer's view never mounts, producing a blank page
// after the first navigation.
export function patchBrowserWindowLookup(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as { BrowserWindow?: typeof BrowserWindow }
  const BW = electron.BrowserWindow
  if (!BW || (BW as unknown as { __orca_fromWcPatched?: boolean }).__orca_fromWcPatched) {
    return
  }
  const orig = BW.fromWebContents.bind(BW)
  BW.fromWebContents = ((wc: { id?: number } | null): BrowserWindow | null => {
    if (!wc) return null
    if (typeof wc.id === 'number' && fakeWindowsByWcId.has(wc.id)) {
      return fakeWindowsByWcId.get(wc.id) ?? null
    }
    try {
      return orig(wc as WebContents)
    } catch {
      return null
    }
  }) as typeof BW.fromWebContents
  ;(BW as unknown as { __orca_fromWcPatched?: boolean }).__orca_fromWcPatched = true
}

function makeFakeWebContents(id: number, ownerRef: { window: BrowserWindow | null }): WebContents {
  const emitter = new EventEmitter()
  // Why: Electron's stream uses arbitrarily many listeners (every PTY
  // attaches one or two for repaint/zoom). Suppress MaxListenersExceeded
  // warnings without losing observability — they're noise here.
  emitter.setMaxListeners(0)

  const wc = {
    id,
    isDestroyed: () => false,
    isLoading: () => false,
    isCrashed: () => false,
    getURL: () => '',
    getProcessId: () => process.pid,
    // Why: Electron's `BrowserWindow.fromWebContents(wc)` internally calls
    // `wc.getOwnerBrowserWindow()`. Several IPC handlers use that to find
    // the source window. Returning our fake window keeps those paths
    // working — without this, `runtime:syncWindowGraph` throws and the
    // entire renderer-graph sync (which drives navigation into a worktree
    // and editor mounts) silently fails, producing a blank page.
    getOwnerBrowserWindow: (): BrowserWindow | null => ownerRef.window,
    // Why: trusted-renderer guards (e.g. browser-session handlers) call
    // `sender.getType()` to verify the IPC came from the main BrowserWindow
    // and not a webview / browserview / offscreen renderer. Reporting
    // 'window' means "this is the main renderer".
    getType: (): string => 'window',
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    addListener: emitter.addListener.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    emit: emitter.emit.bind(emitter),
    setMaxListeners: emitter.setMaxListeners.bind(emitter),
    listeners: emitter.listeners.bind(emitter),
    eventNames: emitter.eventNames.bind(emitter),
    send: (channel: string, ...args: unknown[]): void => {
      activeBroadcaster?.(channel, args)
    },
    sendToFrame: (_frameId: number | unknown, channel: string, ...args: unknown[]): void => {
      activeBroadcaster?.(channel, args)
    },
    postMessage: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
    getZoomFactor: () => 1,
    setBackgroundThrottling: () => {},
    setVisualZoomLevelLimits: () => {},
    setLayoutZoomLevelLimits: () => {},
    invalidate: () => {},
    reload: () => {},
    reloadIgnoringCache: () => {},
    focus: () => {},
    isFocused: () => true,
    setUserAgent: () => {},
    getUserAgent: () => 'OrcaWebHeadless/1.0',
    openDevTools: () => {},
    closeDevTools: () => {},
    executeJavaScript: () => Promise.resolve(undefined),
    insertCSS: () => Promise.resolve(''),
    removeInsertedCSS: () => Promise.resolve(),
    setWindowOpenHandler: () => {},
    // Why: handlers reach for webContents.session to register permission
    // request handlers. Provide a no-op shim so callers don't crash; the
    // gateway side enforces auth, not session-level permissions.
    session: {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      setDevicePermissionHandler: () => {},
      webRequest: {
        onBeforeRequest: () => {},
        onBeforeSendHeaders: () => {},
        onHeadersReceived: () => {}
      }
    },
    debugger: {
      attach: () => {},
      detach: () => {},
      sendCommand: () => Promise.resolve({}),
      on: () => {},
      off: () => {}
    }
  } as unknown as WebContents
  return wc
}

export function createHeadlessBrowserWindow(): BrowserWindow {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  const id = nextFakeId++
  // Why: forward-reference the window from the webContents so
  // `wc.getOwnerBrowserWindow()` can return its owner. We use an indirection
  // object because the BrowserWindow can't reference itself during its own
  // construction without a temporal cycle.
  const ownerRef: { window: BrowserWindow | null } = { window: null }
  const webContents = makeFakeWebContents(id, ownerRef)
  const win = {
    id,
    webContents,
    isDestroyed: () => false,
    isFocused: () => false,
    isVisible: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    show: () => {},
    hide: () => {},
    focus: () => {},
    blur: () => {},
    close: () => {},
    destroy: () => {},
    minimize: () => {},
    maximize: () => {},
    unmaximize: () => {},
    restore: () => {},
    setFullScreen: () => {},
    setBounds: () => {},
    getBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
    setSize: () => {},
    setPosition: () => {},
    setTitle: () => {},
    getTitle: () => 'Orca',
    moveTop: () => {},
    flashFrame: () => {},
    setIcon: () => {},
    setRepresentedFilename: () => {},
    setProgressBar: () => {},
    setMenu: () => {},
    setBackgroundColor: () => {},
    setOpacity: () => {},
    getOpacity: () => 1,
    setHasShadow: () => {},
    setAlwaysOnTop: () => {},
    // Why: upstream's deferLoad refactor extracted a loadMainWindow() helper
    // that calls .loadFile / .loadURL after IPC handlers register. In headless
    // mode no renderer mounts on the server, so these are no-ops — the bundle
    // is served to browsers via the gateway instead.
    loadFile: () => Promise.resolve(),
    loadURL: () => Promise.resolve(),
    reload: () => {},
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    addListener: emitter.addListener.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    emit: emitter.emit.bind(emitter),
    setMaxListeners: emitter.setMaxListeners.bind(emitter),
    listeners: emitter.listeners.bind(emitter),
    eventNames: emitter.eventNames.bind(emitter)
  } as unknown as BrowserWindow
  ownerRef.window = win
  fakeWindowsByWcId.set(id, win)
  return win
}
