// Path-input picker with backend-driven autocomplete. Used in web mode where
// the native Electron open-dialog is unavailable.
//
// UX:
// - Type a path. Each keystroke kicks `window.api.fs.autocompleteDir(path)`
//   to list folder-name completions under the parent of the typed path.
// - Enter (or "Use this folder") submits the typed path as-is. The backend's
//   tilde-expanded absolute form (returned in `inputAbsolute`) is what
//   actually gets passed to the caller, so `~/foo` → `/home/.../foo`.
// - Tab + ArrowKeys navigate suggestions; Tab also completes-and-drills
//   (appends `/`). Mouse hover does NOT change keyboard selection — only
//   arrow keys do, so Enter never accidentally picks a hovered suggestion.
// - Click on a suggestion drills in (appends `name/` to the input, just
//   like Tab) rather than submitting — submitting takes a deliberate Enter.
// - Escape cancels the picker.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { RemoteFileBrowser } from '@/components/sidebar/RemoteFileBrowser'

type Result = {
  parent: string
  suggestions: string[]
  inputIsExistingDir: boolean
  inputAbsolute: string
  inputExists: boolean
}

export type RemoteFolderPickerProps = {
  /** Initial value of the path input. */
  initialValue?: string
  /** Label rendered above the input (optional). */
  label?: string
  /** Placeholder for the input. */
  placeholder?: string
  /** Called when the user accepts a path. The absolutePath is the
   *  canonical tilde-expanded form. */
  onPick: (absolutePath: string) => void
  /** Optional cancel handler — called on Escape or the Cancel button. */
  onCancel?: () => void
}

const DEBOUNCE_MS = 90

export function RemoteFolderPicker({
  initialValue = '~',
  label,
  placeholder = 'Type a path…',
  onPick,
  onCancel
}: RemoteFolderPickerProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [result, setResult] = useState<Result | null>(null)
  // Why: clicking Browse swaps the inline autocomplete view for an
  // interactive file-browser (the same one the SSH "Remote project" flow
  // uses, parameterised with a local browseDir). Selecting a folder there
  // returns to inline mode with the path pre-filled.
  const [browsing, setBrowsing] = useState(false)
  const localBrowseDir = useCallback(
    (dirPath: string) => window.api.fs.browseDir({ dirPath }),
    []
  )
  // Why: -1 means "no keyboard selection". Only ArrowKeys promote this above
  // -1. Mouse hover styles `.hover:bg-muted` on the suggestion row but does
  // NOT change activeIdx — that way Enter on the input never accidentally
  // picks a hovered suggestion. Idiomatic Spotlight/Quick-Open behaviour.
  const [activeIdx, setActiveIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Why: every keystroke kicks an autocomplete request. We tag each request
  // with a monotonic seq and only apply the latest response, so an in-flight
  // older request can't overwrite a newer one on a slow link.
  const reqSeq = useRef(0)

  const runAutocomplete = useCallback(async (input: string) => {
    const seq = ++reqSeq.current
    try {
      const r = await window.api.fs.autocompleteDir(input)
      if (seq === reqSeq.current) {
        setResult(r)
        // Reset selection — a typed character invalidates the prior
        // suggestion-list position.
        setActiveIdx(-1)
      }
    } catch (err) {
      console.warn('[picker] autocomplete failed', err)
      if (seq === reqSeq.current) {
        setResult(null)
      }
    }
  }, [])

  useEffect(() => {
    const handle = window.setTimeout(() => void runAutocomplete(value), DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [value, runAutocomplete])

  useEffect(() => {
    inputRef.current?.focus()
    // Why: don't select-all on focus. The default value is `~` which the
    // user usually keeps; auto-select would have them backspace it away
    // every time. Place the caret at end instead.
    const len = inputRef.current?.value.length ?? 0
    inputRef.current?.setSelectionRange(len, len)
  }, [])

  const acceptTyped = useCallback(() => {
    // Why: prefer the backend's canonical inputAbsolute (tilde-expanded,
    // resolved) over the raw typed string. If we don't have a result yet
    // (network race), fall back to the typed value — caller-side `repos.add`
    // will surface a helpful error if the path doesn't exist.
    const trimmedTyped = value.replace(/\/+$/, '') || '/'
    const path = result?.inputAbsolute || trimmedTyped
    onPick(path)
  }, [onPick, result, value])

  const drillInto = useCallback(
    (suggestion: string) => {
      // Why: completing a suggestion means "navigate into this folder",
      // matching shell Tab-completion. We strip the typed prefix and replace
      // with the full folder name plus a trailing `/` so the next debounce
      // lists that folder's contents.
      const trailingSlash = value.endsWith('/')
      const base = trailingSlash ? value : value.slice(0, value.lastIndexOf('/') + 1)
      const next = base + suggestion + '/'
      setValue(next)
      setActiveIdx(-1)
      inputRef.current?.focus()
    },
    [value]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel?.()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const max = result?.suggestions.length ?? 0
        if (max > 0) setActiveIdx((idx) => Math.min(max - 1, idx + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((idx) => Math.max(-1, idx - 1))
        return
      }
      if (e.key === 'Tab' && result && result.suggestions.length > 0) {
        e.preventDefault()
        const idx = activeIdx >= 0 ? activeIdx : 0
        drillInto(result.suggestions[idx])
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        // Why: Enter always submits the typed value, even when a suggestion
        // is highlighted via ArrowKeys. To navigate INTO a highlighted
        // suggestion, the user presses Tab (or clicks the row). This
        // separation is what makes "pick a folder that has sub-folders"
        // possible — Enter is unambiguously "accept what's in the input".
        acceptTyped()
      }
    },
    [acceptTyped, activeIdx, drillInto, onCancel, result]
  )

  const visibleSuggestions = useMemo(() => result?.suggestions ?? [], [result])
  const inputExists = result?.inputExists ?? false
  const acceptLabel = inputExists ? 'Use this folder' : 'Use this path'

  if (browsing) {
    // Why: hand off to the same RemoteFileBrowser the SSH flow uses,
    // parameterised with a local browseDir. On select, drop back into
    // inline mode with the path the user picked pre-filled — they can
    // then commit it with "Use this folder" or keep editing.
    return (
      <RemoteFileBrowser
        browseDir={localBrowseDir}
        initialPath={value && value.trim().length > 0 ? value : '~'}
        onSelect={(path) => {
          setValue(path)
          setBrowsing(false)
          // Defer focus to after the input re-mounts.
          requestAnimationFrame(() => {
            const len = path.length
            inputRef.current?.focus()
            inputRef.current?.setSelectionRange(len, len)
          })
        }}
        onCancel={() => {
          setBrowsing(false)
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      {label && <label className="text-xs text-muted-foreground">{label}</label>}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          className="flex-1 min-w-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          aria-label="Browse"
          title="Browse"
          className="shrink-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm hover:bg-muted"
        >
          <FolderOpen className="size-3.5" />
        </button>
      </div>
      {visibleSuggestions.length > 0 && (
        // Why: this is rendered as part of the flex column rather than
        // absolutely-positioned so it doesn't overlap the action buttons
        // below. A typical dialog has plenty of vertical room; the inline
        // list also makes it obvious the suggestions and the Submit button
        // are separate affordances.
        <div className="max-h-60 overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-sm">
          <div className="sticky top-0 border-b border-border/60 bg-popover/95 px-2.5 py-1 text-[10px] text-muted-foreground">
            ↑/↓ to navigate · Tab to drill in · Enter to pick the current path
          </div>
          {visibleSuggestions.map((s, idx) => (
            <button
              type="button"
              key={s}
              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-sm font-mono ${
                idx === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
              }`}
              // Why: NO `onMouseEnter` here — hover styling stays purely
              // visual via Tailwind's `:hover` rule. Setting activeIdx on
              // hover was the bug that made Enter "pick whatever the mouse
              // happens to be near" instead of the typed value.
              onClick={() => drillInto(s)}
            >
              <span>{s}</span>
              <span className="text-muted-foreground text-xs">↹</span>
            </button>
          ))}
        </div>
      )}
      {result?.parent && (
        <div className="text-xs text-muted-foreground font-mono truncate">
          {inputExists ? (
            <>
              Folder: <span className="text-foreground">{result.inputAbsolute}</span>
            </>
          ) : (
            <>
              Looking in <span className="text-foreground">{result.parent}</span>
            </>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          onClick={acceptTyped}
          // Why: disable the submit affordance when the path doesn't exist
          // so the user gets immediate feedback instead of a backend "not
          // a valid git repository" error a beat later. They can still hit
          // Enter to force-submit if they intend to create.
          disabled={result !== null && !inputExists}
          title={inputExists ? acceptLabel : 'That path does not exist'}
        >
          {acceptLabel}
        </button>
      </div>
    </div>
  )
}
