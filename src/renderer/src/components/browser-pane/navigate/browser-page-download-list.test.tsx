import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserPageDownloadList } from './browser-page-download-list'
import type { BrowserDownloadState } from './browser-download-progress'

// Default: desktop. The VSAgent-web case below opts in per-test.
vi.mock('@/lib/vsagent-web-mode', () => ({ isVSAgentWebMode: vi.fn(() => false) }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function completedDownload(): BrowserDownloadState {
  return {
    browserPageId: 'page-1',
    downloadId: 'dl-1',
    origin: 'example.com',
    filename: 'report.pdf',
    totalBytes: 1024,
    mimeType: 'application/pdf',
    receivedBytes: 1024,
    status: 'completed',
    savePath: '/downloads/report.pdf',
    error: null,
    progressState: null,
    completedAt: Date.now()
  }
}

describe('BrowserPageDownloadList', () => {
  it('shows Open, Show, and Dismiss for a completed download on desktop', () => {
    const markup = renderToStaticMarkup(
      <BrowserPageDownloadList
        visibleDownloads={[completedDownload()]}
        onOpenDownloadedFile={vi.fn()}
        onShowDownloadedFile={vi.fn()}
        onDismissDownload={vi.fn()}
      />
    )

    expect(markup).toContain('Open')
    expect(markup).toContain('Show')
    expect(markup).toContain('Dismiss')
  })

  it('hides Open and Show but keeps Dismiss in VSAgent web mode', async () => {
    const { isVSAgentWebMode } = await import('@/lib/vsagent-web-mode')
    vi.mocked(isVSAgentWebMode).mockReturnValue(true)
    try {
      const markup = renderToStaticMarkup(
        <BrowserPageDownloadList
          visibleDownloads={[completedDownload()]}
          onOpenDownloadedFile={vi.fn()}
          onShowDownloadedFile={vi.fn()}
          onDismissDownload={vi.fn()}
        />
      )

      expect(markup).not.toContain('Open')
      expect(markup).not.toContain('Show')
      expect(markup).toContain('Dismiss')
    } finally {
      vi.mocked(isVSAgentWebMode).mockReturnValue(false)
    }
  })
})
