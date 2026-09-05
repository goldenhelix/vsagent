#!/usr/bin/env node
// Boots a packaged VSAgent release tarball the way an install host does and
// asserts `orca serve` actually comes up. This is the guard that 0.5.0 lacked:
// that release shipped an out/main which require()d a module we never staged,
// so the backend crash-looped before ever binding its port. Inspecting the
// bundle is not enough — only a real boot proves the whole require graph
// loads, the runtime WS server binds, and the web client is served. Run this
// against the just-built tarball in CI before publishing.
//
// Flow: extract tarball → `pnpm install --prod` → assert the production
// node-pty patch survived the install → boot scripts/vsagent-serve (the exact
// production launcher) with an isolated HOME → assert GET /web-index.html
// returns 200, the log contains the server-ready line, and the launcher
// recorded the "Web client URL" to the vsagent state file.
//
// No display flags are passed: the app's own headless fallback (or Xvfb if
// present on the runner) handles display-less Linux.
//
// Usage: node config/scripts/smoke-test-tarball.mjs [path/to/tarball.tar.gz]
//   Defaults to the newest dist/vsagent-linux-x64-*.tar.gz (excluding the
//   `latest` alias). Exits 0 on success, 1 otherwise.

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { POSTINSTALL_STAGED_SCRIPTS } from './release-tarball-staged-config.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const HOST = '127.0.0.1'
const PORT = process.env.SMOKE_PORT || '7099'
const BOOT_TIMEOUT_MS = 120_000
// A comment only config/patches/node-pty@1.1.0.patch introduces, in a lib/ file
// that ships prebuilt in the npm tarball — so its presence proves the patch was
// applied on the host, not that a build step happened to run.
const NODE_PTY_PATCH_MARKER = 'Orca: a retired master is unreachable'

function die(msg, bootLog) {
  console.error(`[smoke] FAIL: ${msg}`)
  if (bootLog) {
    console.error('[smoke] --- boot log ---')
    console.error(bootLog.trimEnd())
    console.error('[smoke] --- end boot log ---')
  }
  process.exit(1)
}
const log = (msg) => console.log(`[smoke] ${msg}`)

// Resolve the tarball to test.
let tarball = process.argv[2]
if (!tarball) {
  const distDir = path.join(repoRoot, 'dist')
  const candidates = existsSync(distDir)
    ? readdirSync(distDir)
        .filter((f) => /^vsagent-linux-x64-.*\.tar\.gz$/.test(f) && !f.includes('latest'))
        .map((f) => path.join(distDir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : []
  if (!candidates.length) {
    die('no tarball argument given and none found in dist/')
  }
  tarball = candidates[0]
}
if (!existsSync(tarball)) {
  die(`tarball not found: ${tarball}`)
}
log(`tarball: ${tarball}`)

const work = mkdtempSync(path.join(tmpdir(), 'vsagent-smoke-'))
const appDir = path.join(work, 'vsagent')
// Why: an isolated HOME keeps Electron userData / pairing state / the
// launcher's web-url state file inside the scratch dir, so the smoke run never
// collides with a real install (singleton locks) and cleanup is total.
const homeDir = path.join(work, 'home')
mkdirSync(homeDir, { recursive: true })

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    die(`${cmd} ${args.join(' ')} exited ${r.status ?? 'signal'}`)
  }
}

// Extract and sanity-check the staged layout. pnpm-workspace.yaml is in the
// list because it is the only carrier of patchedDependencies / shamefullyHoist
// / overrides since pnpm 10 — if the build script stops staging it, the install
// below still succeeds and the failure only shows up as odd runtime behaviour.
// The postinstall's import closure comes from the same list the builder stages
// from, so a helper dropped there fails here rather than on an install host.
run('tar', ['-xzf', tarball, '-C', work])
for (const rel of [
  'out/main/index.js',
  'out/main/daemon-entry.js',
  'out/web/web-index.html',
  'out/cli/index.js',
  'out/package.json',
  'pnpm-workspace.yaml',
  'scripts/vsagent-serve',
  ...POSTINSTALL_STAGED_SCRIPTS
]) {
  if (!existsSync(path.join(appDir, rel))) {
    die(`extracted tarball is missing ${rel}`)
  }
}

// Rehydrate node_modules exactly as the install host does: this fetches the
// Electron binary and rebuilds node-pty against Electron's ABI (the tarball's
// postinstall = rebuild-native-deps.mjs). --no-frozen-lockfile mirrors
// install.sh: the staged package.json is slimmed/augmented relative to the
// dev-inclusive lockfile, and CI defaults --frozen-lockfile=true otherwise.
// Remove ELECTRON_SKIP_BINARY_DOWNLOAD so nothing on the runner short-circuits
// the electron download.
const installEnv = { ...process.env }
const skipFlag = installEnv.ELECTRON_SKIP_BINARY_DOWNLOAD
if (skipFlag) {
  log(`unsetting ELECTRON_SKIP_BINARY_DOWNLOAD (was ${skipFlag}) for the smoke install`)
}
delete installEnv.ELECTRON_SKIP_BINARY_DOWNLOAD

log('pnpm install --prod --no-frozen-lockfile (runs the tarball postinstall)')
run('pnpm', ['install', '--prod', '--no-frozen-lockfile'], { cwd: appDir, env: installEnv })

// Guard: node-pty is a production dependency carrying a patch, and the patch
// only reaches the host through the staged pnpm-workspace.yaml. An unpatched
// node-pty installs and loads fine — it just misbehaves around terminal
// teardown — so assert the patch text is really in the installed copy rather
// than trusting the install's exit code.
const installedUnixTerminal = path.join(appDir, 'node_modules/node-pty/lib/unixTerminal.js')
if (!existsSync(installedUnixTerminal)) {
  die(`node-pty did not install (missing ${installedUnixTerminal})`)
}
if (!readFileSync(installedUnixTerminal, 'utf8').includes(NODE_PTY_PATCH_MARKER)) {
  die('installed node-pty is unpatched — the tarball lost pnpm-workspace.yaml patchedDependencies')
}
log('node-pty patch applied on the host install')

// Guard: require('electron') returns the binary path — confirm it exists. The
// postinstall should have guaranteed this; fail loud with diagnostics if not.
function resolveElectron() {
  const r = spawnSync(
    'node',
    [
      '-e',
      'const p=require("electron");process.stdout.write(JSON.stringify({path:p,exists:require("fs").existsSync(p)}))'
    ],
    { cwd: appDir, encoding: 'utf8' }
  )
  try {
    return JSON.parse(r.stdout)
  } catch {
    return { path: null, exists: false, err: (r.stderr || '').trim() }
  }
}
const electron = resolveElectron()
log(`electron: ${JSON.stringify(electron)}`)
if (!electron.exists) {
  die(
    `electron binary missing after install — the postinstall strict installer should have fetched it: ${JSON.stringify(electron)}`
  )
}

// Boot through the production launcher. No display flags: the app's in-process
// fallback (ensure-virtual-display) handles a display-less host.
log(`booting scripts/vsagent-serve on port ${PORT}`)
const child = spawn(path.join(appDir, 'scripts', 'vsagent-serve'), [], {
  cwd: appDir,
  env: {
    ...installEnv,
    VSAGENT_PORT: PORT,
    HOME: homeDir,
    // Why: point every XDG dir under the scratch HOME so Electron userData and
    // the launcher's state file are isolated regardless of the runner's env.
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let bootLog = ''
// Why an empty-string sentinel rather than null: this is only ever read to
// report how the launcher died, and a plain string keeps every read a string.
let exitReason = ''
child.stdout.on('data', (d) => {
  bootLog += d
  process.stdout.write(d)
})
child.stderr.on('data', (d) => {
  bootLog += d
  process.stderr.write(d)
})
child.on('exit', (code, signal) => {
  exitReason = signal ? `signal ${signal}` : `code ${code}`
})

// The runtime WS port also serves the web client over plain HTTP; a 200 here
// proves out/web staged correctly AND the server bound its port.
function probeWebClient() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/web-index.html', timeout: 3000 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const start = process.hrtime.bigint()
let ready = false
while (Number(process.hrtime.bigint() - start) / 1e6 < BOOT_TIMEOUT_MS) {
  if (exitReason) {
    die(`vsagent-serve exited before becoming ready (${exitReason})`, bootLog)
  }
  // Why: vsagent-serve rebrands the ready line; accept both spellings so the
  // smoke also passes against an unfiltered `electron . --serve` boot.
  if (/(VSAgent|Orca) server ready/.test(bootLog) && (await probeWebClient())) {
    ready = true
    break
  }
  await sleep(1500)
}

let failure = null
if (!ready) {
  failure = `server did not become ready (log line + HTTP 200 on /web-index.html) within ${BOOT_TIMEOUT_MS / 1000}s`
} else {
  // The pairing offer prints the tokenized web client URL, and the launcher
  // must have mirrored it into the state file — this validates the systemd
  // URL-recovery path end to end.
  if (!bootLog.includes('Web client URL: ')) {
    failure = 'boot log is missing the "Web client URL:" line (pairing offer or out/web missing)'
  } else {
    const webUrlFile = path.join(homeDir, '.local', 'state', 'vsagent', 'web-url')
    // Why: the state file is written by the launcher's stdout filter, which can
    // trail the in-process log by a beat — give it a moment before judging.
    let webUrl = null
    for (let i = 0; i < 10 && webUrl === null; i += 1) {
      try {
        webUrl = readFileSync(webUrlFile, 'utf8').trim()
      } catch {
        await sleep(500)
      }
    }
    if (!webUrl || !webUrl.includes('/web-index.html')) {
      failure = `launcher did not record the web client URL to ${webUrlFile}`
    } else {
      log(`web client URL recorded: ${webUrl}`)
    }
  }
}

child.kill('SIGTERM')
await sleep(2000)
if (!exitReason) {
  child.kill('SIGKILL')
  await sleep(500)
}
try {
  rmSync(work, { recursive: true, force: true })
} catch {
  // best-effort cleanup; CI tears the runner down anyway
}

if (failure) {
  die(failure, bootLog)
}
log(`PASS — serve booted, bound ${HOST}:${PORT}, and served /web-index.html`)
process.exit(0)
