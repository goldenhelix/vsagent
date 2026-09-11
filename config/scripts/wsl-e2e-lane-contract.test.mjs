import { describe, expect, it } from 'vitest'
import { hasWslSourceChange, selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

// Why (VSAgent fork): upstream's pr.yml is deleted here, so the assertions
// wiring the reusable WSL lane to it are gone; the source routing still ships.
describe('real WSL terminal lane', () => {
  it.each([
    'config/scripts/verify-wsl-e2e-participation.mjs',
    'config/scripts/verify-playwright-participation.mjs',
    'src/main/wsl-availability.ts',
    'src/main/wsl/wsl-runner.ts',
    'src/main/pty/wsl-orca-env.ts',
    'src/shared/wsl-login-shell-command.ts',
    'src/shared/windows-terminal-shell.ts',
    'tests/e2e/helpers/wsl-golden-stub-agent.ts',
    'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
    'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts',
    '.github/actions/setup-wsl-test-runtime/setup.ps1',
    '.github/workflows/windows-wsl-e2e.yml'
  ])('routes %s to both WSL sentinels', (path) => {
    expect(hasWslSourceChange([path])).toBe(true)
    expect(selectPrE2eSpecs([path])).toEqual(
      expect.arrayContaining([
        'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
        'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts'
      ])
    )
  })

  it.each([
    'docs/reference/wsl-command-execution.md',
    'src/main/wsl-availability.test.ts',
    'src/main/ssh/connection.ts'
  ])('excludes unrelated or unit-only change %s', (path) => {
    expect(hasWslSourceChange([path])).toBe(false)
  })
})
