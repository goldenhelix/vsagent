import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const root = resolve(import.meta.dirname, '../..')
const runner = readFileSync(join(root, 'config/scripts/run-ssh-docker-e2e.mjs'), 'utf8')

// Why (VSAgent fork): upstream's e2e.yml is deleted here, so its lane-job
// assertions are gone; the runner opt-ins and the spec routing still ship.
it('runs SSH browser specs through a runner that enables their opt-ins', () => {
  for (const [spec, flag] of [
    ['tests/e2e/local-ssh-browser-routing.spec.ts', 'ORCA_E2E_LOCAL_SSH_BROWSER'],
    [
      'tests/e2e/ssh-client-hosted-browser-drop-reconnect.spec.ts',
      'ORCA_E2E_SSH_CLIENT_HOSTED_BROWSER'
    ]
  ]) {
    expect(runner).toContain(`'${spec}'`)
    expect(runner).toContain(`${flag}: '1'`)
  }
})

it('routes every Docker network-route source to the journey that covers it', () => {
  const spec = 'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts'
  for (const changed of [
    spec,
    'src/main/browser/ssh-browser-network-execution-route.ts',
    'src/main/browser/browser-network-deferred-socket.ts',
    'src/main/browser/browser-network-execution-route.ts',
    'src/main/browser/system-ssh-socks-client-socket.ts',
    'src/main/ssh/system-ssh-dynamic-forward-process.ts',
    'tests/e2e/helpers/docker-ssh-relay-target.ts',
    'tests/e2e/helpers/docker-ssh-relay-image.ts'
  ]) {
    expect(selectPrE2eSpecs([changed])).toContain(spec)
  }
  expect(selectPrE2eSpecs(['src/renderer/src/components/Unrelated.tsx'])).not.toContain(spec)
  expect(selectPrE2eSpecs(['tests/e2e/helpers/docker-ssh-relay-terminal-tabs.ts'])).not.toContain(
    spec
  )
})
