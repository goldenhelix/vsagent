import type { PreloadApi } from '../../../../preload/api-types'
import { callRuntimeResult } from './web-runtime-calls'

export type WebWebPreviewApi = NonNullable<PreloadApi['webPreview']>

export type WebWebPreviewResult<K extends keyof WebWebPreviewApi> = Awaited<
  ReturnType<WebWebPreviewApi[K]>
>

// Why: browser panes in the web client are iframe-backed by the server-side
// webpreview reverse proxy instead of an Electron webview; sessions are
// minted over the paired RPC so the unguessable proxy URL is the only
// capability the iframe needs. The RPC method already resolves the URL to an
// absolute origin (see webpreview.ts's `toPublic`), so it works across every
// paired runtime environment without the caller re-deriving an origin.
export function createWebPreviewApi(): WebWebPreviewApi {
  type SessionResult = { session: WebWebPreviewResult<'create'> | null }
  return {
    create: async (args) => {
      const { session } = await callRuntimeResult<SessionResult>('webpreview.create', args)
      if (!session) {
        throw new Error('webpreview.create returned no session')
      }
      return session
    },
    setOrigin: async (args) =>
      (await callRuntimeResult<SessionResult>('webpreview.setOrigin', args)).session,
    delete: async (args) => {
      await callRuntimeResult('webpreview.delete', args)
    }
  }
}
