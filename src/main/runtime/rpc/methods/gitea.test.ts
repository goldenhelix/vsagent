import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GITEA_METHODS } from './gitea'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('gitea RPC methods', () => {
  it('routes Gitea issue queries and mutations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      diagnoseGiteaAuth: vi.fn().mockResolvedValue({ configured: true }),
      listGiteaRepoIssues: vi.fn().mockResolvedValue({ items: [] }),
      listGiteaRepoLabels: vi.fn().mockResolvedValue(['bug']),
      listGiteaRepoMilestones: vi.fn().mockResolvedValue([{ id: 1, title: 'v1.0' }]),
      updateGiteaRepoIssue: vi.fn().mockResolvedValue({ ok: true }),
      addGiteaRepoIssueComment: vi.fn().mockResolvedValue({ ok: true }),
      getGiteaRepoWorkItemDetails: vi.fn().mockResolvedValue({ body: 'Details' }),
      getGiteaRepoWorkItemByPath: vi.fn().mockResolvedValue({ id: 'gitea-issue-7' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITEA_METHODS })

    await dispatcher.dispatch(makeRequest('gitea.diagnoseAuth'))
    await dispatcher.dispatch(
      makeRequest('gitea.listIssues', {
        repo: 'id:repo-1',
        state: 'opened',
        assignee: '@me',
        limit: 50,
        milestone: 'v1.0'
      })
    )
    await dispatcher.dispatch(makeRequest('gitea.listLabels', { repo: 'id:repo-1' }))
    await dispatcher.dispatch(makeRequest('gitea.listMilestones', { repo: 'id:repo-1' }))
    await dispatcher.dispatch(
      makeRequest('gitea.updateIssue', {
        repo: 'id:repo-1',
        number: 7,
        updates: { state: 'closed', title: 'Done', body: 'Updated body' }
      })
    )
    await dispatcher.dispatch(
      makeRequest('gitea.addIssueComment', {
        repo: 'id:repo-1',
        number: 7,
        body: 'looks good'
      })
    )
    await dispatcher.dispatch(makeRequest('gitea.workItemDetails', { repo: 'id:repo-1', iid: 7 }))
    await dispatcher.dispatch(makeRequest('gitea.workItemByPath', { repo: 'id:repo-1', iid: 7 }))

    expect(runtime.diagnoseGiteaAuth).toHaveBeenCalledWith()
    expect(runtime.listGiteaRepoIssues).toHaveBeenCalledWith(
      'id:repo-1',
      'opened',
      '@me',
      50,
      'v1.0'
    )
    expect(runtime.listGiteaRepoLabels).toHaveBeenCalledWith('id:repo-1')
    expect(runtime.listGiteaRepoMilestones).toHaveBeenCalledWith('id:repo-1')
    expect(runtime.updateGiteaRepoIssue).toHaveBeenCalledWith('id:repo-1', 7, {
      state: 'closed',
      title: 'Done',
      body: 'Updated body'
    })
    expect(runtime.addGiteaRepoIssueComment).toHaveBeenCalledWith('id:repo-1', 7, 'looks good')
    expect(runtime.getGiteaRepoWorkItemDetails).toHaveBeenCalledWith('id:repo-1', 7)
    expect(runtime.getGiteaRepoWorkItemByPath).toHaveBeenCalledWith('id:repo-1', 7)
  })

  it('rejects an issue list without a repo selector', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listGiteaRepoIssues: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITEA_METHODS })

    const response = await dispatcher.dispatch(makeRequest('gitea.listIssues', {}))
    expect(response.ok).toBe(false)
    expect(runtime.listGiteaRepoIssues).not.toHaveBeenCalled()
  })
})
