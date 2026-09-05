import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web preload API host-owned settings', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mirrors the host workspace root and nesting default without ever writing them back', async () => {
    // Why the host wins: a browser client has no local filesystem, so `~/orca/workspaces` is a
    // fiction — every workspace this client creates is created on the host.
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { settings: { workspaceDir: '/srv/seeded/workspaces', nestWorkspaces: false } },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    await globals.window.api.settings.set({ workspaceDir: '/home/browser/elsewhere' })
    const refreshed = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      workspaceDir?: string
      nestWorkspaces?: boolean
    }

    expect(settings.workspaceDir).toBe('/srv/seeded/workspaces')
    expect(settings.nestWorkspaces).toBe(false)
    expect(stored.workspaceDir).toBe('/srv/seeded/workspaces')
    expect(refreshed.workspaceDir).toBe('/srv/seeded/workspaces')
    expect(runtimeCalls).not.toContainEqual(expect.objectContaining({ method: 'settings.update' }))
  })

  it('keeps the local workspace defaults when a paired host reports none', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'call-1',
            ok: true,
            result: { settings: {} },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ workspaceDir: '/home/browser/kept' })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()

    expect(settings.workspaceDir).toBe('/home/browser/kept')
    expect(settings.nestWorkspaces).toBe(true)
  })

  it('reaches the dedicated quick-command RPC on the paired host', async () => {
    // Why this lives here: seeded quick commands used to ride `settings.get`. Upstream moved them
    // to their own method (bodies reach ~240 KB), and the browser client reaches it through the
    // generic environment passthrough — so the settings blob must not carry them a second time.
    const runtimeCalls: { method: string; params: unknown }[] = []
    const terminalQuickCommands = [
      {
        id: 'seeded',
        label: 'Seeded',
        action: 'terminal-command' as const,
        command: 'pnpm dev',
        appendEnter: true,
        scope: { type: 'global' as const }
      }
    ]
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            // Method-aware on purpose: a blanket quick-command payload would make `settings.get`
            // throw inside the mirror and pass the assertions below from the catch branch.
            result:
              method === 'settings.get'
                ? { settings: { workspaceDir: '/srv/seeded/workspaces', nestWorkspaces: false } }
                : { terminalQuickCommands },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const response = await globals.window.api.runtimeEnvironments.call({
      selector: 'web-env-1',
      method: 'settings.getTerminalQuickCommands'
    })
    const settings = await globals.window.api.settings.get()

    expect(runtimeCalls).toContainEqual({
      method: 'settings.getTerminalQuickCommands',
      params: undefined
    })
    expect(response).toMatchObject({ ok: true, result: { terminalQuickCommands } })
    // The host projection resolved (so the blob really was inspected) and carried no commands.
    expect(settings.workspaceDir).toBe('/srv/seeded/workspaces')
    expect(settings.terminalQuickCommands).toEqual([])
  })
})
