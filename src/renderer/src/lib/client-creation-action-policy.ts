import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { AppState } from '@/store/types'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { canRenderWebPreviewBrowserPane } from './webpreview-browser-availability'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

export const MANAGED_BROWSER_UNAVAILABLE_MESSAGE =
  "Managed browser tabs are unavailable because this web client's paired runtime does not support browser streaming."
export const RUNTIME_BROWSER_UNAVAILABLE_MESSAGE =
  'Managed browser tabs are unavailable because the paired runtime does not support browser streaming.'
export const FLOATING_BROWSER_UNAVAILABLE_MESSAGE =
  'Managed browser tabs are unavailable in the web client floating workspace.'
export const LOCAL_BROWSER_UNAVAILABLE_MESSAGE =
  'Managed browser tabs in the web client must be created by a capable paired runtime.'
export const MOBILE_EMULATOR_UNAVAILABLE_MESSAGE =
  'Mobile Emulator is unavailable in the web client.'

export type ClientCreationAction = 'managed-browser' | 'mobile-emulator'
export type ClientCreationActionProvider = 'local-client' | 'paired-runtime'

export type ClientCreationActionAvailability =
  | { state: 'enabled'; provider: ClientCreationActionProvider }
  | { state: 'hidden'; reason: string }

export type ClientCreationActionPolicy = Record<
  ClientCreationAction,
  ClientCreationActionAvailability
>

export function resolveClientCreationActionPolicy(args: {
  surface: 'electron' | 'paired-web'
  runtimeStatus: Pick<RuntimeStatus, 'capabilities' | 'hostPlatform'> | null
  floatingWorkspace?: boolean
  webPreviewProxyAvailable?: boolean
}): ClientCreationActionPolicy {
  const browserStreamingAvailable = args.runtimeStatus?.capabilities?.includes(
    BROWSER_SCREENCAST_RUNTIME_CAPABILITY
  )

  if (args.surface === 'electron') {
    return {
      'managed-browser': {
        state: 'enabled',
        provider: browserStreamingAvailable ? 'paired-runtime' : 'local-client'
      },
      'mobile-emulator': { state: 'enabled', provider: 'local-client' }
    }
  }

  // Why (VSAgent fork): a webpreview-proxy host can back a client-local browser tab with
  // the iframe pane, so the web client keeps browser tabs without browser streaming.
  // Preferred over streaming when both exist — the pane guard mounts the iframe either way.
  return {
    'managed-browser': args.floatingWorkspace
      ? { state: 'hidden', reason: FLOATING_BROWSER_UNAVAILABLE_MESSAGE }
      : args.webPreviewProxyAvailable
        ? { state: 'enabled', provider: 'local-client' }
        : browserStreamingAvailable
          ? { state: 'enabled', provider: 'paired-runtime' }
          : { state: 'hidden', reason: MANAGED_BROWSER_UNAVAILABLE_MESSAGE },
    // The web preload cannot stream emulator frames, even when the host can run emulator tasks.
    'mobile-emulator': { state: 'hidden', reason: MOBILE_EMULATOR_UNAVAILABLE_MESSAGE }
  }
}

export function getClientCreationActionPolicy(
  state: AppState,
  worktreeId: string | null
): ClientCreationActionPolicy {
  const floatingWorkspace = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  const runtimeEnvironmentId = floatingWorkspace
    ? null
    : worktreeId
      ? getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      : (state.settings?.activeRuntimeEnvironmentId?.trim() ?? null)
  const runtimeStatus = runtimeEnvironmentId
    ? (state.runtimeStatusByEnvironmentId?.get(runtimeEnvironmentId)?.status ?? null)
    : null

  return resolveClientCreationActionPolicy({
    surface: isPairedWebClientWindow() ? 'paired-web' : 'electron',
    runtimeStatus,
    floatingWorkspace,
    webPreviewProxyAvailable: canRenderWebPreviewBrowserPane(runtimeStatus)
  })
}

export function assertClientCreationActionAvailable(
  state: AppState,
  worktreeId: string | null,
  action: ClientCreationAction
): void {
  const availability = getClientCreationActionPolicy(state, worktreeId)[action]
  if (availability.state !== 'enabled') {
    throw new Error(availability.reason)
  }
}

export function assertRuntimeManagedBrowserCreationAvailable(
  state: AppState,
  runtimeEnvironmentId: string
): void {
  const capabilities =
    state.runtimeStatusByEnvironmentId?.get(runtimeEnvironmentId)?.status?.capabilities
  if (!capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY)) {
    throw new Error(RUNTIME_BROWSER_UNAVAILABLE_MESSAGE)
  }
}

export function assertManagedBrowserMaterializationAllowed(
  state: AppState,
  browserRuntimeEnvironmentId: string | null | undefined,
  worktreeId?: string | null
): void {
  if (!isPairedWebClientWindow()) {
    return
  }
  const runtimeEnvironmentId = browserRuntimeEnvironmentId?.trim()
  if (!runtimeEnvironmentId) {
    // Why (VSAgent fork): the webpreview proxy backs client-local tabs, so they are
    // materializable exactly when the policy hands this workspace 'local-client'.
    const availability = getClientCreationActionPolicy(state, worktreeId ?? null)['managed-browser']
    if (availability.state === 'enabled' && availability.provider === 'local-client') {
      return
    }
    throw new Error(LOCAL_BROWSER_UNAVAILABLE_MESSAGE)
  }
  assertRuntimeManagedBrowserCreationAvailable(state, runtimeEnvironmentId)
}
