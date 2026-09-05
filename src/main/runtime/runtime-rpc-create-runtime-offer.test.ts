import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'

vi.mock('../git/worktree', () => {
  const worktrees: unknown[] = []
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

type Reply = Record<string, unknown>

function startedServer(
  options: { defaultPairingAddress?: string | null } = {}
): Promise<OrcaRuntimeRpcServer> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-offer-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    webClientRoot: userDataPath,
    ...options
  })
  return server.start().then(() => server)
}

async function dispatchOverWebSocket(
  server: OrcaRuntimeRpcServer,
  deviceToken: string,
  params: unknown = {}
): Promise<Reply> {
  const replies: Reply[] = []
  await server['handleWebSocketMessage'](
    JSON.stringify({ id: 'req_offer', method: 'pairing.createRuntimeOffer', deviceToken, params }),
    (response) => replies.push(JSON.parse(response) as Reply),
    () => {}
  )
  return replies.at(-1)!
}

// Why: a real connected device has been marked seen, so it is no longer the "pending" grant
// getOrCreatePendingDevice would hand straight back — without this the minter returns the caller's
// own credential and every assertion about the minted grant is tautological.
function connectedRuntimeCaller(
  server: OrcaRuntimeRpcServer,
  name: string
): { deviceId: string; token: string } {
  const registry = server.getDeviceRegistry()!
  const caller = registry.addDevice(name, 'runtime')
  registry.updateLastSeen(caller.deviceId)
  return caller
}

describe('pairing.createRuntimeOffer over the runtime transports', () => {
  it('mints an offer for a runtime-scope WebSocket device', async () => {
    const server = await startedServer()
    const caller = connectedRuntimeCaller(server, 'web client')

    const reply = await dispatchOverWebSocket(server, caller.token, { address: '100.64.1.20' })

    expect(reply).toMatchObject({ ok: true })
    const result = (reply as { result: { available: true; pairingUrl: string; deviceId: string } })
      .result
    expect(result.available).toBe(true)
    expect(parsePairingCode(result.pairingUrl)?.endpoint).toContain('100.64.1.20')
    expect(result.deviceId).not.toBe(caller.deviceId)
    expect(server.getDeviceRegistry()?.getDevice(result.deviceId)?.scope).toBe('runtime')

    await server.stop()
  })

  it('refuses a mobile-scope WebSocket device and mints nothing', async () => {
    const server = await startedServer()
    const registry = server.getDeviceRegistry()!
    const phone = registry.addDevice('phone', 'mobile')
    const devicesBefore = registry.listDevices().length

    const reply = await dispatchOverWebSocket(server, phone.token)

    expect(reply).toMatchObject({ ok: false })
    expect(JSON.stringify(reply)).not.toContain('orca://pair')
    expect(registry.listDevices()).toHaveLength(devicesBefore)

    await server.stop()
  })

  it('mints an offer over the local Unix socket, which is local trust', async () => {
    const server = await startedServer()

    const response = await server['handleMessage'](
      JSON.stringify({
        id: 'req_socket_offer',
        authToken: server['authToken'],
        method: 'pairing.createRuntimeOffer',
        params: { address: '100.64.1.20', rotate: true }
      })
    )

    expect(response).toMatchObject({ ok: true, result: { available: true } })

    await server.stop()
  })

  it("falls back to the serve's configured pairing address when the caller passes none", async () => {
    const server = await startedServer({ defaultPairingAddress: '100.64.1.20:6768' })
    const caller = connectedRuntimeCaller(server, 'cli')

    const reply = await dispatchOverWebSocket(server, caller.token)

    const result = (reply as { result: { available: true; endpoint: string } }).result
    expect(result.endpoint).toBe('ws://100.64.1.20:6768')

    await server.stop()
  })

  it("treats a blank address as none so the serve's configured address still wins", async () => {
    const server = await startedServer({ defaultPairingAddress: '100.64.1.20:6768' })
    const caller = connectedRuntimeCaller(server, 'cli')

    const reply = await dispatchOverWebSocket(server, caller.token, { address: '  ' })

    const result = (reply as { result: { available: true; endpoint: string } }).result
    expect(result.endpoint).toBe('ws://100.64.1.20:6768')

    await server.stop()
  })

  // Why: STA-2370 — a dropped reach turns "This computer only" into a grant that rebinds every
  // interface on the next launch, so the wire must carry the caller's declared choice.
  it('records the declared reach on the minted grant', async () => {
    const server = await startedServer()
    const registry = server.getDeviceRegistry()!
    const caller = connectedRuntimeCaller(server, 'web client')

    const reply = await dispatchOverWebSocket(server, caller.token, {
      address: '127.0.0.1',
      reach: 'this-computer'
    })

    const result = (reply as { result: { available: true; deviceId: string } }).result
    expect(registry.getDevice(result.deviceId)?.pairingReach).toBe('this-computer')

    await server.stop()
  })

  it('defaults the minted grant to network reach when the caller declares none', async () => {
    const server = await startedServer()
    const registry = server.getDeviceRegistry()!
    const caller = connectedRuntimeCaller(server, 'cli')

    const reply = await dispatchOverWebSocket(server, caller.token, { address: '100.64.1.20' })

    const result = (reply as { result: { available: true; deviceId: string } }).result
    expect(registry.getDevice(result.deviceId)?.pairingReach).toBe('network')

    await server.stop()
  })
})
