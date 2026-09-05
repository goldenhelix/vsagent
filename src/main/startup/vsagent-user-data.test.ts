import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveVSAgentUserDataDir, runningFromVSAgentInstall } from './vsagent-user-data'

let dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vsagent-userdata-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  dirs = []
})

describe('resolveVSAgentUserDataDir', () => {
  it('returns null for a dev checkout (no VERSION marker, no env)', () => {
    const appPath = makeDir()
    expect(
      resolveVSAgentUserDataDir({ appPath, appDataPath: '/home/u/.config', env: {} })
    ).toBeNull()
  })

  it('resolves <appData>/vsagent for a tarball install (VERSION marker present)', () => {
    const appPath = makeDir()
    writeFileSync(join(appPath, 'VERSION'), '0.6.1\n')
    expect(resolveVSAgentUserDataDir({ appPath, appDataPath: '/home/u/.config', env: {} })).toBe(
      join('/home/u/.config', 'vsagent')
    )
  })

  it('VSAGENT_DATA_DIR (absolute) wins even without the marker', () => {
    const appPath = makeDir()
    expect(
      resolveVSAgentUserDataDir({
        appPath,
        appDataPath: '/home/u/.config',
        env: { VSAGENT_DATA_DIR: '/srv/vsagent-data' }
      })
    ).toBe('/srv/vsagent-data')
  })

  it('ignores a relative VSAGENT_DATA_DIR with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appPath = makeDir()
    expect(
      resolveVSAgentUserDataDir({
        appPath,
        appDataPath: '/home/u/.config',
        env: { VSAGENT_DATA_DIR: 'relative/dir' }
      })
    ).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('warns when the resolved dir risks the unix-socket sun_path limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appPath = makeDir()
    const longDir = `/srv/${'x'.repeat(120)}`
    resolveVSAgentUserDataDir({
      appPath,
      appDataPath: '/home/u/.config',
      env: { VSAGENT_DATA_DIR: longDir }
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sun_path'))
    warn.mockRestore()
  })
})

describe('runningFromVSAgentInstall', () => {
  it('keys off the VERSION marker at the app root', () => {
    const appPath = makeDir()
    expect(runningFromVSAgentInstall(appPath)).toBe(false)
    writeFileSync(join(appPath, 'VERSION'), '0.6.1\n')
    expect(runningFromVSAgentInstall(appPath)).toBe(true)
  })
})
