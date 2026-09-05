import { hostname } from 'node:os'
import { isPairingWildcardHostname } from '../../shared/network/pairing-url'
import {
  getServeFlagTypoError,
  getServeOptionValidationError
} from '../../shared/serve-option-validation'

export type ServeOptions = {
  json: boolean
  wsPort?: number
  /** Exact listener address; null keeps the default all-interfaces bind. */
  bindHost: string | null
  pairingAddress: string | null
  noPairing: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null
  https: boolean
  tlsCertPath: string | null
  tlsKeyPath: string | null
  serverName: string | null
  storageNamespace: string | null
}

function optionsBeforeTerminator(argv: readonly string[]): readonly string[] {
  const terminatorIndex = argv.indexOf('--')
  return terminatorIndex === -1 ? argv : argv.slice(0, terminatorIndex)
}

function optionName(token: string): string {
  const equalsIndex = token.indexOf('=')
  return equalsIndex === -1 ? token : token.slice(0, equalsIndex)
}

function lastValueOccurrence(
  argv: readonly string[],
  flags: readonly string[]
): string | null | undefined {
  const flagNames = new Set(flags)
  let value: string | null | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    const name = optionName(token)
    if (!flagNames.has(name)) {
      continue
    }

    const equalsIndex = token.indexOf('=')
    if (equalsIndex !== -1) {
      const assigned = token.slice(equalsIndex + 1)
      value = assigned || null
      continue
    }

    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      value = next || null
      index += 1
    } else {
      value = null
    }
  }
  return value
}

function valueAfter(
  argv: readonly string[],
  flags: readonly string[],
  required: boolean,
  displayFlag: string
): string | null {
  const value = lastValueOccurrence(argv, flags)
  if (value === undefined || value === null) {
    if (required && value !== undefined) {
      throw new Error(`Missing value for ${displayFlag}.`)
    }
    return null
  }
  return value
}

function lastBooleanValue(argv: readonly string[], flags: readonly string[]): boolean {
  const flagNames = new Set(flags)
  let value = false
  for (const token of argv) {
    const name = optionName(token)
    if (!flagNames.has(name)) {
      continue
    }
    // CLI boolean flags are true only in bare form; `--flag=...` is a string value.
    value = !token.includes('=')
  }
  return value
}

function hasFlag(argv: readonly string[], flags: readonly string[]): boolean {
  const flagNames = new Set(flags)
  return argv.some((token) => flagNames.has(optionName(token)))
}

/** First value that survives trimming; a blank flag or env value falls through to the next source. */
function firstNonBlank(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return null
}

export function getServeOptions(argv: readonly string[]): ServeOptions {
  const optionsArgv = optionsBeforeTerminator(argv)
  const typoError = getServeFlagTypoError(optionsArgv)
  if (typoError) {
    throw new Error(typoError)
  }

  const rawPort = valueAfter(optionsArgv, ['--serve-port', '--port'], true, '--serve-port')
  let wsPort: number | undefined
  if (rawPort) {
    const parsedPort = Number(rawPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid --serve-port value: ${rawPort}`)
    }
    wsPort = parsedPort
  }

  const bindHost = firstNonBlank(
    valueAfter(optionsArgv, ['--serve-host', '--host'], false, '--serve-host')
  )
  const explicitPairingAddress = valueAfter(
    optionsArgv,
    ['--serve-pairing-address', '--pairing-address'],
    false,
    '--serve-pairing-address'
  )
  // Why: the served web client namespaces its browser storage from this, and the static web-client
  // handler reads the env var rather than ServeOptions, so a flag value is normalized back into it.
  const storageNamespace = firstNonBlank(
    valueAfter(
      optionsArgv,
      ['--serve-storage-namespace', '--storage-namespace'],
      false,
      '--serve-storage-namespace'
    ),
    process.env.ORCA_STORAGE_NAMESPACE
  )
  if (storageNamespace) {
    process.env.ORCA_STORAGE_NAMESPACE = storageNamespace
  }

  const options: ServeOptions = {
    // The CLI uses `flags.has('json')`, so even `--json=false` enables JSON output.
    json: hasFlag(optionsArgv, ['--serve-json', '--json']),
    ...(wsPort !== undefined ? { wsPort } : {}),
    bindHost,
    // Why: binding one interface (say a Tailscale address) while the advertised host stays at the
    // 127.0.0.1 default prints an unreachable pairing URL, so the bind host becomes the default
    // advertised address. A wildcard bind has no single reachable address and must not.
    pairingAddress:
      explicitPairingAddress ?? (bindHost && !isPairingWildcardHostname(bindHost) ? bindHost : null),
    noPairing: lastBooleanValue(optionsArgv, ['--serve-no-pairing', '--no-pairing']),
    mobilePairing: lastBooleanValue(optionsArgv, ['--serve-mobile-pairing', '--mobile-pairing']),
    recipeJson: lastBooleanValue(optionsArgv, ['--serve-recipe-json', '--recipe-json']),
    projectRoot: valueAfter(
      optionsArgv,
      ['--serve-project-root', '--project-root'],
      false,
      '--serve-project-root'
    ),
    // Why: serving TLS directly (wss:// + https://) lets a container expose HTTPS with no reverse
    // proxy. Self-signed by default; --serve-cert/--serve-key supply an operator certificate.
    https: lastBooleanValue(optionsArgv, ['--serve-https', '--https']),
    tlsCertPath: valueAfter(optionsArgv, ['--serve-cert', '--cert'], false, '--serve-cert'),
    tlsKeyPath: valueAfter(optionsArgv, ['--serve-key', '--key'], false, '--serve-key'),
    // Why: pairing offers carry this so a client gets a meaningful default saved-server name.
    serverName: firstNonBlank(
      valueAfter(optionsArgv, ['--serve-name', '--name'], false, '--serve-name'),
      process.env.ORCA_SERVE_NAME,
      hostname()
    ),
    storageNamespace
  }
  const validationError = getServeOptionValidationError(options)
  if (validationError) {
    throw new Error(validationError)
  }
  return options
}
