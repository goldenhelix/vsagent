#!/usr/bin/env node
// Builds a self-contained Linux x64 release tarball for VSAgent, which ships
// upstream Orca's native `--serve` mode as a self-hosted web service.
//
// What the tarball contains:
//   - out/                      all built artifacts (main, preload, renderer,
//                               cli, shared, relay, web, package.json). Staged
//                               wholesale: 0.5.0 shipped a hand-picked subset
//                               whose out/main require()d an unstaged module
//                               and crash-looped, so we no longer curate.
//   - package.json (slimmed) + pnpm-lock.yaml + pnpm-workspace.yaml + .npmrc
//     so `pnpm install --prod` can hydrate node_modules on the install host.
//     pnpm-workspace.yaml is what carries patchedDependencies (node-pty is a
//     production dependency), shamefullyHoist and overrides since pnpm 10 moved
//     them out of package.json's `pnpm` field.
//   - scripts/vsagent-serve + scripts/vsagent.service + scripts/install.sh
//     (launcher, systemd template, and upgrade re-runs)
//   - config/scripts/{rebuild-native-deps,install-electron-package-binary}.mjs
//     plus their import closure (the shipped postinstall) and config/patches/
//     (pnpm patchedDependencies)
//   - resources/                runtime-loaded (skill freshness metadata reads
//                               cwd/resources when unpackaged, icons, media)
//   - VERSION                   computed version string for diagnostics
//
// What it does NOT contain: node_modules. Production deps are installed on the
// target host with pnpm so native modules (node-pty) get rebuilt against the
// bundled Electron ABI and Electron's binary is fetched for the host.
//
// Output: dist/vsagent-linux-x64-<version>.tar.gz (+ .sha256)

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
import {
  buildStagedPackageJson,
  buildStagedPnpmWorkspaceConfig,
  POSTINSTALL_STAGED_SCRIPTS
} from './release-tarball-staged-config.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')
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
  // CI sets RELEASE_VERSION when invoked from a tag; otherwise fall back to
  // package.json + a `git describe` suffix so dev builds are uniquely named.
  const fromEnv = process.env.RELEASE_VERSION?.trim()
  if (fromEnv) {
    return fromEnv.replace(/^v/, '')
  }

  const base = pkg.version || '0.0.0'
  try {
    const desc = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
    if (desc.status === 0) {
      const trimmed = desc.stdout.trim()
      if (trimmed && !trimmed.startsWith(`v${base}`) && !trimmed.startsWith(base)) {
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
  // Why this order: build:cli runs tsc with --outDir out over src, which emits
  // unbundled out/main/**.js. build:electron-vite must run AFTER build:cli so
  // its clean + bundled out/main overwrites that tsc clobber. Then
  // verify:built-skills-cli statically checks the built CLI's require()/import()
  // graph resolves, and build:web-from-renderer projects the web-index.html
  // entry out of out/renderer into out/web — so it must follow build:electron-vite
  // too. This is upstream's own `build:desktop`/`build:release` order; the older
  // standalone `build:web` Vite pass is no longer exercised by any upstream
  // pipeline, so it is the path more likely to rot unnoticed.
  run('pnpm', ['run', 'build:relay'])
  run('pnpm', ['run', 'build:cli'])
  run('pnpm', ['run', 'build:electron-vite'])
  run('pnpm', ['run', 'verify:built-skills-cli'])
  run('pnpm', ['run', 'build:web-from-renderer'])
}

// Verify the build outputs we expect to ship. out/web/web-index.html is the
// upstream web client entry that `orca serve` serves over its runtime port;
// out/package.json is the type=commonjs boundary verify-cli-bin.mjs writes.
const required = [
  'out/main/index.js',
  'out/main/daemon-entry.js',
  'out/web/web-index.html',
  'out/cli/index.js',
  'out/package.json',
  'out/relay/linux-x64/relay.js'
]
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
    if (opts.optional) {
      return false
    }
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
    if (opts.optional) {
      return false
    }
    console.error(`[release-tarball] missing required source file: ${rel}`)
    process.exit(1)
  }
  mkdirSync(path.dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return true
}

// Built artifacts — the whole tree (see header for why not a curated subset).
stagePath('out')

// Launcher + install/upgrade scripts.
stageFile('scripts/vsagent-serve')
stageFile('scripts/vsagent-cli')
stageFile('scripts/vsagent.service')
stageFile('scripts/install.sh')

// The shipped postinstall (rebuild-native-deps) rebuilds node-pty against the
// bundled Electron ABI and guarantees Electron's binary via the strict
// installer (electron's own install.js can exit 0 without extracting on
// Node 24, crash-looping fresh installs). Staged with its whole import
// closure — see POSTINSTALL_STAGED_SCRIPTS.
for (const rel of POSTINSTALL_STAGED_SCRIPTS) {
  stageFile(rel)
}
// pnpm patchedDependencies — required by `pnpm install` on the host.
stagePath('config/patches')

// Why: skill freshness metadata resolves resources/ from cwd when unpackaged
// (src/main/skills/skill-bundle-artifacts.ts), and icons/media load from here.
stagePath('resources')

// pnpm-lock.yaml + .npmrc give the host install reproducible resolution.
stageFile('pnpm-lock.yaml')
stageFile('.npmrc', { optional: true })
stageFile('LICENSE', { optional: true })

// pnpm-workspace.yaml is the rest of the install contract: patchedDependencies
// (node-pty is a production dependency — an unpatched one is a real runtime
// regression), shamefullyHoist (the hoisted layout the runtime's bare require()
// calls expect) and overrides. Without staging it, `pnpm install --prod` loses
// all three silently. See release-tarball-staged-config.mjs for the one edit
// this copy carries (allowUnusedPatches).
//
// Note for a future debugger: the staged file also carries
// `minimumReleaseAge: 4320`. If the host install ever has to re-resolve
// (--no-frozen-lockfile after the staged package.json moved electron between
// dependency buckets), a version published inside that 3-day window is refused
// unless it is listed under minimumReleaseAgeExclude.
writeFileSync(
  path.join(stageDir, 'pnpm-workspace.yaml'),
  buildStagedPnpmWorkspaceConfig(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')),
  'utf8'
)

// VERSION marker — handy for diagnostics on the host.
writeFileSync(path.join(stageDir, 'VERSION'), `${version}\n`, 'utf8')

// The slimmed package.json for the on-host `pnpm install --prod` — electron and
// @electron/rebuild promoted into dependencies, no dead `pnpm` field.
writeFileSync(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(buildStagedPackageJson(pkg, version), null, 2)}\n`,
  'utf8'
)

// Step 3: create the tarball using GNU tar. Deterministic owner/group so two
// builds of the same commit produce byte-identical tarballs.
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

// Surface the path and digest as GitHub Actions outputs when running in CI.
// The release workflow consumes these to drive the upload step.
if (process.env.GITHUB_OUTPUT) {
  const lines = [
    `tarball_path=${tarballPath}`,
    `tarball_name=${tarballName}`,
    `tarball_sha256=${sha256}`,
    `tarball_version=${version}`
  ]
  writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, { flag: 'a' })
}
