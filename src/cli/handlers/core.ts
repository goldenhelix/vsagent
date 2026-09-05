import { spawn } from 'node:child_process'
import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/launch'
import { getServeOptionValidationError } from '../../shared/serve-option-validation'
import type { RuntimePairingOfferResult } from '../../shared/runtime-pairing-offer'

function formatRuntimePairingOffer(offer: RuntimePairingOfferResult): string {
  // Why: match the name the operator invoked — the vsagent launcher sets VSAGENT_BRAND_CLI, the same
  // seam the root help text uses. Both names run this one CLI.
  const bin = process.env.VSAGENT_BRAND_CLI === '1' ? 'vsagent' : 'orca'
  if (!offer.available) {
    return [`Pairing is unavailable (${offer.reason}).`, offer.guidance].join('\n')
  }
  const lines = [`Pairing URL: ${offer.pairingUrl}`, `Endpoint:    ${offer.endpoint}`]
  if (offer.webClientUrl) {
    lines.push(`Web client:  ${offer.webClientUrl}`)
  }
  const name = offer.serverName ?? '<name>'
  lines.push(
    '',
    'In a web client: Settings → Remote Servers → Add Server, paste the pairing URL',
    "  (adds this server's projects alongside the current ones).",
    '',
    `For CLI access from another host (\`${bin} --environment ${name} ...\`):`,
    `  ${bin} environment add --name ${name} --pairing-code '${offer.pairingUrl}'`
  )
  return lines.join('\n')
}

function envRecord(): Record<string, string> {
  // Why: the `orca` launcher runs Orca's Electron binary as Node, so this CLI
  // process carries ELECTRON_RUN_AS_NODE=1. Strip it before it reaches the
  // spawned `claude` (and any nested Electron it launches), which would
  // otherwise be forced into headless plain-Node mode.
  const env = stripElectronRunAsNode(process.env)
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function withTeammateModeAuto(args: string[]): string[] {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--teammate-mode' || arg.startsWith('--teammate-mode=')) {
      return args
    }
  }
  return ['--teammate-mode', 'auto', ...args]
}

async function runClaudeAgentTeams(env: Record<string, string>, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn('claude', withTeammateModeAuto(args), {
      stdio: 'inherit',
      env
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolve(code)
        return
      }
      resolve(signal ? 1 : 0)
    })
  })
}

function getOptionalServePort(flags: Map<string, string | boolean>): string | null {
  if (!flags.has('port')) {
    return null
  }
  const rawPort = flags.get('port')
  if (typeof rawPort !== 'string' || rawPort.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --port.')
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RuntimeClientError('invalid_argument', `Invalid --port value: ${rawPort}`)
  }
  return rawPort
}

/** Same missing-value contract as --port, for the flags that carry a free-form string. */
function getOptionalStringFlag(flags: Map<string, string | boolean>, name: string): string | null {
  if (!flags.has(name)) {
    return null
  }
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
  }
  return value
}

export const CORE_HANDLERS: Record<string, CommandHandler> = {
  'claude-teams': async ({ client, rawArgs }) => {
    if (process.platform === 'win32') {
      throw new RuntimeClientError(
        'unsupported_platform',
        'Claude Agent Teams native panes are not supported on Windows.'
      )
    }
    const paneKey = process.env.ORCA_PANE_KEY
    if (!paneKey) {
      throw new RuntimeClientError(
        'invalid_environment',
        'orca claude-teams must be run inside an Orca terminal.'
      )
    }
    const response = await client.call<{ launch: { env: Record<string, string> } }>(
      'agentTeams.prepareLaunch',
      {
        paneKey,
        env: envRecord()
      }
    )
    process.exitCode = await runClaudeAgentTeams(
      {
        ...envRecord(),
        ...response.result.launch.env
      },
      rawArgs ?? []
    )
  },
  open: async ({ client, json }) => {
    const result = await client.openOrca()
    printResult(result, json, formatCliStatus)
  },
  serve: async ({ flags, json }) => {
    const projectRootValue = flags.get('project-root')
    const projectRoot = typeof projectRootValue === 'string' ? projectRootValue : null
    const noPairing = flags.get('no-pairing') === true
    const mobilePairing = flags.get('mobile-pairing') === true
    const recipeJson = flags.get('recipe-json') === true
    const https = flags.get('https') === true
    const certPath = getOptionalStringFlag(flags, 'cert')
    const keyPath = getOptionalStringFlag(flags, 'key')
    const validationError = getServeOptionValidationError({
      noPairing,
      mobilePairing,
      recipeJson,
      projectRoot,
      https,
      tlsCertPath: certPath,
      tlsKeyPath: keyPath
    })
    if (validationError) {
      throw new RuntimeClientError('invalid_argument', validationError)
    }
    const port = getOptionalServePort(flags)
    const host = getOptionalStringFlag(flags, 'host')
    const serverName = getOptionalStringFlag(flags, 'name')
    const pairingAddressValue = flags.get('pairing-address')
    const exitCode = await serveOrcaApp({
      json,
      port,
      host,
      pairingAddress: typeof pairingAddressValue === 'string' ? pairingAddressValue : null,
      serverName,
      https,
      certPath,
      keyPath,
      noPairing,
      mobilePairing,
      recipeJson,
      projectRoot
    })
    process.exitCode = exitCode
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    printResult(result, json, formatStatus)
  },
  'pairing-url': async ({ client, flags, json }) => {
    const address = getOptionalStringFlag(flags, 'address')
    const result = await client.call<RuntimePairingOfferResult>('pairing.createRuntimeOffer', {
      address,
      rotate: flags.get('rotate') === true
    })
    if (!json && !result.result.available) {
      process.exitCode = 1
    }
    printResult(result, json, formatRuntimePairingOffer)
  }
}
