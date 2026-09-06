import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

import {
  createWebClaudeUsageApi,
  createWebCodexUsageApi,
  createWebOpenCodeUsageApi
} from './web-usage-providers-api'

describe('web usage provider APIs', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })

  it('routes each provider to its own host methods', async () => {
    callRuntimeResult.mockResolvedValue({ enabled: true })

    await createWebClaudeUsageApi().setEnabled({ enabled: true })
    await createWebCodexUsageApi().getScanState()
    await createWebOpenCodeUsageApi().getBreakdown({ scope: 'orca', range: '30d', kind: 'model' })

    expect(callRuntimeResult.mock.calls.map((call) => call[0])).toEqual([
      'claudeUsage.setEnabled',
      'codexUsage.getScanState',
      'openCodeUsage.getBreakdown'
    ])
    expect(callRuntimeResult.mock.calls[0][1]).toEqual({ enabled: true })
    expect(callRuntimeResult.mock.calls[2][1]).toEqual({
      scope: 'orca',
      range: '30d',
      kind: 'model'
    })
  })

  it('gives a scan enough time to finish on the host', async () => {
    callRuntimeResult.mockResolvedValue({ enabled: true })

    await createWebClaudeUsageApi().setEnabled({ enabled: true })

    // A first transcript scan is far slower than a default RPC round trip.
    expect(callRuntimeResult.mock.calls[0][2]).toBeGreaterThanOrEqual(60_000)
  })

  // Why: upstream's store slice reads undefined as "usage is not supported here"
  // and no-ops silently, which is the right degradation for an older host.
  it('resolves undefined when the host rejects the call', async () => {
    callRuntimeResult.mockRejectedValue(new Error('unknown method claudeUsage.getScanState'))

    await expect(createWebClaudeUsageApi().getScanState()).resolves.toBeUndefined()
  })
})
