import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why source text: `installRuntimeRpc` and `launchServeMode` are module-private and only reachable
// through an Electron `app` boot, so the wiring itself is pinned here while the behaviour they wire
// is covered by serve-runtime-rpc-options.test.ts and runtime-rpc-serve-tls.test.ts.
const source = readFileSync(
  join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
  'utf8'
)
const launcherInstallSource = readFileSync(
  join(process.cwd(), 'src/main/startup/serve-cli-launcher-install.ts'),
  'utf8'
)

describe('serve runtime launch wiring', () => {
  it('spreads the serve transport options into the runtime RPC server', () => {
    const constructionStart = source.indexOf('new OrcaRuntimeRpcServer({')
    const constructionEnd = source.indexOf('webClientRoot: getBundledWebClientRoot()')
    expect(constructionStart).toBeGreaterThanOrEqual(0)
    expect(constructionEnd).toBeGreaterThan(constructionStart)
    expect(source.slice(constructionStart, constructionEnd)).toContain(
      '...buildServeRuntimeRpcOptions(serveOptions)'
    )
  })

  it('runs the serve-time CLI launcher installs from the serve launch path', () => {
    // The blocks themselves live in serve-cli-launcher-install.ts (max-lines); this pins that
    // `launchServeMode` still calls them.
    expect(source).toContain('await installServeCliLaunchers()')
  })

  it('gates both serve-time CLI launcher installs on the managed-install env', () => {
    // Why both: upstream added a second install block (the bare `orca` dispatcher) after the fork
    // wrote this gate, and a tarball install owns that launcher too — gating only the first would
    // let serve overwrite it.
    expect(launcherInstallSource).toContain("process.env.ORCA_MANAGED_INSTALL === '1'")
    const gated = launcherInstallSource.match(/!cliLaunchersExternallyManaged\b/g) ?? []
    expect(gated).toHaveLength(2)
    const installerGuard = launcherInstallSource.indexOf('!cliLaunchersExternallyManaged')
    expect(launcherInstallSource.indexOf('new CliInstaller(')).toBeGreaterThan(installerGuard)
    expect(launcherInstallSource.indexOf('installLinuxBareOrcaDispatcher({')).toBeGreaterThan(
      launcherInstallSource.lastIndexOf('!cliLaunchersExternallyManaged')
    )
  })
})
