import { Server } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { DashboardCardHostKind } from '../../../../shared/dashboard-snapshot'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

type DashboardHostBadgeProps = {
  hostKind?: DashboardCardHostKind
  executionHostId?: ExecutionHostId
  hostLabel?: string
  /** Why (VSAgent fork): with several paired servers in one web client, an icon
   *  and a hover tooltip cannot say WHICH server an agent is running on. */
  showLabel?: boolean
  keyboardFocusable?: boolean
  className?: string
  iconClassName?: string
}

function fallbackHostLabel(executionHostId: ExecutionHostId | undefined): string | null {
  const parsed = parseExecutionHostId(executionHostId)
  if (parsed?.kind === 'ssh') {
    return parsed.targetId
  }
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId
  }
  return null
}

export function dashboardHostTooltipLabel({
  hostKind,
  executionHostId,
  hostLabel
}: Pick<DashboardHostBadgeProps, 'hostKind' | 'executionHostId' | 'hostLabel'>): string | null {
  if (hostKind !== 'ssh' && hostKind !== 'remote') {
    return null
  }
  const label = hostLabel?.trim() || fallbackHostLabel(executionHostId)
  if (hostKind === 'ssh') {
    return label
      ? translate('dashboardPopout.host.sshNamed', 'SSH host · {{host}}', { host: label })
      : translate('dashboardPopout.host.ssh', 'SSH host')
  }
  return label
    ? translate('dashboardPopout.host.remoteNamed', 'Remote Orca host · {{host}}', { host: label })
    : translate('dashboardPopout.host.remote', 'Remote Orca host')
}

export function DashboardHostBadge({
  hostKind,
  executionHostId,
  hostLabel,
  showLabel = false,
  keyboardFocusable = false,
  className,
  iconClassName
}: DashboardHostBadgeProps): React.JSX.Element | null {
  const tooltipLabel = dashboardHostTooltipLabel({ hostKind, executionHostId, hostLabel })
  if (!tooltipLabel) {
    return null
  }
  const visibleLabel = showLabel ? hostLabel?.trim() || fallbackHostLabel(executionHostId) : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 items-center justify-center text-muted-foreground',
            visibleLabel && 'shrink px-1',
            keyboardFocusable &&
              'pointer-events-auto focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            className
          )}
          data-dashboard-host-badge={hostKind}
          aria-label={tooltipLabel}
          tabIndex={keyboardFocusable ? 0 : undefined}
        >
          <Server className={cn('size-3', iconClassName)} aria-hidden />
          {visibleLabel ? (
            <span className="ml-1 max-w-[7rem] truncate text-[11px] font-normal">
              {visibleLabel}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  )
}
