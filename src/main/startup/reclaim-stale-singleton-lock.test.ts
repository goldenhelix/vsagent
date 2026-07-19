import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reclaimStaleSingletonLock, SINGLETON_LOCK_KEEP_ENV } from './reclaim-stale-singleton-lock'

let dirs: string[] = []

function makeUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-singleton-'))
  dirs.push(dir)
  return dir
}

function forgeLock(
  userData: string,
  target: string,
  options: { socketTarget?: string | null } = {}
): void {
  symlinkSync(target, join(userData, 'SingletonLock'))
  if (options.socketTarget !== null) {
    const socketTarget =
      options.socketTarget ?? join(userData, 'gone-scoped-dir', 'SingletonSocket')
    symlinkSync(socketTarget, join(userData, 'SingletonSocket'))
  }
  writeFileSync(join(userData, 'SingletonCookie'), '1234567890')
}

function symlinkExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  dirs = []
})

describe('reclaimStaleSingletonLock', () => {
  const base = { isServeMode: true, platform: 'linux' as const, hostname: 'container-b' }

  it('is a no-op outside serve mode and off Linux', () => {
    const userData = makeUserData()
    forgeLock(userData, 'container-a-424242')
    expect(
      reclaimStaleSingletonLock({ ...base, userDataPath: userData, isServeMode: false }).reclaimed
    ).toBe(false)
    expect(
      reclaimStaleSingletonLock({ ...base, userDataPath: userData, platform: 'darwin' }).reclaimed
    ).toBe(false)
    expect(existsSync(join(userData, 'SingletonCookie'))).toBe(true)
  })

  it('is a no-op when the opt-out env is set', () => {
    const userData = makeUserData()
    forgeLock(userData, 'container-a-424242')
    const result = reclaimStaleSingletonLock({
      ...base,
      userDataPath: userData,
      env: { [SINGLETON_LOCK_KEEP_ENV]: '1' }
    })
    expect(result.reclaimed).toBe(false)
    expect(result.reason).toBe('opt-out-env')
  })

  it('reclaims a foreign-hostname lock whose socket target is gone (container restart)', () => {
    const userData = makeUserData()
    // Socket symlink points at a wiped /tmp scoped dir — target does not exist.
    forgeLock(userData, 'container-a-424242')
    const result = reclaimStaleSingletonLock({
      ...base,
      userDataPath: userData,
      isPidAlive: () => true // pid table can lie across namespaces; socket decides
    })
    expect(result.reclaimed).toBe(true)
    expect(symlinkExists(join(userData, 'SingletonLock'))).toBe(false)
    expect(symlinkExists(join(userData, 'SingletonSocket'))).toBe(false)
    expect(existsSync(join(userData, 'SingletonCookie'))).toBe(false)
  })

  it('leaves a foreign-hostname lock whose socket target exists and pid is alive', () => {
    const userData = makeUserData()
    const liveDir = join(userData, 'live-scoped-dir')
    mkdirSync(liveDir)
    const liveSocketTarget = join(liveDir, 'SingletonSocket')
    writeFileSync(liveSocketTarget, '')
    forgeLock(userData, 'container-a-424242', { socketTarget: liveSocketTarget })
    const result = reclaimStaleSingletonLock({
      ...base,
      userDataPath: userData,
      isPidAlive: () => true
    })
    expect(result.reclaimed).toBe(false)
    expect(result.reason).toBe('foreign-holder-maybe-alive')
    expect(symlinkExists(join(userData, 'SingletonLock'))).toBe(true)
  })

  it('reclaims a same-hostname lock with a dead pid and preserves a live one', () => {
    const dead = makeUserData()
    forgeLock(dead, 'container-b-424242')
    expect(
      reclaimStaleSingletonLock({
        ...base,
        userDataPath: dead,
        isPidAlive: () => false
      }).reclaimed
    ).toBe(true)

    const alive = makeUserData()
    forgeLock(alive, 'container-b-424242')
    const kept = reclaimStaleSingletonLock({
      ...base,
      userDataPath: alive,
      isPidAlive: () => true
    })
    expect(kept.reclaimed).toBe(false)
    expect(kept.reason).toBe('holder-alive')
    expect(symlinkExists(join(alive, 'SingletonLock'))).toBe(true)
  })

  it('parses hostnames containing dashes (splits on the LAST dash)', () => {
    const userData = makeUserData()
    forgeLock(userData, 'my-multi-dash-host-99999')
    const result = reclaimStaleSingletonLock({
      ...base,
      hostname: 'my-multi-dash-host',
      userDataPath: userData,
      isPidAlive: (pid) => {
        expect(pid).toBe(99999)
        return false
      }
    })
    expect(result.reclaimed).toBe(true)
  })

  it('no-ops when there is no lock or the target is unparseable', () => {
    const empty = makeUserData()
    expect(reclaimStaleSingletonLock({ ...base, userDataPath: empty }).reason).toBe('no-lock')

    const bogus = makeUserData()
    symlinkSync('garbage', join(bogus, 'SingletonLock'))
    expect(reclaimStaleSingletonLock({ ...base, userDataPath: bogus }).reason).toBe(
      'unparseable-lock'
    )
  })
})
