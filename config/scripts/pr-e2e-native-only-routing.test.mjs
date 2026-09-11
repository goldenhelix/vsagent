import { describe, expect, it } from 'vitest'
import { hasNativeImeSourceChange, shouldRunReusablePrE2e } from './pr-e2e-source-routing.mjs'

// Why (VSAgent fork): upstream's pr.yml is deleted here, so the assertions on
// its e2e_filter step are gone; the routing decisions themselves still ship.
describe('native-only PR E2E routing', () => {
  it('avoids generic E2E allocation for native-only changes while preserving its IME lane', () => {
    for (const file of [
      'tests/e2e/terminal-ibus-hangul-native.spec.ts',
      'config/scripts/run-terminal-ibus-hangul-e2e.mjs'
    ]) {
      expect(hasNativeImeSourceChange([file])).toBe(true)
      expect(shouldRunReusablePrE2e([file])).toBe(false)
    }
    expect(shouldRunReusablePrE2e([])).toBe(false)
    for (const spec of [
      'tests/e2e/ssh-startup-exec-readiness.spec.ts',
      'tests/e2e/paired-startup-exec-readiness.spec.ts',
      'tests/e2e/terminal-ime-exact-byte.spec.ts',
      'tests/e2e/future.spec.ts'
    ]) {
      expect(shouldRunReusablePrE2e([spec])).toBe(true)
      expect(shouldRunReusablePrE2e(['tests/e2e/terminal-ibus-hangul-native.spec.ts', spec])).toBe(
        true
      )
    }
  })
})
