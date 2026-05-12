// Patches `ipcMain` and `WebContents.prototype.send` to mirror the renderer
// IPC surface onto an in-process registry. The web gateway uses that registry
// to bridge browser clients (which don't have a preload talking to ipcMain
// directly) into the same handlers the Electron renderer uses.
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent, IpcMainEvent, WebContents } from 'electron'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
type EventHandler = (event: IpcMainEvent, ...args: unknown[]) => void
type EventBroadcaster = (channel: string, args: unknown[]) => void

const invokeRegistry = new Map<string, InvokeHandler>()
const sendRegistry = new Map<string, Set<EventHandler>>()

let eventBroadcaster: EventBroadcaster | null = null
let installed = false

export function installIpcIntercept(): void {
  if (installed) return
  installed = true
  // Why: Object.defineProperty rather than `ipcMain.handle = wrapped`. On
  // Electron 41, direct reassignment of ipcMain methods at the top of
  // main/index.ts crashes with a misleading "Cannot read properties of
  // undefined (reading 'prototype')" from the CJS-from-ESM loader's
  // descriptor check. Calling defineProperty inside whenReady sidesteps it.
  patchMethod('handle', (channel, handler) => {
    invokeRegistry.set(String(channel), handler as InvokeHandler)
  })
  patchMethod('handleOnce', (channel, handler) => {
    invokeRegistry.set(String(channel), handler as InvokeHandler)
  })
  patchMethod('removeHandler', (channel) => {
    invokeRegistry.delete(String(channel))
  })
  patchMethod('on', (channel, handler) => {
    const c = String(channel)
    let set = sendRegistry.get(c)
    if (!set) {
      set = new Set()
      sendRegistry.set(c, set)
    }
    set.add(handler as EventHandler)
  })
  patchMethod('removeListener', (channel, handler) => {
    sendRegistry.get(String(channel))?.delete(handler as EventHandler)
  })
}

function patchMethod(
  name: 'handle' | 'handleOnce' | 'removeHandler' | 'on' | 'removeListener',
  observe: (channel: unknown, handler?: unknown) => void
): void {
  const target = ipcMain as unknown as Record<string, unknown>
  const original = target[name]
  if (typeof original !== 'function') {
    console.warn(`[web-gateway] ipcMain.${name} not a function; skipping`)
    return
  }
  const wrapped = function patched(this: unknown, ...args: unknown[]): unknown {
    try {
      observe(args[0], args[1])
    } catch (err) {
      console.error(`[web-gateway] observer for ${name} threw`, err)
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  }
  try {
    Object.defineProperty(target, name, {
      value: wrapped,
      writable: true,
      configurable: true
    })
  } catch (err) {
    console.warn(`[web-gateway] could not patch ipcMain.${name}:`, err)
  }
}

// Why: must run after the Electron app is ready — on some platforms
// `WebContents` isn't a resolvable class at module load. Called from inside
// `WebGateway.start()` which is itself behind `app.whenReady()`.
export function patchWebContentsSend(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebContents } = require('electron') as { WebContents?: { prototype: object } }
  if (!WebContents || !WebContents.prototype) {
    console.warn('[web-gateway] WebContents.prototype unavailable; events will not broadcast')
    return
  }
  const proto = WebContents.prototype as unknown as {
    send: (channel: string, ...args: unknown[]) => void
    __orca_send_patched?: boolean
  }
  if (proto.__orca_send_patched) return
  const realSend = proto.send
  proto.send = function patchedSend(channel: string, ...args: unknown[]): void {
    if (eventBroadcaster) {
      try {
        eventBroadcaster(channel, args)
      } catch (err) {
        console.error('[web-gateway] broadcaster threw', err)
      }
    }
    return realSend.call(this, channel, ...args)
  }
  proto.__orca_send_patched = true
}

export function setEventBroadcaster(fn: EventBroadcaster | null): void {
  eventBroadcaster = fn
}

// Why: a direct broadcast path for code that needs to fan an event out to
// all connected WS clients without going through a BrowserWindow.
// `webContents.send` is the normal path, and the gateway patches that to
// also broadcast — but in headless mode there's no real BrowserWindow
// (we use a fake stand-in that doesn't appear in
// `BrowserWindow.getAllWindows()`), so calling `webContents.send` from a
// `for (const win of BrowserWindow.getAllWindows())` loop reaches nothing.
// This helper sidesteps that by invoking the broadcaster directly.
export function broadcastToWebClients(channel: string, args: unknown[]): void {
  if (eventBroadcaster) {
    try {
      eventBroadcaster(channel, args)
    } catch (err) {
      console.error('[web-gateway] broadcastToWebClients threw', err)
    }
  }
}

export async function dispatchInvoke(
  channel: string,
  sender: WebContents | null,
  args: unknown[]
): Promise<unknown> {
  const handler = invokeRegistry.get(channel)
  if (!handler) {
    throw new Error(`no ipcMain.handle registered for "${channel}"`)
  }
  // Why: ipcMain handlers expect an IpcMainInvokeEvent. We synthesise a
  // minimal one — most handlers only read `.sender`.
  const event = {
    sender,
    senderFrame: null,
    frameId: 0,
    processId: 0,
    returnValue: undefined as unknown,
    preventDefault: () => {},
    defaultPrevented: false,
    type: 'invoke' as const
  }
  return await handler(event as unknown as IpcMainInvokeEvent, ...args)
}

export function dispatchSend(
  channel: string,
  sender: WebContents | null,
  args: unknown[]
): void {
  const handlers = sendRegistry.get(channel)
  if (!handlers || handlers.size === 0) {
    return
  }
  const event = {
    sender,
    senderFrame: null,
    frameId: 0,
    processId: 0,
    reply: () => {},
    returnValue: undefined as unknown,
    preventDefault: () => {},
    defaultPrevented: false
  }
  for (const handler of handlers) {
    try {
      handler(event as unknown as IpcMainEvent, ...args)
    } catch (err) {
      console.error(`[web-gateway] ipcMain.on("${channel}") handler threw`, err)
    }
  }
}
