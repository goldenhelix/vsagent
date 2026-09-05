import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--host <address>] [--pairing-address <host>] [--name <label>] [--https] [--cert <path>] [--key <path>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'host',
      'pairing-address',
      'name',
      'https',
      'cert',
      'key',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--host binds a single interface (for example a Tailscale address) instead of every interface, and becomes the advertised address unless --pairing-address overrides it.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      '--name labels this server in pairing offers; clients use it as the default saved-server name. Defaults to the machine hostname.',
      '--https serves wss:// and https:// directly with a self-signed certificate, which browsers warn about once. Pass --cert and --key together, alongside --https, to use your own certificate.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --host 100.64.1.20 --name build-box',
      'orca serve --https --cert /etc/orca/server.crt --key /etc/orca/server.key',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  }
]
