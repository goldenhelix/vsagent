import { readlinkSync, rmSync, existsSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

export const SINGLETON_LOCK_KEEP_ENV = 'ORCA_SERVE_KEEP_STALE_SINGLETON_LOCK'

/**
 * Why: with userData on a persistent volume, Chromium's SingletonLock —
 * a symlink to `<hostname>-<pid>` — survives container restarts. Chromium
 * self-heals a stale lock only when the recorded hostname matches the current
 * one; a fresh container gets a NEW hostname, so the old lock reads as
 * "profile in use on another computer" and requestSingleInstanceLock() fails.
 * The failure then surfaces as a confusing X11/ozone crash (exit 133) because
 * display setup never runs for lockless launches.
 *
 * This reclaims the lock before acquisition when the holder is provably
 * unreachable. It never touches a lock whose holder may be alive, so real
 * multi-instance protection is preserved: same-hostname locks are only
 * reclaimed when the pid is dead, and foreign-hostname locks only when the
 * socket target is gone or the pid is dead in our namespace.
 */
export function reclaimStaleSingletonLock(options: {
  userDataPath: string
  isServeMode: boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  hostname?: string
  isPidAlive?: (pid: number) => boolean
}): { reclaimed: boolean; reason: string } {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (!options.isServeMode || platform !== 'linux') {
    return { reclaimed: false, reason: 'not-serve-linux' }
  }
  if (env[SINGLETON_LOCK_KEEP_ENV] === '1') {
    return { reclaimed: false, reason: 'opt-out-env' }
  }

  const lockPath = join(options.userDataPath, 'SingletonLock')
  let target: string
  try {
    target = readlinkSync(lockPath)
  } catch {
    // ENOENT (no lock) or EINVAL (not a symlink — Chromium recovers those
    // itself); nothing for us to do.
    return { reclaimed: false, reason: 'no-lock' }
  }

  // Lock target is `<hostname>-<pid>`; hostnames may contain dashes, so split
  // on the LAST dash.
  const separator = target.lastIndexOf('-')
  const holderHost = separator > 0 ? target.slice(0, separator) : ''
  const holderPid = separator > 0 ? Number(target.slice(separator + 1)) : Number.NaN
  if (!holderHost || !Number.isInteger(holderPid) || holderPid <= 0) {
    // Unparseable target — Chromium unlinks bogus locks itself.
    return { reclaimed: false, reason: 'unparseable-lock' }
  }

  const isPidAlive =
    options.isPidAlive ??
    ((pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM means the pid exists but is owned by another user — alive.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    })

  const currentHost = options.hostname ?? osHostname()
  let stale = false
  let reason = ''
  if (holderHost === currentHost) {
    if (isPidAlive(holderPid)) {
      return { reclaimed: false, reason: 'holder-alive' }
    }
    stale = true
    reason = `same host, pid ${holderPid} dead`
  } else {
    // Foreign hostname (the prior-container case). Reclaim only when the
    // holder is provably unreachable: its socket target no longer exists
    // (fresh containers wipe /tmp/scoped_dir*) or the pid is dead here.
    const socketGone = !singletonSocketTargetExists(options.userDataPath)
    if (socketGone || !isPidAlive(holderPid)) {
      stale = true
      reason = `foreign host ${holderHost}, ${socketGone ? 'socket target gone' : `pid ${holderPid} dead`}`
    } else {
      return { reclaimed: false, reason: 'foreign-holder-maybe-alive' }
    }
  }

  if (!stale) {
    return { reclaimed: false, reason: 'not-stale' }
  }

  // Order matters: remove the lock FIRST. If we crash mid-reclaim the next
  // boot sees no lock and proceeds; removing the socket first but leaving the
  // lock would reproduce the refusal we are fixing.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      rmSync(join(options.userDataPath, name), { force: true })
    } catch {
      // Best effort; Chromium tolerates partial cleanup once the lock is gone.
    }
  }
  console.warn(
    `[serve] Reclaimed stale single-instance lock (holder ${holderHost}-${holderPid}; ${reason}).`
  )
  return { reclaimed: true, reason }
}

function singletonSocketTargetExists(userDataPath: string): boolean {
  try {
    const socketTarget = readlinkSync(join(userDataPath, 'SingletonSocket'))
    return existsSync(socketTarget)
  } catch {
    return false
  }
}
