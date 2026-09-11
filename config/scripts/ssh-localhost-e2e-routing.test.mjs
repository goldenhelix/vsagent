import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

// Why (VSAgent fork): upstream's e2e.yml is deleted here, so the assertions on
// its ssh-localhost job are gone; the spec routing it fed still ships.
it('selects the localhost journey for its remote hook authorities', () => {
  const spec = 'tests/e2e/ssh-localhost.spec.ts'
  for (const file of [
    'src/relay/relay-agent-hook-runtime.ts',
    'src/relay/agent-hook-server.ts',
    'src/relay/plugin-overlay.ts',
    'src/main/agent-hooks/server.ts',
    'src/main/ssh/ssh-relay-session.ts',
    'src/shared/agent-hook-relay.ts'
  ]) {
    expect(existsSync(resolve(import.meta.dirname, '../..', file)), file).toBe(true)
    expect(selectPrE2eSpecs([file])).toContain(spec)
  }
  expect(selectPrE2eSpecs(['src/renderer/src/components/Unrelated.tsx'])).not.toContain(spec)
})
