import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why source text: both entrypoints boot the real process on import, so the only way to pin
// "the alias pass runs before anything reads the environment" is to read where the call sits.
// It has to hold in BOTH: `orca serve` goes through the CLI, but a systemd unit or
// `scripts/vsagent-serve` launches Electron directly and never touches the CLI entry.
function readEntry(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('VSAGENT_* env aliases are applied at every process entry', () => {
  it('applies them in the main process before startup preflight reads the environment', () => {
    const source = readEntry('src/main/index.ts')
    expect(source).toContain(
      "import { applyVSAgentEnvAliases } from '../shared/vsagent-env-aliases'"
    )
    const applyIndex = source.indexOf('\napplyVSAgentEnvAliases()')
    const preflightIndex = source.indexOf('runMainProcessPreflight({')
    expect(applyIndex).toBeGreaterThanOrEqual(0)
    expect(preflightIndex).toBeGreaterThan(applyIndex)
  })

  it('applies them in the CLI process before main() runs', () => {
    const source = readEntry('src/cli/index.ts')
    const applyIndex = source.indexOf('\napplyVSAgentEnvAliases()')
    const mainIndex = source.indexOf('export async function main(')
    expect(applyIndex).toBeGreaterThanOrEqual(0)
    expect(mainIndex).toBeGreaterThan(applyIndex)
  })
})
