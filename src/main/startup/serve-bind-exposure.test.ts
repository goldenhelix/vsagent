import { describe, expect, it } from 'vitest'
import { describeServeBindExposure } from './serve-bind-exposure'

describe('describeServeBindExposure', () => {
  it('warns for the default wide bind', () => {
    expect(describeServeBindExposure('0.0.0.0')).toContain('reachable from the network')
  })

  it('warns for a single routable interface', () => {
    const line = describeServeBindExposure('100.64.1.20')
    expect(line).toContain('100.64.1.20')
    expect(line).toContain('reachable from the network')
  })

  it('offers the narrowing advice only for a wildcard bind', () => {
    // Why: the advice is actionable against serve's wide default, but on an address the operator
    // already passed to --host it reads as "do the thing you just did".
    expect(describeServeBindExposure('0.0.0.0')).toContain('Pass --host <address>')
    expect(describeServeBindExposure('[::]')).toContain('Pass --host <address>')
    expect(describeServeBindExposure('100.64.1.20')).not.toContain('--host')
  })

  it('reports a loopback pin as local only', () => {
    expect(describeServeBindExposure('127.0.0.1')).toContain('local only')
  })

  it('strips IPv6 brackets before classifying', () => {
    // Why: the bind host is read back from the published `ws://[::1]:6768` endpoint, whose URL
    // hostname keeps the brackets — unstripped, `[::1]` fails the `::1` compare and reads as exposed.
    expect(describeServeBindExposure('[::1]')).toContain('local only')
    expect(describeServeBindExposure('[::]')).toContain('reachable from the network')
  })
})
