import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

function fakeReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method } as unknown as IncomingMessage
}

type FakeResponse = ServerResponse & {
  headers: Record<string, string>
  body: Promise<Buffer>
}

function fakeRes(): FakeResponse {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  const body = new Promise<Buffer>((resolveBody) => {
    stream.on('finish', () => resolveBody(Buffer.concat(chunks)))
  })
  const headers: Record<string, string> = {}
  const res = Object.assign(stream, {
    statusCode: 0,
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = String(value)
    },
    body
  })
  return res as unknown as FakeResponse
}

describe('createStaticWebClientHandler storage namespace injection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-static-web-'))
  writeFileSync(
    join(dir, 'web-index.html'),
    '<!doctype html><html><head><title>x</title></head><body></body></html>'
  )
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")')

  afterEach(() => {
    delete process.env.ORCA_STORAGE_NAMESPACE
  })

  it('injects window.__VSAGENT_STORAGE_NAMESPACE__ right after <head> when a namespace is set', async () => {
    const handler = createStaticWebClientHandler(dir, {
      storageNamespace: '/w/ws/app_instance/app_A'
    })
    const res = fakeRes()
    handler(fakeReq('/web-index.html'), res)
    const body = (await res.body).toString('utf8')
    expect(body).toContain(
      '<head><script>window.__VSAGENT_STORAGE_NAMESPACE__="/w/ws/app_instance/app_A";</script>'
    )
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('falls back to process.env.ORCA_STORAGE_NAMESPACE when no explicit option is passed', async () => {
    process.env.ORCA_STORAGE_NAMESPACE = '/w/env-scope'
    const handler = createStaticWebClientHandler(dir)
    const res = fakeRes()
    handler(fakeReq('/web-index.html'), res)
    const body = (await res.body).toString('utf8')
    expect(body).toContain('window.__VSAGENT_STORAGE_NAMESPACE__="/w/env-scope"')
  })

  it('does not inject anything when there is no namespace', async () => {
    const handler = createStaticWebClientHandler(dir, {})
    const res = fakeRes()
    handler(fakeReq('/web-index.html'), res)
    const body = (await res.body).toString('utf8')
    expect(body).not.toContain('__VSAGENT_STORAGE_NAMESPACE__')
  })

  it('escapes "<" so an attacker-controlled namespace cannot close the script tag', async () => {
    const handler = createStaticWebClientHandler(dir, { storageNamespace: '</script><script>x' })
    const res = fakeRes()
    handler(fakeReq('/web-index.html'), res)
    const body = (await res.body).toString('utf8')
    expect(body).not.toContain('</script><script>x')
    expect(body).toContain('\\u003c/script>\\u003cscript>x')
  })

  it('does not inject into non-HTML assets even with a namespace set', async () => {
    const handler = createStaticWebClientHandler(dir, { storageNamespace: '/w/ws' })
    const res = fakeRes()
    handler(fakeReq('/assets/app.js'), res)
    const body = (await res.body).toString('utf8')
    expect(body).toBe('console.log("hi")')
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
  })

  it('HEAD request against web-index.html with a namespace ends with no body', async () => {
    const handler = createStaticWebClientHandler(dir, { storageNamespace: '/w/ws' })
    const res = fakeRes()
    handler(fakeReq('/web-index.html', 'HEAD'), res)
    const body = await res.body
    expect(body.length).toBe(0)
  })
})
