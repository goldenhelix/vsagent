import type { TerminalPreviewApi } from '../../../../preload/api/dashboard-api'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload,
  TerminalPreviewReplayChunk
} from '../../../../shared/terminal-preview'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { RemoteRuntimeMultiplexedTerminal } from '../../runtime/remote-runtime-terminal-multiplexer-types'

// Why (VSAgent fork): the agent dashboard's terminal preview is desktop IPC
// (terminalPreview:* on the main process), which a browser tab has no host for —
// the shim's fallback resolved undefined and the dialog threw before rendering
// anything. The paired host already multiplexes this pty for the terminal pane,
// so the preview rides the same stream as an extra, viewport-less subscriber:
// no grid claim, and a distinct client id so it never evicts the pane's stream.

const UNAVAILABLE: TerminalPreviewConnectResult = { snapshot: null, replay: [] }
/** The host answers a fresh subscription with its snapshot; give up rather than hang. */
const SNAPSHOT_TIMEOUT_MS = 10_000

type PreviewSubscription = {
  close: () => void
  stream: RemoteRuntimeMultiplexedTerminal | null
}

export function createWebTerminalPreviewApi(): TerminalPreviewApi {
  const subscriptions = new Map<string, PreviewSubscription>()
  const listeners = new Set<(payload: TerminalPreviewDataPayload) => void>()

  const emit = (payload: TerminalPreviewDataPayload): void => {
    for (const listener of Array.from(listeners)) {
      listener(payload)
    }
  }

  const dropSubscription = (ptyId: string): void => {
    const existing = subscriptions.get(ptyId)
    if (existing) {
      subscriptions.delete(ptyId)
      existing.close()
    }
  }

  const connect = async (ptyId: string): Promise<TerminalPreviewConnectResult> => {
    const parts = parseRemoteRuntimePtyId(ptyId)
    if (!parts?.environmentId || !parts.handle) {
      return UNAVAILABLE
    }
    dropSubscription(ptyId)

    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('../../runtime/remote-runtime-terminal-multiplexer')
    const subscription: PreviewSubscription = {
      stream: null,
      close: () => {
        subscription.stream?.close()
        subscription.stream = null
      }
    }
    subscriptions.set(ptyId, subscription)

    // Bytes seen before the host's snapshot land as replay, the way the desktop
    // preview receives them; afterwards they are live data for the open dialog.
    const preSnapshot: TerminalPreviewReplayChunk[] = []
    let settled = false
    const result = new Promise<TerminalPreviewConnectResult>((resolve) => {
      const settle = (value: TerminalPreviewConnectResult): void => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      const timer = setTimeout(() => settle({ ...UNAVAILABLE }), SNAPSHOT_TIMEOUT_MS)
      const finish = (value: TerminalPreviewConnectResult): void => {
        clearTimeout(timer)
        settle(value)
      }

      void getRemoteRuntimeTerminalMultiplexer(parts.environmentId as string)
        .subscribeTerminal({
          terminal: parts.handle,
          client: { id: `desktop:dashboard-preview:${ptyId}`, type: 'desktop' },
          callbacks: {
            onData: (data) => {
              if (!settled) {
                preSnapshot.push({ data, mode: 'live' })
                return
              }
              emit({ type: 'data', ptyId, data, bytes: data.length })
            },
            onSnapshot: (data, meta) => {
              if (settled) {
                // A recovery snapshot means the stream re-based; upstream refreshes on resync.
                emit({ type: 'resync', ptyId })
                return
              }
              finish({
                snapshot: {
                  data,
                  cols: meta?.cols ?? 80,
                  rows: meta?.rows ?? 24,
                  ...(meta?.seq === undefined ? {} : { seq: meta.seq }),
                  ...(meta?.pendingEscapeTailAnsi === undefined
                    ? {}
                    : { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi }),
                  ...(meta?.kittyKeyboardFlags === undefined
                    ? {}
                    : { kittyKeyboardFlags: meta.kittyKeyboardFlags })
                },
                replay: preSnapshot
              })
            },
            onEnd: () => finish({ ...UNAVAILABLE }),
            onError: () => finish({ ...UNAVAILABLE })
          }
        })
        .then((stream) => {
          if (subscriptions.get(ptyId) !== subscription) {
            stream.close()
            return
          }
          subscription.stream = stream
        })
        .catch(() => finish({ ...UNAVAILABLE }))
    })

    const connected = await result
    if (connected.snapshot === null) {
      dropSubscription(ptyId)
    }
    return connected
  }

  return {
    connect,
    input: (ptyId, data) =>
      Promise.resolve(subscriptions.get(ptyId)?.stream?.sendInput(data) === true),
    // Never claim the grid: the pane the agent is actually working in owns it, and
    // upstream's preview scales the pty's own size to the dialog when fit returns null.
    fit: () => Promise.resolve(null),
    // The multiplexer acknowledges output for its own flow control.
    ack: () => Promise.resolve(),
    unsubscribe: (ptyId) => {
      dropSubscription(ptyId)
      return Promise.resolve()
    },
    onData: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}
