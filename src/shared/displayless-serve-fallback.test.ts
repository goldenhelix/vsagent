import { describe, expect, it } from 'vitest'
import {
  DISPLAYLESS_SERVE_FALLBACK_ENV,
  DISPLAYLESS_SERVE_OPT_IN_HINT,
  DISPLAYLESS_SERVE_OZONE_ARG,
  displaylessServeLaunchArgs,
  isDisplaylessServeFallbackEnabled
} from './displayless-serve-fallback'

describe('isDisplaylessServeFallbackEnabled', () => {
  it('is off by default so serve keeps upstream #17615 protection', () => {
    expect(isDisplaylessServeFallbackEnabled({})).toBe(false)
  })

  it('arms only on an exact opt-in', () => {
    expect(isDisplaylessServeFallbackEnabled({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: '1' })).toBe(true)
    expect(isDisplaylessServeFallbackEnabled({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: ' 1 ' })).toBe(
      true
    )
    // Why: a half-set variable must not silently trade browser panes away.
    expect(isDisplaylessServeFallbackEnabled({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: 'true' })).toBe(
      false
    )
    expect(isDisplaylessServeFallbackEnabled({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: '0' })).toBe(false)
    expect(isDisplaylessServeFallbackEnabled({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: '' })).toBe(false)
  })

  it('reads process.env when no env is passed', () => {
    const original = process.env[DISPLAYLESS_SERVE_FALLBACK_ENV]
    process.env[DISPLAYLESS_SERVE_FALLBACK_ENV] = '1'
    try {
      expect(isDisplaylessServeFallbackEnabled()).toBe(true)
    } finally {
      if (original === undefined) {
        delete process.env[DISPLAYLESS_SERVE_FALLBACK_ENV]
      } else {
        process.env[DISPLAYLESS_SERVE_FALLBACK_ENV] = original
      }
    }
  })

  it('is spelled ORCA_* so serve code stays brand-free', () => {
    expect(DISPLAYLESS_SERVE_FALLBACK_ENV).toBe('ORCA_ALLOW_DISPLAYLESS_SERVE')
  })
})

describe('displaylessServeLaunchArgs', () => {
  // Verified on Electron 43.4.1 with no DISPLAY: this switch on argv reaches `ready`, while
  // `--headless` alone segfaults and appending either from JS never selects the platform.
  it('passes only the Ozone platform switch when armed on Linux', () => {
    expect(displaylessServeLaunchArgs({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: '1' }, 'linux')).toEqual([
      '--ozone-platform=headless'
    ])
    expect(DISPLAYLESS_SERVE_OZONE_ARG).toBe('--ozone-platform=headless')
  })

  it('adds nothing when the opt-in is absent', () => {
    expect(displaylessServeLaunchArgs({}, 'linux')).toEqual([])
  })

  it('adds nothing off Linux, which has no Ozone platform to pick', () => {
    expect(displaylessServeLaunchArgs({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: '1' }, 'darwin')).toEqual(
      []
    )
    expect(displaylessServeLaunchArgs({ [DISPLAYLESS_SERVE_FALLBACK_ENV]: '1' }, 'win32')).toEqual(
      []
    )
  })

  // Why: an operator whose launcher execs Electron itself (a container entrypoint,
  // a CI deploy script) only ever sees this first hint — it has to carry the whole
  // recipe, or setting the variable alone leaves serve failing the same way.
  it('tells a custom launcher about the switch, not just the variable', () => {
    expect(DISPLAYLESS_SERVE_OPT_IN_HINT).toContain(DISPLAYLESS_SERVE_FALLBACK_ENV)
    expect(DISPLAYLESS_SERVE_OPT_IN_HINT).toContain(DISPLAYLESS_SERVE_OZONE_ARG)
  })
})
