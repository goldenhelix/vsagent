import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isVSAgentWebMode } from '@/lib/vsagent-web-mode'
import { SourceControlEntryContextMenu } from './source-control/listing/entry-context-menu'

// Default: desktop. The VSAgent-web case below opts in per-test.
vi.mock('@/lib/vsagent-web-mode', () => ({ isVSAgentWebMode: vi.fn(() => false) }))

type ItemProps = { onSelect?: () => void; children?: React.ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))

vi.mock('@/components/ui/context-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)

  return {
    ContextMenu: passthrough,
    ContextMenuContent: passthrough,
    ContextMenuItem: (props: ItemProps) => {
      items.list.push(props)
      return React_.createElement(React_.Fragment, null, props.children)
    },
    ContextMenuSeparator: () => null,
    ContextMenuSub: passthrough,
    ContextMenuSubContent: passthrough,
    ContextMenuSubTrigger: passthrough,
    ContextMenuTrigger: passthrough
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: { openInApplications: never[] } }) => unknown) =>
    selector({ settings: { openInApplications: [] } })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/local-file-manager-label', () => ({
  getLocalFileManagerLabel: () => 'Finder'
}))

vi.mock('@/lib/open-in-app-catalog', () => ({
  OpenInApplicationIcon: () => null
}))

vi.mock('@/components/sidebar/WorktreeOpenInMenu', () => ({
  getWorktreeOpenInEntries: () => [],
  openOpenInAppsSettings: vi.fn(),
  openWorktreePath: vi.fn()
}))

function childrenText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .filter((child): child is string => typeof child === 'string')
    .join('')
}

describe('SourceControlEntryContextMenu', () => {
  const writeClipboardText = vi.fn()

  beforeEach(() => {
    items.list = []
    writeClipboardText.mockReset()
    vi.stubGlobal('window', {
      api: { ui: { writeClipboardText } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies the supplied relative path', () => {
    renderToStaticMarkup(
      <SourceControlEntryContextMenu
        currentWorktreeId="worktree-1"
        absolutePath="/repo/src/example.ts"
        relativePath="src/example.ts"
        onRevealInExplorer={vi.fn()}
      >
        <div />
      </SourceControlEntryContextMenu>
    )

    const copyRelativePathItem = items.list.find(
      (item) => childrenText(item.children) === 'Copy Relative Path'
    )

    expect(copyRelativePathItem).toBeDefined()
    copyRelativePathItem?.onSelect?.()
    expect(writeClipboardText).toHaveBeenCalledWith('src/example.ts')
  })

  it('hides the desktop "Open in" submenu (and its separator) in VSAgent web mode, keeping "Open in File Explorer"', () => {
    vi.mocked(isVSAgentWebMode).mockReturnValue(true)
    try {
      const markup = renderToStaticMarkup(
        <SourceControlEntryContextMenu
          currentWorktreeId="worktree-1"
          absolutePath="/repo/src/example.ts"
          relativePath="src/example.ts"
          onRevealInExplorer={vi.fn()}
        >
          <div />
        </SourceControlEntryContextMenu>
      )

      // "Customize apps..." only renders inside the "Open in" submenu, so its
      // absence proves the whole submenu (and the separator gating it) is gone.
      expect(markup).not.toContain('Customize apps')
      const revealInExplorerItem = items.list.find(
        (item) => childrenText(item.children) === 'Open in File Explorer'
      )
      expect(revealInExplorerItem).toBeDefined()
    } finally {
      vi.mocked(isVSAgentWebMode).mockReturnValue(false)
    }
  })
})
