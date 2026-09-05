import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const listGiteaIssues = vi.fn()
const listGiteaLabels = vi.fn()
const listGiteaMilestones = vi.fn()
const getGiteaIssueDetails = vi.fn()
const getGiteaWorkItemByPath = vi.fn()
const addGiteaIssueComment = vi.fn()
const updateGiteaIssue = vi.fn()
const getGiteaAuthStatus = vi.fn()

vi.mock('../gitea/issues', () => ({
  listGiteaIssues: (...args: unknown[]) => listGiteaIssues(...args),
  listGiteaLabels: (...args: unknown[]) => listGiteaLabels(...args),
  listGiteaMilestones: (...args: unknown[]) => listGiteaMilestones(...args),
  getGiteaIssueDetails: (...args: unknown[]) => getGiteaIssueDetails(...args),
  getGiteaWorkItemByPath: (...args: unknown[]) => getGiteaWorkItemByPath(...args)
}))
vi.mock('../gitea/issue-mutations', () => ({
  addGiteaIssueComment: (...args: unknown[]) => addGiteaIssueComment(...args),
  updateGiteaIssue: (...args: unknown[]) => updateGiteaIssue(...args)
}))
vi.mock('../gitea/client', () => ({
  getGiteaAuthStatus: (...args: unknown[]) => getGiteaAuthStatus(...args)
}))

const { RuntimeGiteaCommands } = await import('./runtime-gitea-commands')
const { installRuntimeReviewCommandSurface } = await import('./runtime-review-command-surface')

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: 'ssh-1'
} as unknown as Repo

function makeCommands(localGitArgs: [] | [{ wslDistro?: string }] = []) {
  return new RuntimeGiteaCommands({
    resolveRepo: vi.fn(async () => repo),
    getLocalGitArgs: () => localGitArgs
  })
}

describe('RuntimeGiteaCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stamps the repo id onto listed issues and threads the milestone past the GitLab normalizer', async () => {
    listGiteaIssues.mockResolvedValue({
      items: [
        {
          number: 7,
          title: 'Broken login',
          state: 'opened',
          url: 'https://gitea.example/org/repo/issues/7',
          labels: ['bug'],
          updatedAt: '2026-01-01T00:00:00Z',
          author: 'ada'
        }
      ]
    })

    const result = await makeCommands([{ wslDistro: 'Ubuntu' }]).listGiteaRepoIssues(
      'id:repo-1',
      'closed',
      '@me',
      50,
      '  v1.0  '
    )

    expect(listGiteaIssues).toHaveBeenCalledWith(
      '/workspace/repo',
      50,
      'closed',
      '@me',
      'v1.0',
      'ssh-1',
      { wslDistro: 'Ubuntu' }
    )
    expect(result.items).toEqual([
      {
        id: 'gitea-issue-repo-1-7',
        type: 'issue',
        number: 7,
        title: 'Broken login',
        state: 'opened',
        url: 'https://gitea.example/org/repo/issues/7',
        labels: ['bug'],
        updatedAt: '2026-01-01T00:00:00Z',
        author: 'ada',
        repoId: 'repo-1'
      }
    ])
    expect(result.error).toBeUndefined()
  })

  it('drops a blank milestone and surfaces a listing error', async () => {
    listGiteaIssues.mockResolvedValue({
      items: [],
      error: { type: 'not_found', message: 'nope' }
    })

    const result = await makeCommands().listGiteaRepoIssues(
      'id:repo-1',
      undefined,
      undefined,
      5,
      '  '
    )

    expect(listGiteaIssues).toHaveBeenCalledWith(
      '/workspace/repo',
      5,
      'opened',
      undefined,
      undefined,
      'ssh-1'
    )
    expect(result.error).toEqual({ type: 'not_found', message: 'nope' })
  })

  it('forwards the remaining seven operations with the resolved repo path', async () => {
    const commands = makeCommands()
    await commands.diagnoseGiteaAuth()
    await commands.listGiteaRepoLabels('id:repo-1')
    await commands.listGiteaRepoMilestones('id:repo-1')
    await commands.updateGiteaRepoIssue('id:repo-1', 7, { state: 'closed' })
    await commands.addGiteaRepoIssueComment('id:repo-1', 7, 'looks good')
    await commands.getGiteaRepoWorkItemDetails('id:repo-1', 7)
    await commands.getGiteaRepoWorkItemByPath('id:repo-1', 7)

    expect(getGiteaAuthStatus).toHaveBeenCalledOnce()
    expect(listGiteaLabels).toHaveBeenCalledWith('/workspace/repo', 'ssh-1')
    expect(listGiteaMilestones).toHaveBeenCalledWith('/workspace/repo', 'ssh-1')
    expect(updateGiteaIssue).toHaveBeenCalledWith(
      '/workspace/repo',
      7,
      { state: 'closed' },
      'ssh-1'
    )
    expect(addGiteaIssueComment).toHaveBeenCalledWith('/workspace/repo', 7, 'looks good', 'ssh-1')
    expect(getGiteaIssueDetails).toHaveBeenCalledWith('/workspace/repo', 7, 'ssh-1')
    expect(getGiteaWorkItemByPath).toHaveBeenCalledWith('/workspace/repo', 7, 'ssh-1')
  })
})

// Why: the non-Gitea owners are irrelevant here; a proxy answers whatever
// property name the installer binds so the assertion stays about Gitea.
function commandOwnerStub(): Record<string, () => void> {
  return new Proxy({}, { get: () => () => {} }) as Record<string, () => void>
}

describe('installRuntimeReviewCommandSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('binds every Gitea command onto the runtime surface', async () => {
    const gitea = makeCommands()
    const target = {} as Record<string, (...args: unknown[]) => unknown>

    installRuntimeReviewCommandSurface(
      target as never,
      {
        gitLabQueries: commandOwnerStub(),
        gitLabMutations: commandOwnerStub(),
        gitea,
        gitHubReviewQueries: commandOwnerStub(),
        gitHubReviewMutations: commandOwnerStub(),
        gitHubIssueComments: commandOwnerStub(),
        gitHubProjects: commandOwnerStub()
      } as never
    )

    expect(
      Object.keys(target)
        .filter((name) => name.includes('Gitea'))
        .sort()
    ).toEqual([
      'addGiteaRepoIssueComment',
      'diagnoseGiteaAuth',
      'getGiteaRepoWorkItemByPath',
      'getGiteaRepoWorkItemDetails',
      'listGiteaRepoIssues',
      'listGiteaRepoLabels',
      'listGiteaRepoMilestones',
      'updateGiteaRepoIssue'
    ])
    // Bound, not merely present: an unbound method would lose `this.deps`.
    await target.listGiteaRepoLabels!('id:repo-1')
    expect(listGiteaLabels).toHaveBeenCalledWith('/workspace/repo', 'ssh-1')
  })
})
