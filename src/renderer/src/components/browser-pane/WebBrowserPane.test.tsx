// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { WebPreviewBrowserPageModel } from './use-webpreview-browser-page'

// The iframe attributes are load-bearing security/routing terms, not styling: allow-same-origin is
// what lets the injected nav script postMessage back, the missing allow-top-navigation is what stops
// a hostile page navigating Orca itself, and no-referrer is what keeps handleLeakedPreviewRequest
// from hijacking Orca's own /assets/** requests back into the proxy.
type MockAppState = { browserPagesByWorkspace: Record<string, BrowserPage[]> }

const mocks = vi.hoisted(() => ({
  state: null as MockAppState | null,
  model: null as WebPreviewBrowserPageModel | null,
  hookedPageIds: [] as string[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

vi.mock('./use-webpreview-browser-page', () => ({
  useWebPreviewBrowserPage: (page: BrowserPage) => {
    mocks.hookedPageIds.push(page.id)
    return mocks.model
  }
}))

vi.mock('./assemble-chrome/BrowserAddressBar', () => ({
  default: ({ value }: { value: string }) => <input readOnly value={value} />
}))

import WebBrowserPane from './WebBrowserPane'

const WORKSPACE_ID = 'ws-1'
const SESSION_URL = 'https://gateway.example:6768/__orca/webpreview/aaaa1111/app'

function createPage(id: string): BrowserPage {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'wt-1',
    url: 'http://localhost:5173/app',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as unknown as BrowserPage
}

function createWorkspace(activePageId: string | null): BrowserWorkspace {
  return {
    id: WORKSPACE_ID,
    worktreeId: 'wt-1',
    activePageId,
    pageIds: ['page-a', 'page-b']
  } as unknown as BrowserWorkspace
}

function renderPaneContainer(activePageId: string | null): HTMLElement {
  // Why a detached container: happy-dom starts a real page load the moment an iframe connects to
  // the document, and this suite only inspects attributes.
  const { container } = render(<WebBrowserPane browserTab={createWorkspace(activePageId)} />, {
    container: document.createElement('div')
  })
  return container
}

function renderPane(activePageId: string | null): HTMLIFrameElement | null {
  return renderPaneContainer(activePageId).querySelector('iframe')
}

beforeEach(() => {
  mocks.hookedPageIds = []
  mocks.state = {
    browserPagesByWorkspace: { [WORKSPACE_ID]: [createPage('page-a'), createPage('page-b')] }
  }
  mocks.model = {
    urlInput: 'http://localhost:5173/app',
    setUrlInput: vi.fn(),
    displayedUrl: 'http://localhost:5173/app',
    status: 'idle',
    error: null,
    canGoBack: false,
    canGoForward: false,
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    onLoad: vi.fn(),
    iframeRef: { current: null },
    addressInputRef: { current: null },
    iframeSrc: SESSION_URL
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WebBrowserPane', () => {
  it('points the frame at the absolute proxy session URL', () => {
    expect(renderPane('page-a')?.getAttribute('src')).toBe(SESSION_URL)
  })

  it('sandboxes the frame without allow-top-navigation and sends no referrer', () => {
    const iframe = renderPane('page-a')
    const sandbox = iframe?.getAttribute('sandbox') ?? ''
    expect(sandbox.split(' ')).toContain('allow-same-origin')
    expect(sandbox.split(' ')).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('drives the workspace active page, falling back to the first one', () => {
    renderPane('page-b')
    expect(mocks.hookedPageIds).toEqual(['page-b'])
    cleanup()
    mocks.hookedPageIds = []
    renderPane(null)
    expect(mocks.hookedPageIds).toEqual(['page-a'])
  })

  it('drives history and reload through the shared browser control row', () => {
    const container = renderPaneContainer('page-a')
    // Why by label: these are BrowserNavigationControlRow's own buttons, so this also catches a
    // regression back to a hand-rolled copy of that row.
    const button = (label: string): HTMLButtonElement | null =>
      container.querySelector(`button[aria-label="${label}"]`)
    expect(button('Back')?.disabled).toBe(true)
    expect(button('Forward')?.disabled).toBe(true)

    button('Reload')?.click()
    expect(mocks.model?.reload).toHaveBeenCalledTimes(1)
  })

  it('renders an empty pane when the workspace has no pages', () => {
    mocks.state = { browserPagesByWorkspace: {} }
    expect(renderPane('page-a')).toBeNull()
    expect(mocks.hookedPageIds).toEqual([])
  })
})
