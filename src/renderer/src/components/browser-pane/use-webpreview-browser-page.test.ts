// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import type { WebPreviewSessionInfo } from '../../../../preload/api/web-preview-api'

// The proxy session is the pane's whole reachability story: the iframe src has to be the ABSOLUTE
// session URL the host minted (a paired client may hold sessions on several hosts), pings from a
// sibling pane's frame must not move this pane, and the session must outlive re-navigation but not
// unmount.
type MockAppState = {
  setBrowserPageUrl: (pageId: string, url: string) => void
  updateBrowserPageState: (pageId: string, updates: Record<string, unknown>) => void
  addBrowserHistoryEntry: (url: string, title: string) => void
  consumeAddressBarFocusRequest: (pageId: string) => boolean
}

const mocks = vi.hoisted(() => ({
  state: null as MockAppState | null
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockAppState) => unknown) => {
    if (!mocks.state) {
      throw new Error('mock app state not initialized')
    }
    return selector(mocks.state)
  }
}))

import { useWebPreviewBrowserPage } from './use-webpreview-browser-page'

const PROXY_ORIGIN = 'https://gateway.example:6768'

type WebPreviewApiStub = {
  create: ReturnType<typeof vi.fn>
  setOrigin: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

let webPreview: WebPreviewApiStub
let setBrowserPageUrl: Mock<(pageId: string, url: string) => void>

function session(id: string, targetOrigin: string): WebPreviewSessionInfo {
  return { id, targetOrigin, proxyPath: `${PROXY_ORIGIN}/__orca/webpreview/${id}` }
}

function createPage(url: string): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    url,
    title: 'page-a',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  } as unknown as BrowserPage
}

/** A stand-in for the mounted frame so `e.source` filtering can be driven directly. */
function attachFakeIframe(ref: React.RefObject<HTMLIFrameElement | null>): Window {
  const contentWindow = {} as Window
  ref.current = { contentWindow } as unknown as HTMLIFrameElement
  return contentWindow
}

function postNavPing(source: Window, data: unknown): void {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source })
  act(() => {
    window.dispatchEvent(event)
  })
}

beforeEach(() => {
  webPreview = {
    create: vi.fn(async ({ targetOrigin }: { targetOrigin: string }) =>
      session('aaaa1111', targetOrigin)
    ),
    setOrigin: vi.fn(async ({ id, targetOrigin }: { id: string; targetOrigin: string }) =>
      session(id, targetOrigin)
    ),
    delete: vi.fn(async () => {})
  }
  Object.defineProperty(window, 'api', {
    value: { webPreview },
    configurable: true,
    writable: true
  })
  setBrowserPageUrl = vi.fn<(pageId: string, url: string) => void>()
  mocks.state = {
    setBrowserPageUrl,
    updateBrowserPageState: vi.fn(),
    addBrowserHistoryEntry: vi.fn(),
    consumeAddressBarFocusRequest: vi.fn(() => false)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useWebPreviewBrowserPage', () => {
  it('mints a session on mount and points the iframe at the absolute session URL', async () => {
    const { result } = renderHook(() =>
      useWebPreviewBrowserPage(createPage('http://localhost:5173/app?x=1'))
    )

    await waitFor(() => {
      expect(result.current.iframeSrc).toBe(`${PROXY_ORIGIN}/__orca/webpreview/aaaa1111/app?x=1`)
    })
    expect(webPreview.create).toHaveBeenCalledWith({ targetOrigin: 'http://localhost:5173' })
    expect(result.current.displayedUrl).toBe('http://localhost:5173/app?x=1')
  })

  it('stays on a blank page until the user navigates', async () => {
    const { result } = renderHook(() => useWebPreviewBrowserPage(createPage('about:blank')))

    expect(result.current.iframeSrc).toBe('about:blank')
    expect(webPreview.create).not.toHaveBeenCalled()

    act(() => {
      result.current.navigate('localhost:8080')
    })
    await waitFor(() => {
      expect(result.current.iframeSrc).toBe(`${PROXY_ORIGIN}/__orca/webpreview/aaaa1111/`)
    })
    expect(webPreview.create).toHaveBeenCalledWith({ targetOrigin: 'http://localhost:8080' })
  })

  it('retargets the existing session instead of minting a second one', async () => {
    const { result } = renderHook(() =>
      useWebPreviewBrowserPage(createPage('http://localhost:5173/'))
    )
    await waitFor(() => expect(result.current.iframeSrc).toContain('aaaa1111'))

    act(() => {
      result.current.navigate('http://localhost:3000/other')
    })
    await waitFor(() => {
      expect(webPreview.setOrigin).toHaveBeenCalledWith({
        id: 'aaaa1111',
        targetOrigin: 'http://localhost:3000'
      })
    })
    expect(webPreview.create).toHaveBeenCalledTimes(1)
  })

  it('reports an unusable address instead of navigating', async () => {
    const { result } = renderHook(() => useWebPreviewBrowserPage(createPage('about:blank')))

    act(() => {
      result.current.navigate('   ')
    })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(webPreview.create).not.toHaveBeenCalled()
  })

  it('follows a nav ping from its own frame and ignores one from another pane', async () => {
    const { result } = renderHook(() =>
      useWebPreviewBrowserPage(createPage('http://localhost:5173/'))
    )
    await waitFor(() => expect(result.current.iframeSrc).toContain('aaaa1111'))
    const ownFrame = attachFakeIframe(result.current.iframeRef)

    postNavPing({} as Window, {
      type: 'orca-webpreview-nav',
      upstreamUrl: 'http://localhost:5173/from-another-pane'
    })
    expect(result.current.displayedUrl).toBe('http://localhost:5173/')

    postNavPing(ownFrame, {
      type: 'orca-webpreview-nav',
      upstreamUrl: 'http://localhost:5173/routed'
    })
    expect(result.current.displayedUrl).toBe('http://localhost:5173/routed')
    expect(setBrowserPageUrl).toHaveBeenCalledWith('page-a', 'http://localhost:5173/routed')
  })

  it('retargets the session when the injected script forwards a cross-origin link click', async () => {
    const { result } = renderHook(() =>
      useWebPreviewBrowserPage(createPage('http://localhost:5173/'))
    )
    await waitFor(() => expect(result.current.iframeSrc).toContain('aaaa1111'))
    const ownFrame = attachFakeIframe(result.current.iframeRef)

    postNavPing(ownFrame, {
      type: 'orca-webpreview-navigate',
      url: 'https://example.test/docs'
    })
    await waitFor(() => {
      expect(webPreview.setOrigin).toHaveBeenCalledWith({
        id: 'aaaa1111',
        targetOrigin: 'https://example.test'
      })
    })
  })

  it('releases the session only when the pane unmounts', async () => {
    const { result, unmount } = renderHook(() =>
      useWebPreviewBrowserPage(createPage('http://localhost:5173/'))
    )
    await waitFor(() => expect(result.current.iframeSrc).toContain('aaaa1111'))

    act(() => {
      result.current.navigate('http://localhost:3000/')
    })
    await waitFor(() => expect(webPreview.setOrigin).toHaveBeenCalledTimes(1))
    expect(webPreview.delete).not.toHaveBeenCalled()

    unmount()
    expect(webPreview.delete).toHaveBeenCalledWith({ id: 'aaaa1111' })
  })
})
