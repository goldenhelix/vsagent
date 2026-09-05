import { describe, expect, it } from 'vitest'
import {
  isGiteaPullRequestRow,
  mapGiteaAssignees,
  mapGiteaComment,
  mapGiteaIssueInfo,
  mapGiteaIssueInfoToWorkItem,
  mapGiteaIssueState,
  mapGiteaIssueToWorkItem,
  mapGiteaLabelNames,
  mapGiteaMilestones,
  type RawGiteaIssue
} from './issue-mappers'

function giteaIssue(overrides: Partial<RawGiteaIssue> = {}): RawGiteaIssue {
  return {
    number: 12,
    title: 'Fix the parser',
    body: '## Steps\nrepro here',
    state: 'open',
    html_url: 'https://gitea.example.com/team/repo/issues/12',
    user: { login: 'alice', avatar_url: 'https://gitea.example.com/avatars/alice' },
    labels: [
      { id: 1, name: 'bug' },
      { id: 2, name: 'p1' }
    ],
    assignees: [{ login: 'bob' }, { username: 'carol' }],
    updated_at: '2026-05-15T00:00:00Z',
    ...overrides
  }
}

describe('Gitea issue mappers', () => {
  it('maps GitHub-shaped state onto GitLab vocabulary', () => {
    expect(mapGiteaIssueState('open')).toBe('opened')
    expect(mapGiteaIssueState('closed')).toBe('closed')
    expect(mapGiteaIssueState(undefined)).toBe('opened')
  })

  it('detects PR rows returned in the issues list', () => {
    expect(isGiteaPullRequestRow(giteaIssue())).toBe(false)
    expect(isGiteaPullRequestRow(giteaIssue({ pull_request: { merged: false } }))).toBe(true)
  })

  it('extracts label names, skipping blanks', () => {
    expect(mapGiteaLabelNames([{ name: 'bug' }, { name: '  ' }, { name: null }])).toEqual(['bug'])
  })

  it('maps milestones to {id,title}, dropping blanks and missing ids', () => {
    expect(
      mapGiteaMilestones([
        { id: 3, title: '  v1.0  ' },
        { id: 4, title: '  ' },
        { title: 'no-id' },
        null
      ])
    ).toEqual([{ id: 3, title: 'v1.0' }])
  })

  it('maps a single issue to the shared GitLabIssueInfo shape', () => {
    expect(mapGiteaIssueInfo(giteaIssue())).toEqual({
      number: 12,
      title: 'Fix the parser',
      state: 'opened',
      url: 'https://gitea.example.com/team/repo/issues/12',
      labels: ['bug', 'p1'],
      updatedAt: '2026-05-15T00:00:00Z',
      description: '## Steps\nrepro here',
      author: 'alice',
      authorAvatarUrl: 'https://gitea.example.com/avatars/alice'
    })
  })

  it('returns null for rows missing an identifier or url', () => {
    expect(mapGiteaIssueInfo(giteaIssue({ number: undefined }))).toBeNull()
    expect(mapGiteaIssueInfo(giteaIssue({ html_url: null }))).toBeNull()
  })

  it('maps a list row to the GitLabWorkItem shape with a stamped repoId', () => {
    expect(mapGiteaIssueToWorkItem(giteaIssue(), 'repo-9')).toEqual({
      id: 'gitea-issue-repo-9-12',
      type: 'issue',
      number: 12,
      title: 'Fix the parser',
      state: 'opened',
      url: 'https://gitea.example.com/team/repo/issues/12',
      labels: ['bug', 'p1'],
      updatedAt: '2026-05-15T00:00:00Z',
      author: 'alice',
      repoId: 'repo-9'
    })
  })

  it('stamps a repoId onto a listed issue identically to the raw mapper', () => {
    const info = mapGiteaIssueInfo(giteaIssue())
    expect(info).not.toBeNull()
    expect(mapGiteaIssueInfoToWorkItem(info!, 'repo-9')).toEqual(
      mapGiteaIssueToWorkItem(giteaIssue(), 'repo-9')
    )
  })

  it('normalizes a missing author and updatedAt on the listed-issue row', () => {
    const info = mapGiteaIssueInfo(giteaIssue({ user: null, updated_at: null }))
    expect(mapGiteaIssueInfoToWorkItem(info!, 'repo-9')).toMatchObject({
      id: 'gitea-issue-repo-9-12',
      author: null,
      updatedAt: ''
    })
  })

  it('maps a comment, resolving login and bot flag', () => {
    expect(
      mapGiteaComment({
        id: 3,
        html_url: 'https://gitea.example.com/team/repo/issues/12#comment-3',
        user: { login: 'ci-bot', avatar_url: 'a', is_bot: true },
        body: 'looks good',
        created_at: '2026-05-16T00:00:00Z'
      })
    ).toEqual({
      id: 3,
      author: 'ci-bot',
      authorAvatarUrl: 'a',
      body: 'looks good',
      createdAt: '2026-05-16T00:00:00Z',
      url: 'https://gitea.example.com/team/repo/issues/12#comment-3',
      isBot: true
    })
  })

  it('collects assignee logins from either login or username fields', () => {
    expect(mapGiteaAssignees(giteaIssue())).toEqual(['bob', 'carol'])
  })
})
