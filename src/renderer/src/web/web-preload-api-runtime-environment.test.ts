import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION } from '../../../shared/protocol-version'
import {
  RUNTIME_ENVIRONMENT_REGISTRY_KEY,
  encodePairingCode,
  installBrowserGlobals,
  readStoredRuntimeEnvironment,
  readStoredRuntimeEnvironments,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web runtime environment identity', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('does not resolve an old server selector through a differently keyed server', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const serverB = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })

    // Why (VSAgent D1): pairing is additive, so the old selector still names its
    // own server — it must never be answered by the differently keyed new one.
    await expect(
      globals.window.api.runtimeEnvironments.resolve({ selector: 'web-server-a' })
    ).resolves.toMatchObject({ id: 'web-server-a', name: 'Test runtime' })
    expect(serverB.environment.id).not.toBe('web-server-a')
    await expect(
      globals.window.api.runtimeEnvironments.resolve({ selector: 'web-server-missing' })
    ).rejects.toThrow('Unknown Orca runtime environment: web-server-missing')
  })

  it('pairs additional servers without evicting the ones already paired', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const serverB = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })

    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a', name: 'Test runtime' },
      { id: serverB.environment.id, name: 'Server B' }
    ])
    // The first paired server stays the active one until Active Server moves.
    expect(globals.window.api.settings.getSync()?.activeRuntimeEnvironmentId).toBeNull()
    await globals.window.api.settings.setActiveRuntimeEnvironmentPreference({
      environmentId: serverB.environment.id
    })
    await expect(
      globals.window.api.runtimeEnvironments.resolve({ selector: 'active' })
    ).resolves.toMatchObject({ id: serverB.environment.id })
  })

  it('removes one paired server without disturbing the others', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const serverB = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })
    const sessionKey = `orca.web.workspaceSession.v1.runtime:${encodeURIComponent(serverB.environment.id)}`
    globals.storage.setItem(sessionKey, JSON.stringify({ activeWorktreeId: 'w-1' }))

    await expect(
      globals.window.api.runtimeEnvironments.remove({ selector: serverB.environment.id })
    ).resolves.toMatchObject({ removed: { id: serverB.environment.id } })

    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
    expect(globals.storage.getItem(sessionKey)).toBeNull()
  })

  it('gives every paired server its own live client', async () => {
    const constructed: string[] = []
    const closed: string[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        constructor(offer: { publicKeyB64: string }) {
          constructed.push(offer.publicKeyB64)
          this.key = offer.publicKeyB64
        }

        key: string

        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {},
            _meta: { runtimeId: `runtime-${this.key}` }
          })
        }

        close(): void {
          closed.push(this.key)
        }
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const serverB = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })

    await globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'repos.list'
    })
    await globals.window.api.runtimeEnvironments.call({
      selector: serverB.environment.id,
      method: 'repos.list'
    })
    await globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'repos.list'
    })

    expect(constructed).toEqual(['public-key', 'server-b-key'])
    expect(closed).toEqual([])
    expect(readStoredRuntimeEnvironment(globals.storage, 'web-server-a')).toMatchObject({
      runtimeId: 'runtime-public-key'
    })
    expect(
      readStoredRuntimeEnvironment(globals.storage, serverB.environment.id)
    ).toMatchObject({ runtimeId: 'runtime-server-b-key' })
  })

  it('migrates the legacy single slot into the registry once', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
    expect(globals.storage.getItem('orca.web.runtimeEnvironment.v1')).toBeNull()
    expect(readStoredRuntimeEnvironments(globals.storage)).toMatchObject([{ id: 'web-server-a' }])

    await globals.window.api.runtimeEnvironments.remove({ selector: 'web-server-a' })
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toEqual([])
  })

  it('keeps pairing state separate from generic Active Server settings writes', async () => {
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Windows 2',
      pairingCode: encodePairingCode({ publicKeyB64: 'windows-2-key' })
    })

    const settings = await globals.window.api.settings.set({ activeRuntimeEnvironmentId: null })

    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: paired.environment.id, name: 'Windows 2' }
    ])
    expect(settings.activeRuntimeEnvironmentId).toBeNull()
    expect(globals.window.api.settings.getSync()?.activeRuntimeEnvironmentId).toBeNull()
    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).not.toHaveProperty(
      'activeRuntimeEnvironmentId'
    )
    await expect(
      globals.window.api.runtimeEnvironments.remove({ selector: paired.environment.id })
    ).resolves.toMatchObject({ removed: { id: paired.environment.id } })
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toEqual([])
  })

  it('stores paired device identity from a web access link', async () => {
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Shared server',
      pairingCode: encodePairingCode({ pairedDeviceId: 'paired-device-a' })
    })

    expect(paired.environment.pairedDeviceId).toBe('paired-device-a')
    expect(readStoredRuntimeEnvironment(globals.storage)).toMatchObject({
      pairedDeviceId: 'paired-device-a'
    })
  })

  it('persists an explicit Active Server choice across unrelated web settings writes', async () => {
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Windows 2',
      pairingCode: encodePairingCode({ publicKeyB64: 'windows-2-key' })
    })

    await globals.window.api.settings.setActiveRuntimeEnvironmentPreference({
      environmentId: 'Windows 2'
    })
    await globals.window.api.settings.set({ terminalFontSize: 15 })
    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      activeRuntimeEnvironmentId: paired.environment.id,
      terminalFontSize: 15
    })

    await globals.window.api.settings.setActiveRuntimeEnvironmentPreference({
      environmentId: null
    })
    await globals.window.api.settings.set({ terminalFontSize: 16 })
    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      activeRuntimeEnvironmentId: null,
      terminalFontSize: 16
    })
  })

  it('rejects an unknown explicit Active Server choice without corrupting the preference', async () => {
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Windows 2',
      pairingCode: encodePairingCode({ publicKeyB64: 'windows-2-key' })
    })
    await globals.window.api.settings.setActiveRuntimeEnvironmentPreference({
      environmentId: paired.environment.id
    })

    await expect(
      globals.window.api.settings.setActiveRuntimeEnvironmentPreference({
        environmentId: 'unknown-server'
      })
    ).rejects.toThrow('Unknown Orca runtime environment: unknown-server')
    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      activeRuntimeEnvironmentId: paired.environment.id
    })
  })

  it('keeps old selectors only when re-pairing proves the same server key', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A again',
      pairingCode: encodePairingCode({ publicKeyB64: 'public-key' })
    })

    await expect(
      globals.window.api.runtimeEnvironments.resolve({ selector: 'web-server-a' })
    ).resolves.toMatchObject({ id: paired.environment.id, name: 'Server A again' })
  })

  it('ignores malformed persisted compatibility ids when resolving selectors', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const stored = JSON.parse(
      globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}'
    ) as Record<string, unknown>
    stored.compatibleEnvironmentIds = { old: 'web-server-old' }
    globals.storage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(stored))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.runtimeEnvironments.resolve({ selector: 'web-server-old' })
    ).rejects.toThrow('Unknown Orca runtime environment: web-server-old')
  })

  it('ignores malformed persisted paired device identity', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const stored = JSON.parse(
      globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}'
    ) as Record<string, unknown>
    stored.pairedDeviceId = { invalid: true }
    globals.storage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(stored))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const [environment] = await globals.window.api.runtimeEnvironments.list()
    expect(environment).not.toHaveProperty('pairedDeviceId')
  })

  it('keeps pairing while manual disconnect fences passive reconnects', async () => {
    const calls: string[] = []
    const close = vi.fn()
    let clientCount = 0
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        constructor() {
          clientCount += 1
        }

        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          calls.push(method)
          return Promise.resolve({
            id: method,
            ok: true,
            result: { runtimeId: 'runtime-1', pairedDeviceId: 'paired-device-a' },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {
          close()
        }
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.runtimeEnvironments.getStatus({ selector: 'web-server-a' })
    ).resolves.toMatchObject({ ok: true })
    await globals.window.api.runtimeEnvironments.disconnect({ selector: 'web-server-a' })

    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
    await expect(
      globals.window.api.runtimeEnvironments.getStatus({ selector: 'web-server-a' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_manually_disconnected' }
    })
    await expect(
      globals.window.api.runtimeEnvironments.call({
        selector: 'web-server-a',
        method: 'repos.list'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_manually_disconnected' }
    })
    await expect(
      globals.window.api.runtimeEnvironments.subscribe(
        { selector: 'web-server-a', method: 'terminal.subscribe' },
        { onResponse: vi.fn() }
      )
    ).rejects.toThrow('runtime_manually_disconnected')
    expect(clientCount).toBe(1)
    expect(calls).toEqual(['status.get'])
    expect(close).toHaveBeenCalledOnce()

    await expect(
      globals.window.api.runtimeEnvironments.connect({ selector: 'web-server-a' })
    ).resolves.toMatchObject({ ok: true })
    expect(clientCount).toBe(2)
    expect(calls).toEqual(['status.get', 'status.get'])
    expect(readStoredRuntimeEnvironment(globals.storage, 'web-server-a')).toMatchObject({
      pairedDeviceId: 'paired-device-a'
    })
  })

  it('fences a web runtime response that completes after manual disconnect', async () => {
    let resolveCall!: (response: RuntimeRpcResponse<unknown>) => void
    const pendingCall = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      resolveCall = resolve
    })
    const call = vi.fn(() => pendingCall)
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const status = globals.window.api.runtimeEnvironments.getStatus({
      selector: 'web-server-a'
    })
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    await globals.window.api.runtimeEnvironments.disconnect({ selector: 'web-server-a' })
    resolveCall({
      id: 'status.get',
      ok: true,
      result: { runtimeId: 'runtime-1' },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(status).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_manually_disconnected' }
    })
  })

  it.each(['active runtime', 'selected environment'] as const)(
    'returns a disconnect envelope when a queued %s call disconnects',
    async (route) => {
      const pending: ((response: RuntimeRpcResponse<unknown>) => void)[] = []
      const call = vi.fn(
        (method: string) =>
          new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
            pending.push((response) => resolve({ ...response, id: method }))
          })
      )
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call = call
          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const invoke = (): Promise<RuntimeRpcResponse<unknown>> =>
        route === 'active runtime'
          ? globals.window.api.runtime.call({ method: 'repos.list' })
          : globals.window.api.runtimeEnvironments.call({
              selector: 'web-server-a',
              method: 'repos.list'
            })

      const activeCalls = Array.from({ length: 8 }, invoke)
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(8))
      const queuedCall = invoke()
      expect(call).toHaveBeenCalledTimes(8)

      await globals.window.api.runtimeEnvironments.disconnect({ selector: 'web-server-a' })
      pending[0]?.({
        id: 'repos.list',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-1' }
      })

      await expect(queuedCall).resolves.toMatchObject({
        ok: false,
        error: { code: 'runtime_manually_disconnected' }
      })
      expect(call).toHaveBeenCalledTimes(8)

      for (const resolve of pending.slice(1)) {
        resolve({
          id: 'repos.list',
          ok: true,
          result: {},
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      await expect(Promise.all(activeCalls)).resolves.toEqual(
        Array.from({ length: 8 }, () =>
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: 'runtime_manually_disconnected' })
          })
        )
      )
    }
  )
  it('keeps the current host when verification rejects an incompatible replacement', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'status',
            ok: true,
            result: { runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1 },
            _meta: { runtimeId: 'runtime-old' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const previousStored = globals.storage.getItem(RUNTIME_ENVIRONMENT_REGISTRY_KEY)

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Incompatible server',
        pairingCode: encodePairingCode()
      })
    ).resolves.toMatchObject({ ok: false, kind: 'protocol-incompatible' })
    expect(globals.storage.getItem(RUNTIME_ENVIRONMENT_REGISTRY_KEY)).toBe(previousStored)
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
  })

  it('keeps the current host when browser storage rejects a verified replacement', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-new',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
            },
            _meta: { runtimeId: 'runtime-new' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    vi.spyOn(globals.storage, 'setItem').mockImplementation(() => {
      throw new Error('Browser storage is full.')
    })

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Verified replacement',
        pairingCode: encodePairingCode()
      })
    ).resolves.toMatchObject({
      ok: false,
      kind: 'environment-save-failed',
      // Why: installBrowserGlobals is a real web client, so translate() applies the VSAgent brand seam.
      message:
        'VSAgent verified the host but could not save it. Check browser storage and try again.'
    })
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
  })

  it('requires an explicit loopback override and persists the SSH dependency', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-new',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
      },
      _meta: { runtimeId: 'runtime-new' }
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const pairingCode = encodePairingCode({ endpoint: 'ws://127.0.0.1:6768' })

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Tunnel server',
        pairingCode
      })
    ).resolves.toMatchObject({ ok: false, kind: 'host-unreachable' })
    expect(call).not.toHaveBeenCalled()

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Tunnel server',
        pairingCode,
        allowLoopback: true
      })
    ).resolves.toMatchObject({
      ok: true,
      environment: { connectionDependency: 'ssh-tunnel' }
    })
    expect(call).toHaveBeenCalledOnce()
    expect(readStoredRuntimeEnvironment(globals.storage)).toMatchObject({
      connectionDependency: 'ssh-tunnel'
    })
  })

  it('returns a structured failure when the browser client cannot be constructed', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        constructor() {
          throw new Error('Invalid public key: expected 32 bytes, got 3')
        }
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Broken server',
        pairingCode: encodePairingCode()
      })
    ).resolves.toMatchObject({ ok: false, kind: 'access-link-invalid' })
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
  })

  it('classifies coded browser authorization failures without relying on copy', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.reject(
            Object.assign(new Error('Access grant rejected.'), { code: 'unauthorized' })
          )
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Expired server',
        pairingCode: encodePairingCode()
      })
    ).resolves.toMatchObject({
      ok: false,
      kind: 'access-link-invalid',
      message: 'Access grant rejected.'
    })
  })

  it('replaces API closures on reinstall while retaining the runtime client singleton', async () => {
    let clientCount = 0
    const call = vi.fn((method: string): Promise<RuntimeRpcResponse<unknown>> =>
      Promise.resolve({
        id: method,
        ok: true,
        result: { method },
        _meta: { runtimeId: 'runtime-a' }
      })
    )
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        constructor() {
          clientCount += 1
        }

        call = call

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const firstApi = globals.window.api
    const initialZoom = firstApi.ui.getZoomLevel()
    firstApi.ui.setZoomLevel(initialZoom + 1)
    await expect(firstApi.runtime.call({ method: 'status.first' })).resolves.toEqual({
      id: 'status.first',
      ok: true,
      result: { method: 'status.first' },
      _meta: { runtimeId: 'runtime-a' }
    })
    expect(readStoredRuntimeEnvironment(globals.storage, 'web-server-a')).toMatchObject({
      runtimeId: 'runtime-a'
    })

    installWebPreloadApi()
    const secondApi = globals.window.api
    await secondApi.runtime.call({ method: 'status.second' })
    await firstApi.runtime.call({ method: 'status.old-capture' })

    expect(secondApi).not.toBe(firstApi)
    expect(secondApi.ui.getZoomLevel()).toBe(initialZoom)
    expect(firstApi.ui.getZoomLevel()).toBe(initialZoom + 1)
    expect(clientCount).toBe(1)
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'status.first',
      'status.second',
      'status.old-capture'
    ])
  })
})
