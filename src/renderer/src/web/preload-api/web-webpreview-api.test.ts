import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

import { createWebPreviewApi } from './web-webpreview-api'

describe('web webPreview API routing', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })

  it('create() routes to webpreview.create and returns the session', async () => {
    const session = { id: 'abc', targetOrigin: 'http://127.0.0.1:3000', proxyPath: 'http://127.0.0.1:6768/__orca/webpreview/abc' }
    callRuntimeResult.mockResolvedValue({ session })

    const result = await createWebPreviewApi().create({ targetOrigin: 'http://127.0.0.1:3000' })

    expect(callRuntimeResult).toHaveBeenCalledWith('webpreview.create', {
      targetOrigin: 'http://127.0.0.1:3000'
    })
    expect(result).toBe(session)
  })

  it('create() throws when the host returns no session', async () => {
    callRuntimeResult.mockResolvedValue({ session: null })

    await expect(
      createWebPreviewApi().create({ targetOrigin: 'http://127.0.0.1:3000' })
    ).rejects.toThrow('webpreview.create returned no session')
  })

  it('setOrigin() routes to webpreview.setOrigin and passes through a null session', async () => {
    callRuntimeResult.mockResolvedValue({ session: null })

    const result = await createWebPreviewApi().setOrigin({
      id: 'abc',
      targetOrigin: 'http://127.0.0.1:4000'
    })

    expect(callRuntimeResult).toHaveBeenCalledWith('webpreview.setOrigin', {
      id: 'abc',
      targetOrigin: 'http://127.0.0.1:4000'
    })
    expect(result).toBeNull()
  })

  it('delete() routes to webpreview.delete and discards the result', async () => {
    callRuntimeResult.mockResolvedValue(undefined)

    await createWebPreviewApi().delete({ id: 'abc' })

    expect(callRuntimeResult).toHaveBeenCalledWith('webpreview.delete', { id: 'abc' })
  })
})
