import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

const readWorkflow = (relativePath) => parse(readFileSync(join(projectDir, relativePath), 'utf8'))

describe('Windows signing workflow contract', () => {
  it('falls back to a hash-pinned SignPath nupkg when the gallery API is down', () => {
    const installAction = readWorkflow('.github/actions/install-signpath-module/action.yml')
    const installRun = installAction.runs.steps[0].run

    // Why: the gallery API 403s during Azure Front Door incidents while its CDN
    // stays up, so a pinned nupkg is the fallback. The hash pin is the only
    // integrity check on that route — losing it would let any payload install.
    const { 'fallback-version': version, 'fallback-sha256': sha256 } = installAction.inputs
    expect(version.default).toMatch(/^4\.\d+\.\d+$/)
    expect(sha256.default).toMatch(/^[0-9a-f]{64}$/)
    expect(installRun).toContain('Get-FileHash -LiteralPath $nupkg -Algorithm SHA256')
    expect(installRun).toContain('$actualHash -ne $expectedHash.ToUpperInvariant()')
    expect(installRun).toContain('throw "SHA-256 mismatch for $source')
    expect(installRun).toContain(
      'https://cdn.powershellgallery.com/packages/signpath.$version.nupkg'
    )

    // The module only resolves by name when the folder matches its ModuleVersion.
    expect(installRun).toContain(
      '$versionRoot = Join-Path -Path $signPathModulePath -ChildPath $version'
    )
    // The fallback only runs after the gallery route is exhausted, and still
    // fails the job when neither route produced a usable module.
    expect(installRun.indexOf('$installed = $true')).toBeLessThan(
      installRun.indexOf('if (-not $installed)')
    )
    expect(installRun).toContain('throw "Unable to install the SignPath PowerShell module')
  })
})

// Why this one survives: the NSIS uninstaller is generated inside electron-builder's
// uninstaller pass and deleted immediately after being embedded, so the only way CI can
// sign it is the export/import relay through win.signtoolOptions.sign. The workflow legs
// of that relay lived in the upstream release workflows this fork removed; the
// electron-builder hook they all depend on is still asserted here.
describe('Windows NSIS uninstaller signing', () => {
  it('wires the electron-builder sign hook that the relay depends on', () => {
    const require = createRequire(import.meta.url)
    const configPath = resolve(projectDir, 'config/electron-builder.config.cjs')
    delete require.cache[require.resolve(configPath)]
    const config = require(configPath)

    expect(typeof config.win.signtoolOptions.sign).toBe('function')
    delete require.cache[require.resolve(configPath)]
  })
})
