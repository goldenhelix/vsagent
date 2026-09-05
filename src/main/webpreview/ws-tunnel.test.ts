// Integration test for the webpreview WebSocket tunnel. Stands up a real ws
// echo server as the "upstream", points a webpreview session at it, and drives
// a ws client through handleWebPreviewUpgrade — asserting text AND binary
// frames round-trip intact (binary integrity matters: KasmVNC streams VNC as
// binary WebSocket frames).

import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createSession, deleteSession } from './registry'
import { handleWebPreviewUpgrade, isWebPreviewUpgrade } from './proxy'

let upstream: WebSocketServer
let gateway: Server
let upstreamPort: number
let gatewayPort: number
let sessionId: string

beforeAll(async () => {
  // Upstream: echo every frame back, preserving binary-ness.
  upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  upstream.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }))
  })
  await once(upstream, 'listening')
  upstreamPort = (upstream.address() as AddressInfo).port

  // Gateway: route webpreview upgrades into the tunnel, destroy the rest
  // (mirrors GatewayServer's upgrade handler).
  gateway = createServer()
  gateway.on('upgrade', (req, socket, head) => {
    if (isWebPreviewUpgrade(req)) {
      handleWebPreviewUpgrade(req, socket, head)
    } else {
      socket.destroy()
    }
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  gatewayPort = (gateway.address() as AddressInfo).port

  sessionId = createSession(`http://127.0.0.1:${upstreamPort}`).id
})

afterAll(async () => {
  deleteSession(sessionId)
  await new Promise<void>((resolve) => gateway.close(() => resolve()))
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

function connect(path: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${gatewayPort}${path}`)
}

describe('webpreview WebSocket tunnel', () => {
  it('round-trips a text frame through the proxy to the upstream', async () => {
    const client = connect(`/__orca/webpreview/${sessionId}/`)
    await once(client, 'open')
    client.send('hello-vnc')
    const [msg] = await once(client, 'message')
    expect(msg.toString()).toBe('hello-vnc')
    client.close()
    await once(client, 'close')
  })

  it('preserves binary frames byte-for-byte (incl. high bytes)', async () => {
    const client = connect(`/__orca/webpreview/${sessionId}/socket?q=1`)
    await once(client, 'open')
    const payload = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfa, 0xff])
    client.send(payload)
    const [data] = await once(client, 'message')
    const received = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    expect(received.equals(payload)).toBe(true)
    client.close()
    await once(client, 'close')
  })

  it('rejects an upgrade for an unknown session', async () => {
    const bad = connect('/__orca/webpreview/deadbeefdeadbeef/')
    const outcome = await new Promise<string>((resolve) => {
      bad.on('open', () => resolve('open'))
      bad.on('error', () => resolve('error'))
      bad.on('close', () => resolve('close'))
    })
    expect(outcome).not.toBe('open')
  })

  it('fails cleanly (no hang) when the upstream refuses the connection', async () => {
    const dead = createSession('http://127.0.0.1:1') // nothing listens on :1
    const client = connect(`/__orca/webpreview/${dead.id}/`)
    const outcome = await new Promise<string>((resolve) => {
      client.on('open', () => resolve('open'))
      client.on('error', () => resolve('error'))
      client.on('close', () => resolve('close'))
    })
    expect(outcome).not.toBe('open')
    deleteSession(dead.id)
  })

  it('isWebPreviewUpgrade: true for proxy paths, false for unrelated upgrades', () => {
    expect(
      isWebPreviewUpgrade({ url: `/__orca/webpreview/${sessionId}/x`, headers: {} } as never)
    ).toBe(true)
    expect(isWebPreviewUpgrade({ url: '/__orca/ws', headers: {} } as never)).toBe(false)
    expect(isWebPreviewUpgrade({ url: '/random', headers: {} } as never)).toBe(false)
  })
})
