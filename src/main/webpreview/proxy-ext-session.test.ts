// Regression lock for the `_ext` open-forward-proxy hole the fork shipped:
// `_ext` was routed BEFORE the session lookup, so anything that could reach the
// serve port could ask the host to fetch an arbitrary URL on its behalf
// (link-local metadata, an internal admin service, …). The session id is the
// only credential this surface has, so nothing may forward without one.

import { createServer, type IncomingMessage, type Server, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createSession, deleteSession, listSessions } from './registry'
import { handleWebPreview, isWebPreviewPath } from './proxy'

// Stands in for a host-reachable service the caller must not be able to read.
let internalService: Server
let internalUrl: string
let internalHits: string[] = []

let gateway: Server
let gatewayPort: number

beforeAll(async () => {
  internalService = createServer((req, res) => {
    internalHits.push(req.url ?? '')
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain')
    res.end('internal-secret')
  })
  await new Promise<void>((resolve) => internalService.listen(0, '127.0.0.1', resolve))
  internalUrl = `http://127.0.0.1:${(internalService.address() as AddressInfo).port}/latest/meta-data/`

  gateway = createServer((req, res) => {
    if (isWebPreviewPath(req.url)) {
      void handleWebPreview(req, res)
      return
    }
    res.statusCode = 418
    res.end('not a preview path')
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  gatewayPort = (gateway.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()))
  await new Promise<void>((resolve) => internalService.close(() => resolve()))
})

beforeEach(() => {
  internalHits = []
  for (const session of listSessions()) {
    deleteSession(session.id)
  }
})

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: gatewayPort, path, method: 'GET' },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('webpreview /_ext requires a live session', () => {
  it('404s an _ext request with an unknown session id and forwards nothing', async () => {
    const res = await get(
      `/__orca/webpreview/deadbeefdeadbeefdeadbeefdeadbeef/_ext?u=${encodeURIComponent(internalUrl)}`
    )

    expect(res.status).toBe(404)
    expect(res.body).toContain('unknown session')
    expect(internalHits).toEqual([])
  })

  it('404s an _ext request whose session was deleted', async () => {
    const session = createSession('http://127.0.0.1:1')
    deleteSession(session.id)

    const res = await get(
      `/__orca/webpreview/${session.id}/_ext?u=${encodeURIComponent(internalUrl)}`
    )

    expect(res.status).toBe(404)
    expect(internalHits).toEqual([])
  })

  it('400s when no session id is present at all', async () => {
    const res = await get('/__orca/webpreview/')

    expect(res.status).toBe(400)
    expect(internalHits).toEqual([])
  })

  it('still forwards _ext for a live session (the escape hatch keeps working)', async () => {
    const session = createSession('http://127.0.0.1:1')

    const res = await get(
      `/__orca/webpreview/${session.id}/_ext?u=${encodeURIComponent(internalUrl)}`
    )

    expect(res.status).toBe(200)
    expect(res.body).toBe('internal-secret')
    expect(internalHits).toEqual(['/latest/meta-data/'])
  })

  it('400s a live-session _ext request with no ?u=', async () => {
    const session = createSession('http://127.0.0.1:1')

    const res = await get(`/__orca/webpreview/${session.id}/_ext`)

    expect(res.status).toBe(400)
    expect(internalHits).toEqual([])
  })
})
