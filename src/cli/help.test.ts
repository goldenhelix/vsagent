import { describe, expect, it } from 'vitest'
import { ROOT_HELP_TEXT_PRIMARY } from './root-help-text-primary'
import { ROOT_HELP_TEXT_SECONDARY } from './root-help-text-secondary'
import { COMMAND_SPECS } from './specs'

// Why: the root help text is hand-maintained, not generated from COMMAND_SPECS, so a top-level
// command can ship without ever being listed in `orca --help`.
const STARTUP_TIER_COMMANDS = ['open', 'serve', 'status', 'pairing-url']

function startupSection(): string {
  const lines = ROOT_HELP_TEXT_PRIMARY.split('\n')
  const start = lines.indexOf('Startup:')
  expect(start).toBeGreaterThan(-1)
  const end = lines.indexOf('', start)
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

describe('root help text', () => {
  it('lists every Startup-tier command under the Startup heading', () => {
    const section = startupSection()
    for (const command of STARTUP_TIER_COMMANDS) {
      expect(section).toContain(`  ${command} `)
    }
  })

  it('backs every Startup-tier command with a real spec', () => {
    for (const command of STARTUP_TIER_COMMANDS) {
      expect(COMMAND_SPECS.some((spec) => spec.path.join(' ') === command)).toBe(true)
    }
  })

  it('shows each Startup-tier command in the Common Commands usage block', () => {
    for (const command of STARTUP_TIER_COMMANDS) {
      expect(ROOT_HELP_TEXT_SECONDARY).toContain(`  orca ${command} `)
    }
  })

  it('documents pairing-url with usage, notes and examples', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'pairing-url')
    expect(spec?.usage).toBe('orca pairing-url [--address <host>] [--rotate] [--json]')
    expect(spec?.allowedFlags).toEqual(expect.arrayContaining(['address', 'rotate', 'json']))
    expect(spec?.examples?.length ?? 0).toBeGreaterThan(0)
    expect(spec?.notes?.length ?? 0).toBeGreaterThan(0)
  })
})
