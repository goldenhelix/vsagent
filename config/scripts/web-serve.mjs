#!/usr/bin/env node
// Launches the Orca backend in headless web-mode and serves the renderer
// bundle through the gateway. Intended for shipping Orca as a hosted
// service: a single command stands up everything a browser client needs.
//
// Environment variables (legacy ORCA_WEB_* names still accepted):
//   VSAGENT_PORT           HTTP port to serve the bundle + WS on (default 8080)
//   VSAGENT_HOST           Bind address (default 0.0.0.0). Set to 127.0.0.1
//                          when running behind a reverse proxy on the same host.
//   VSAGENT_TOKEN          Optional shared bearer token (PoC auth)
//   VSAGENT_PICKER_ROOTS   Colon-separated roots the folder picker is allowed
//                          to traverse (defaults to $HOME)
//   VSAGENT_USER_DATA_PATH Backend data dir (default: ~/.vsagent)
//
// Defines internally:
//   ORCA_WEB_GATEWAY=1
//   ORCA_WEB_HEADLESS=1
//   ORCA_WEB_ROOT=<repoRoot>/out/web

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const electronPath = require('electron')
const wrapperPath = path.join(repoRoot, 'config/scripts/web-cjs-wrapper.cjs')
const webRoot = path.join(repoRoot, 'out/web')
const mainEntry = path.join(repoRoot, 'out/main/index.js')

function ensure(condition, message) {
  if (!condition) {
    console.error(`[web-serve] ${message}`)
    process.exit(1)
  }
}

ensure(existsSync(webRoot), `web bundle not found at ${webRoot}. Run \`pnpm web:build\` first.`)
ensure(
  existsSync(mainEntry),
  `main bundle not found at ${mainEntry}. Run \`pnpm build:electron-vite\` first.`
)

const userDataPath =
  process.env.VSAGENT_USER_DATA_PATH ||
  process.env.ORCA_USER_DATA_PATH ||
  path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.vsagent')
mkdirSync(userDataPath, { recursive: true })

// Why: a crashed previous run leaves stale singleton-lock and Unix-socket
// files that make Electron fail-and-shutdown immediately on the next boot
// (FATAL: Failed to shutdown / SIGTRAP). Sweep them before launch so the
// operator doesn't have to reach into the data dir after a crash.
const staleFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'orca-runtime.json']
for (const name of staleFiles) {
  const p = path.join(userDataPath, name)
  if (existsSync(p)) {
    try {
      unlinkSync(p)
      console.log(`[web-serve] cleaned stale ${name}`)
    } catch (err) {
      console.warn(`[web-serve] could not remove stale ${name}:`, err?.message ?? err)
    }
  }
}
try {
  for (const entry of readdirSync(userDataPath)) {
    if (entry.endsWith('.sock')) {
      try {
        unlinkSync(path.join(userDataPath, entry))
        console.log(`[web-serve] cleaned stale socket ${entry}`)
      } catch {
        // Why: harmless — daemon-init can usually re-bind even with a
        // stale socket file present.
      }
    }
  }
} catch {
  // userDataPath was just created; no entries to walk.
}

// Why: resolve canonical VSAGENT_* names first, fall back to legacy ORCA_WEB_*,
// then set BOTH on the spawned env so older code paths (and the main process's
// own legacy fallback) see the same value. Keeps the gateway-side rename safe
// without forcing operators to flip their env at the same time.
const PORT = process.env.VSAGENT_PORT || process.env.ORCA_WEB_PORT || '8080'
const HOST = process.env.VSAGENT_HOST || process.env.ORCA_WEB_HOST || '0.0.0.0'
const TOKEN = process.env.VSAGENT_TOKEN || process.env.ORCA_WEB_TOKEN || ''
const PICKER_ROOTS =
  process.env.VSAGENT_PICKER_ROOTS || process.env.ORCA_WEB_PICKER_ROOTS || ''

const env = {
  ...process.env,
  ORCA_WEB_GATEWAY: '1',
  ORCA_WEB_HEADLESS: '1',
  ORCA_WEB_ROOT: webRoot,
  VSAGENT_WEB_ROOT: webRoot,
  VSAGENT_PORT: PORT,
  ORCA_WEB_PORT: PORT,
  VSAGENT_HOST: HOST,
  ORCA_WEB_HOST: HOST,
  ...(TOKEN ? { VSAGENT_TOKEN: TOKEN, ORCA_WEB_TOKEN: TOKEN } : {}),
  ...(PICKER_ROOTS
    ? { VSAGENT_PICKER_ROOTS: PICKER_ROOTS, ORCA_WEB_PICKER_ROOTS: PICKER_ROOTS }
    : {}),
  VSAGENT_USER_DATA_PATH: userDataPath,
  ORCA_USER_DATA_PATH: userDataPath,
  ORCA_DEV_USER_DATA_PATH: userDataPath,
  // Why: in headless mode the operator launches us via the CJS wrapper
  // (web-cjs-wrapper.cjs), so app.getAppPath() resolves to the wrapper's
  // directory rather than the repo root and the PTY-daemon entry resolves
  // to a non-existent path. Pin the entry explicitly so the daemon
  // forks correctly.
  ORCA_DAEMON_ENTRY: path.join(repoRoot, 'out/main/daemon-entry.js')
}

const args = [
  '--no-sandbox',
  // Why: --headless=new uses Chromium's new headless mode, which avoids
  // creating any GTK widgets — so backend boots on display-less Linux
  // hosts without xvfb. Note: BrowserWindow is never created at all in
  // ORCA_WEB_HEADLESS mode (see web-gateway/headless-window.ts).
  '--headless=new',
  // Why: starting with Electron 41 the new headless mode alone is not
  // enough — Ozone still tries to bind a platform backend at process
  // init and SIGSEGVs immediately when no X server / display is present.
  // Pinning Ozone to its headless backend keeps the GPU-less boot path
  // happy on bare Linux servers (CI, bastion hosts, container images).
  '--ozone-platform=headless',
  '--disable-gpu',
  '--enable-logging=stderr',
  wrapperPath
]

// Why: log to BOTH stdout (operator's terminal) AND a rotating file under
// the data dir. After a crash you can inspect the file to see the trail of
// IPC calls that led up to it. Keep the most recent prior log as `.prev`.
const logDir = path.join(userDataPath, 'logs')
mkdirSync(logDir, { recursive: true })
const logPath = path.join(logDir, 'web-serve.log')
const prevLogPath = path.join(logDir, 'web-serve.prev.log')
try {
  if (existsSync(logPath)) {
    const size = statSync(logPath).size
    if (size > 0) renameSync(logPath, prevLogPath)
  }
} catch {
  // Why: a rotate failure should not block startup; the log just appends.
}
const logStream = createWriteStream(logPath, { flags: 'a' })

const teeStdout = (chunk) => {
  process.stdout.write(chunk)
  logStream.write(chunk)
}
const teeStderr = (chunk) => {
  process.stderr.write(chunk)
  logStream.write(chunk)
}

console.log(`[web-serve] starting on http://${HOST}:${PORT}`)
console.log(`[web-serve] data dir: ${userDataPath}`)
console.log(`[web-serve] web root: ${webRoot}`)
console.log(`[web-serve] log file: ${logPath}`)
logStream.write(`\n=== [web-serve] launching at ${new Date().toISOString()} ===\n`)

const child = spawn(electronPath, args, { env, stdio: ['inherit', 'pipe', 'pipe'] })
child.stdout?.on('data', teeStdout)
child.stderr?.on('data', teeStderr)
child.on('exit', (code, signal) => {
  const msg = `[web-serve] backend exited code=${code} signal=${signal}`
  console.log(msg)
  logStream.write(msg + '\n')
  logStream.end(() => process.exit(code ?? 0))
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig)
  })
}
