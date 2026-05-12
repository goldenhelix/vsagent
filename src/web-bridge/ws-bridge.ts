// Browser-side WebSocket bridge that emulates Electron's ipcRenderer over a
// network socket. The Orca preload imports {ipcRenderer, contextBridge,
// webFrame, webUtils} from 'electron'; when this file is aliased in via Vite,
// the preload code becomes a portable JS module that runs inside the user's
// browser and talks to the Orca backend (running on a remote Linux server)
// over a single multiplexed WebSocket.

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

type AnyArgs = unknown[]
type Listener = (event: { sender: unknown }, ...args: AnyArgs) => void

type PendingInvoke = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

type WireMessage =
  | { kind: 'invoke'; id: number; channel: string; args: AnyArgs }
  | { kind: 'send'; channel: string; args: AnyArgs }
  | { kind: 'subscribe'; channel: string }
  | { kind: 'unsubscribe'; channel: string }
  | { kind: 'invoke-ok'; id: number; value: unknown }
  | { kind: 'invoke-err'; id: number; error: string }
  | { kind: 'event'; channel: string; args: AnyArgs }

// Why: the renderer ships subscribe/unsubscribe semantics per listener, but a
// single channel may end up with many listeners. We deduplicate at the wire
// layer so we only ask the server to subscribe once per channel.
class IpcRendererShim {
  private nextInvokeId = 1
  private pending = new Map<number, PendingInvoke>()
  private listenersByChannel = new Map<string, Set<Listener>>()
  private ws: WebSocket | null = null
  private wsReady: Promise<WebSocket>
  private outbox: WireMessage[] = []

  // Why: surface connection state to the renderer so it can render a banner
  // when the WS drops. Listeners are invoked with the new state immediately
  // (synchronously) on subscribe so React state seeds correctly.
  private connectionListeners = new Set<(state: ConnectionState) => void>()
  private currentState: ConnectionState = 'connecting'
  private reconnectAttempt = 0
  private url = ''

  constructor(url: string) {
    this.url = url
    this.wsReady = this.connect()
  }

  private setState(s: ConnectionState): void {
    if (this.currentState === s) return
    this.currentState = s
    for (const fn of this.connectionListeners) {
      try {
        fn(s)
      } catch (e) {
        console.error('[web-bridge] connection listener threw', e)
      }
    }
  }

  onConnectionChange(fn: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(fn)
    fn(this.currentState)
    return () => {
      this.connectionListeners.delete(fn)
    }
  }

  get connectionState(): ConnectionState {
    return this.currentState
  }

  private connect(): Promise<WebSocket> {
    this.setState('connecting')
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      ws.addEventListener('open', () => {
        this.ws = ws
        this.reconnectAttempt = 0
        for (const queued of this.outbox.splice(0)) {
          ws.send(JSON.stringify(queued))
        }
        // Why: re-subscribe to all channels the renderer registered before the
        // socket opened so listeners attached during the initial render burst
        // (the common case) still receive events.
        for (const channel of this.listenersByChannel.keys()) {
          ws.send(JSON.stringify({ kind: 'subscribe', channel } satisfies WireMessage))
        }
        this.setState('connected')
        resolve(ws)
      })
      ws.addEventListener('message', (evt) => this.handleMessage(evt.data))
      ws.addEventListener('close', () => {
        this.ws = null
        // Why: fail every in-flight invoke so awaiting callers see a real
        // error instead of hanging forever. Reject before scheduling a
        // reconnect so retries can be triggered by the catch handler.
        for (const [id, p] of this.pending) {
          p.reject(new Error('WebSocket connection lost'))
          this.pending.delete(id)
        }
        this.setState('disconnected')
        this.scheduleReconnect()
      })
      ws.addEventListener('error', (err) => {
        console.error('[web-bridge] WebSocket error', err)
        reject(new Error('WebSocket connection failed'))
      })
    })
  }

  // Why: exponential backoff with a cap of 5s. The cap keeps the UX
  // responsive — once the server is back up, the next reconnect lands
  // within a few seconds at worst.
  private scheduleReconnect(): void {
    this.reconnectAttempt++
    const delay = Math.min(5000, 250 * 2 ** Math.min(5, this.reconnectAttempt - 1))
    setTimeout(() => {
      if (this.currentState === 'disconnected') {
        this.wsReady = this.connect()
      }
    }, delay)
  }

  private send(msg: WireMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      this.outbox.push(msg)
    }
  }

  private handleMessage(raw: unknown): void {
    let msg: WireMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.kind === 'invoke-ok') {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      p?.resolve(msg.value)
    } else if (msg.kind === 'invoke-err') {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      p?.reject(new Error(msg.error))
    } else if (msg.kind === 'event') {
      const set = this.listenersByChannel.get(msg.channel)
      if (!set) return
      const event = { sender: null }
      for (const listener of [...set]) {
        try {
          listener(event, ...msg.args)
        } catch (e) {
          console.error('[web-bridge] listener threw', msg.channel, e)
        }
      }
    }
  }

  invoke(channel: string, ...args: AnyArgs): Promise<unknown> {
    const id = this.nextInvokeId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ kind: 'invoke', id, channel, args })
    })
  }

  sendChannel(channel: string, ...args: AnyArgs): void {
    this.send({ kind: 'send', channel, args })
  }

  on(channel: string, listener: Listener): this {
    let set = this.listenersByChannel.get(channel)
    if (!set) {
      set = new Set()
      this.listenersByChannel.set(channel, set)
      this.send({ kind: 'subscribe', channel })
    }
    set.add(listener)
    return this
  }

  removeListener(channel: string, listener: Listener): this {
    const set = this.listenersByChannel.get(channel)
    if (!set) return this
    set.delete(listener)
    if (set.size === 0) {
      this.listenersByChannel.delete(channel)
      this.send({ kind: 'unsubscribe', channel })
    }
    return this
  }

  removeAllListeners(channel?: string): this {
    if (channel) {
      this.listenersByChannel.delete(channel)
      this.send({ kind: 'unsubscribe', channel })
    } else {
      for (const c of this.listenersByChannel.keys()) {
        this.send({ kind: 'unsubscribe', channel: c })
      }
      this.listenersByChannel.clear()
    }
    return this
  }
}

const bridgeUrl = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/__orca/ws`
})()

export const bridge = new IpcRendererShim(bridgeUrl)

// Why: surface the bridge connection state to the renderer through a small
// global. The renderer is built independently of the web-bridge sources, so
// importing them from renderer code would couple the two trees. A read-only
// global keeps the renderer dependency on the bridge minimal.
;(window as unknown as { orcaWeb?: unknown }).orcaWeb = {
  onConnectionChange: (fn: (state: ConnectionState) => void) => bridge.onConnectionChange(fn),
  getConnectionState: (): ConnectionState => bridge.connectionState
}
