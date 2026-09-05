// Why (VSAgent fork): the serve HTTP server multiplexes the static web-client
// handler with the webpreview reverse proxy. This chain keeps the transport's
// listener wiring to one call so the fork seam in ws-transport stays tiny.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

// Owns the response when it returns true; false falls through to the next
// handler in the chain.
export type ExtraHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => boolean | Promise<boolean>

// Returns true when it hijacks the upgrade socket; false hands it to the RPC
// WebSocketServer.
export type ExtraUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void

type UpgradeCapableServer = {
  on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void
}

type UpgradeWebSocketServer = {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    done: (ws: unknown) => void
  ): void
  emit(event: 'connection', ws: unknown, req: IncomingMessage): void
}

// Routes HTTP upgrades: the webpreview tunnel may hijack the raw socket; all
// remaining upgrades go to the RPC WebSocketServer.
export function attachServeUpgradeRouting(
  httpServer: UpgradeCapableServer,
  wss: UpgradeWebSocketServer,
  extraUpgradeHandler: ExtraUpgradeHandler | undefined
): void {
  httpServer.on('upgrade', (req, socket, head) => {
    if (extraUpgradeHandler?.(req, socket, head)) {
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })
}

export function composeServeRequestListener(
  extraHandler: ExtraHttpHandler | undefined,
  staticListener: RequestListener | undefined
): RequestListener | undefined {
  if (extraHandler === undefined) {
    return staticListener
  }
  return (req, res) => {
    void (async () => {
      try {
        if (await extraHandler(req, res)) {
          return
        }
      } catch {
        // Why: a proxy fault must not leave the socket hanging open forever.
        if (!res.headersSent) {
          res.statusCode = 502
        }
        res.end()
        return
      }
      if (staticListener) {
        staticListener(req, res)
        return
      }
      res.statusCode = 404
      res.end()
    })()
  }
}
