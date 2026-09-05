import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  buildStagedPackageJson,
  buildStagedPnpmWorkspaceConfig,
  POSTINSTALL_STAGED_SCRIPTS
} from './release-tarball-staged-config.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const readProject = (file) => readFileSync(join(projectDir, file), 'utf8')
const packageJson = JSON.parse(readProject('package.json'))
const workspaceYaml = readProject('pnpm-workspace.yaml')
const builderSource = readProject('config/scripts/build-release-tarball.mjs')
const smokeSource = readProject('config/scripts/smoke-test-tarball.mjs')

describe('staged release package.json', () => {
  it('promotes electron and @electron/rebuild into dependencies', () => {
    const staged = buildStagedPackageJson(packageJson, '1.2.3')

    // Why this matters: `pnpm install --prod` on the host skips devDependencies
    // outright, and the shipped postinstall imports @electron/rebuild and
    // resolves node_modules/electron/package.json before fetching the binary.
    expect(staged.dependencies.electron).toBe(packageJson.devDependencies.electron)
    expect(staged.dependencies['@electron/rebuild']).toBe(
      packageJson.devDependencies['@electron/rebuild']
    )
    expect(staged.dependencies).toMatchObject(packageJson.dependencies)
  })

  it('writes no pnpm field, since pnpm 12 ignores it', () => {
    const staged = buildStagedPackageJson(packageJson, '1.2.3')

    // The fork staged `pnpm: { onlyBuiltDependencies: [...], allowUnusedPatches }`
    // here. pnpm 10 moved install settings into pnpm-workspace.yaml and retired
    // onlyBuiltDependencies for allowBuilds, so that block was a silent no-op
    // that read like working configuration.
    expect(staged).not.toHaveProperty('pnpm')
    expect(JSON.stringify(staged)).not.toContain('onlyBuiltDependencies')
  })

  it('stamps the release version and keeps both CLI bin names', () => {
    const staged = buildStagedPackageJson(packageJson, '1.2.3')

    expect(staged.version).toBe('1.2.3')
    expect(staged.name).toBe(packageJson.name)
    expect(staged.bin).toEqual({ orca: './out/cli/index.js', vsagent: './out/cli/index.js' })
    expect(staged.scripts).toEqual({
      serve: './scripts/vsagent-serve',
      postinstall: 'node config/scripts/rebuild-native-deps.mjs'
    })
    expect(staged.engines).toEqual(packageJson.engines)
    expect(staged.packageManager).toBe(packageJson.packageManager)
  })

  // Why throw instead of spreading undefined: JSON.stringify drops an undefined
  // value, so a rename would ship a tarball whose --prod install never installs
  // Electron at all — and nothing would fail until the host tried to boot.
  it('refuses to stage a package.json without the Electron devDependencies', () => {
    expect(() =>
      buildStagedPackageJson({ ...packageJson, devDependencies: {} }, '1.2.3')
    ).toThrowError(/electron/)
  })
})

describe('staged pnpm-workspace.yaml', () => {
  it('allows unused patches so a --prod install does not fail on devDependency patches', () => {
    const staged = parse(buildStagedPnpmWorkspaceConfig(workspaceYaml))

    // Most patched packages (@xterm/*, lint-staged) are devDependencies a --prod
    // install never materializes; pnpm otherwise fails with ERR_PNPM_UNUSED_PATCH.
    expect(staged.allowUnusedPatches).toBe(true)
  })

  it('carries the production node-pty patch, hoisting and overrides through', () => {
    const source = parse(workspaceYaml)
    const staged = parse(buildStagedPnpmWorkspaceConfig(workspaceYaml))

    // node-pty is a *production* dependency: an install that loses its patch
    // succeeds and then misbehaves at runtime, which is why this file has to be
    // staged at all.
    expect(staged.patchedDependencies['node-pty@1.1.0']).toBe(
      source.patchedDependencies['node-pty@1.1.0']
    )
    expect(staged.shamefullyHoist).toBe(true)
    expect(staged.overrides).toEqual(source.overrides)
  })

  it('leaves allowBuilds exactly as upstream ships it', () => {
    const source = parse(workspaceYaml)
    const staged = parse(buildStagedPnpmWorkspaceConfig(workspaceYaml))

    // package-electron-runtime-contract.test.mjs pins that the root postinstall
    // is the single owner of the Electron binary install; adding electron here
    // would let electron's own flaky installer run too.
    expect(staged.allowBuilds).toEqual(source.allowBuilds)
    expect(staged.allowBuilds).not.toHaveProperty('electron')
  })

  it('fails loudly when the workspace file is not a mapping', () => {
    expect(() => buildStagedPnpmWorkspaceConfig('- packages\n')).toThrowError(/mapping/)
  })
})

// Both shapes the shipped postinstall reaches another config/scripts file by:
// a relative ESM import, and a repo-root-relative path literal (the child
// process it spawns, and the .cjs it require()s from the Electron probe). The
// literal pattern demands the quote right after the extension, which is what
// keeps the "run ensure-native-runtime.mjs first" error message out.
const RELATIVE_IMPORT = /from '(\.\/[^']+\.[cm]?js)'/g
const SCRIPT_PATH_LITERAL = /'\.?\/?(config\/scripts\/[^']+\.[cm]js)'/g

/** Everything reachable from `entries` through those two shapes. */
function collectScriptClosure(entries) {
  const reached = new Set(entries)
  const queue = [...entries]
  while (queue.length > 0) {
    const current = queue.pop()
    const source = readProject(current)
    const found = [
      ...[...source.matchAll(RELATIVE_IMPORT)].map(
        ([, spec]) => `config/scripts/${spec.slice('./'.length)}`
      ),
      ...[...source.matchAll(SCRIPT_PATH_LITERAL)].map(([, rel]) => rel)
    ]
    for (const rel of found) {
      if (!reached.has(rel)) {
        reached.add(rel)
        queue.push(rel)
      }
    }
  }
  return reached
}

describe('staged postinstall scripts', () => {
  // The failure this guards is total and silent until an install host hits it:
  // a helper upstream splits out of either entry script is not staged, and the
  // host's `pnpm install --prod` dies at import time with ERR_MODULE_NOT_FOUND.
  it('stages the whole import closure of the shipped postinstall', () => {
    const closure = collectScriptClosure([
      'config/scripts/rebuild-native-deps.mjs',
      'config/scripts/install-electron-package-binary.mjs'
    ])

    expect([...closure].sort()).toEqual([...POSTINSTALL_STAGED_SCRIPTS].sort())
  })

  it('stages every listed script through the builder', () => {
    expect(builderSource).toContain('POSTINSTALL_STAGED_SCRIPTS')
    for (const rel of POSTINSTALL_STAGED_SCRIPTS) {
      expect(() => readProject(rel), rel).not.toThrow()
    }
  })
})

describe('build-release-tarball.mjs', () => {
  it('builds the web client through the renderer projection', () => {
    // build:web (the standalone Vite web config) still exists but no upstream
    // pipeline calls it any more; build:desktop and build:release both project
    // out/renderer instead, so that is the path that stays exercised.
    expect(builderSource).toContain("'build:web-from-renderer'")
    expect(builderSource).not.toContain("'build:web'")
  })

  it('verifies the built CLI runtime graph before projecting the web client', () => {
    const electronVite = builderSource.indexOf("'build:electron-vite'")
    const verifySkills = builderSource.indexOf("'verify:built-skills-cli'")
    const webFromRenderer = builderSource.indexOf("'build:web-from-renderer'")

    expect(electronVite).toBeGreaterThan(-1)
    expect(verifySkills).toBeGreaterThan(electronVite)
    expect(webFromRenderer).toBeGreaterThan(verifySkills)
  })

  it('stages pnpm-workspace.yaml alongside the lockfile', () => {
    expect(builderSource).toContain("stageFile('pnpm-lock.yaml')")
    expect(builderSource).toContain('buildStagedPnpmWorkspaceConfig')
    expect(builderSource).toContain("path.join(stageDir, 'pnpm-workspace.yaml')")
  })
})

describe('smoke-test-tarball.mjs', () => {
  it('requires the staged pnpm-workspace.yaml in the extracted tarball', () => {
    expect(smokeSource).toContain("'pnpm-workspace.yaml'")
  })

  it('requires the postinstall import closure in the extracted tarball', () => {
    expect(smokeSource).toContain('...POSTINSTALL_STAGED_SCRIPTS')
  })

  it('asserts a marker the node-pty patch really introduces', () => {
    const marker = /NODE_PTY_PATCH_MARKER = '([^']+)'/.exec(smokeSource)?.[1]
    const patchLine = readProject('config/patches/node-pty@1.1.0.patch')
      .split('\n')
      .find((line) => line.includes(marker))

    expect(marker).toBeTruthy()
    // Guards the guard: a marker that drifted out of the patch would fail the
    // smoke test on a correct tarball, and one lifted from an unchanged upstream
    // line would pass it on a tarball that lost the patch. Requiring the marker
    // to live on an added (`+`) line rules both out.
    expect(patchLine?.startsWith('+')).toBe(true)
  })
})
