import { beforeEach, describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { deleteSession, listSessions } from '../../../webpreview/registry'
import { WEBPREVIEW_METHODS } from './webpreview'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(): RpcDispatcher {
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: WEBPREVIEW_METHODS })
}

beforeEach(() => {
  for (const session of listSessions()) {
    deleteSession(session.id)
  }
})

describe('webpreview RPC methods', () => {
  it('create returns an absolute URL when the ctx carries a webpreview http origin', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('webpreview.create', { targetOrigin: 'example.com' }),
      { webPreviewHttpOrigin: 'http://127.0.0.1:6768' }
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error('expected ok response')
    }
    const session = (
      response.result as { session: { id: string; targetOrigin: string; proxyPath: string } }
    ).session
    expect(session.targetOrigin).toBe('http://example.com')
    expect(session.proxyPath).toBe(`http://127.0.0.1:6768/__orca/webpreview/${session.id}`)
  })

  it('create falls back to a bare path when no http origin is available', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('webpreview.create', { targetOrigin: 'example.com' })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error('expected ok response')
    }
    const session = (response.result as { session: { id: string; proxyPath: string } }).session
    expect(session.proxyPath).toBe(`/__orca/webpreview/${session.id}`)
  })

  it('create rejects a missing target origin', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(makeRequest('webpreview.create', {}))

    expect(response.ok).toBe(false)
  })

  it('setOrigin retargets an existing session and keeps returning an absolute URL', async () => {
    const dispatcher = makeDispatcher()
    const created = await dispatcher.dispatch(
      makeRequest('webpreview.create', { targetOrigin: 'example.com' }),
      { webPreviewHttpOrigin: 'https://serve.example:9443' }
    )
    if (!created.ok) {
      throw new Error('expected ok response')
    }
    const id = (created.result as { session: { id: string } }).session.id

    const response = await dispatcher.dispatch(
      makeRequest('webpreview.setOrigin', { id, targetOrigin: 'other.example' }),
      { webPreviewHttpOrigin: 'https://serve.example:9443' }
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error('expected ok response')
    }
    const session = (
      response.result as { session: { id: string; targetOrigin: string; proxyPath: string } | null }
    ).session
    expect(session?.targetOrigin).toBe('http://other.example')
    expect(session?.proxyPath).toBe(`https://serve.example:9443/__orca/webpreview/${id}`)
  })

  it('setOrigin returns a null session for an unknown id', async () => {
    const dispatcher = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('webpreview.setOrigin', { id: 'does-not-exist', targetOrigin: 'example.com' })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error('expected ok response')
    }
    expect((response.result as { session: unknown }).session).toBeNull()
  })

  it('delete removes the session so a later setOrigin sees it as gone', async () => {
    const dispatcher = makeDispatcher()
    const created = await dispatcher.dispatch(
      makeRequest('webpreview.create', { targetOrigin: 'example.com' })
    )
    if (!created.ok) {
      throw new Error('expected ok response')
    }
    const id = (created.result as { session: { id: string } }).session.id

    const deleteResponse = await dispatcher.dispatch(makeRequest('webpreview.delete', { id }))
    expect(deleteResponse).toMatchObject({ ok: true, result: { deleted: true } })

    const afterDelete = await dispatcher.dispatch(
      makeRequest('webpreview.setOrigin', { id, targetOrigin: 'example.com' })
    )
    if (!afterDelete.ok) {
      throw new Error('expected ok response')
    }
    expect((afterDelete.result as { session: unknown }).session).toBeNull()
  })

  it('does not register webpreview.list or webpreview.get', async () => {
    const dispatcher = makeDispatcher()

    const list = await dispatcher.dispatch(makeRequest('webpreview.list'))
    const get = await dispatcher.dispatch(makeRequest('webpreview.get', { id: 'x' }))

    expect(list).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(get).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
  })
})
