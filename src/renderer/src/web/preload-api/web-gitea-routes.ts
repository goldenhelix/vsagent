export type WebGiteaRouteKey =
  | 'diagnoseAuth'
  | 'listIssues'
  | 'listLabels'
  | 'listMilestones'
  | 'updateIssue'
  | 'addIssueComment'
  | 'workItemDetails'
  | 'workItemByPath'

export type WebGiteaRuntimeMethod =
  | 'gitea.diagnoseAuth'
  | 'gitea.listIssues'
  | 'gitea.listLabels'
  | 'gitea.listMilestones'
  | 'gitea.updateIssue'
  | 'gitea.addIssueComment'
  | 'gitea.workItemDetails'
  | 'gitea.workItemByPath'

export const GITEA_WEB_RPC_METHODS = {
  diagnoseAuth: 'gitea.diagnoseAuth',
  listIssues: 'gitea.listIssues',
  listLabels: 'gitea.listLabels',
  listMilestones: 'gitea.listMilestones',
  updateIssue: 'gitea.updateIssue',
  addIssueComment: 'gitea.addIssueComment',
  workItemDetails: 'gitea.workItemDetails',
  workItemByPath: 'gitea.workItemByPath'
} as const satisfies Record<WebGiteaRouteKey, WebGiteaRuntimeMethod>
