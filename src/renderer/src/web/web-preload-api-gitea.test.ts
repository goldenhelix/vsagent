import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web Gitea preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
    vi.doUnmock('electron')
  })

  it('keeps the web Gitea preload key set in parity with desktop preload', async () => {
    vi.doMock('electron', () => ({
      ipcRenderer: { invoke: vi.fn() }
    }))
    const globals = installBrowserGlobals('Linux')
    const { giteaApi } = (await import(
      new URL('../../../preload/gitea.ts', import.meta.url).href
    )) as {
      giteaApi: Record<string, unknown>
    }
    const { installWebPreloadApi } = await import('./web-preload-api')

    installWebPreloadApi()

    expect(Object.keys(globals.window.api.gitea).sort()).toEqual(Object.keys(giteaApi).sort())
  })

  it('routes every runtime-backed Gitea method through the expected RPC method', async () => {
    type GiteaApi = NonNullable<PreloadApi['gitea']>
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { ok: true, items: [] },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    const { GITEA_WEB_RPC_METHODS } = await import('./preload-api/web-gitea-routes')
    installWebPreloadApi()
    const api = globals.window.api
    const repoPath = '/workspace/repo'

    const routeCases: {
      key: keyof typeof GITEA_WEB_RPC_METHODS
      invoke: (gitea: GiteaApi) => Promise<unknown>
      expectedMethod: string
      expectedParams: unknown
    }[] = [
      {
        key: 'diagnoseAuth',
        invoke: (gitea) => gitea.diagnoseAuth(),
        expectedMethod: 'gitea.diagnoseAuth',
        expectedParams: undefined
      },
      {
        key: 'listIssues',
        invoke: (gitea) =>
          gitea.listIssues({ repoPath, state: 'all', assignee: '@me', limit: 30 }),
        expectedMethod: 'gitea.listIssues',
        expectedParams: { repoPath, repo: repoPath, state: 'all', assignee: '@me', limit: 30 }
      },
      {
        key: 'listLabels',
        invoke: (gitea) => gitea.listLabels({ repoPath }),
        expectedMethod: 'gitea.listLabels',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'listMilestones',
        invoke: (gitea) => gitea.listMilestones({ repoPath }),
        expectedMethod: 'gitea.listMilestones',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'updateIssue',
        invoke: (gitea) => gitea.updateIssue({ repoPath, number: 7, updates: { state: 'closed' } }),
        expectedMethod: 'gitea.updateIssue',
        expectedParams: { repoPath, repo: repoPath, number: 7, updates: { state: 'closed' } }
      },
      {
        key: 'addIssueComment',
        invoke: (gitea) => gitea.addIssueComment({ repoPath, number: 7, body: 'Fixed' }),
        expectedMethod: 'gitea.addIssueComment',
        expectedParams: { repoPath, repo: repoPath, number: 7, body: 'Fixed' }
      },
      {
        key: 'workItemDetails',
        invoke: (gitea) => gitea.workItemDetails({ repoPath, iid: 8 }),
        expectedMethod: 'gitea.workItemDetails',
        expectedParams: { repoPath, repo: repoPath, iid: 8 }
      },
      {
        key: 'workItemByPath',
        invoke: (gitea) => gitea.workItemByPath({ repoPath, iid: 7 }),
        expectedMethod: 'gitea.workItemByPath',
        expectedParams: { repoPath, repo: repoPath, iid: 7 }
      }
    ]

    expect(routeCases.map((routeCase) => routeCase.key).sort()).toEqual(
      Object.keys(GITEA_WEB_RPC_METHODS).sort()
    )

    for (const routeCase of routeCases) {
      await routeCase.invoke(api.gitea)
    }

    expect(runtimeCalls).toEqual(
      routeCases.map((routeCase) => ({
        method: routeCase.expectedMethod,
        params: routeCase.expectedParams
      }))
    )
  })

  it('routes Gitea repo selectors through repo id when provided, dropping the desktop owner guard from workItemDetails', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: method === 'gitea.workItemDetails' ? null : { ok: true, items: [] },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'gitea',
      projectId: 'gitea:gitea.example.com/group/project',
      hostId: 'runtime:web-env-1',
      repoId: 'repo-gitea-runtime',
      providerIdentity: {
        provider: 'gitea',
        owner: 'group',
        repo: 'project',
        host: 'gitea.example.com',
        webUrl: 'https://gitea.example.com/group/project'
      }
    }

    await api.gitea.listIssues({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitea-runtime',
      sourceContext,
      state: 'opened'
    })
    await api.gitea.workItemDetails({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitea-runtime',
      sourceContext,
      repoOwnerExecutionHostId: 'ssh:ssh-1',
      iid: 9
    })

    expect(runtimeCalls).toEqual([
      {
        method: 'gitea.listIssues',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitea-runtime',
          sourceContext,
          repo: 'id:repo-gitea-runtime',
          state: 'opened'
        }
      },
      {
        method: 'gitea.workItemDetails',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitea-runtime',
          sourceContext,
          repo: 'id:repo-gitea-runtime',
          iid: 9
        }
      }
    ])
  })
})
