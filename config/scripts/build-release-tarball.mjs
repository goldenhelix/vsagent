#!/usr/bin/env node
// Builds a self-contained Linux x64 release tarball for VSAgent web mode.
//
// What the tarball contains:
//   - out/main, out/web, out/cli  (built artifacts)
//   - package.json + pnpm-lock.yaml + .npmrc  (so `pnpm install --prod`
//     can hydrate node_modules on the install host)
//   - config/scripts/web-serve.mjs + web-cjs-wrapper.cjs  (launcher)
//   - config/patches/                                     (pnpm patches
//     referenced by package.json are required by `pnpm install`)
//   - resources/vsagent.svg                                (used by the
//     headless main process when registering the app icon)
//   - scripts/install.sh + scripts/vsagent.service        (re-used during
//     upgrades so the installed copy can re-render the unit file)
//   - VERSION                                             (computed version
//     string for diagnostics)
//
// What it does NOT contain: node_modules. We install production deps on
// the target host using pnpm so that native modules (better-sqlite3,
// node-pty) get rebuilt against the local glibc/Node ABI. Shipping a
// prebuilt node_modules tree from CI would force us to also ship a
// compatible Node/Electron and any glibc shim.
//
// Output: dist/vsagent-linux-x64-<version>.tar.gz
// Prints the final path and sha256 to stdout.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

function run(cmd, args, opts = {}) {
  console.log(`[release-tarball] $ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    ...opts
  })
  if (result.status !== 0) {
    console.error(`[release-tarball] command failed: ${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

function resolveVersion() {
  // CI sets RELEASE_VERSION when invoked from a tag; otherwise fall back
  // to package.json + a `git describe` suffix so dev builds are uniquely
  // named.
  const fromEnv = process.env.RELEASE_VERSION?.trim()
  if (fromEnv) return fromEnv.replace(/^v/, '')

  const base = pkg.version || '0.0.0'
  try {
    const desc = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
    if (desc.status === 0) {
      const trimmed = desc.stdout.trim()
      if (trimmed && !trimmed.startsWith('v' + base) && !trimmed.startsWith(base)) {
        return `${base}+${trimmed}`
      }
      return trimmed.replace(/^v/, '') || base
    }
  } catch {
    // ignore — fall back to package.json version
  }
  return base
}

const version = resolveVersion()
const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')

console.log(`[release-tarball] version=${version}`)
console.log(`[release-tarball] repoRoot=${repoRoot}`)

// Step 1: build artifacts.
if (skipBuild) {
  console.log('[release-tarball] --skip-build passed; assuming out/ is fresh')
} else {
  run('pnpm', ['run', 'build:electron-vite'])
  run('pnpm', ['run', 'web:build'])
  run('pnpm', ['run', 'build:cli'])
}

// Verify the build outputs we expect to ship.
const required = ['out/main/index.js', 'out/web/index.html', 'out/cli/index.js']
for (const rel of required) {
  const p = path.join(repoRoot, rel)
  if (!existsSync(p)) {
    console.error(`[release-tarball] missing build output: ${rel}`)
    process.exit(1)
  }
}

// Step 2: stage everything under dist/stage/vsagent.
const distDir = path.join(repoRoot, 'dist')
const stageRoot = path.join(distDir, 'stage')
const stageDir = path.join(stageRoot, 'vsagent')
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

function stagePath(rel, opts = {}) {
  const src = path.join(repoRoot, rel)
  const dst = path.join(stageDir, rel)
  if (!existsSync(src)) {
    if (opts.optional) return false
    console.error(`[release-tarball] missing required source path: ${rel}`)
    process.exit(1)
  }
  mkdirSync(path.dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true, dereference: false })
  return true
}

function stageFile(rel, opts = {}) {
  const src = path.join(repoRoot, rel)
  const dst = path.join(stageDir, rel)
  if (!existsSync(src)) {
    if (opts.optional) return false
    console.error(`[release-tarball] missing required source file: ${rel}`)
    process.exit(1)
  }
  mkdirSync(path.dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return true
}

// Built artifacts.
stagePath('out/main')
stagePath('out/web')
stagePath('out/cli')

// Launcher + supporting files. We rewrite package.json below so that
// the on-host install has only what's needed at runtime.
stageFile('config/scripts/web-serve.mjs')
stageFile('config/scripts/web-cjs-wrapper.cjs')
stagePath('config/patches', { optional: true })

stageFile('resources/vsagent.svg', { optional: true })
stageFile('resources/icon.png', { optional: true })

// Install scripts so on-host upgrades / re-runs work.
stageFile('scripts/install.sh', { optional: true })
stageFile('scripts/vsagent.service', { optional: true })

// pnpm-lock.yaml + .npmrc are required for a reproducible `pnpm
// install --prod` on the target host.
stageFile('pnpm-lock.yaml')
stageFile('.npmrc', { optional: true })
stageFile('LICENSE', { optional: true })

// VERSION marker — handy for diagnostics on the host.
writeFileSync(path.join(stageDir, 'VERSION'), `${version}\n`, 'utf8')

// Write a slimmed package.json. We strip devDependencies, scripts that
// are irrelevant on the host, and rewire `web:serve` so `pnpm web:serve`
// works from the install dir without needing the rest of the build
// pipeline. We KEEP `postinstall` so `pnpm install --prod` rebuilds
// native deps against the bundled Electron ABI — but rebuild-native-deps
// is not shipped, so we replace it with a noop that still rebuilds
// electron's chromium binary (the only thing strictly required at
// runtime).
const stagedPkg = {
  name: pkg.name,
  version,
  description: pkg.description,
  homepage: pkg.homepage,
  author: pkg.author,
  license: pkg.license,
  private: true,
  main: pkg.main,
  bin: { vsagent: './out/cli/index.js' },
  scripts: {
    'web:serve': 'node config/scripts/web-serve.mjs',
    // Why: on `pnpm install --prod` the project's normal postinstall
    // (`pnpm rebuild electron && rebuild-native-deps.mjs`) needs the
    // rebuild-native-deps helper we deliberately don't ship. Reduce it
    // to just rebuilding electron, which pnpm already wired up.
    postinstall: 'pnpm rebuild electron better-sqlite3 node-pty || true'
  },
  dependencies: pkg.dependencies,
  engines: pkg.engines,
  packageManager: pkg.packageManager,
  pnpm: pkg.pnpm
}
writeFileSync(
  path.join(stageDir, 'package.json'),
  JSON.stringify(stagedPkg, null, 2) + '\n',
  'utf8'
)

// Step 3: create the tarball using GNU tar (system-provided everywhere
// we target). Use a deterministic owner/group so two builds of the same
// commit produce byte-identical tarballs.
mkdirSync(distDir, { recursive: true })
const tarballName = `vsagent-linux-x64-${version}.tar.gz`
const tarballPath = path.join(distDir, tarballName)
rmSync(tarballPath, { force: true })

run('tar', [
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '--sort=name',
  '-czf',
  tarballPath,
  '-C',
  stageRoot,
  'vsagent'
])

// Step 4: compute sha256 and print final summary.
const buf = readFileSync(tarballPath)
const sha256 = createHash('sha256').update(buf).digest('hex')
const sizeMb = (statSync(tarballPath).size / (1024 * 1024)).toFixed(1)

writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${tarballName}\n`, 'utf8')

console.log('')
console.log('=== vsagent release tarball ready ===')
console.log(`path:    ${tarballPath}`)
console.log(`size:    ${sizeMb} MiB`)
console.log(`sha256:  ${sha256}`)
console.log(`version: ${version}`)

// Surface the path and digest as GitHub Actions outputs when running in
// CI. The release workflow consumes these to drive the upload step.
if (process.env.GITHUB_OUTPUT) {
  const lines = [
    `tarball_path=${tarballPath}`,
    `tarball_name=${tarballName}`,
    `tarball_sha256=${sha256}`,
    `tarball_version=${version}`
  ]
  writeFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', { flag: 'a' })
}
