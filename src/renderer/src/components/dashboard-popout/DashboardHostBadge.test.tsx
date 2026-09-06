// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DashboardHostBadge } from './DashboardHostBadge'

afterEach(cleanup)

describe('DashboardHostBadge', () => {
  it('names a saved SSH host in its focusable tooltip', async () => {
    render(
      <TooltipProvider>
        <DashboardHostBadge
          hostKind="ssh"
          executionHostId="ssh:opaque-target"
          hostLabel="openclaw"
          keyboardFocusable
        />
      </TooltipProvider>
    )

    const badge = screen.getByLabelText('SSH host · openclaw')
    expect(badge).toHaveAttribute('data-dashboard-host-badge', 'ssh')
    expect(badge.querySelector('.lucide-server')).toBeInTheDocument()

    fireEvent.focus(badge)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('SSH host · openclaw')
  })

  it('distinguishes paired Orca hosts and omits local hosts', () => {
    const { rerender } = render(
      <TooltipProvider>
        <DashboardHostBadge
          hostKind="remote"
          executionHostId="runtime:server-1"
          hostLabel="Build Mac"
        />
      </TooltipProvider>
    )

    const badge = screen.getByLabelText('Remote Orca host · Build Mac')
    expect(badge).toHaveAttribute('data-dashboard-host-badge', 'remote')
    expect(badge.querySelector('.lucide-server')).toBeInTheDocument()

    rerender(
      <TooltipProvider>
        <DashboardHostBadge hostKind="local" executionHostId="local" />
      </TooltipProvider>
    )
    expect(screen.queryByLabelText(/host/i)).not.toBeInTheDocument()
  })

  // Why (VSAgent fork): with several paired servers in one web client, the icon
  // and its hover tooltip cannot say which server an agent belongs to.
  it('names the host on the badge itself when asked', () => {
    const { rerender } = render(
      <TooltipProvider>
        <DashboardHostBadge
          hostKind="remote"
          executionHostId="runtime:server-1"
          hostLabel="Build Mac"
          showLabel
        />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Remote Orca host · Build Mac')).toHaveTextContent('Build Mac')

    // Falls back to the environment id when the server has no saved name.
    rerender(
      <TooltipProvider>
        <DashboardHostBadge hostKind="remote" executionHostId="runtime:server-1" showLabel />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Remote Orca host · server-1')).toHaveTextContent('server-1')

    // Default stays icon-only, so desktop and single-server web are unchanged.
    rerender(
      <TooltipProvider>
        <DashboardHostBadge
          hostKind="remote"
          executionHostId="runtime:server-1"
          hostLabel="Build Mac"
        />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Remote Orca host · Build Mac')).not.toHaveTextContent('Build Mac')
  })
})
