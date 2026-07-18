import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSessionOrigin
} from '../../../webpreview/registry'
import { WEBPREVIEW_PROXY_PREFIX } from '../../../webpreview/proxy'

// Why: web clients cannot host an Electron webview, so browser panes are backed
// by the server-side webpreview reverse proxy. These methods let a paired
// client mint/retarget proxy sessions; the returned proxyPath is iframe-able
// on the same origin that serves the web client.

const WebPreviewCreateParams = z.object({
  targetOrigin: requiredString('Missing target origin')
})

const WebPreviewSessionParams = z.object({
  id: requiredString('Missing session id')
})

const WebPreviewSetOriginParams = z.object({
  id: requiredString('Missing session id'),
  targetOrigin: requiredString('Missing target origin')
})

type PublicWebPreviewSession = {
  id: string
  targetOrigin: string
  proxyPath: string
}

function toPublic(session: { id: string; targetOrigin: string }): PublicWebPreviewSession {
  return {
    id: session.id,
    targetOrigin: session.targetOrigin,
    proxyPath: `${WEBPREVIEW_PROXY_PREFIX}/${session.id}`
  }
}

export const WEBPREVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'webpreview.create',
    params: WebPreviewCreateParams,
    handler: (params) => ({ session: toPublic(createSession(params.targetOrigin)) })
  }),
  defineMethod({
    name: 'webpreview.get',
    params: WebPreviewSessionParams,
    handler: (params) => {
      const session = getSession(params.id)
      return { session: session ? toPublic(session) : null }
    }
  }),
  defineMethod({
    name: 'webpreview.setOrigin',
    params: WebPreviewSetOriginParams,
    handler: (params) => {
      const session = updateSessionOrigin(params.id, params.targetOrigin)
      return { session: session ? toPublic(session) : null }
    }
  }),
  defineMethod({
    name: 'webpreview.list',
    params: null,
    handler: () => ({ sessions: listSessions().map(toPublic) })
  }),
  defineMethod({
    name: 'webpreview.delete',
    params: WebPreviewSessionParams,
    handler: (params) => {
      deleteSession(params.id)
      return { deleted: true }
    }
  })
]
