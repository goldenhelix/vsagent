import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { isVSAgentWebMode } from '@/lib/vsagent-web-mode'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getExecutionHostLabel,
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'

export type AiVaultHostScopeOption = {
  id: ExecutionHostScope
  label: string
}

export function useAiVaultExecutionHostScope(args: {
  activeWorktreeId: string | null
  resumeTargetState: AiVaultSessionResumeTargetState
  availableExecutionHostScopes?: readonly ExecutionHostScope[]
}): {
  executionHostScope: ExecutionHostScope
  activeExecutionHostScope: ExecutionHostId | null
  onExecutionHostScopeChange: (scope: ExecutionHostScope) => void
} {
  const userChangedHostScopeRef = useRef(false)
  const settings = useAppStore((s) => s.settings)
  const activeExecutionHostId = useMemo(
    () => getAiVaultResumeWorkspaceExecutionHostId(args.resumeTargetState, args.activeWorktreeId),
    [args.activeWorktreeId, args.resumeTargetState]
  )
  const activeExecutionHost = parseExecutionHostId(activeExecutionHostId)
  const activeExecutionHostScope: ExecutionHostId | null =
    activeExecutionHost?.kind === 'ssh' || activeExecutionHost?.kind === 'runtime'
      ? activeExecutionHost.id
      : null
  // Why: a named workspace whose host the client store cannot place is `unverifiable`, not local.
  // Defaulting it to local scanned the desktop's own history and reported "No agent sessions found"
  // for a user whose sessions all live on an SSH host (#13713). Widen to every host instead of
  // asserting one. A local workspace still resolves to `local` and is unaffected.
  const workspaceHostUnresolved = args.activeWorktreeId !== null && activeExecutionHostId === null
  // Why (VSAgent fork): the web client has no local host, so fall back to the
  // focused runtime env (Orca Server) instead of the phantom "Local Mac".
  // getSettingsFocusedExecutionHostId itself defaults to LOCAL_EXECUTION_HOST_ID
  // when no runtime env is focused yet (e.g. before the first pairing) — widen
  // to every host in that case rather than resolving back to "local".
  const focusedExecutionHostId = getSettingsFocusedExecutionHostId(settings)
  const localFallbackScope: ExecutionHostScope = isVSAgentWebMode()
    ? focusedExecutionHostId === LOCAL_EXECUTION_HOST_ID
      ? ALL_EXECUTION_HOSTS_SCOPE
      : focusedExecutionHostId
    : LOCAL_EXECUTION_HOST_ID
  const defaultExecutionHostScope: ExecutionHostScope =
    activeExecutionHostScope ??
    (workspaceHostUnresolved ? ALL_EXECUTION_HOSTS_SCOPE : localFallbackScope)
  const [executionHostScope, setExecutionHostScope] =
    useState<ExecutionHostScope>(defaultExecutionHostScope)

  useEffect(() => {
    // Why: preserve an explicit user choice (e.g. "All") across incidental
    // rerenders, but reset to the new default once that choice no longer
    // applies to the active worktree's host.
    const allowedScopes = new Set<ExecutionHostScope>([
      localFallbackScope,
      ALL_EXECUTION_HOSTS_SCOPE,
      ...(activeExecutionHostScope ? [activeExecutionHostScope] : []),
      ...(args.availableExecutionHostScopes ?? [])
    ])
    if (!allowedScopes.has(executionHostScope)) {
      setExecutionHostScope(defaultExecutionHostScope)
      userChangedHostScopeRef.current = false
      return
    }
    if (!userChangedHostScopeRef.current && executionHostScope !== defaultExecutionHostScope) {
      setExecutionHostScope(defaultExecutionHostScope)
    }
  }, [
    activeExecutionHostScope,
    args.availableExecutionHostScopes,
    defaultExecutionHostScope,
    executionHostScope,
    localFallbackScope
  ])

  const handleExecutionHostScopeChange = useCallback(
    (nextScope: ExecutionHostScope) => {
      userChangedHostScopeRef.current = nextScope !== defaultExecutionHostScope
      setExecutionHostScope(nextScope)
    },
    [defaultExecutionHostScope]
  )

  return {
    executionHostScope,
    activeExecutionHostScope,
    onExecutionHostScopeChange: handleExecutionHostScopeChange
  }
}

export function buildRuntimeAiVaultHostScopeOptions(
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[]
): AiVaultHostScopeOption[] {
  return runtimeEnvironments.map((environment) => {
    const id = toRuntimeExecutionHostId(environment.id)
    const label = environment.name.trim() || getExecutionHostLabel(id)
    return { id, label }
  })
}

export function buildAiVaultHostScopeOptions(args: {
  activeExecutionHostScope: ExecutionHostId | null
  runtimeHostOptions: readonly AiVaultHostScopeOption[]
}): AiVaultHostScopeOption[] {
  const options: AiVaultHostScopeOption[] = []
  const seen = new Set<ExecutionHostScope>()
  const add = (option: AiVaultHostScopeOption): void => {
    if (seen.has(option.id)) {
      return
    }
    seen.add(option.id)
    options.push(option)
  }
  const activeHost = args.activeExecutionHostScope
    ? parseExecutionHostId(args.activeExecutionHostScope)
    : null

  // Why (VSAgent fork): the web client has no local execution host, so keep it
  // out of the Agents host dropdown — the runtime env is the only real host.
  if (!isVSAgentWebMode()) {
    add({ id: LOCAL_EXECUTION_HOST_ID, label: getExecutionHostLabel(LOCAL_EXECUTION_HOST_ID) })
  }
  if (activeHost?.kind === 'ssh') {
    add({ id: activeHost.id, label: getExecutionHostLabel(activeHost.id) })
  }
  for (const option of args.runtimeHostOptions) {
    add(option)
  }
  if (activeHost?.kind === 'runtime') {
    add({ id: activeHost.id, label: getExecutionHostLabel(activeHost.id) })
  }
  add({ id: ALL_EXECUTION_HOSTS_SCOPE, label: getExecutionHostLabel(ALL_EXECUTION_HOSTS_SCOPE) })

  return options
}
