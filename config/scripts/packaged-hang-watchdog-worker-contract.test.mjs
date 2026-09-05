import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('packaged hang watchdog worker contract', () => {
  it('launches the packaged worker sandboxed on Linux with a bounded timeout', () => {
    const smokeSource = readFileSync(
      'config/scripts/smoke-packaged-hang-watchdog-worker.mjs',
      'utf8'
    )

    expect(smokeSource).toContain(
      "process.platform === 'linux' ? ['--no-sandbox', launcherDir] : [launcherDir]"
    )
    expect(smokeSource).toContain('const LAUNCH_TIMEOUT_MS = 30_000')
    expect(smokeSource).toContain('timeout: LAUNCH_TIMEOUT_MS')
  })

  // Why: Electron ignores process.exitCode, so the gate needs app.exit plus a stdout assertion.
  it('fails the smoke when the packaged worker never reports success', () => {
    const smokeSource = readFileSync(
      'config/scripts/smoke-packaged-hang-watchdog-worker.mjs',
      'utf8'
    )

    expect(smokeSource).toContain('app.exit(1)')
    expect(smokeSource).not.toContain('app.quit()')
    expect(smokeSource).toContain('if (!result.stdout.includes(SUCCESS_LINE))')
  })
})
