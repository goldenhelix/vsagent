import { RuntimeClientError } from './types'

export type ServeChildArgs = {
  json?: boolean
  port?: string | null
  host?: string | null
  pairingAddress?: string | null
  serverName?: string | null
  https?: boolean
  certPath?: string | null
  keyPath?: string | null
  noPairing?: boolean
  mobilePairing?: boolean
  recipeJson?: boolean
  projectRoot?: string | null
}

/**
 * The `--serve-*` argv a foreground `orca serve` child is spawned with.
 *
 * These names are the CLI's half of the contract that `getServeOptions`
 * (`src/main/startup/serve-options.ts`) parses and `normalizeServeModeArgv`
 * rewrites into; `src/cli/serve-electron-flag-parity.test.ts` fails when the
 * halves drift.
 */
export function buildServeChildArgs(args: ServeChildArgs): string[] {
  const childArgs = ['--serve']
  if (args.json) {
    childArgs.push('--serve-json')
  }
  if (args.port) {
    childArgs.push('--serve-port', args.port)
  }
  if (args.host) {
    childArgs.push('--serve-host', args.host)
  }
  if (args.pairingAddress) {
    childArgs.push('--serve-pairing-address', args.pairingAddress)
  }
  if (args.serverName) {
    childArgs.push('--serve-name', args.serverName)
  }
  if (args.https) {
    childArgs.push('--serve-https')
  }
  if (args.certPath) {
    childArgs.push('--serve-cert', args.certPath)
  }
  if (args.keyPath) {
    childArgs.push('--serve-key', args.keyPath)
  }
  if (args.noPairing) {
    childArgs.push('--serve-no-pairing')
  }
  if (args.mobilePairing) {
    childArgs.push('--serve-mobile-pairing')
  }
  if (args.recipeJson) {
    if (!args.projectRoot) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires --project-root.'
      )
    }
    childArgs.push('--serve-recipe-json', '--serve-project-root', args.projectRoot)
  }
  return childArgs
}
