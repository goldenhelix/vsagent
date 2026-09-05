import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { SHARED_ACCESS_DEVICE_NAME } from './runtime-rpc/runtime-rpc-pairing-types'

function createServer(
  overrides: { serverDisplayName?: string; webClientRoot?: string } = {}
): OrcaRuntimeRpcServer {
  return new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-shared-access-pairing-')),
    enableWebSocket: true,
    wsPort: 0,
    ...overrides
  })
}

function baseUrlOf(server: OrcaRuntimeRpcServer): string {
  const endpoint = server.getWebSocketEndpoint()
  if (!endpoint) {
    throw new Error('WebSocket transport did not start')
  }
  return `http://127.0.0.1:${new URL(endpoint).port}`
}

describe('createSharedAccessPairingUrl', () => {
  it('reuses one shared runtime device across repeated open-pairing hits', async () => {
    const server = createServer()
    await server.start()

    try {
      const first = server.createSharedAccessPairingUrl('wss://proxy.example.com')
      const second = server.createSharedAccessPairingUrl('wss://proxy.example.com/agent')
      expect(first).toBeTruthy()
      expect(second).toBeTruthy()

      // Why this is the point of the feature: every visitor shares ONE revocable credential, so a
      // trusted-proxy deployment does not grow a registry entry per page load.
      const devices = server.getDeviceRegistry()?.listDevices() ?? []
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({
        name: SHARED_ACCESS_DEVICE_NAME,
        scope: 'runtime',
        pairingReach: 'network'
      })

      const firstOffer = parsePairingCode(first!)
      const secondOffer = parsePairingCode(second!)
      expect(firstOffer?.deviceToken).toBe(devices[0]?.token)
      expect(secondOffer?.deviceToken).toBe(firstOffer?.deviceToken)
      expect(firstOffer?.pairedDeviceId).toBe(devices[0]?.deviceId)
      expect(firstOffer?.scope).toBe('runtime')
      // The endpoint always mirrors the request the visitor actually arrived on.
      expect(firstOffer?.endpoint).toBe('wss://proxy.example.com')
      expect(secondOffer?.endpoint).toBe('wss://proxy.example.com/agent')
    } finally {
      await server.stop()
    }
  })

  it('carries the configured server display name', async () => {
    const server = createServer({ serverDisplayName: 'build-box' })
    await server.start()

    try {
      const url = server.createSharedAccessPairingUrl('ws://build-box:6768')
      expect(parsePairingCode(url!)?.name).toBe('build-box')
    } finally {
      await server.stop()
    }
  })

  it('returns null before the WebSocket listener is ready so the redirect falls through', () => {
    const server = createServer()

    expect(server.createSharedAccessPairingUrl('ws://build-box:6768')).toBeNull()
    expect(server.getDeviceRegistry()?.listDevices() ?? []).toHaveLength(0)
  })

  it('returns null instead of throwing when the offer cannot be encoded', async () => {
    const server = createServer()
    await server.start()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // A header-derived endpoint is attacker-influenced; an unencodable one must not 502 the page.
      expect(server.createSharedAccessPairingUrl('')).toBeNull()
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      await server.stop()
    }
  })
})

const REDIRECT_LOCATION_PREFIX = 'web-index.html#pairing='

// Relative Location so a reverse-proxy path prefix survives, and the offer rides in the fragment.
function redirectedOffer(response: Response): PairingOffer | null {
  const location = response.headers.get('location') ?? ''
  expect(location.startsWith(REDIRECT_LOCATION_PREFIX)).toBe(true)
  return parsePairingCode(decodeURIComponent(location.slice(REDIRECT_LOCATION_PREFIX.length)))
}

describe('open-pairing redirect wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('claims GET / ahead of the static web client and leaves web-index.html alone', async () => {
    vi.stubEnv('ORCA_SERVE_OPEN_PAIRING', '1')
    const webClientRoot = mkdtempSync(join(tmpdir(), 'orca-shared-access-web-'))
    writeFileSync(join(webClientRoot, 'web-index.html'), '<html>web</html>')
    const server = createServer({ webClientRoot })
    await server.start()

    try {
      const redirect = await fetch(`${baseUrlOf(server)}/`, { redirect: 'manual' })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get('cache-control')).toBe('no-store')
      const offer = redirectedOffer(redirect)
      expect(offer?.scope).toBe('runtime')

      // Why a second hit: this is the invariant the feature exists for — every visitor lands on the
      // SAME revocable credential, so the registry cannot grow an entry per page load. HEAD with
      // spoofed forwarded headers mirrors the release recipe's `curl -sI` probe behind a TLS proxy.
      const second = await fetch(`${baseUrlOf(server)}/`, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'x-forwarded-host': 'proxy.example', 'x-forwarded-proto': 'https' }
      })
      expect(second.status).toBe(302)
      const secondOffer = redirectedOffer(second)
      expect(secondOffer?.deviceToken).toBe(offer?.deviceToken)
      const devices = server.getDeviceRegistry()?.listDevices() ?? []
      expect(devices).toHaveLength(1)
      expect(devices[0]?.name).toBe(SHARED_ACCESS_DEVICE_NAME)
      // Why wss on a plain socket: X-Forwarded-Proto is the proxy's TLS termination, and a ws:// dial
      // from the https page it serves would be blocked as mixed content.
      expect(secondOffer?.endpoint).toBe('wss://proxy.example')

      // Why: a redirect on the web client's own path would loop — fragments never reach the server.
      const index = await fetch(`${baseUrlOf(server)}/web-index.html`, { redirect: 'manual' })
      expect(index.status).toBe(200)
      await expect(index.text()).resolves.toBe('<html>web</html>')
    } finally {
      await server.stop()
    }
  })

  it('serves the static web client at / when open pairing is off', async () => {
    const webClientRoot = mkdtempSync(join(tmpdir(), 'orca-shared-access-web-'))
    writeFileSync(join(webClientRoot, 'web-index.html'), '<html>web</html>')
    const server = createServer({ webClientRoot })
    await server.start()

    try {
      const response = await fetch(`${baseUrlOf(server)}/`, { redirect: 'manual' })
      expect(response.status).not.toBe(302)
      expect(server.getDeviceRegistry()?.listDevices() ?? []).toHaveLength(0)
    } finally {
      await server.stop()
    }
  })
})
