import { afterEach, describe, expect, it, vi } from 'vitest'
import { printHelp } from './help'
import { COMMAND_SPECS } from './specs'

function captureRootHelp(): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    printHelp(COMMAND_SPECS)
    return spy.mock.calls.map((call) => String(call[0])).join('\n')
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('root help text', () => {
  // Why: ROOT_HELP_TEXT is hand-maintained (not generated from specs), so a
  // top-level command can ship without being listed. Lock in the Startup-tier
  // commands operators discover from `orca --help`.
  it('lists every Startup-tier command', () => {
    const help = captureRootHelp()
    for (const command of ['open', 'serve', 'status', 'pairing-url']) {
      expect(help).toContain(command)
      // The command must also have a real spec backing it.
      expect(COMMAND_SPECS.some((spec) => spec.path.join(' ') === command)).toBe(true)
    }
  })

  it('documents pairing-url with its own command help', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'pairing-url')
    expect(spec).toBeDefined()
    expect(spec?.examples?.length ?? 0).toBeGreaterThan(0)
  })
})
