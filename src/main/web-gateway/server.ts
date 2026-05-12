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

// Why: we treat the gateway as proof-of-concept; in production this token
// should be exchanged through an auth flow (the same kind of pairing the
// mobile RPC already does). For now any client that knows the shared token
// can connect. Set ORCA_WEB_TOKEN to require a token; leave it unset to
// allow local-only loopback connections.
const SHARED_TOKEN = process.env.ORCA_WEB_TOKEN || null

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
  webRoot: string
  getHostWebContents?: () => WebContents | null
}

export class WebGateway {
  private port: number
  private webRoot: string
  private wss: WebSocketServer | null = null
  private httpServer: ReturnType<typeof createServer> | null = null
  private subscribersByChannel = new Map<string, Set<WebSocket>>()
  private subscriptionsByClient = new WeakMap<WebSocket, Set<string>>()
  private getHostWebContents: () => WebContents | null

  constructor(opts: WebGatewayOptions) {
    this.port = opts.port ?? 8765
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
      this.httpServer!.listen(this.port, '0.0.0.0', () => resolve())
    })
    console.log(`[web-gateway] listening on http://0.0.0.0:${this.port}`)
  }

  async stop(): Promise<void> {
    setEventBroadcaster(null)
    setHeadlessBroadcaster(null)
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
      return res.end()
    }
    // Why: serve a tiny health endpoint so it's easy to verify the gateway
    // is alive from curl without having to load the bundle.
    if (req.url === '/__orca/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, ts: Date.now() }))
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
        return res.end('Unauthorized')
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
      return res.end()
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
    ws.on('message', async (data) => {
      let msg: WireIn
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      switch (msg.kind) {
        case 'invoke': {
          try {
            const value = await dispatchInvoke(
              msg.channel,
              this.getHostWebContents(),
              msg.args
            )
            this.sendMessage(ws, { kind: 'invoke-ok', id: msg.id, value })
          } catch (err) {
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
    const payload = JSON.stringify({ kind: 'event', channel, args } satisfies WireOut)
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload)
        } catch (err) {
          console.error('[web-gateway] broadcast failed', channel, err)
        }
      }
    }
  }
}
