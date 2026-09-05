import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// Why (VSAgent fork): the tarball serve is unpackaged, so upstream's dev
// branch routes its state to `<appData>/orca-dev` while the plain-node CLI
// resolves `<appData>/orca` — external shells can't find the running server.
// A VSAgent INSTALL (identified by the VERSION marker the release tarball
// stages at the app root) gets one stable, documented dir instead:
//   VSAGENT_DATA_DIR (absolute) > <appData>/vsagent
// Dev checkouts and upstream tests have no VERSION marker, so their
// orca-dev / E2E semantics are untouched.

/** Longest safe `<dir>/daemon/daemon-v*.sock` prefix. Linux sun_path is 108
 *  bytes (incl. NUL); leave headroom for the socket filename. */
const MAX_SAFE_USER_DATA_PATH_BYTES = 80

export function resolveVSAgentUserDataDir(options: {
  appPath: string
  appDataPath: string
  env?: NodeJS.ProcessEnv
}): string | null {
  const env = options.env ?? process.env
  const override = env.VSAGENT_DATA_DIR?.trim()
  if (override) {
    if (!isAbsolute(override)) {
      console.warn(`[serve] VSAGENT_DATA_DIR must be an absolute path; ignoring "${override}".`)
    } else {
      warnOnLongUserDataPath(override)
      return override
    }
  }
  if (!runningFromVSAgentInstall(options.appPath)) {
    return null
  }
  const installDefault = join(options.appDataPath, 'vsagent')
  warnOnLongUserDataPath(installDefault)
  return installDefault
}

export function runningFromVSAgentInstall(appPath: string): boolean {
  return existsSync(join(appPath, 'VERSION'))
}

// Why: a userData path deep enough that `<dir>/daemon/daemon-v<N>.sock`
// exceeds the 107-byte sun_path limit silently breaks the daemon and the unix
// RPC transport (listen EINVAL) — serve never reaches its ready line.
// Container-style nested paths hit this easily, so warn loudly up front.
export function warnOnLongUserDataPath(dir: string): void {
  if (Buffer.byteLength(dir, 'utf8') > MAX_SAFE_USER_DATA_PATH_BYTES) {
    console.warn(
      `[serve] Data dir path is ${Buffer.byteLength(dir, 'utf8')} bytes long (${dir}); ` +
        'unix sockets under it may exceed the 107-byte sun_path limit and fail with EINVAL. ' +
        'Use a shorter VSAGENT_DATA_DIR.'
    )
  }
}
