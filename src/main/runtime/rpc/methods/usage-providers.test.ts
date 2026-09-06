import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  clearUsageProviderStores,
  setUsageProviderStores,
  type UsageProviderQueryStore
} from '../../../usage/usage-provider-store-registry'
import { USAGE_PROVIDER_METHODS } from './usage-providers'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(): RpcDispatcher {
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: USAGE_PROVIDER_METHODS })
}

function makeStore(): UsageProviderQueryStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getScanState: vi.fn(() => ({ enabled: false })),
    setEnabled: vi.fn((enabled: boolean) => ({ enabled })),
    refresh: vi.fn(() => ({ enabled: true })),
    getSnapshot: vi.fn(() => ({ summary: {} })),
    getSummary: vi.fn(() => ({ totalTokens: 3 })),
    getDaily: vi.fn(() => []),
    getBreakdown: vi.fn(() => []),
    getRecentSessions: vi.fn(() => [])
  } as never
}

let claudeUsage = makeStore()

beforeEach(() => {
  claudeUsage = makeStore()
  setUsageProviderStores({
    claudeUsage,
    codexUsage: makeStore(),
    openCodeUsage: makeStore()
  })
})

afterEach(() => clearUsageProviderStores())

describe('usage provider RPC methods', () => {
  it('exposes every store operation for all three providers', () => {
    const names = USAGE_PROVIDER_METHODS.map((method) => method.name)
    for (const prefix of ['claudeUsage', 'codexUsage', 'openCodeUsage']) {
      expect(names).toContain(`${prefix}.getScanState`)
      expect(names).toContain(`${prefix}.setEnabled`)
      expect(names).toContain(`${prefix}.refresh`)
      expect(names).toContain(`${prefix}.getSnapshot`)
      expect(names).toContain(`${prefix}.getSummary`)
      expect(names).toContain(`${prefix}.getDaily`)
      expect(names).toContain(`${prefix}.getBreakdown`)
      expect(names).toContain(`${prefix}.getRecentSessions`)
    }
  })

  it('forwards arguments to the registered store the way the IPC handlers do', async () => {
    const dispatcher = makeDispatcher()

    const enabled = await dispatcher.dispatch(
      makeRequest('claudeUsage.setEnabled', { enabled: true }),
      {}
    )
    expect(enabled).toMatchObject({ ok: true, result: { enabled: true } })
    expect(claudeUsage.setEnabled).toHaveBeenCalledWith(true)

    await dispatcher.dispatch(
      makeRequest('claudeUsage.getSnapshot', { scope: 'orca', range: '30d', limit: 5 }),
      {}
    )
    expect(claudeUsage.getSnapshot).toHaveBeenCalledWith('orca', '30d', 5)

    await dispatcher.dispatch(
      makeRequest('claudeUsage.getBreakdown', { scope: 'all', range: '7d', kind: 'model' }),
      {}
    )
    expect(claudeUsage.getBreakdown).toHaveBeenCalledWith('all', '7d', 'model')

    // refresh takes an optional body; an omitted force must not become undefined-as-true.
    await dispatcher.dispatch(makeRequest('claudeUsage.refresh'), {})
    expect(claudeUsage.refresh).toHaveBeenCalledWith(false)
  })

  it('fails the call instead of the host when no store is registered', async () => {
    clearUsageProviderStores()

    const response = await makeDispatcher().dispatch(makeRequest('claudeUsage.getScanState'), {})

    expect(response.ok).toBe(false)
    if (response.ok) {
      throw new Error('expected an error response')
    }
    expect(response.error.message).toContain('claudeUsage')
  })
})
