// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { TasksPane } from './TasksPane'

// SearchableSetting reads settingsSearchQuery; empty query renders every row.
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

function checkboxLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[role="checkbox"]')).map((node) =>
    (node.textContent ?? '').replace(/\s+/g, ' ').trim()
  )
}

describe('TasksPane', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('renders a Gitea provider toggle alongside the built-in providers', () => {
    const settings = getDefaultSettings('~') as GlobalSettings
    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <TasksPane settings={settings} updateSettings={vi.fn()} />
        </I18nextProvider>
      )
    })
    const labels = checkboxLabels(host)
    expect(labels.some((label) => /Gitea/.test(label))).toBe(true)
    expect(labels.some((label) => /GitHub/.test(label))).toBe(true)
  })

  it('toggling Gitea off persists a provider list without gitea', () => {
    const settings = getDefaultSettings('~') as GlobalSettings
    const updateSettings = vi.fn()
    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <TasksPane settings={settings} updateSettings={updateSettings} />
        </I18nextProvider>
      )
    })
    const giteaToggle = Array.from(host.querySelectorAll('[role="checkbox"]')).find((node) =>
      /Gitea/.test(node.textContent ?? '')
    ) as HTMLElement | undefined
    expect(giteaToggle).toBeDefined()
    act(() => giteaToggle?.click())
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const nextVisible = updateSettings.mock.calls[0][0].visibleTaskProviders as string[]
    expect(nextVisible).not.toContain('gitea')
    expect(nextVisible).toContain('github')
  })
})
