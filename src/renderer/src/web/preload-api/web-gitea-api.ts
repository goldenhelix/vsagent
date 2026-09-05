import type { PreloadApi } from '../../../../preload/api-types'
import { GITEA_WEB_RPC_METHODS } from './web-gitea-routes'
import type { WebGiteaRuntimeMethod } from './web-gitea-routes'
import { mapRepoPathArg } from './web-review-api'
import { callRuntimeResult } from './web-runtime-calls'

export type WebGiteaApi = NonNullable<PreloadApi['gitea']>

export type WebGiteaResult<K extends keyof WebGiteaApi> = Awaited<ReturnType<WebGiteaApi[K]>>

export function createGiteaApi(): WebGiteaApi {
  const route = <Result>(method: WebGiteaRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))

  const giteaApi = {
    diagnoseAuth: () => route<WebGiteaResult<'diagnoseAuth'>>(GITEA_WEB_RPC_METHODS.diagnoseAuth),
    listIssues: (args) =>
      route<WebGiteaResult<'listIssues'>>(GITEA_WEB_RPC_METHODS.listIssues, args),
    listLabels: (args) =>
      route<WebGiteaResult<'listLabels'>>(GITEA_WEB_RPC_METHODS.listLabels, args),
    listMilestones: (args) =>
      route<WebGiteaResult<'listMilestones'>>(GITEA_WEB_RPC_METHODS.listMilestones, args),
    updateIssue: (args) =>
      route<WebGiteaResult<'updateIssue'>>(GITEA_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<WebGiteaResult<'addIssueComment'>>(GITEA_WEB_RPC_METHODS.addIssueComment, args),
    workItemDetails: ({ repoOwnerExecutionHostId: _owner, ...args }) =>
      route<WebGiteaResult<'workItemDetails'>>(GITEA_WEB_RPC_METHODS.workItemDetails, args),
    workItemByPath: (args) =>
      route<WebGiteaResult<'workItemByPath'>>(GITEA_WEB_RPC_METHODS.workItemByPath, args)
  } satisfies WebGiteaApi

  return giteaApi
}
