import { describe, expect, it } from 'vitest'
import { buildServeRuntimeRpcOptions } from './serve-runtime-rpc-options'
import type { ServeOptions } from './serve-options'

function serveOptions(overrides: Partial<ServeOptions> = {}): ServeOptions {
  return {
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
    serverName: null,
    storageNamespace: null,
    ...overrides
  }
}

describe('buildServeRuntimeRpcOptions', () => {
  it('passes nothing through for a desktop launch', () => {
    expect(buildServeRuntimeRpcOptions(null)).toEqual({})
  })

  it('leaves the bind unpinned when --serve-host is absent', () => {
    // Why: an absent flag must keep serve on today's exposeNetworkByDefault wide bind, not pin it.
    expect(buildServeRuntimeRpcOptions(serveOptions())).not.toHaveProperty('pinnedBindHost')
  })

  it('pins the bind host from --serve-host', () => {
    expect(buildServeRuntimeRpcOptions(serveOptions({ bindHost: '100.64.1.20' }))).toMatchObject({
      pinnedBindHost: '100.64.1.20'
    })
  })

  it('pins an explicit wildcard bind host too', () => {
    // Why: `--host 0.0.0.0` is still an explicit answer; the pin is what makes it survive a restart,
    // and ensureNetworkExposure() allows widening to the address it was already pinned to.
    expect(buildServeRuntimeRpcOptions(serveOptions({ bindHost: '0.0.0.0' }))).toMatchObject({
      pinnedBindHost: '0.0.0.0'
    })
  })

  it('carries the advertised address and server name into on-demand offers', () => {
    expect(
      buildServeRuntimeRpcOptions(
        serveOptions({ pairingAddress: 'orca.internal:6768', serverName: 'build-box' })
      )
    ).toMatchObject({
      defaultPairingAddress: 'orca.internal:6768',
      serverDisplayName: 'build-box'
    })
  })

  it('enables TLS with no certificate paths when only --serve-https is set', () => {
    const options = buildServeRuntimeRpcOptions(serveOptions({ https: true }))
    expect(options.serveTls).toBe(true)
    expect(options).not.toHaveProperty('serveTlsCertPath')
    expect(options).not.toHaveProperty('serveTlsKeyPath')
  })

  it('forwards an operator certificate pair', () => {
    expect(
      buildServeRuntimeRpcOptions(
        serveOptions({
          https: true,
          tlsCertPath: '/etc/tls/cert.pem',
          tlsKeyPath: '/etc/tls/key.pem'
        })
      )
    ).toMatchObject({
      serveTls: true,
      serveTlsCertPath: '/etc/tls/cert.pem',
      serveTlsKeyPath: '/etc/tls/key.pem'
    })
  })

  it('drops certificate paths that arrive without --serve-https', () => {
    // Why: the material is read only while TLS is on, so passing the paths through would imply a
    // certificate is in use while the listener still serves plain HTTP.
    const options = buildServeRuntimeRpcOptions(
      serveOptions({ tlsCertPath: '/etc/tls/cert.pem', tlsKeyPath: '/etc/tls/key.pem' })
    )
    expect(options).not.toHaveProperty('serveTls')
    expect(options).not.toHaveProperty('serveTlsCertPath')
    expect(options).not.toHaveProperty('serveTlsKeyPath')
  })
})
