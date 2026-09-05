import type { KeybindingActionId, KeybindingOverrides } from '../../../shared/keybindings'
import { isVSAgentWebMode } from './vsagent-web-mode'

// Why (VSAgent web mode): in a browser tab the desktop tab/window shortcuts
// collide with the browser's own chrome. Browsers reserve Ctrl/Cmd+T (new tab),
// +W (close tab), +Shift+T (reopen tab), +N (new window) at the browser level,
// so the app cannot reliably preventDefault them. Remap the app actions onto
// browser-safe Ctrl/Cmd+Alt chords and let the browser keep its native ones.
// These are layered UNDER the user's own overrides, so an explicit Settings
// binding still wins.
export const WEB_MODE_KEYBINDING_OVERRIDES: Readonly<
  Partial<Record<KeybindingActionId, string[]>>
> = {
  // Browser owns Cmd/Ctrl+T — move "new terminal tab" to Alt+T.
  'tab.newTerminal': ['Mod+Alt+T'],
  // Off Cmd+Alt+T (its macOS default) so it doesn't shadow tab.newTerminal.
  'tab.newAgent': ['Mod+Alt+G'],
  // Browser owns Cmd/Ctrl+W — move "close tab" to Alt+W.
  'tab.close': ['Mod+Alt+W'],
  // Off Mod+Alt+W (its default) so it doesn't shadow tab.close.
  'tab.closeAll': ['Mod+Alt+Shift+W'],
  // Browser owns Cmd/Ctrl+Shift+T (reopen closed tab) — move to Alt+Shift+T.
  'tab.reopenClosed': ['Mod+Alt+Shift+T'],
  // Browser owns Cmd/Ctrl+N (new window) — move "new workspace" to Alt+N.
  'workspace.create': ['Mod+Alt+N'],
  // Unbind: tab.rename's macOS default is Cmd+R, which would preventDefault and
  // swallow the browser's page reload. Cmd/Ctrl+R must reach the browser.
  'tab.rename': []
}

/**
 * Layer the browser-safe web-mode chords under the user's own keybinding
 * overrides. In desktop mode (or under vitest) this is the identity function, so
 * desktop behavior is unchanged. Exposed with an explicit `webMode` argument so
 * the remap can be unit-tested without the browser-location signal.
 */
export function applyWebModeKeybindingOverrides(
  overrides: KeybindingOverrides,
  webMode: boolean = isVSAgentWebMode()
): KeybindingOverrides {
  if (!webMode) {
    return overrides
  }
  return { ...WEB_MODE_KEYBINDING_OVERRIDES, ...overrides }
}
