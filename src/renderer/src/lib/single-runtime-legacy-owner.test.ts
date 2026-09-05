import { describe, expect, it } from 'vitest'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'

const focusedOn = (activeRuntimeEnvironmentId: string | null, ids: string[]) => ({
  settings: { activeRuntimeEnvironmentId },
  runtimeEnvironments: ids.map((id) => ({ id }))
})

describe('getSingleFocusedRuntimeEnvironmentId', () => {
  it('returns nothing without a focused environment', () => {
    expect(getSingleFocusedRuntimeEnvironmentId(focusedOn(null, ['env-a']), false)).toBeNull()
    expect(getSingleFocusedRuntimeEnvironmentId(focusedOn('   ', ['env-a']), false)).toBeNull()
  })

  it('trusts the focus pointer before the environment catalog has loaded', () => {
    expect(
      getSingleFocusedRuntimeEnvironmentId(
        { settings: { activeRuntimeEnvironmentId: 'env-a' } },
        false
      )
    ).toBe('env-a')
  })

  it('keeps the desktop rule that a second environment means "unowned is local"', () => {
    expect(getSingleFocusedRuntimeEnvironmentId(focusedOn('env-a', ['env-a']), false)).toBe('env-a')
    expect(
      getSingleFocusedRuntimeEnvironmentId(focusedOn('env-a', ['env-a', 'env-b']), false)
    ).toBeNull()
  })

  it('keeps inheriting the focused server in web mode with several paired', () => {
    expect(
      getSingleFocusedRuntimeEnvironmentId(focusedOn('env-a', ['env-a', 'env-b']), true)
    ).toBe('env-a')
    expect(getSingleFocusedRuntimeEnvironmentId(focusedOn('env-a', ['env-b']), true)).toBeNull()
    expect(getSingleFocusedRuntimeEnvironmentId(focusedOn('env-a', []), true)).toBeNull()
  })
})
