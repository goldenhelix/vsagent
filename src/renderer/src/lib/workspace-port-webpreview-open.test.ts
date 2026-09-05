import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../shared/workspace-ports'

const { activateAndRevealWorktreeMock } = vi.hoisted(() => ({
  activateAndRevealWorktreeMock: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

import { openWorkspacePortInBrowser } from './workspace-port-actions'
import {
  canRoutePortThroughWebPreview,
  openPortThroughWebPreviewWindow
} from './workspace-port-webpreview-open'

function workspacePort(advertisedUrl?: string): WorkspacePort {
  return {
    id: '127.0.0.1:5173:1234',
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: 5173,
    pid: 1234,
    processName: 'node',
    protocol: 'http',
    kind: 'workspace',
    ...(advertisedUrl ? { advertisedUrl } : {}),
    owner: {
      worktreeId: 'repo::/workspace/app',
      repoId: 'repo',
      displayName: 'app',
      path: '/workspace/app',
      confidence: 'cwd'
    }
  }
}

const create = vi.fn()
const openUrl = vi.fn()
const windowOpen = vi.fn()
const runtimeEnvironmentCall = vi.fn()

function stubWindow(options: { webPreview?: boolean; webClient?: boolean } = {}): void {
  const webPreview = { create, setOrigin: vi.fn(), delete: vi.fn() }
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    open: windowOpen,
    __ORCA_WEB_CLIENT__: options.webClient ?? true,
    api: {
      shell: { openUrl },
      runtimeEnvironments: { call: runtimeEnvironmentCall },
      ...(options.webPreview === false ? {} : { webPreview })
    }
  })
}

beforeEach(() => {
  create.mockReset()
  openUrl.mockReset()
  windowOpen.mockReset()
  runtimeEnvironmentCall.mockReset()
  activateAndRevealWorktreeMock.mockReset()
  create.mockResolvedValue({
    id: 'aaaa1111',
    targetOrigin: 'http://127.0.0.1:5173',
    proxyPath: 'http://serve-host:6768/__orca/webpreview/aaaa1111'
  })
  stubWindow()
})

describe('canRoutePortThroughWebPreview', () => {
  it('routes only when the web preload exposes webPreview on a web client page', () => {
    expect(canRoutePortThroughWebPreview()).toBe(true)
  })

  it('stays off on a desktop build that is served the same bundle', () => {
    stubWindow({ webPreview: false })
    expect(canRoutePortThroughWebPreview()).toBe(false)
  })

  it('stays off in the Electron renderer even if a webPreview api is present', () => {
    stubWindow({ webClient: false })
    expect(canRoutePortThroughWebPreview()).toBe(false)
  })
})

describe('openPortThroughWebPreviewWindow', () => {
  it('opens the session origin plus the port URL path, search and hash', async () => {
    await expect(
      openPortThroughWebPreviewWindow('http://127.0.0.1:5173/app?tab=logs#tail')
    ).resolves.toEqual({ ok: true })

    expect(create).toHaveBeenCalledWith({ targetOrigin: 'http://127.0.0.1:5173' })
    expect(windowOpen).toHaveBeenCalledWith(
      'http://serve-host:6768/__orca/webpreview/aaaa1111/app?tab=logs#tail',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('reports the failure reason when the session cannot be minted', async () => {
    create.mockRejectedValueOnce(new Error('session limit reached'))

    await expect(openPortThroughWebPreviewWindow('http://127.0.0.1:5173')).resolves.toEqual({
      ok: false,
      reason: 'session limit reached'
    })
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('reports an unusable port URL instead of opening a blank tab', async () => {
    await expect(openPortThroughWebPreviewWindow('not a url')).resolves.toMatchObject({ ok: false })
    expect(create).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
  })
})

describe('openWorkspacePortInBrowser in the web client', () => {
  it('routes a system-browser open through a webpreview session', async () => {
    const createBrowserTab = vi.fn()

    await expect(
      openWorkspacePortInBrowser({
        port: workspacePort('http://127.0.0.1:5173/dashboard'),
        runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
        createBrowserTab: createBrowserTab as never,
        setRemoteBrowserPageHandle: vi.fn() as never,
        openInOrcaBrowser: false
      })
    ).resolves.toEqual({ ok: true })

    expect(windowOpen).toHaveBeenCalledWith(
      'http://serve-host:6768/__orca/webpreview/aaaa1111/dashboard',
      '_blank',
      'noopener,noreferrer'
    )
    expect(openUrl).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('opens an Orca browser tab locally instead of driving the host browser', async () => {
    const createBrowserTab = vi.fn(() => ({ activePageId: 'local-page-1' }))
    const setRemoteBrowserPageHandle = vi.fn()

    await expect(
      openWorkspacePortInBrowser({
        port: workspacePort(),
        runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
        createBrowserTab: createBrowserTab as never,
        setRemoteBrowserPageHandle: setRemoteBrowserPageHandle as never
      })
    ).resolves.toEqual({ ok: true })

    expect(activateAndRevealWorktreeMock).toHaveBeenCalledWith('repo::/workspace/app', {
      providesInitialSurface: true
    })
    // No browserRuntimeEnvironmentId: the iframe pane navigates client-side, so a
    // host page would only fight it with screencast snapshots.
    expect(createBrowserTab).toHaveBeenCalledWith('repo::/workspace/app', 'http://127.0.0.1:5173', {
      activate: true
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(setRemoteBrowserPageHandle).not.toHaveBeenCalled()
  })

  it('leaves the desktop system-browser path alone outside the web client', async () => {
    stubWindow({ webClient: false })
    openUrl.mockResolvedValueOnce(undefined)

    await expect(
      openWorkspacePortInBrowser({
        port: workspacePort(),
        runtimeTarget: { kind: 'local' },
        createBrowserTab: vi.fn() as never,
        setRemoteBrowserPageHandle: vi.fn() as never,
        openInOrcaBrowser: false
      })
    ).resolves.toEqual({ ok: true })

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:5173')
    expect(create).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
  })
})
