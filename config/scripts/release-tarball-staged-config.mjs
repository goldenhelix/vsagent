// The two install-config files the release tarball stages for the on-host
// `pnpm install --prod`: a slimmed package.json and a copy of the repo's
// pnpm-workspace.yaml. Both are pure text transforms, kept out of
// build-release-tarball.mjs so they can be asserted without running a build —
// every bug this module guards against is silent (a dropped patch, an ignored
// config key), which is exactly the class no boot smoke test notices until a
// specific host misbehaves.

import { parse, stringify } from 'yaml'

/**
 * The config/scripts files the tarball's `postinstall` needs on the install
 * host: `rebuild-native-deps.mjs` (the staged postinstall itself), the child
 * process it spawns, and their static-import closure.
 *
 * The closure is the point. When this pipeline was written both entry scripts
 * imported nothing but node builtins, so staging the two was enough; upstream
 * has since split helpers out of both, and a missing one makes the host's
 * `pnpm install --prod` die at import time with ERR_MODULE_NOT_FOUND — the
 * exact "unstaged module" failure this tarball apparatus exists to catch, only
 * now at install rather than boot. release-tarball-staged-config.test.mjs
 * re-derives the closure from source so upstream drift fails here instead.
 */
export const POSTINSTALL_STAGED_SCRIPTS = [
  'config/scripts/rebuild-native-deps.mjs',
  'config/scripts/install-electron-package-binary.mjs',
  'config/scripts/windows-process-tree-gyp-rebuild.mjs',
  'config/scripts/electron-platform-path.mjs',
  'config/scripts/shared-electron-dist-cache.mjs',
  'config/scripts/space-sharing-copy.mjs',
  // Not an import: rebuild-native-deps require()s this inside the Electron
  // load probe. Missing, the probe reports node-pty as broken and forces a
  // needless source rebuild instead of failing outright.
  'config/scripts/node-pty-job-ownership.cjs'
]

/**
 * The slimmed package.json shipped inside the tarball.
 *
 * Two deliberate differences from the repo's own package.json:
 *
 * - `electron` and `@electron/rebuild` move from devDependencies into
 *   dependencies. `pnpm install --prod` skips devDependencies entirely, and the
 *   shipped postinstall (`rebuild-native-deps.mjs`) statically imports
 *   `@electron/rebuild`, then calls `ensureElectronPackageInstalled()`, whose
 *   strict installer (`install-electron-package-binary.mjs`) resolves
 *   `node_modules/electron/package.json` — it fetches the platform binary, not
 *   the npm package, so the package itself has to resolve first.
 * - No `pnpm` field. pnpm 10 moved install settings out of package.json into
 *   pnpm-workspace.yaml and pnpm 12 ignores the old field, so writing one here
 *   would be a no-op that reads like configuration. See
 *   buildStagedPnpmWorkspaceConfig for where those settings actually live.
 *
 * Nothing here adds `electron` to `allowBuilds`: the root `postinstall` is the
 * single owner of the Electron binary install (pinned by
 * `package-electron-runtime-contract.test.mjs`), and a root project's lifecycle
 * scripts run under `--prod` regardless of `allowBuilds`.
 */
export function buildStagedPackageJson(pkg, version) {
  const electron = pkg.devDependencies?.electron
  const electronRebuild = pkg.devDependencies?.['@electron/rebuild']
  // Why throw rather than spread an undefined through: JSON.stringify drops an
  // undefined value, so a rename upstream would silently ship a tarball whose
  // `pnpm install --prod` never installs Electron at all.
  if (!electron || !electronRebuild) {
    throw new Error(
      'package.json devDependencies must carry electron and @electron/rebuild for the release tarball'
    )
  }
  return {
    name: pkg.name,
    version,
    description: pkg.description,
    homepage: pkg.homepage,
    author: pkg.author,
    license: pkg.license,
    private: true,
    main: pkg.main,
    bin: { orca: './out/cli/index.js', vsagent: './out/cli/index.js' },
    scripts: {
      serve: './scripts/vsagent-serve',
      postinstall: 'node config/scripts/rebuild-native-deps.mjs'
    },
    dependencies: {
      ...pkg.dependencies,
      electron,
      '@electron/rebuild': electronRebuild
    },
    optionalDependencies: pkg.optionalDependencies,
    engines: pkg.engines,
    packageManager: pkg.packageManager
  }
}

/**
 * The tarball's copy of pnpm-workspace.yaml, which since pnpm 10 is the only
 * place `pnpm install` reads `patchedDependencies`, `shamefullyHoist` and
 * `overrides` from. Staging it is not optional housekeeping:
 *
 * - `node-pty` is a *production* dependency with a patch; a `--prod` install
 *   without this file installs it unpatched, which is a functional regression
 *   nothing later in the install fails on.
 * - `shamefullyHoist: true` is the flat layout the runtime's bare `require()`
 *   calls resolve against.
 * - `overrides` pins a transitive dependency that ships in the runtime bundle.
 *
 * The one edit: `allowUnusedPatches`, because most patched packages
 * (`@xterm/*`, `lint-staged`) are devDependencies a `--prod` install never
 * materializes, and pnpm otherwise fails the whole install with
 * ERR_PNPM_UNUSED_PATCH.
 *
 * `allowBuilds` is copied through untouched — in particular `electron` must NOT
 * be added to it (see buildStagedPackageJson).
 *
 * Comments are lost on the parse/stringify round trip; this is a build artifact,
 * not a source file.
 */
export function buildStagedPnpmWorkspaceConfig(workspaceYaml) {
  const config = parse(workspaceYaml)
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('pnpm-workspace.yaml did not parse to a mapping')
  }
  return stringify({ ...config, allowUnusedPatches: true })
}
