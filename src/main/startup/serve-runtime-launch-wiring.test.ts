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

  it('gates both serve-time CLI launcher installs on the managed-install env', () => {
    // Why both: upstream added a second install block (the bare `orca` dispatcher) after the fork
    // wrote this gate, and a tarball install owns that launcher too — gating only the first would
    // let serve overwrite it.
    expect(source).toContain("process.env.ORCA_MANAGED_INSTALL === '1'")
    const gated = source.match(/!cliLaunchersExternallyManaged\b/g) ?? []
    expect(gated).toHaveLength(2)
    const installerGuard = source.indexOf('!cliLaunchersExternallyManaged')
    expect(source.indexOf('new CliInstaller(')).toBeGreaterThan(installerGuard)
    expect(source.indexOf('installLinuxBareOrcaDispatcher({')).toBeGreaterThan(
      source.lastIndexOf('!cliLaunchersExternallyManaged')
    )
  })
})
