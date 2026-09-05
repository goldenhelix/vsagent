import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const AVAILABLE_OFFER = {
  available: true,
  pairingUrl: 'orca://pair?code=abc',
  endpoint: 'ws://100.64.1.20:6768',
  deviceId: 'device-1',
  serverName: 'build-box',
  webClientUrl: 'https://100.64.1.20:6768/web-index.html#pairing=abc'
}

const UNAVAILABLE_OFFER = {
  available: false,
  reason: 'websocket_unavailable',
  guidance: 'Inspect preceding runtime errors and choose an unused --port.'
}

async function runCapturingOutput(argv: string[]): Promise<string> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {})
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await main(argv, '/tmp/repo')
    return [...out.mock.calls, ...err.mock.calls].map((call) => String(call[0])).join('\n')
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

describe('orca pairing-url', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('mints an offer with the requested address and rotation', async () => {
    callMock.mockResolvedValue({ ok: true, result: AVAILABLE_OFFER })

    const printed = await runCapturingOutput([
      'pairing-url',
      '--address',
      '100.64.1.20',
      '--rotate'
    ])

    expect(callMock).toHaveBeenCalledWith('pairing.createRuntimeOffer', {
      address: '100.64.1.20',
      rotate: true
    })
    expect(printed).toContain('Pairing URL: orca://pair?code=abc')
    expect(printed).toContain('Web client:  https://100.64.1.20:6768/web-index.html#pairing=abc')
    expect(printed).toContain("orca environment add --name build-box --pairing-code 'orca://pair")
    expect(process.exitCode).toBeFalsy()
  })

  it('sends a null address and no rotation when neither flag is given', async () => {
    callMock.mockResolvedValue({ ok: true, result: AVAILABLE_OFFER })

    await runCapturingOutput(['pairing-url'])

    expect(callMock).toHaveBeenCalledWith('pairing.createRuntimeOffer', {
      address: null,
      rotate: false
    })
  })

  it('prints the reason and guidance and exits non-zero when pairing is unavailable', async () => {
    callMock.mockResolvedValue({ ok: true, result: UNAVAILABLE_OFFER })

    const printed = await runCapturingOutput(['pairing-url'])

    expect(printed).toContain('Pairing is unavailable (websocket_unavailable).')
    expect(printed).toContain(UNAVAILABLE_OFFER.guidance)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('keeps the JSON channel machine-readable and does not fail the process', async () => {
    callMock.mockResolvedValue({ ok: true, result: UNAVAILABLE_OFFER })

    const printed = await runCapturingOutput(['pairing-url', '--json'])

    expect(JSON.parse(printed)).toMatchObject({ ok: true, result: UNAVAILABLE_OFFER })
    expect(process.exitCode).toBeFalsy()
  })

  it('renames the CLI in the copy-paste examples when the vsagent launcher branded it', async () => {
    callMock.mockResolvedValue({ ok: true, result: AVAILABLE_OFFER })
    const previous = process.env.VSAGENT_BRAND_CLI
    process.env.VSAGENT_BRAND_CLI = '1'

    try {
      const printed = await runCapturingOutput(['pairing-url'])
      expect(printed).toContain('vsagent environment add --name build-box')
    } finally {
      if (previous === undefined) {
        delete process.env.VSAGENT_BRAND_CLI
      } else {
        process.env.VSAGENT_BRAND_CLI = previous
      }
    }
  })

  it('rejects --address with no value instead of minting an offer', async () => {
    callMock.mockResolvedValue({ ok: true, result: AVAILABLE_OFFER })

    const printed = await runCapturingOutput(['pairing-url', '--address'])

    expect(callMock).not.toHaveBeenCalled()
    expect(printed).toContain('Missing value for --address.')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
