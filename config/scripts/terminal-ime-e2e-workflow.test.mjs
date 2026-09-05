import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')

describe('terminal IME e2e workflow', () => {
  it('keeps IBus lifecycle scoped to owned processes', () => {
    const runner = readFileSync(
      join(projectDir, 'config/scripts/run-terminal-ibus-hangul-e2e.mjs'),
      'utf8'
    )

    expect(runner).toContain(
      "['--xim', '--verbose', '--panel=disable', '--emoji-extension=disable']"
    )
    expect(runner).toContain("spawn('xfwm4', ['--compositor=off']")
    expect(runner).toContain("['initial-input-mode', 'hangul']")
    expect(runner).toContain("['hangul-keyboard', '2']")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGTERM')")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGKILL')")
    expect(runner).toContain('const killDeadline = Date.now() + processKillTimeoutMs')
    expect(runner).toMatch(
      /'test:e2e:headful',\s*'--workers=1',\s*'--',\s*'tests\/e2e\/terminal-ibus-hangul-native\.spec\.ts'/
    )
    expect(runner).not.toContain("'--replace'")
    expect(runner).not.toContain('killall')
    expect(runner).not.toContain('pkill')
  })

  it('bounds blocking native input commands', () => {
    const nativeSpec = readFileSync(
      join(projectDir, 'tests/e2e/terminal-ibus-hangul-native.spec.ts'),
      'utf8'
    )

    expect(nativeSpec.match(/timeout: NATIVE_COMMAND_TIMEOUT_MS/g)).toHaveLength(3)
  })
})
