import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { createSession, deleteSession, updateSessionOrigin } from '../../../webpreview/registry'
import { WEBPREVIEW_PROXY_PREFIX } from '../../../webpreview/proxy'

// Why: web clients cannot host an Electron webview, so browser panes are backed
// by the server-side webpreview reverse proxy. These methods let a paired
// client mint/retarget proxy sessions. `webpreview.list`/`webpreview.get` are
// intentionally absent — no renderer caller needs them, and `list` would hand
// every session id (each an unguessable capability) to any authenticated client.

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
  // Why absolute: a paired web client can hold more than one runtime environment
  // in a single page, so a bare path would resolve against whichever environment
  // served the currently-loaded bundle rather than the one that owns this session.
  proxyPath: string
}

function toPublic(
  session: { id: string; targetOrigin: string },
  httpOrigin: string | null | undefined
): PublicWebPreviewSession {
  const path = `${WEBPREVIEW_PROXY_PREFIX}/${session.id}`
  return {
    id: session.id,
    targetOrigin: session.targetOrigin,
    proxyPath: httpOrigin ? `${httpOrigin}${path}` : path
  }
}

export const WEBPREVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'webpreview.create',
    params: WebPreviewCreateParams,
    handler: (params, ctx) => ({
      session: toPublic(createSession(params.targetOrigin), ctx.webPreviewHttpOrigin)
    })
  }),
  defineMethod({
    name: 'webpreview.setOrigin',
    params: WebPreviewSetOriginParams,
    handler: (params, ctx) => {
      const session = updateSessionOrigin(params.id, params.targetOrigin)
      return { session: session ? toPublic(session, ctx.webPreviewHttpOrigin) : null }
    }
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
