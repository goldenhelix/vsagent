import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi } from './web-preload-api-test-harness'

// Why (VSAgent fork): in a browser tab these ui.on* listeners have no main process
// feeding them — the renderer's own shortcut replay does (vsagent-web-window-shortcuts),
// so the shim must deliver instead of stubbing them as no-ops.
describe('web ui window-shortcut listeners', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('delivers replayed window-shortcut actions and honors unsubscribe', async () => {
    const { api } = await installApi('Linux')
    const { emitWebWindowShortcut } = await import('@/lib/vsagent-web-window-shortcuts')
    const palette = vi.fn()
    const quickOpen = vi.fn()

    const unsubscribePalette = api.ui.onToggleWorktreePalette(palette)
    api.ui.onOpenQuickOpen(quickOpen)
    emitWebWindowShortcut('ui:toggleWorktreePalette')
    emitWebWindowShortcut('ui:openQuickOpen')

    expect(palette).toHaveBeenCalledTimes(1)
    expect(quickOpen).toHaveBeenCalledTimes(1)

    unsubscribePalette()
    emitWebWindowShortcut('ui:toggleWorktreePalette')
    expect(palette).toHaveBeenCalledTimes(1)
  })
})
