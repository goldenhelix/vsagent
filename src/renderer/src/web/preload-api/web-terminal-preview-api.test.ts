import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '../../runtime/remote-runtime-terminal-multiplexer-types'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'

const { subscribeTerminal } = vi.hoisted(() => ({ subscribeTerminal: vi.fn() }))

vi.mock('../../runtime/remote-runtime-terminal-multiplexer', () => ({
  getRemoteRuntimeTerminalMultiplexer: () => ({ subscribeTerminal })
}))

import { createWebTerminalPreviewApi } from './web-terminal-preview-api'

const PTY_ID = 'remote:env-1@@handle-9'

type Subscription = {
  callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  close: ReturnType<typeof vi.fn>
  sendInput: ReturnType<typeof vi.fn>
}

const subscriptions: Subscription[] = []

function stubSubscribe(): void {
  subscribeTerminal.mockImplementation(
    async (args: { callbacks: RemoteRuntimeMultiplexedTerminalCallbacks }) => {
      const subscription: Subscription = {
        callbacks: args.callbacks,
        close: vi.fn(),
        sendInput: vi.fn(() => true)
      }
      subscriptions.push(subscription)
      return { close: subscription.close, sendInput: subscription.sendInput }
    }
  )
}

// Waits for the shim's subscribe() promise chain to settle before driving callbacks.
async function latestSubscription(): Promise<Subscription> {
  for (let attempt = 0; attempt < 20 && subscriptions.length === 0; attempt += 1) {
    await Promise.resolve()
  }
  return subscriptions.at(-1) as Subscription
}

describe('web terminalPreview API', () => {
  beforeEach(() => {
    subscriptions.length = 0
    subscribeTerminal.mockReset()
    stubSubscribe()
  })

  it('answers the host snapshot as the preview connection and streams live data', async () => {
    const api = createWebTerminalPreviewApi()
    const payloads: TerminalPreviewDataPayload[] = []
    api.onData((payload) => payloads.push(payload))

    const connecting = api.connect(PTY_ID, { scrollbackRows: 24 })
    const subscription = await latestSubscription()
    // Bytes ahead of the snapshot are replay, exactly as the desktop preview receives them.
    subscription.callbacks.onData('early')
    subscription.callbacks.onSnapshot('screen', { cols: 120, rows: 40, seq: 7 })

    await expect(connecting).resolves.toEqual({
      snapshot: { data: 'screen', cols: 120, rows: 40, seq: 7 },
      replay: [{ data: 'early', mode: 'live' }]
    })
    expect(subscribeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: 'handle-9',
        client: expect.objectContaining({ type: 'desktop' })
      })
    )
    // No viewport: claiming the grid would resize the pane the agent is working in.
    expect(subscribeTerminal.mock.calls[0][0].viewport).toBeUndefined()

    subscription.callbacks.onData('live')
    subscription.callbacks.onSnapshot('rebased')
    expect(payloads).toEqual([
      { type: 'data', ptyId: PTY_ID, data: 'live', bytes: 4 },
      { type: 'resync', ptyId: PTY_ID }
    ])

    expect(await api.input(PTY_ID, 'ls\r')).toBe(true)
    expect(subscription.sendInput).toHaveBeenCalledWith('ls\r')
    await api.unsubscribe(PTY_ID)
    expect(subscription.close).toHaveBeenCalledTimes(1)
    expect(await api.input(PTY_ID, 'ls\r')).toBe(false)
  })

  it('reports the host contract for unavailable previews instead of throwing', async () => {
    const api = createWebTerminalPreviewApi()

    // A local (non-paired) pty id has no runtime stream to ride.
    await expect(api.connect('pty-1')).resolves.toEqual({ snapshot: null, replay: [] })
    expect(subscribeTerminal).not.toHaveBeenCalled()

    const connecting = api.connect(PTY_ID)
    const subscription = await latestSubscription()
    subscription.callbacks.onEnd?.('exited')
    await expect(connecting).resolves.toEqual({ snapshot: null, replay: [] })
    expect(subscription.close).toHaveBeenCalledTimes(1)

    // fit never claims the grid, and ack is the multiplexer's own business.
    await expect(api.fit(PTY_ID, 80, 24)).resolves.toBeNull()
    await expect(api.ack(PTY_ID, 10)).resolves.toBeUndefined()
  })
})
