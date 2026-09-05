import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketTransport } from './rpc/ws-transport'
import { loadOrCreateTlsCertificate } from './tls-certificate'
import type * as TlsCertificateModule from './tls-certificate'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

vi.mock('./tls-certificate', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof TlsCertificateModule
  return {
    ...actual,
    loadOrCreateTlsCertificate: vi.fn(actual.loadOrCreateTlsCertificate)
  }
})

const generateCertificate = vi.mocked(loadOrCreateTlsCertificate)

function userDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-serve-tls-'))
}

function wsTransportOf(server: OrcaRuntimeRpcServer): WebSocketTransport | undefined {
  return (server['activeTransports'] as unknown[]).find(
    (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
  )
}

function tlsMaterialOf(transport: WebSocketTransport | undefined): {
  cert: string | undefined
  key: string | undefined
} {
  const fields = transport as unknown as { tlsCert?: string; tlsKey?: string }
  return { cert: fields?.tlsCert, key: fields?.tlsKey }
}

describe('OrcaRuntimeRpcServer --serve-https', () => {
  it('publishes a ws:// endpoint and no TLS material when serveTls is off', async () => {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: userDataDir(),
      enableWebSocket: true,
      wsPort: 0,
      exposeNetworkByDefault: true
    })

    await server.start()
    try {
      expect(server.getWebSocketEndpoint()!.startsWith('ws://')).toBe(true)
      expect(tlsMaterialOf(wsTransportOf(server)).cert).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('publishes a wss:// endpoint on the initial bind with a self-signed certificate', async () => {
    const userDataPath = userDataDir()
    generateCertificate.mockClear()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      exposeNetworkByDefault: true,
      serveTls: true
    })

    await server.start()
    try {
      // Why the scheme matters: createWebClientUrl derives https:// from wss://, and a ws:// endpoint
      // served over TLS would make the web client dial plain WebSocket against an HTTPS listener.
      const endpoint = server.getWebSocketEndpoint()!
      expect(endpoint.startsWith('wss://')).toBe(true)
      expect(new URL(endpoint).hostname).toBe('0.0.0.0')
      const material = tlsMaterialOf(wsTransportOf(server))
      expect(material.cert).toContain('BEGIN CERTIFICATE')
      expect(material.key).toBeTruthy()
      expect(generateCertificate).toHaveBeenCalledWith(userDataPath)
    } finally {
      await server.stop()
    }
  })

  it('keeps wss:// and the same certificate across the pairing-time widen', async () => {
    const userDataPath = userDataDir()
    generateCertificate.mockClear()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      serveTls: true
    })

    await server.start()
    try {
      expect(server.getWebSocketEndpoint()).toBe(
        `wss://127.0.0.1:${wsTransportOf(server)!.resolvedPort}`
      )
      const before = tlsMaterialOf(wsTransportOf(server))

      await server.ensureNetworkExposure()

      // Why: the widen restarts the listener through the same code path, so a scheme derived only at
      // start() would republish ws:// and strand every client that dialled the TLS endpoint.
      expect(server.getWebSocketEndpoint()!.startsWith('wss://')).toBe(true)
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
      expect(tlsMaterialOf(wsTransportOf(server))).toEqual(before)
      // Why once: a regenerated self-signed certificate would break any client that pinned the
      // fingerprint the first listener presented.
      expect(generateCertificate).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('prefers an operator certificate over the self-signed one', async () => {
    const certSource = loadOrCreateTlsCertificate(userDataDir())
    const operatorDir = userDataDir()
    const certPath = join(operatorDir, 'operator-cert.pem')
    const keyPath = join(operatorDir, 'operator-key.pem')
    writeFileSync(certPath, certSource.cert, 'utf-8')
    writeFileSync(keyPath, certSource.key, 'utf-8')

    const userDataPath = userDataDir()
    generateCertificate.mockClear()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      exposeNetworkByDefault: true,
      serveTls: true,
      serveTlsCertPath: certPath,
      serveTlsKeyPath: keyPath
    })

    await server.start()
    try {
      expect(tlsMaterialOf(wsTransportOf(server))).toEqual({
        cert: certSource.cert,
        key: certSource.key
      })
      // Why: generating (and persisting) a self-signed pair alongside an operator certificate would
      // leave a second private key on disk that nothing serves.
      expect(generateCertificate).not.toHaveBeenCalled()
      expect(readdirSync(userDataPath).some((entry) => entry.endsWith('.pem'))).toBe(false)
    } finally {
      await server.stop()
    }
  })
})
