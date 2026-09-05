import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getGiteaIssueDetails, listGiteaIssues, listGiteaLabels } from './issues'
import { addGiteaIssueComment, updateGiteaIssue } from './issue-mutations'
import { _resetGiteaRepoRefCache } from './repository-ref'

const OLD_ENV = process.env

function issue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    body: 'body text',
    state: 'open',
    html_url: `https://gitea.example.com/team/repo/issues/${number}`,
    user: { login: 'alice', avatar_url: 'a' },
    labels: [{ id: 5, name: 'bug' }],
    assignees: [{ login: 'alice' }],
    updated_at: '2026-05-15T00:00:00Z',
    ...overrides
  }
}

describe('Gitea issue client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    delete process.env.ORCA_GITEA_API_BASE_URL
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://gitea.example.com/team/repo.git\n',
      stderr: ''
    })
    _resetGiteaRepoRefCache()
    vi.unstubAllGlobals()
  })

  it('lists issues, drops PR rows, and maps to the shared shape', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      expect(parsed.pathname).toBe('/api/v1/repos/team/repo/issues')
      expect(parsed.searchParams.get('type')).toBe('issues')
      expect(parsed.searchParams.get('state')).toBe('open')
      expect(parsed.searchParams.get('sort')).toBe('recentupdate')
      return Response.json([issue(7), issue(8, { pull_request: { merged: false } })])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await listGiteaIssues('/repo', 20, 'opened')
    expect(result.error).toBeUndefined()
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ number: 7, state: 'opened', labels: ['bug'] })
  })

  it('resolves the current user for an assigned-to-me filter', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/api/v1/user') {
        return Response.json({ login: 'me-user' })
      }
      expect(parsed.searchParams.get('assigned_by')).toBe('me-user')
      return Response.json([issue(7)])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await listGiteaIssues('/repo', 20, 'opened', '@me')
    expect(result.items).toHaveLength(1)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/api/v1/user'))).toBe(true)
  })

  it('classifies a permission error from the list endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'forbidden' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await listGiteaIssues('/repo')
    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('permission_denied')
  })

  it('aggregates issue detail with its comment thread', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/issues/7/comments')) {
        return Response.json([
          { id: 2, user: { login: 'bob' }, body: 'second', created_at: '2026-05-16T00:00:00Z' },
          { id: 1, user: { login: 'alice' }, body: 'first', created_at: '2026-05-15T00:00:00Z' }
        ])
      }
      return Response.json(issue(7))
    })
    vi.stubGlobal('fetch', fetchMock)

    const details = await getGiteaIssueDetails('/repo', 7)
    expect(details?.item.number).toBe(7)
    expect(details?.body).toBe('body text')
    expect(details?.assignees).toEqual(['alice'])
    // Oldest-first ordering.
    expect(details?.comments.map((c) => c.id)).toEqual([1, 2])
  })

  it('posts an issue comment and returns the mapped comment', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(String(url)).toContain('/issues/7/comments')
      return Response.json({
        id: 99,
        user: { login: 'me' },
        body: 'thanks',
        created_at: '2026-05-17T00:00:00Z',
        html_url: 'https://gitea.example.com/team/repo/issues/7#c99'
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await addGiteaIssueComment('/repo', 7, 'thanks')
    expect(result).toEqual({
      ok: true,
      comment: {
        id: 99,
        author: 'me',
        authorAvatarUrl: '',
        body: 'thanks',
        createdAt: '2026-05-17T00:00:00Z',
        url: 'https://gitea.example.com/team/repo/issues/7#c99',
        isBot: false
      }
    })
  })

  it('patches title/body/state in a single request', async () => {
    let patchBody: unknown = null
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('PATCH')
      patchBody = JSON.parse(String(init?.body))
      return Response.json(issue(7, { state: 'closed', title: 'New' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateGiteaIssue('/repo', 7, {
      title: 'New',
      body: 'updated',
      state: 'closed'
    })
    expect(result).toEqual({ ok: true })
    expect(patchBody).toEqual({ title: 'New', body: 'updated', state: 'closed' })
  })

  it('lists label names', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([
        { id: 1, name: 'bug' },
        { id: 2, name: 'p1' }
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(listGiteaLabels('/repo')).resolves.toEqual(['bug', 'p1'])
  })

  it('returns a resolve error when the remote is not a Gitea host', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://github.com/team/repo.git\n',
      stderr: ''
    })
    const result = await listGiteaIssues('/repo')
    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('not_found')
  })
})
