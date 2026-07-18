// The ports panel / worktree card "open in browser" action. Split from
// workspace-port-actions.ts, which retains the scan/stop plumbing.
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { useAppStore } from '@/store'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import { browserUrlForPort } from './workspace-port-urls'

type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

// Why: in the web client, browser tabs are iframe-backed by the server-side
// webpreview proxy (see WebBrowserPane); port opens must route through it
// because the port listens on the serve host, not the user's machine.
function canRoutePortThroughWebPreview(): boolean {
  // Why: capability check first — only the web preload defines webPreview, and
  // test environments stub window without a location for isWebClientLocation.
  return Boolean(window.api?.webPreview) && isWebClientLocation()
}

export async function openWorkspacePortInBrowser(args: {
  port: WorkspacePort
  activeWorktreeId?: string | null
  runtimeTarget: RuntimeClientTarget
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
  localhostLabelRoute?: LocalhostWorktreeLabelRoute | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rawUrl = browserUrlForPort(args.port)
  let url = rawUrl
  if (args.runtimeTarget.kind === 'local' && args.localhostLabelRoute) {
    try {
      url = (await window.api.localhostWorktreeLabels.register(args.localhostLabelRoute)).url
    } catch {
      url = rawUrl
    }
  }
  // Why (web client): port URLs point at the serve host's loopback, which the
  // user's machine cannot reach — shell.openUrl would window.open that dead
  // URL. Mint a webpreview proxy session and open its gateway-origin path.
  if (args.openInOrcaBrowser === false && canRoutePortThroughWebPreview()) {
    try {
      const target = new URL(url)
      const session = await window.api.webPreview!.create({ targetOrigin: target.origin })
      window.open(
        session.proxyPath + target.pathname + target.search + target.hash,
        '_blank',
        'noopener,noreferrer'
      )
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open port preview.' }
    }
  }
  if (args.openInOrcaBrowser === false && args.runtimeTarget.kind === 'local') {
    try {
      await window.api.shell.openUrl(url)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open system browser.' }
    }
  }

  const worktreeId =
    args.port.kind === 'workspace' ? args.port.owner.worktreeId : args.activeWorktreeId
  if (!worktreeId) {
    return { ok: false, reason: 'No workspace selected for the browser.' }
  }
  activateAndRevealWorktree(worktreeId)
  // Why (web client): a local browser tab renders WebBrowserPane, which
  // proxies the URL through webpreview. Creating a host-side page via the
  // browser.tabCreate RPC would start the Xvfb screencast machinery and let
  // host snapshots overwrite the locally navigated URL.
  if (canRoutePortThroughWebPreview()) {
    args.createBrowserTab(worktreeId, url, { activate: true })
    return { ok: true }
  }
  if (args.runtimeTarget.kind === 'environment') {
    try {
      const remotePage = await callRuntimeRpc<{ browserPageId: string }>(
        args.runtimeTarget,
        'browser.tabCreate',
        { worktree: toRuntimeWorktreeSelector(worktreeId), url },
        { timeoutMs: 30_000 }
      )
      const tab = args.createBrowserTab(worktreeId, url, { activate: true })
      if (!tab.activePageId) {
        return { ok: false, reason: 'Failed to create a browser page.' }
      }
      args.setRemoteBrowserPageHandle(tab.activePageId, {
        environmentId: args.runtimeTarget.environmentId,
        remotePageId: remotePage.browserPageId
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open remote browser.' }
    }
  }
  args.createBrowserTab(worktreeId, url, { activate: true })
  return { ok: true }
}
