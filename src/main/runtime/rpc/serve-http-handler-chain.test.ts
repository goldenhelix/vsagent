import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachServeUpgradeRouting, composeServeRequestListener } from './serve-http-handler-chain'

describe('composeServeRequestListener', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    servers.length = 0
  })

  async function listen(
    listener: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  ): Promise<string> {
    const server = createServer(listener)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('returns the static listener untouched when there is no extra handler', () => {
    const staticListener = vi.fn()
    expect(composeServeRequestListener(undefined, staticListener)).toBe(staticListener)
    expect(composeServeRequestListener(undefined, undefined)).toBeUndefined()
  })

  it('falls through to the static listener when the extra handler declines', async () => {
    const staticListener = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200
      res.end('static')
    })
    const extraHandler = vi.fn(() => false)
    const base = await listen(composeServeRequestListener(extraHandler, staticListener))

    const response = await fetch(`${base}/anything`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('static')
    expect(extraHandler).toHaveBeenCalledTimes(1)
    expect(staticListener).toHaveBeenCalledTimes(1)
  })

  it('lets the extra handler own the response, skipping the static listener', async () => {
    const staticListener = vi.fn()
    const base = await listen(
      composeServeRequestListener(async (_req, res) => {
        res.statusCode = 201
        res.end('proxied')
        return true
      }, staticListener)
    )

    const response = await fetch(`${base}/__orca/webpreview/abc/`)

    expect(response.status).toBe(201)
    await expect(response.text()).resolves.toBe('proxied')
    expect(staticListener).not.toHaveBeenCalled()
  })

  it('404s a declined request when there is no static listener', async () => {
    const base = await listen(composeServeRequestListener(() => false, undefined))

    const response = await fetch(`${base}/missing`)

    expect(response.status).toBe(404)
  })

  it('502s without hanging when the extra handler throws', async () => {
    const base = await listen(
      composeServeRequestListener(() => {
        throw new Error('upstream exploded')
      }, undefined)
    )

    const response = await fetch(`${base}/boom`)

    expect(response.status).toBe(502)
  })

  it('502s without hanging when an async extra handler rejects', async () => {
    const staticListener = vi.fn()
    const base = await listen(
      composeServeRequestListener(async () => {
        await Promise.resolve()
        throw new Error('upstream exploded later')
      }, staticListener)
    )

    const response = await fetch(`${base}/boom`)

    expect(response.status).toBe(502)
    // Why: the failed handler already owns the request; falling through would double-answer it.
    expect(staticListener).not.toHaveBeenCalled()
  })

  it('closes the socket when the extra handler throws after sending headers', async () => {
    const base = await listen(
      composeServeRequestListener((_req, res) => {
        res.writeHead(200)
        throw new Error('exploded mid-response')
      }, undefined)
    )

    const response = await fetch(`${base}/partial`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('')
  })
})

describe('attachServeUpgradeRouting', () => {
  function createHarness() {
    let upgradeListener:
      | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
      | undefined = undefined
    const httpServer = {
      on(
        _event: 'upgrade',
        listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
      ) {
        upgradeListener = listener
      }
    }
    const socketSentinel = { id: 'ws' }
    const handleUpgrade = vi.fn(
      (
        _req: IncomingMessage,
        _socket: Duplex,
        _head: Buffer,
        done: (ws: unknown) => void
      ): void => {
        done(socketSentinel)
      }
    )
    const emit = vi.fn()
    const wss = { handleUpgrade, emit }
    const req = { url: '/rpc' } as unknown as IncomingMessage
    const socket = {} as unknown as Duplex
    const head = Buffer.alloc(0)
    return {
      httpServer,
      wss,
      handleUpgrade,
      emit,
      req,
      socket,
      head,
      socketSentinel,
      fire: (): void => upgradeListener?.(req, socket, head)
    }
  }

  it('hands non-hijacked upgrades to the RPC WebSocketServer', () => {
    const harness = createHarness()
    const extraUpgradeHandler = vi.fn(() => false)

    attachServeUpgradeRouting(harness.httpServer, harness.wss, extraUpgradeHandler)
    harness.fire()

    expect(extraUpgradeHandler).toHaveBeenCalledWith(harness.req, harness.socket, harness.head)
    expect(harness.handleUpgrade).toHaveBeenCalledTimes(1)
    expect(harness.emit).toHaveBeenCalledWith('connection', harness.socketSentinel, harness.req)
  })

  it('routes every upgrade to the RPC WebSocketServer when no extra handler is wired', () => {
    const harness = createHarness()

    attachServeUpgradeRouting(harness.httpServer, harness.wss, undefined)
    harness.fire()

    expect(harness.handleUpgrade).toHaveBeenCalledTimes(1)
    expect(harness.emit).toHaveBeenCalledWith('connection', harness.socketSentinel, harness.req)
  })

  it('leaves a hijacked upgrade entirely to the extra handler', () => {
    const harness = createHarness()

    attachServeUpgradeRouting(harness.httpServer, harness.wss, () => true)
    harness.fire()

    expect(harness.handleUpgrade).not.toHaveBeenCalled()
    expect(harness.emit).not.toHaveBeenCalled()
  })
})
