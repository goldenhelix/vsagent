import { hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getServeOptions } from './serve-options'
import { normalizeServeModeArgv } from './serve-mode-argv'

const DEFAULT_OPTIONS = {
  json: false,
  bindHost: null,
  pairingAddress: null,
  noPairing: false,
  mobilePairing: false,
  recipeJson: false,
  projectRoot: null,
  https: false,
  tlsCertPath: null,
  tlsKeyPath: null,
  serverName: hostname(),
  storageNamespace: null
}

describe('getServeOptions', () => {
  let priorServeName: string | undefined
  let priorStorageNamespace: string | undefined

  beforeEach(() => {
    priorServeName = process.env.ORCA_SERVE_NAME
    priorStorageNamespace = process.env.ORCA_STORAGE_NAMESPACE
    delete process.env.ORCA_SERVE_NAME
    delete process.env.ORCA_STORAGE_NAMESPACE
  })

  afterEach(() => {
    restoreEnv('ORCA_SERVE_NAME', priorServeName)
    restoreEnv('ORCA_STORAGE_NAMESPACE', priorStorageNamespace)
  })

  it('parses a valid launch', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-port', '6768', '--serve-no-pairing'])
    ).toEqual({
      ...DEFAULT_OPTIONS,
      wsPort: 6768,
      noPairing: true
    })
  })

  it('accepts equals-form values in the normalized shape', () => {
    expect(
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-port=6768',
        '--serve-pairing-address=127.0.0.1',
        '--serve-project-root=/tmp/repo'
      ])
    ).toMatchObject({
      wsPort: 6768,
      pairingAddress: '127.0.0.1',
      projectRoot: '/tmp/repo'
    })
  })

  it('uses the final occurrence of each value flag', () => {
    expect(
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-port',
        '6768',
        '--serve-port=6769',
        '--serve-pairing-address',
        'first.example',
        '--serve-pairing-address=last.example',
        '--serve-project-root',
        '/first',
        '--serve-project-root=/last'
      ])
    ).toMatchObject({
      wsPort: 6769,
      pairingAddress: 'last.example',
      projectRoot: '/last'
    })
  })

  it('applies missing or invalid values only to the final occurrence', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-port', '--serve-port', '6768']).wsPort
    ).toBe(6768)
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-port', '6768', '--serve-port'])
    ).toThrow('Missing value for --serve-port.')
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-port', '6768', '--serve-port=bad'])
    ).toThrow('Invalid --serve-port value: bad')
  })

  it('uses the final value of mixed boolean aliases', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-no-pairing', '--no-pairing=false']).noPairing
    ).toBe(false)
    expect(
      getServeOptions(['/AppRun', '--serve', '--no-pairing=false', '--serve-no-pairing']).noPairing
    ).toBe(true)
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-mobile-pairing', '--mobile-pairing=0'])
        .mobilePairing
    ).toBe(false)
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-recipe-json', '--recipe-json=false'])
        .recipeJson
    ).toBe(false)
  })

  it('keeps JSON enabled for an equals-form global flag', () => {
    expect(getServeOptions(['/AppRun', '--serve', '--json=false']).json).toBe(true)
  })

  it('accepts an equals-form value that resembles a pairing flag', () => {
    const argv = normalizeServeModeArgv(['/AppRun', 'serve', '--pairing-address=--no-pairng'])
    expect(getServeOptions(argv).pairingAddress).toBe('--no-pairng')
  })

  it('shares cross-flag validation with the CLI-form launch', () => {
    const argv = normalizeServeModeArgv([
      '/opt/orca/orca-ide',
      'serve',
      '--no-pairing',
      '--mobile-pairing'
    ])
    expect(() => getServeOptions(argv)).toThrow(/either --mobile-pairing or --no-pairing/i)
  })

  it('rejects recipe JSON without runtime pairing and a project root', () => {
    expect(() =>
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-recipe-json',
        '--serve-no-pairing',
        '--serve-project-root',
        '/tmp/repo'
      ])
    ).toThrow(/requires runtime pairing.*--no-pairing/i)
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-recipe-json'])).toThrow(
      /requires --project-root/i
    )
  })

  it('rejects a security-shaped typo while allowing Chromium switches', () => {
    const normalized = normalizeServeModeArgv(['/AppRun', 'serve', '--no-pairng'])
    expect(() => getServeOptions(normalized)).toThrow(/Unknown flag --no-pairng.*--no-pairing/i)
    expect(
      getServeOptions(['/AppRun', '--serve', '--disable-gpu', '--disable-features=Vulkan'])
        .noPairing
    ).toBe(false)
  })

  it('still rejects a flag-shaped space value, as the CLI does', () => {
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-pairing-address', '--no-pairng'])
    ).toThrow(/Unknown flag --no-pairng.*--no-pairing/i)
  })

  it('ignores serve-looking arguments after the terminator', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--', '--serve-port', '1', '--serve-no-pairing'])
    ).toEqual(DEFAULT_OPTIONS)
  })

  it('requires a port value', () => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-port'])).toThrow(
      'Missing value for --serve-port.'
    )
  })

  it.each(['', '--serve-json', '--'])('rejects an unusable port value %j', (value) => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-port', value])).toThrow(
      'Missing value for --serve-port.'
    )
  })

  it.each([
    ['--serve-host', '--host', 'bindHost', '100.64.1.20'],
    ['--serve-name', '--name', 'serverName', 'build-box'],
    ['--serve-storage-namespace', '--storage-namespace', 'storageNamespace', 'team-a']
  ])('reads %s / %s in both the space and equals forms', (serveFlag, cliFlag, field, value) => {
    for (const argv of [
      ['/AppRun', '--serve', serveFlag, value],
      ['/AppRun', '--serve', `${serveFlag}=${value}`],
      ['/AppRun', '--serve', cliFlag, value],
      ['/AppRun', '--serve', `${cliFlag}=${value}`]
    ]) {
      delete process.env.ORCA_STORAGE_NAMESPACE
      expect(getServeOptions(argv)).toMatchObject({ [field]: value })
    }
  })

  it('reads --serve-https as a boolean in both spellings', () => {
    expect(getServeOptions(['/AppRun', '--serve', '--serve-https']).https).toBe(true)
    expect(getServeOptions(['/AppRun', '--serve', '--https']).https).toBe(true)
    // A boolean with an attached value is a string, matching the other serve booleans.
    expect(getServeOptions(['/AppRun', '--serve', '--serve-https=false']).https).toBe(false)
    expect(getServeOptions(['/AppRun', '--serve']).https).toBe(false)
  })

  it('advertises a pinned bind host, but never a wildcard one', () => {
    expect(getServeOptions(['/AppRun', '--serve', '--serve-host', '100.64.1.20'])).toMatchObject({
      bindHost: '100.64.1.20',
      pairingAddress: '100.64.1.20'
    })
    for (const wildcard of ['0.0.0.0', '::', '[::]', '*']) {
      expect(getServeOptions(['/AppRun', '--serve', '--serve-host', wildcard])).toMatchObject({
        bindHost: wildcard,
        pairingAddress: null
      })
    }
  })

  it('keeps an explicit pairing address ahead of the bind host', () => {
    expect(
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-host',
        '100.64.1.20',
        '--serve-pairing-address',
        'orca.example.com'
      ]).pairingAddress
    ).toBe('orca.example.com')
  })

  it('resolves the server name as flag > ORCA_SERVE_NAME > hostname', () => {
    process.env.ORCA_SERVE_NAME = 'from-env'
    expect(getServeOptions(['/AppRun', '--serve', '--serve-name', 'from-flag']).serverName).toBe(
      'from-flag'
    )
    expect(getServeOptions(['/AppRun', '--serve']).serverName).toBe('from-env')
    process.env.ORCA_SERVE_NAME = '   '
    expect(getServeOptions(['/AppRun', '--serve']).serverName).toBe(hostname())
  })

  it('normalizes the storage namespace into ORCA_STORAGE_NAMESPACE for the static handler', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-storage-namespace', 'team-a'])
        .storageNamespace
    ).toBe('team-a')
    expect(process.env.ORCA_STORAGE_NAMESPACE).toBe('team-a')

    delete process.env.ORCA_STORAGE_NAMESPACE
    process.env.ORCA_STORAGE_NAMESPACE = 'from-env'
    expect(getServeOptions(['/AppRun', '--serve']).storageNamespace).toBe('from-env')
  })

  it('rejects half a TLS keypair', () => {
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-https', '--serve-cert', '/tmp/server.crt'])
    ).toThrow(/--cert and --key together/i)
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-https', '--serve-key', '/tmp/server.key'])
    ).toThrow(/--cert and --key together/i)
  })

  it('rejects a TLS keypair that no --https would ever read', () => {
    expect(() =>
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-cert',
        '/tmp/server.crt',
        '--serve-key',
        '/tmp/server.key'
      ])
    ).toThrow(/--cert and --key with --https/i)
  })

  it.each([
    ['--serve-cert', '/tmp/server.crt', '--serve-key', '/tmp/server.key'],
    ['--serve-cert=/tmp/server.crt', '--serve-key=/tmp/server.key'],
    ['--cert', '/tmp/server.crt', '--key', '/tmp/server.key'],
    ['--cert=/tmp/server.crt', '--key=/tmp/server.key']
  ])('reads a TLS keypair from %s', (...tlsArgv) => {
    expect(getServeOptions(['/AppRun', '--serve', '--serve-https', ...tlsArgv])).toMatchObject({
      https: true,
      tlsCertPath: '/tmp/server.crt',
      tlsKeyPath: '/tmp/server.key'
    })
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
