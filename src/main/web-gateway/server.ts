import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFile, stat } from 'fs/promises'
import { extname, join, normalize, resolve } from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import type { WebContents } from 'electron'
import {
  dispatchInvoke,
  dispatchSend,
  installIpcIntercept,
  patchWebContentsSend,
  setEventBroadcaster
} from './ipc-intercept'
import { setHeadlessBroadcaster, patchBrowserWindowLookup } from './headless-window'
import { handleWebPreview, isWebPreviewPath } from './webpreview/proxy'

// Why: we treat the gateway as proof-of-concept; in production this token
// should be exchanged through an auth flow (the same kind of pairing the
// mobile RPC already does). For now any client that knows the shared token
// can connect. Set VSAGENT_TOKEN (or the legacy ORCA_WEB_TOKEN) to require
// one; leave it unset to allow local-only loopback connections.
const SHARED_TOKEN = process.env.VSAGENT_TOKEN || process.env.ORCA_WEB_TOKEN || null

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}

type WireIn =
  | { kind: 'invoke'; id: number; channel: string; args: unknown[] }
  | { kind: 'send'; channel: string; args: unknown[] }
  | { kind: 'subscribe'; channel: string }
  | { kind: 'unsubscribe'; channel: string }

type WireOut =
  | { kind: 'invoke-ok'; id: number; value: unknown }
  | { kind: 'invoke-err'; id: number; error: string }
  | { kind: 'event'; channel: string; args: unknown[] }

export type WebGatewayOptions = {
  port?: number
  /** Bind address. Default `0.0.0.0` (reachable from the LAN). Set to
   *  `127.0.0.1` when the gateway sits behind a reverse proxy (Caddy,
   *  nginx) on the same host so the port isn't exposed outside loopback. */
  host?: string
  webRoot: string
  getHostWebContents?: () => WebContents | null
}

export class WebGateway {
  private port: number
  private host: string
  private webRoot: string
  private wss: WebSocketServer | null = null
  private httpServer: ReturnType<typeof createServer> | null = null
  private subscribersByChannel = new Map<string, Set<WebSocket>>()
  private subscriptionsByClient = new WeakMap<WebSocket, Set<string>>()
  private getHostWebContents: () => WebContents | null

  // Why: stringifying large event payloads (notably session:changed snapshots
  // — multiple KB each) on the synchronous emit path holds the Electron main
  // thread long enough that inbound WS messages stall until the burst flushes,
  // which surfaced as multi-second freezes where the browser saw no frames.
  // Enqueue + setImmediate drain releases the event loop between bursts so
  // invoke handlers run promptly, and per-channel coalescing collapses rapid
  // full-snapshot emissions to a single stringify call before the drain.
  private eventQueue: { channel: string; args: unknown[] }[] = []
  private coalesceIndices = new Map<string, number>()
  private drainScheduled = false

  // Channels whose payload is a complete snapshot — newer emissions supersede
  // older ones, so it is safe to drop in-flight duplicates. Incremental
  // channels (pty:data, anything keyed by id with delta payloads) MUST NOT go
  // in here or output will be lost.
  private static readonly COALESCABLE_CHANNELS = new Set<string>(['session:changed'])

  // Why: production-grade broadcast telemetry. Two paths:
  //   1. Slow-drain tripwire — silent in healthy operation; logs immediately
  //      with a per-channel byte breakdown the moment a single drain exceeds
  //      SLOW_DRAIN_MS, so a regression is loud the first time it happens.
  //   2. Rolling summary — every TELEMETRY_INTERVAL_MS, emits one line of
  //      headline counters plus a top-channels-by-bytes line. The summary is
  //      suppressed when no traffic occurred in the window, so idle hosts
  //      stay quiet. Overhead is a handful of Map increments per broadcast
  //      and two console.log lines per window — negligible vs. the visibility
  //      it gives when the next freeze report lands.
  private static readonly SLOW_DRAIN_MS = 20
  private static readonly TELEMETRY_INTERVAL_MS = 30_000
  private telemetry = {
    enqueued: 0,
    coalesced: 0,
    drains: 0,
    totalDrainMs: 0,
    maxDrainMs: 0,
    maxQueueSize: 0,
    perChannelCount: new Map<string, number>(),
    perChannelCoalesced: new Map<string, number>(),
    perChannelBytes: new Map<string, number>()
  }
  private telemetryTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: WebGatewayOptions) {
    this.port = opts.port ?? 8765
    this.host = opts.host ?? '0.0.0.0'
    this.webRoot = opts.webRoot
    this.getHostWebContents = opts.getHostWebContents ?? (() => null)
  }

  async start(): Promise<void> {
    installIpcIntercept()
    patchWebContentsSend()
    patchBrowserWindowLookup()
    const broadcast = (channel: string, args: unknown[]): void => {
      this.broadcastEvent(channel, args)
    }
    setEventBroadcaster(broadcast)
    setHeadlessBroadcaster(broadcast)

    this.httpServer = createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ noServer: true })
    this.httpServer.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/__orca/ws')) {
        socket.destroy()
        return
      }
      if (!this.checkAuth(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, req)
      })
    })
    this.wss.on('connection', (ws) => this.handleConnection(ws))

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, this.host, () => resolve())
    })
    console.log(`[web-gateway] listening on http://${this.host}:${this.port}`)
    this.startTelemetryTimer()
  }

  async stop(): Promise<void> {
    setEventBroadcaster(null)
    setHeadlessBroadcaster(null)
    this.stopTelemetryTimer()
    // Drop anything queued; a pending setImmediate drain becomes a no-op
    // because both the queue and the coalesce-index map are empty.
    this.eventQueue = []
    this.coalesceIndices.clear()
    if (this.wss) {
      for (const client of this.wss.clients) client.terminate()
      await new Promise<void>((r) => this.wss!.close(() => r()))
      this.wss = null
    }
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()))
      this.httpServer = null
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!SHARED_TOKEN) return true
    const u = new URL(req.url!, 'http://localhost')
    const t = u.searchParams.get('token') ?? req.headers['x-orca-token']
    return t === SHARED_TOKEN
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url) {
      res.statusCode = 400
      res.end()
      return
    }
    // Why: serve a tiny health endpoint so it's easy to verify the gateway
    // is alive from curl without having to load the bundle.
    if (req.url === '/__orca/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ts: Date.now() }))
      return
    }
    // Why: the webpreview HTTP proxy serves an iframe-backed in-app browser.
    // Routed BEFORE the SPA static-file lookup so /__orca/webpreview/...
    // never gets caught by the SPA fallback.
    if (isWebPreviewPath(req.url)) {
      return handleWebPreview(req, res)
    }
    if (SHARED_TOKEN && req.url !== '/__orca/health') {
      // Why: gate the SPA shell behind the same token. The browser sets a
      // cookie after a one-shot ?token= grant so subsequent requests don't
      // need to carry it on every URL. (PoC; production should do a proper
      // login.)
      const cookieHeader = req.headers.cookie || ''
      const hasCookie = cookieHeader.includes(`orca_token=${SHARED_TOKEN}`)
      const u = new URL(req.url, 'http://localhost')
      const queryToken = u.searchParams.get('token')
      if (!hasCookie && queryToken !== SHARED_TOKEN) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'text/plain')
        res.end('Unauthorized')
        return
      }
      if (queryToken === SHARED_TOKEN && !hasCookie) {
        res.setHeader('Set-Cookie', `orca_token=${SHARED_TOKEN}; Path=/; HttpOnly; SameSite=Lax`)
      }
    }
    const u = new URL(req.url, 'http://localhost')
    let pathname = decodeURIComponent(u.pathname)
    if (pathname === '/' || pathname === '/index.html') {
      pathname = '/index.html'
    }
    const safe = normalize(pathname).replace(/^([./\\]+)+/, '')
    const candidate = resolve(this.webRoot, safe)
    if (!candidate.startsWith(this.webRoot)) {
      res.statusCode = 403
      res.end()
      return
    }
    try {
      const st = await stat(candidate)
      if (!st.isFile()) {
        // SPA fallback: serve index.html for client-side routes
        return this.serveFile(res, join(this.webRoot, 'index.html'))
      }
      return this.serveFile(res, candidate)
    } catch {
      return this.serveFile(res, join(this.webRoot, 'index.html'))
    }
  }

  private async serveFile(res: ServerResponse, path: string): Promise<void> {
    try {
      const data = await readFile(path)
      const ext = extname(path).toLowerCase()
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      })
      res.end(data)
    } catch (err) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end(`Not found: ${path}\n${(err as Error).message}`)
    }
  }

  private handleConnection(ws: WebSocket): void {
    this.subscriptionsByClient.set(ws, new Set())
    console.log('[web-gateway] client connected; total =', this.wss?.clients.size ?? 1)
    ws.on('message', async (data) => {
      let msg: WireIn
      try {
        msg = JSON.parse(String(data))
      } catch {
        console.warn('[web-gateway] received non-JSON message; dropping')
        return
      }
      switch (msg.kind) {
        case 'invoke': {
          const startedAt = Date.now()
          // Why: ORCA_WEB_TRACE=1 logs EVERY invoke pre/post — useful when
          // debugging a crash, since the crash log will name the channel
          // that was in flight (or the immediately prior one). Default mode
          // only logs slow (>200ms) and failed invokes to keep noise down.
          const trace = process.env.ORCA_WEB_TRACE === '1'
          if (trace) console.log(`[web-gateway] → invoke "${msg.channel}"`)
          try {
            const value = await dispatchInvoke(
              msg.channel,
              this.getHostWebContents(),
              msg.args
            )
            this.sendMessage(ws, { kind: 'invoke-ok', id: msg.id, value })
            const dur = Date.now() - startedAt
            if (trace) console.log(`[web-gateway] ← invoke "${msg.channel}" ok ${dur}ms`)
            else if (dur > 200) {
              console.log(`[web-gateway] invoke "${msg.channel}" ok in ${dur}ms`)
            }
          } catch (err) {
            const stack = err instanceof Error && err.stack ? err.stack : String(err)
            console.warn(`[web-gateway] invoke "${msg.channel}" failed: ${stack}`)
            this.sendMessage(ws, {
              kind: 'invoke-err',
              id: msg.id,
              error: (err as Error)?.message ?? String(err)
            })
          }
          break
        }
        case 'send': {
          dispatchSend(msg.channel, this.getHostWebContents(), msg.args)
          break
        }
        case 'subscribe': {
          this.subscribe(ws, msg.channel)
          break
        }
        case 'unsubscribe': {
          this.unsubscribe(ws, msg.channel)
          break
        }
      }
    })
    ws.on('close', () => {
      const channels = this.subscriptionsByClient.get(ws)
      if (channels) {
        for (const c of channels) {
          this.subscribersByChannel.get(c)?.delete(ws)
        }
      }
    })
  }

  private subscribe(ws: WebSocket, channel: string): void {
    let set = this.subscribersByChannel.get(channel)
    if (!set) {
      set = new Set()
      this.subscribersByChannel.set(channel, set)
    }
    set.add(ws)
    this.subscriptionsByClient.get(ws)?.add(channel)
  }

  private unsubscribe(ws: WebSocket, channel: string): void {
    this.subscribersByChannel.get(channel)?.delete(ws)
    this.subscriptionsByClient.get(ws)?.delete(channel)
  }

  private sendMessage(ws: WebSocket, msg: WireOut): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  broadcastEvent(channel: string, args: unknown[]): void {
    const set = this.subscribersByChannel.get(channel)
    if (!set || set.size === 0) return
    this.telemetry.enqueued += 1
    incrementMap(this.telemetry.perChannelCount, channel)
    if (WebGateway.COALESCABLE_CHANNELS.has(channel)) {
      const idx = this.coalesceIndices.get(channel)
      if (idx !== undefined) {
        this.eventQueue[idx] = { channel, args }
        this.telemetry.coalesced += 1
        incrementMap(this.telemetry.perChannelCoalesced, channel)
      } else {
        this.coalesceIndices.set(channel, this.eventQueue.length)
        this.eventQueue.push({ channel, args })
      }
    } else {
      this.eventQueue.push({ channel, args })
    }
    if (!this.drainScheduled) {
      this.drainScheduled = true
      setImmediate(() => this.drainEventQueue())
    }
  }

  private drainEventQueue(): void {
    this.drainScheduled = false
    const queue = this.eventQueue
    this.eventQueue = []
    this.coalesceIndices.clear()
    const startedAt = Date.now()
    const perChannelDrainBytes = new Map<string, number>()
    for (const { channel, args } of queue) {
      const set = this.subscribersByChannel.get(channel)
      if (!set || set.size === 0) continue
      const payload = JSON.stringify({ kind: 'event', channel, args } satisfies WireOut)
      const byteLen = Buffer.byteLength(payload)
      addToMap(this.telemetry.perChannelBytes, channel, byteLen)
      addToMap(perChannelDrainBytes, channel, byteLen)
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue
        try {
          ws.send(payload)
        } catch (err) {
          console.error('[web-gateway] broadcast failed', channel, err)
        }
      }
    }
    const durationMs = Date.now() - startedAt
    this.telemetry.drains += 1
    this.telemetry.totalDrainMs += durationMs
    if (durationMs > this.telemetry.maxDrainMs) this.telemetry.maxDrainMs = durationMs
    if (queue.length > this.telemetry.maxQueueSize) this.telemetry.maxQueueSize = queue.length
    if (durationMs >= WebGateway.SLOW_DRAIN_MS) {
      const breakdown = formatTopByBytes(perChannelDrainBytes, 5)
      console.warn(
        `[web-gateway] slow drain: ${durationMs}ms, ${queue.length} events; top: ${breakdown}`
      )
    }
  }

  private startTelemetryTimer(): void {
    if (this.telemetryTimer) return
    this.telemetryTimer = setInterval(() => this.logTelemetrySummary(), WebGateway.TELEMETRY_INTERVAL_MS)
    if (typeof this.telemetryTimer.unref === 'function') this.telemetryTimer.unref()
  }

  private stopTelemetryTimer(): void {
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer)
      this.telemetryTimer = null
    }
  }

  private logTelemetrySummary(): void {
    const t = this.telemetry
    if (t.enqueued === 0) return
    const avgDrainMs = t.drains > 0 ? (t.totalDrainMs / t.drains).toFixed(2) : '0'
    const topBytes = formatTopByBytes(t.perChannelBytes, 5)
    const topCoalesced = formatTopByCount(t.perChannelCoalesced, 3)
    console.log(
      `[web-gateway] telemetry: enqueued=${t.enqueued} coalesced=${t.coalesced} drains=${t.drains} ` +
        `maxQ=${t.maxQueueSize} maxDrain=${t.maxDrainMs}ms avgDrain=${avgDrainMs}ms`
    )
    console.log(`[web-gateway] telemetry by bytes: ${topBytes || '(none)'}`)
    if (t.coalesced > 0) {
      console.log(`[web-gateway] telemetry coalesced-by-channel: ${topCoalesced || '(none)'}`)
    }
    // Reset rolling counters for the next window.
    t.enqueued = 0
    t.coalesced = 0
    t.drains = 0
    t.totalDrainMs = 0
    t.maxDrainMs = 0
    t.maxQueueSize = 0
    t.perChannelCount.clear()
    t.perChannelCoalesced.clear()
    t.perChannelBytes.clear()
  }
}

function incrementMap(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1)
}

function addToMap(m: Map<string, number>, key: string, value: number): void {
  m.set(key, (m.get(key) ?? 0) + value)
}

function formatTopByBytes(m: Map<string, number>, n: number): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([channel, bytes]) => `${channel}=${formatBytes(bytes)}`)
    .join(', ')
}

function formatTopByCount(m: Map<string, number>, n: number): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([channel, count]) => `${channel}=${count}`)
    .join(', ')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
