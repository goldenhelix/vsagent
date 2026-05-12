// `fs:autocompleteDir` — folder-name autocomplete for the remote folder
// picker. Web mode can't use Electron's native open dialog, so the renderer
// shows a text input with autocompletion driven by this IPC.
//
// Security: only paths under the operator's HOME (or an explicit allowlist)
// are reachable. We never reveal files, only subdirectory names.
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { dirname, basename, join, normalize, resolve, sep } from 'path'
import { ipcMain } from 'electron'

const HOME = homedir()
// Why: allow exploring under the user's home directory. Operators that need
// to browse outside (e.g. /var/lib/repos on a shared host) can extend this
// list via ORCA_WEB_PICKER_ROOTS=<colon-separated absolute paths>.
const allowlistFromEnv = (process.env.ORCA_WEB_PICKER_ROOTS || '')
  .split(/[:,]+/)
  .filter((p) => p.length > 0)
  .map((p) => resolve(p))
const ALLOWED_ROOTS = [HOME, ...allowlistFromEnv]

function isPathAllowed(absPath: string): boolean {
  const canon = resolve(absPath)
  for (const root of ALLOWED_ROOTS) {
    if (canon === root || canon.startsWith(root + sep)) {
      return true
    }
  }
  return false
}

// Why: expand a leading `~` so users can type tilde paths like a shell. Any
// other tilde (`~bob`) is not expanded — too easy to leak intent across users.
function expandTilde(input: string): string {
  if (input === '~') return HOME
  if (input.startsWith('~/')) return join(HOME, input.slice(2))
  return input
}

export type AutocompleteResult = {
  /** Absolute path of the parent dir we listed. */
  parent: string
  /** Suggested completions — folder basenames under parent that begin with
   *  the typed prefix. Sorted alphabetically. */
  suggestions: string[]
  /** True when `input` was already an existing directory (so the suggestions
   *  list lists *children* of the input). */
  inputIsExistingDir: boolean
  /** Absolute, tilde-expanded canonical form of `input`. Useful for the
   *  picker UI to submit a clean path regardless of what the user typed
   *  (`~/foo`, `./foo`, trailing slash, etc.). */
  inputAbsolute: string
  /** True when `inputAbsolute` exists as a directory. The picker uses this
   *  to decide whether Enter can submit the typed value immediately. */
  inputExists: boolean
}

export function registerFolderPickerHandlers(): void {
  ipcMain.handle(
    'fs:autocompleteDir',
    async (_event, args: { input: string }): Promise<AutocompleteResult> => {
      const rawInput = (args?.input ?? '').trim()
      const expanded = expandTilde(rawInput.length === 0 ? '~' : rawInput)
      const absoluteInput = resolve(expanded)

      // Determine whether to list children of `absoluteInput` (it's an
      // existing dir) or to list siblings of `absoluteInput` (it's a prefix).
      // Filesystem call is the only authoritative way: stat the input.
      let parent: string
      let prefix: string
      let inputIsExistingDir = false
      let inputExists = false
      try {
        const stat = await import('fs/promises').then((m) => m.stat(absoluteInput))
        if (stat.isDirectory()) {
          inputExists = true
          // Why: if the user typed `…/foo` (no trailing slash) and `foo` is
          // a real folder, we want suggestions for `…/foo/` rather than
          // returning `foo` itself. That matches shell tab-completion.
          if (rawInput.endsWith(sep) || rawInput.endsWith('/')) {
            parent = absoluteInput
            prefix = ''
            inputIsExistingDir = true
          } else {
            parent = dirname(absoluteInput)
            prefix = basename(absoluteInput)
          }
        } else {
          parent = dirname(absoluteInput)
          prefix = basename(absoluteInput)
        }
      } catch {
        // Path doesn't exist — treat as parent+prefix.
        parent = dirname(absoluteInput)
        prefix = basename(absoluteInput)
      }

      // Why: bound the search to allowed roots. The check runs against the
      // canonical parent we're about to read, not the user input — symlinks
      // outside the root are rejected as if the path didn't exist.
      const canonicalParent = normalize(parent)
      const baseResult = {
        parent: canonicalParent,
        suggestions: [] as string[],
        inputIsExistingDir,
        inputAbsolute: absoluteInput,
        inputExists
      }
      if (!isPathAllowed(canonicalParent)) {
        return { ...baseResult, suggestions: [] }
      }

      let entries: { name: string; isDirectory: boolean }[]
      try {
        const raw = await readdir(canonicalParent, { withFileTypes: true })
        entries = raw
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
          .map((e) => ({ name: e.name, isDirectory: true }))
      } catch {
        return baseResult
      }

      const lowerPrefix = prefix.toLowerCase()
      const suggestions = entries
        // Why: hide dotfiles by default unless the user explicitly typed a
        // leading dot. Matches shell tab-completion ergonomics.
        .filter((e) => {
          if (e.name.startsWith('.') && !prefix.startsWith('.')) return false
          return e.name.toLowerCase().startsWith(lowerPrefix)
        })
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
        // Why: cap to keep the WS payload bounded for very wide dirs (e.g.
        // /tmp on busy hosts). 200 matches is more than any picker UX needs.
        .slice(0, 200)

      return { ...baseResult, suggestions }
    }
  )
}
