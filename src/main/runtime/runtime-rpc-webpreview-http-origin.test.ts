import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

// Why this file and not methods/webpreview.test.ts: that file exercises the RPC method
// against a hand-built ctx; this one boots a real WebSocket transport to prove the ctx
// threading (dispatcher -> handleMessage -> RpcContext.webPreviewHttpOrigin) actually wires
// up to the live listener, not just to a mock.

function startedServer(): Promise<OrcaRuntimeRpcServer> {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-webpreview-origin-')),
    enableWebSocket: true,
    wsPort: 0
  })
  return server.start().then(() => server)
}

describe('webpreview.create returns an absolute URL over the live transport', () => {
  it("prefixes the proxy path with the running WebSocket listener's http origin", async () => {
    const server = await startedServer()
    try {
      const endpoint = server.getWebSocketEndpoint()
      expect(endpoint).toBeTruthy()
      const expectedOrigin = `http://127.0.0.1:${new URL(endpoint!).port}`

      const response = (await server['handleMessage'](
        JSON.stringify({
          id: 'req_webpreview_create',
          authToken: server['authToken'],
          method: 'webpreview.create',
          params: { targetOrigin: 'example.com' }
        })
      )) as { ok: true; result: { session: { id: string; proxyPath: string } } }

      expect(response.ok).toBe(true)
      expect(response.result.session.proxyPath).toBe(
        `${expectedOrigin}/__orca/webpreview/${response.result.session.id}`
      )
    } finally {
      await server.stop()
    }
  })

  it('never advertises the 0.0.0.0 wildcard bind host', async () => {
    // Why: a wide (0.0.0.0) bind is the normal state once any network-reach device has paired
    // (or under `orca serve`'s exposeNetworkByDefault) — the raw bind host is not something any
    // client, including the one that just connected, can dial.
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-webpreview-origin-')),
      enableWebSocket: true,
      wsPort: 0,
      exposeNetworkByDefault: true
    })
    await server.start()
    try {
      const endpoint = server.getWebSocketEndpoint()
      expect(endpoint).toBeTruthy()
      expect(new URL(endpoint!).hostname).toBe('0.0.0.0')
      const expectedOrigin = `http://127.0.0.1:${new URL(endpoint!).port}`

      const response = (await server['handleMessage'](
        JSON.stringify({
          id: 'req_webpreview_create_wide_bind',
          authToken: server['authToken'],
          method: 'webpreview.create',
          params: { targetOrigin: 'example.com' }
        })
      )) as { ok: true; result: { session: { id: string; proxyPath: string } } }

      expect(response.ok).toBe(true)
      expect(response.result.session.proxyPath).toBe(
        `${expectedOrigin}/__orca/webpreview/${response.result.session.id}`
      )
    } finally {
      await server.stop()
    }
  })

  it('falls back to a bare path when no WebSocket transport is up', async () => {
    // Why enableWebSocket:false and not just skipping start(): resolveWebPreviewHttpOrigin
    // must not assume a websocket transport entry exists at all (Unix-socket-only hosts).
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-webpreview-origin-')),
      enableWebSocket: false
    })
    await server.start()
    try {
      const response = (await server['handleMessage'](
        JSON.stringify({
          id: 'req_webpreview_create_no_ws',
          authToken: server['authToken'],
          method: 'webpreview.create',
          params: { targetOrigin: 'example.com' }
        })
      )) as { ok: true; result: { session: { id: string; proxyPath: string } } }

      expect(response.ok).toBe(true)
      expect(response.result.session.proxyPath).toBe(
        `/__orca/webpreview/${response.result.session.id}`
      )
    } finally {
      await server.stop()
    }
  })
})
