import { levenshtein } from './edit-distance'

export type ServeOptionValidationInput = {
  noPairing: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null | undefined
  https?: boolean | undefined
  tlsCertPath?: string | null | undefined
  tlsKeyPath?: string | null | undefined
}

export function getServeOptionValidationError(options: ServeOptionValidationInput): string | null {
  const hasCert = Boolean(options.tlsCertPath)
  if (hasCert !== Boolean(options.tlsKeyPath)) {
    // Why: half a keypair silently falls back to the self-signed certificate, so the operator would
    // believe their own certificate is in use.
    return 'Use --cert and --key together; a TLS certificate needs both files.'
  }
  if (hasCert && !options.https) {
    // Why: TLS material is read only when --https is on, so without it the server stays plain HTTP
    // while the operator believes they configured a certificate.
    return 'Use --cert and --key with --https; without it the server serves plain HTTP.'
  }
  if (options.noPairing && options.mobilePairing) {
    return 'Use either --mobile-pairing or --no-pairing, not both.'
  }
  if (options.recipeJson && options.noPairing) {
    return 'Recipe JSON output requires runtime pairing; remove --no-pairing.'
  }
  if (options.recipeJson && options.mobilePairing) {
    return 'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
  }
  if (options.recipeJson && !options.projectRoot) {
    return 'Recipe JSON output requires --project-root.'
  }
  return null
}

const SERVE_SECURITY_FLAG_NAMES = [
  '--no-pairing',
  '--serve-no-pairing',
  '--mobile-pairing',
  '--serve-mobile-pairing',
  '--recipe-json',
  '--serve-recipe-json',
  '--pairing-address',
  '--serve-pairing-address'
] as const

const SERVE_VALUE_FLAG_NAMES = new Set([
  '--port',
  '--serve-port',
  '--host',
  '--serve-host',
  '--pairing-address',
  '--serve-pairing-address',
  '--project-root',
  '--serve-project-root',
  '--cert',
  '--serve-cert',
  '--key',
  '--serve-key',
  '--name',
  '--serve-name',
  '--storage-namespace',
  '--serve-storage-namespace',
  '--pairing-code',
  '--environment'
])

function flagName(token: string): string {
  const equalsIndex = token.indexOf('=')
  return equalsIndex === -1 ? token : token.slice(0, equalsIndex)
}

/** Reject only near-miss pairing flags; Electron/Chromium switches stay open-ended. */
export function getServeFlagTypoError(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '--') {
      break
    }
    if (!token.startsWith('--')) {
      continue
    }
    const name = flagName(token)
    let suggestion: string | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of SERVE_SECURITY_FLAG_NAMES) {
      const distance = levenshtein(name, candidate)
      const maxDistance = candidate.startsWith(name) ? 3 : 2
      if (distance > 0 && distance <= maxDistance && distance < bestDistance) {
        suggestion = candidate
        bestDistance = distance
      }
    }
    if (suggestion) {
      return `Unknown flag ${name}. Did you mean ${suggestion}?`
    }

    // A value that is not flag-shaped belongs to the preceding known value flag.
    // A `--`-prefixed space token remains a flag, matching parseArgs; use `=` when
    // a value itself starts with `--`.
    if (!token.includes('=') && SERVE_VALUE_FLAG_NAMES.has(name)) {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('--')) {
        index += 1
      }
    }
  }
  return null
}
