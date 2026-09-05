import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('packaged Windows PTY native capability routing', () => {
  it('keeps the native probe event-based, scoped, and runnable in packaged Node mode', () => {
    const driver = readFileSync('tests/tools/windows-pty-native-capability-smoke/run.mjs', 'utf8')
    const probe = readFileSync(
      'tests/tools/windows-pty-native-capability-smoke/packaged-node-pty-capability-probe.cjs',
      'utf8'
    )
    const source = `${driver}\n${probe}`

    expect(driver).toContain("ELECTRON_RUN_AS_NODE: '1'")
    expect(source).not.toMatch(/\b(?:sleep|tasklist|taskkill)\b/i)
    expect(source).not.toContain('maxRetries')
    expect(source).not.toContain('retryDelay')
    expect(source).not.toContain("from 'node:child_process'")
    expect(source).not.toContain("require('node:child_process')")
    expect(probe).toContain("'System32', 'wscript.exe'")
    expect(probe).toContain('real-orca-detached-launcher.vbs')
    expect(probe).not.toMatch(/cmd\.exe|start "" \/b/i)
    expect(probe).toContain('native.terminateJob(target._pty, target.pid)')
  })
})
