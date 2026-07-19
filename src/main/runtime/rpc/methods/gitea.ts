import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { normalizeGitLabIssueListArgs } from '../../../gitlab/gitlab-preload-args'

const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

const EmptyParams = z.object({}).optional().default({})

const IssuesList = RepoSelector.extend({
  state: z.unknown().optional(),
  assignee: OptionalString,
  limit: OptionalFiniteNumber,
  milestone: OptionalString
})

// Why: mirrors GitLabIssueUpdate so the shared issue dialog/editing path is
// provider-agnostic — Gitea reuses the same opened/closed + label/assignee delta.
const IssueUpdate = z.object({
  state: z.enum(['opened', 'closed']).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  addAssignees: z.array(z.string()).optional(),
  removeAssignees: z.array(z.string()).optional()
})

const UpdateIssue = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: IssueUpdate
})

const AddIssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: requiredString('Comment body is required')
})

const WorkItemDetails = RepoSelector.extend({
  iid: z.number().int().positive()
})

const WorkItemByPath = RepoSelector.extend({
  iid: z.number().int().positive()
})

export const GITEA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'gitea.listIssues',
    params: IssuesList,
    handler: async (params, { runtime }) => {
      const normalized = normalizeGitLabIssueListArgs(params)
      return runtime.listGiteaRepoIssues(
        params.repo,
        normalized.state,
        normalized.assignee,
        normalized.limit,
        params.milestone
      )
    }
  }),
  defineMethod({
    name: 'gitea.diagnoseAuth',
    params: EmptyParams,
    handler: async (_params, { runtime }) => runtime.diagnoseGiteaAuth()
  }),
  defineMethod({
    name: 'gitea.listLabels',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoLabels(params.repo)
  }),
  defineMethod({
    name: 'gitea.listMilestones',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoMilestones(params.repo)
  }),
  defineMethod({
    name: 'gitea.updateIssue',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateGiteaRepoIssue(params.repo, params.number, params.updates)
  }),
  defineMethod({
    name: 'gitea.addIssueComment',
    params: AddIssueComment,
    handler: async (params, { runtime }) =>
      runtime.addGiteaRepoIssueComment(params.repo, params.number, params.body)
  }),
  defineMethod({
    name: 'gitea.workItemDetails',
    params: WorkItemDetails,
    handler: async (params, { runtime }) =>
      runtime.getGiteaRepoWorkItemDetails(params.repo, params.iid)
  }),
  defineMethod({
    name: 'gitea.workItemByPath',
    params: WorkItemByPath,
    handler: async (params, { runtime }) =>
      runtime.getGiteaRepoWorkItemByPath(params.repo, params.iid)
  })
]
