import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

let webModeForTest = false
vi.mock('./vsagent-web-mode', () => ({
  isVSAgentWebMode: () => webModeForTest
}))

import { dropLocalHostByIdInWebMode, dropLocalHostByKindInWebMode } from './vsagent-web-mode-hosts'

describe('dropLocalHostByKindInWebMode', () => {
  beforeEach(() => {
    webModeForTest = false
  })
  afterEach(() => {
    webModeForTest = false
  })

  const hosts = [
    { kind: 'local' as const, label: 'Local Mac' },
    { kind: 'ssh' as const, label: 'ssh box' },
    { kind: 'runtime' as const, label: 'Orca Server' }
  ]

  it('is a no-op on desktop (not web mode)', () => {
    expect(dropLocalHostByKindInWebMode(hosts)).toEqual(hosts)
  })

  it('drops the local-kind host in web mode', () => {
    webModeForTest = true

    expect(dropLocalHostByKindInWebMode(hosts)).toEqual([
      { kind: 'ssh', label: 'ssh box' },
      { kind: 'runtime', label: 'Orca Server' }
    ])
  })

  it('returns a new array, never the original reference', () => {
    expect(dropLocalHostByKindInWebMode(hosts)).not.toBe(hosts)
  })
})

describe('dropLocalHostByIdInWebMode', () => {
  beforeEach(() => {
    webModeForTest = false
  })
  afterEach(() => {
    webModeForTest = false
  })

  const hosts = [
    { id: LOCAL_EXECUTION_HOST_ID, label: 'Local Mac' },
    { id: 'runtime:abc', label: 'Orca Server' }
  ]

  it('is a no-op on desktop (not web mode)', () => {
    expect(dropLocalHostByIdInWebMode(hosts)).toEqual(hosts)
  })

  it('drops the phantom local host by id in web mode', () => {
    webModeForTest = true

    expect(dropLocalHostByIdInWebMode(hosts)).toEqual([{ id: 'runtime:abc', label: 'Orca Server' }])
  })
})
