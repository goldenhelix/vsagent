import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PAIRING_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['pairing-url'],
    summary: 'Print a pairing URL to add this runtime as a remote server elsewhere',
    usage: 'orca pairing-url [--address <host>] [--rotate] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'address', 'rotate'],
    notes: [
      'Mints a runtime pairing offer for the running server. Feed the printed orca://pair?code=... link to `orca environment add --pairing-code` on another host (or paste it into the web client).',
      'Use --address to advertise a specific host/IP (e.g. a Tailscale name) when the server did not set --pairing-address; the embedded endpoint must be reachable from the other host.',
      'Use --rotate to mint a fresh device token instead of reusing the pending one.'
    ],
    examples: [
      'orca pairing-url',
      'orca pairing-url --address dev-host.example.ts.net:8445',
      'orca pairing-url --json'
    ]
  }
]
