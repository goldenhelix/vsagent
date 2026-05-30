#!/usr/bin/env node
// Boots a packaged VSAgent release tarball headless and asserts the backend
// actually binds its port. This is the guard that 0.5.0 lacked: that release
// shipped an out/main which `require()`d a module we never staged
// (`../../shared/string-utils`), so the backend crash-looped before it ever
// bound 127.0.0.1:7000 and every request returned 502. Inspecting the bundle
// is not enough — only a real boot proves the whole require graph loads and
// the gateway comes up. Run this against the just-built tarball in CI before
// publishing so a non-bootable artifact fails the release instead of shipping.
//
// Usage: node config/scripts/smoke-test-tarball.mjs [path/to/tarball.tar.gz]
//   Defaults to the newest dist/vsagent-linux-x64-*.tar.gz (excluding the
//   `latest` alias). Exits 0 on a successful bind, 1 otherwise.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOST = '127.0.0.1'
const PORT = process.env.SMOKE_PORT || '7099'
const BOOT_TIMEOUT_MS = 90_000

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
  if (!candidates.length) {die('no tarball argument given and none found in dist/')}
  tarball = candidates[0]
}
if (!existsSync(tarball)) {die(`tarball not found: ${tarball}`)}
log(`tarball: ${tarball}`)

const work = mkdtempSync(path.join(tmpdir(), 'vsagent-smoke-'))
const appDir = path.join(work, 'vsagent')
const dataDir = path.join(work, 'data')

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {die(`${cmd} ${args.join(' ')} exited ${r.status ?? 'signal'}`)}
}

// Extract and sanity-check the staged layout.
run('tar', ['-xzf', tarball, '-C', work])
for (const rel of ['out/main/index.js', 'out/web/index.html', 'config/scripts/web-serve.mjs']) {
  if (!existsSync(path.join(appDir, rel))) {die(`extracted tarball is missing ${rel}`)}
}

// Rehydrate node_modules exactly as the install host does: this fetches the
// Electron binary and rebuilds native deps (better-sqlite3, node-pty).
// --no-frozen-lockfile mirrors install.sh: the staged package.json is slimmed
// to runtime deps only, so it won't match the full (dev-inclusive) lockfile,
// and CI otherwise defaults --frozen-lockfile=true and would reject it.
log('pnpm install --prod --no-frozen-lockfile (fetches electron binary + rebuilds native deps)')
run('pnpm', ['install', '--prod', '--no-frozen-lockfile'], { cwd: appDir })

// Boot the gateway headless. web-serve.mjs already pins the Ozone headless
// backend, so this works on a display-less CI runner without xvfb.
log(`booting web-serve.mjs on ${HOST}:${PORT}`)
const child = spawn('node', ['config/scripts/web-serve.mjs'], {
  cwd: appDir,
  env: { ...process.env, VSAGENT_HOST: HOST, VSAGENT_PORT: PORT, VSAGENT_USER_DATA_PATH: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
})
let bootLog = ''
let exited = null
child.stdout.on('data', (d) => {
  bootLog += d
  process.stdout.write(d)
})
child.stderr.on('data', (d) => {
  bootLog += d
  process.stderr.write(d)
})
child.on('exit', (code, signal) => {
  exited = signal ? `signal ${signal}` : `code ${code}`
})

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/__orca/health', timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const start = process.hrtime.bigint()
let bound = false
while (Number(process.hrtime.bigint() - start) / 1e6 < BOOT_TIMEOUT_MS) {
  if (exited !== null) {
    die(`web-serve exited before binding (${exited})`, bootLog)
  }
  if (await probeHealth()) {
    bound = true
    break
  }
  await sleep(1500)
}

child.kill('SIGTERM')
await sleep(1500)
if (exited === null) {child.kill('SIGKILL')}
try {
  rmSync(work, { recursive: true, force: true })
} catch {
  // best-effort cleanup; CI tears the runner down anyway
}

if (!bound) {
  die(`backend never bound ${HOST}:${PORT} within ${BOOT_TIMEOUT_MS / 1000}s`, bootLog)
}
log(`PASS — backend booted and bound ${HOST}:${PORT}`)
process.exit(0)
