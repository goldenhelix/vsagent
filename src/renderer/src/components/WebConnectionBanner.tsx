// Web-mode connection banner. Shown when the WebSocket bridge to the Orca
// backend drops, hidden once it reconnects. The bridge itself (in
// src/web-bridge/ws-bridge.ts) handles reconnect with exponential backoff
// and exposes the state on `window.orcaWeb`. In the desktop Electron build
// `window.orcaWeb` is undefined and this component renders nothing.
import { useEffect, useState } from 'react'
import { isWebMode } from '@/lib/runtime-flavor'

type ConnectionState = 'connecting' | 'connected' | 'disconnected'

type OrcaWebGlobal = {
  onConnectionChange: (fn: (state: ConnectionState) => void) => () => void
  getConnectionState: () => ConnectionState
}

export function WebConnectionBanner(): React.JSX.Element | null {
  const [state, setState] = useState<ConnectionState>('connecting')

  useEffect(() => {
    if (!isWebMode()) return
    const w = window as unknown as { orcaWeb?: OrcaWebGlobal }
    const api = w.orcaWeb
    if (!api) return
    return api.onConnectionChange(setState)
  }, [])

  if (!isWebMode()) return null
  if (state === 'connected') return null
  return (
    <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[200] rounded-md border border-border bg-popover px-3 py-1.5 text-xs shadow-md">
      <span className="text-muted-foreground">
        {state === 'connecting' ? 'Connecting to VSAgent server…' : 'Reconnecting to VSAgent server…'}
      </span>
    </div>
  )
}
