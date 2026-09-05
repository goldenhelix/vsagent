import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

import { createGiteaApi } from './web-gitea-api'

describe('web Gitea API routing', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset().mockResolvedValue(null)
  })

  it('does not forward the desktop repo-owner guard over runtime RPC', async () => {
    await createGiteaApi().workItemDetails({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      repoOwnerExecutionHostId: 'ssh:ssh-1',
      iid: 42
    })

    expect(callRuntimeResult).toHaveBeenCalledWith('gitea.workItemDetails', {
      repo: 'id:repo-1',
      repoId: 'repo-1',
      repoPath: '/workspace/repo',
      iid: 42
    })
  })
})
