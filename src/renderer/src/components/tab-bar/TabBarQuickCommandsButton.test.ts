import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { resolveQuickCommandDefaultHostId } from './TabBarQuickCommandsButton'

const runtime = 'runtime:serve' as ExecutionHostId

describe('resolveQuickCommandDefaultHostId', () => {
  it('prefers the workspace host, then the first host that owns commands', () => {
    expect(
      resolveQuickCommandDefaultHostId(runtime, [{ hostId: 'local' }, { hostId: runtime }])
    ).toBe(runtime)
    expect(resolveQuickCommandDefaultHostId('local', [{ hostId: runtime }])).toBe(runtime)
  })

  // Why (VSAgent fork): the web client has no local host, so the list is empty
  // until the runtime reports quick-command support — reading hosts[0] there
  // crashed the whole workbench on selecting a project.
  it('falls back to the workspace host when no host is available yet', () => {
    expect(resolveQuickCommandDefaultHostId(runtime, [])).toBe(runtime)
    expect(resolveQuickCommandDefaultHostId('local', [])).toBe('local')
  })
})
