import { describe, expect, it } from 'vitest'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import { filterGitLabItemsBySearch } from './task-page-gitlab-item-search'

function item(overrides: Partial<GitLabWorkItem>): GitLabWorkItem {
  return {
    id: `id-${overrides.number ?? 0}`,
    type: 'issue',
    number: 1,
    title: 'Untitled',
    state: 'opened',
    url: 'https://example/1',
    labels: [],
    updatedAt: '2026-01-01T00:00:00Z',
    author: null,
    repoId: 'repo-1',
    ...overrides
  }
}

const items: GitLabWorkItem[] = [
  item({
    number: 964,
    title: '[Build][macOS] test-macos chronically fails',
    labels: ['ci'],
    author: 'nadeau'
  }),
  item({ number: 963, title: '[Build][Windows] header regeneration', labels: ['ci'] }),
  item({
    number: 500,
    title: 'Refactor classifier eval',
    labels: ['build-system'],
    author: 'buildbot'
  }),
  item({ number: 210, title: 'Docs: update README', labels: [] })
]

describe('filterGitLabItemsBySearch', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterGitLabItemsBySearch(items, '')).toHaveLength(4)
    expect(filterGitLabItemsBySearch(items, '   ')).toHaveLength(4)
  })

  it('matches on the visible title, case-insensitively', () => {
    const result = filterGitLabItemsBySearch(items, 'build')
    // Only the two "[Build]" titles — NOT the row whose title lacks "build"
    // even though it has a "build-system" label / "buildbot" author (hidden).
    expect(result.map((i) => i.number).sort()).toEqual([963, 964])
  })

  it('matches on the #number reference the row shows', () => {
    expect(filterGitLabItemsBySearch(items, '964').map((i) => i.number)).toEqual([964])
    expect(filterGitLabItemsBySearch(items, '#210').map((i) => i.number)).toEqual([210])
  })

  it('does NOT match hidden labels or author', () => {
    // "ci" is only a label; "nadeau"/"buildbot" only authors — none are shown.
    expect(filterGitLabItemsBySearch(items, 'ci')).toHaveLength(0)
    expect(filterGitLabItemsBySearch(items, 'nadeau')).toHaveLength(0)
    expect(filterGitLabItemsBySearch(items, 'buildbot')).toHaveLength(0)
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterGitLabItemsBySearch(items, 'zzzzz-nope')).toHaveLength(0)
  })
})
