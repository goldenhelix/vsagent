import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { createRuntimeFileOpenRelay, type RuntimeFileOpenNotifier } from './runtime-file-open-relay'

function harness(options: {
  notifier?: RuntimeFileOpenNotifier | null
  hasClientEventListeners?: boolean
}) {
  const emitted: RuntimeClientEvent[] = []
  const relay = createRuntimeFileOpenRelay({
    getNotifier: () => options.notifier ?? null,
    hasClientEventListeners: () => options.hasClientEventListeners ?? false,
    emitClientEvent: (event) => {
      emitted.push(event)
    }
  })
  return { relay, emitted }
}

describe('createRuntimeFileOpenRelay', () => {
  it('prefers the desktop notifier when this process has a window', () => {
    const openFile = vi.fn()
    const openDiff = vi.fn()
    const { relay, emitted } = harness({
      notifier: { openFile, openDiff },
      hasClientEventListeners: true
    })

    relay.openFile('worktree-1', '/repo/src/a.ts', 'src/a.ts', 'env-1')
    relay.openDiff('worktree-1', '/repo/src/a.ts', 'src/a.ts', true, 'env-1')

    expect(openFile).toHaveBeenCalledWith('worktree-1', '/repo/src/a.ts', 'src/a.ts', 'env-1')
    expect(openDiff).toHaveBeenCalledWith('worktree-1', '/repo/src/a.ts', 'src/a.ts', true, 'env-1')
    expect(emitted).toEqual([])
  })

  it('relays to paired clients when a headless serve has no notifier', () => {
    const { relay, emitted } = harness({ notifier: null, hasClientEventListeners: true })

    relay.openFile('worktree-1', '/repo/README.md', 'README.md', 'env-1')
    relay.openDiff('worktree-1', '/repo/README.md', 'README.md', false)

    expect(emitted).toEqual([
      {
        type: 'openFile',
        worktreeId: 'worktree-1',
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        runtimeEnvironmentId: 'env-1'
      },
      {
        type: 'openDiff',
        worktreeId: 'worktree-1',
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        staged: false
      }
    ])
  })

  it('relays when the notifier exists but cannot open files itself', () => {
    const { relay, emitted } = harness({ notifier: {}, hasClientEventListeners: true })

    relay.openFile('worktree-1', '/repo/README.md', 'README.md')

    expect(emitted).toHaveLength(1)
  })

  it('omits a null runtimeEnvironmentId so the client falls back to the emitting host', () => {
    const { relay, emitted } = harness({ hasClientEventListeners: true })

    relay.openFile('worktree-1', '/repo/README.md', 'README.md', null)

    expect(emitted[0]).not.toHaveProperty('runtimeEnvironmentId')
  })

  it('still fails the CLI when neither a window nor a paired client is listening', () => {
    const { relay, emitted } = harness({ hasClientEventListeners: false })

    expect(() => relay.openFile('worktree-1', '/repo/README.md', 'README.md')).toThrow(
      'renderer_unavailable'
    )
    expect(() => relay.openDiff('worktree-1', '/repo/README.md', 'README.md', false)).toThrow(
      'renderer_unavailable'
    )
    expect(emitted).toEqual([])
  })
})
