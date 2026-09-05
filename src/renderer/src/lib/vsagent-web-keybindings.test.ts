import { describe, expect, it } from 'vitest'
import {
  applyWebModeKeybindingOverrides,
  WEB_MODE_KEYBINDING_OVERRIDES
} from './vsagent-web-keybindings'
import {
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  keybindingMatchesInput,
  normalizeKeybinding,
  type KeybindingActionId
} from '../../../shared/keybindings'

describe('applyWebModeKeybindingOverrides', () => {
  it('is the identity function when not in web mode', () => {
    const overrides = { 'sidebar.left.toggle': ['Mod+B'] }
    expect(applyWebModeKeybindingOverrides(overrides, false)).toBe(overrides)
  })

  it('layers browser-safe chords under user overrides in web mode', () => {
    const result = applyWebModeKeybindingOverrides({}, true)
    expect(result['tab.newTerminal']).toEqual(['Mod+Alt+T'])
    expect(result['tab.close']).toEqual(['Mod+Alt+W'])
    expect(result['tab.reopenClosed']).toEqual(['Mod+Alt+Shift+T'])
    expect(result['workspace.create']).toEqual(['Mod+Alt+N'])
    // tab.rename is unbound so Cmd/Ctrl+R reaches the browser reload.
    expect(result['tab.rename']).toEqual([])
  })

  it('lets an explicit user override win over the web-mode remap', () => {
    const result = applyWebModeKeybindingOverrides({ 'tab.newTerminal': ['Mod+Shift+Y'] }, true)
    expect(result['tab.newTerminal']).toEqual(['Mod+Shift+Y'])
  })

  it('produces valid, normalizable chords for every remapped action', () => {
    for (const bindings of Object.values(WEB_MODE_KEYBINDING_OVERRIDES)) {
      for (const binding of bindings ?? []) {
        expect(normalizeKeybinding(binding).ok).toBe(true)
      }
    }
  })

  it('remaps tab.newTerminal off the browser-reserved Cmd/Ctrl+T', () => {
    const keybindings = applyWebModeKeybindingOverrides({}, true)
    // The browser new-tab chord no longer triggers the app action...
    expect(
      keybindingMatchesInput(
        getEffectiveKeybindingsForAction('tab.newTerminal', 'linux', keybindings)[0] ?? '',
        { key: 't', code: 'KeyT', control: true },
        'linux'
      )
    ).toBe(false)
    // ...but the browser-safe Ctrl+Alt+T chord does.
    expect(
      keybindingMatchesInput(
        getEffectiveKeybindingsForAction('tab.newTerminal', 'linux', keybindings)[0] ?? '',
        { key: 't', code: 'KeyT', control: true, alt: true },
        'linux'
      )
    ).toBe(true)
  })

  it('does not introduce keybinding conflicts on any platform', () => {
    const keybindings = applyWebModeKeybindingOverrides({}, true)
    // Treat every remapped action as customized so findKeybindingConflicts
    // surfaces any collision the remap created against existing defaults.
    const ignoredActionIds: KeybindingActionId[] = []
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const conflicts = findKeybindingConflicts(platform, keybindings, { ignoredActionIds })
      expect(conflicts).toEqual([])
    }
  })
})
