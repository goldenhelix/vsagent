// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { WEBPREVIEW_PROXY_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'

// The iframe pane is the ONLY browser surface a paired browser client can render: it has no
// <webview>, and the streamed pane needs a display on the serve host. The guard must therefore
// mount it whenever the host advertises the proxy, and must never steal the desktop's panes.
type MockAppState = {
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  remoteBrowserPageHandlesByPageId: Record<string, never>
  runtimeStatusByEnvironmentId: Map<string, { status: { capabilities: string[] } }>
  updateBrowserPageState: () => void
  setBrowserPageUrl: () => void
}

const mocks = vi.hoisted(() => ({
  state: null as MockAppState | null,
  environmentId: null as string | null,
  rendered: [] as string[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.environmentId
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))

vi.mock('../host-guest/webview-registry', () => ({
  destroyPersistentWebview: () => {}
}))

vi.mock('./ssh-routed-browser-page-gate', () => ({
  SshRoutedBrowserPageGate: ({
    children
  }: {
    children: (routedPartition: string | null) => React.ReactNode
  }) => <>{children(null)}</>
}))

vi.mock('./BrowserMobileDriverOverlay', () => ({
  BrowserMobileDriverOverlay: () => null
}))

vi.mock('./browser-page-pane', () => ({
  BrowserPagePane: () => {
    mocks.rendered.push('local-guest')
    return <span data-pane="local-guest" />
  }
}))

vi.mock('../stream-remote/remote-browser-page-pane', () => ({
  RemoteBrowserPagePane: () => {
    mocks.rendered.push('remote-screencast')
    return <span data-pane="remote-screencast" />
  }
}))

vi.mock('../ClientHostedBrowserPagePane', () => ({
  ClientHostedBrowserPagePane: () => {
    mocks.rendered.push('client-hosted')
    return <span data-pane="client-hosted" />
  }
}))

vi.mock('../WebBrowserPane', () => ({
  default: () => {
    mocks.rendered.push('webpreview-iframe')
    return <span data-pane="webpreview-iframe" />
  }
}))

import BrowserPane from './browser-workspace-pane'

const WORKSPACE_ID = 'ws-1'
const ENVIRONMENT_ID = 'env-1'

function createPage(): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: WORKSPACE_ID,
    worktreeId: 'wt-1',
    url: 'http://localhost:5173/',
    title: 'page-a',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as unknown as BrowserPage
}

function createWorkspace(): BrowserWorkspace {
  return {
    id: WORKSPACE_ID,
    worktreeId: 'wt-1',
    activePageId: 'page-a',
    pageIds: ['page-a']
  } as unknown as BrowserWorkspace
}

function setWebClient(webPreviewAvailable: boolean, isWebClient: boolean): void {
  Object.defineProperty(window, '__ORCA_WEB_CLIENT__', {
    value: isWebClient,
    configurable: true,
    writable: true
  })
  Object.defineProperty(window, 'api', {
    value: {
      ...(webPreviewAvailable
        ? { webPreview: { create: vi.fn(), setOrigin: vi.fn(), delete: vi.fn() } }
        : {}),
      runtime: { reclaimBrowserForDesktop: vi.fn() }
    },
    configurable: true,
    writable: true
  })
}

function renderWorkspacePane(): void {
  mocks.rendered = []
  render(<BrowserPane browserTab={createWorkspace()} isActive={true} />)
}

describe('browser workspace pane webpreview guard', () => {
  beforeEach(() => {
    mocks.environmentId = ENVIRONMENT_ID
    mocks.state = {
      browserPagesByWorkspace: { [WORKSPACE_ID]: [createPage()] },
      remoteBrowserPageHandlesByPageId: {},
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { capabilities: [WEBPREVIEW_PROXY_RUNTIME_CAPABILITY] } }]
      ]),
      updateBrowserPageState: () => {},
      setBrowserPageUrl: () => {}
    }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('mounts the iframe pane for a web client whose host advertises the proxy', () => {
    setWebClient(true, true)
    renderWorkspacePane()
    expect(mocks.rendered).toEqual(['webpreview-iframe'])
  })

  it('falls through to the streamed pane when the host does not advertise the proxy', () => {
    mocks.state!.runtimeStatusByEnvironmentId = new Map([
      [ENVIRONMENT_ID, { status: { capabilities: ['browser.screencast.v1'] } }]
    ])
    setWebClient(true, true)
    renderWorkspacePane()
    expect(mocks.rendered).toEqual(['remote-screencast'])
  })

  it('leaves the desktop alone even when the host advertises the proxy', () => {
    setWebClient(false, false)
    renderWorkspacePane()
    expect(mocks.rendered).toEqual(['remote-screencast'])
  })

  it('does not claim a workspace with no runtime owner', () => {
    mocks.environmentId = null
    setWebClient(true, true)
    renderWorkspacePane()
    expect(mocks.rendered).toEqual(['local-guest'])
  })
})
