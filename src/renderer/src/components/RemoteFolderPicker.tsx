// Path-input picker with backend-driven autocomplete. Used in web mode where
// the native Electron open-dialog is unavailable.
//
// UX:
// - Type a path. As the user types we debounce-call `window.api.fs.autocomplete
//   Dir(path)` and render suggested subdirectory names.
// - Tab / ArrowDown moves into the suggestion list.
// - Enter accepts the selected suggestion (joins it to the current parent +
//   `/`), or, if nothing is selected, returns the typed path verbatim.
// - Escape closes the popover.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Result = { parent: string; suggestions: string[]; inputIsExistingDir: boolean }

export type RemoteFolderPickerProps = {
  /** Initial value of the path input. */
  initialValue?: string
  /** Label rendered above the input (optional). */
  label?: string
  /** Placeholder for the input. */
  placeholder?: string
  /** Called when the user accepts a path (Enter without an open dropdown,
   *  or by clicking the confirm button). */
  onPick: (absolutePath: string) => void
  /** Optional cancel handler — called on Escape. */
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
        setActiveIdx(-1)
      }
    } catch (err) {
      console.warn('[picker] autocomplete failed', err)
      if (seq === reqSeq.current) {
        setResult({ parent: '', suggestions: [], inputIsExistingDir: false })
      }
    }
  }, [])

  useEffect(() => {
    const handle = window.setTimeout(() => void runAutocomplete(value), DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [value, runAutocomplete])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const accept = useCallback(
    (raw: string) => {
      // Why: trim a trailing slash so callers receive a clean canonical path.
      const trimmed = raw.replace(/\/+$/, '') || '/'
      onPick(trimmed)
    },
    [onPick]
  )

  const buildAcceptedPath = useCallback(
    (suggestion: string): string => {
      if (!result) return value
      // Why: if the current input already ends in `/` the parent IS what we
      // listed, so we just append. Otherwise the user typed a prefix we
      // matched, so we replace the trailing prefix with the full name.
      const trailingSlash = value.endsWith('/')
      const base = trailingSlash ? value : value.slice(0, value.lastIndexOf('/') + 1)
      return base + suggestion
    },
    [value, result]
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
        const completed = buildAcceptedPath(result.suggestions[idx])
        setValue(completed + '/')
        setActiveIdx(-1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (activeIdx >= 0 && result?.suggestions[activeIdx]) {
          const completed = buildAcceptedPath(result.suggestions[activeIdx])
          accept(completed)
        } else {
          accept(value)
        }
      }
    },
    [accept, activeIdx, buildAcceptedPath, onCancel, result, value]
  )

  const visibleSuggestions = useMemo(() => result?.suggestions ?? [], [result])

  return (
    <div className="flex flex-col gap-2 w-full">
      {label && <label className="text-xs text-muted-foreground">{label}</label>}
      <div className="relative">
        <input
          ref={inputRef}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        {visibleSuggestions.length > 0 && (
          <div className="absolute z-10 left-0 right-0 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
            {visibleSuggestions.map((s, idx) => (
              <button
                type="button"
                key={s}
                className={`flex w-full items-center justify-between px-2.5 py-1.5 text-sm font-mono ${
                  idx === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                }`}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => {
                  const completed = buildAcceptedPath(s)
                  setValue(completed + '/')
                  setActiveIdx(-1)
                  inputRef.current?.focus()
                }}
              >
                <span>{s}</span>
                <span className="text-muted-foreground text-xs">↹</span>
              </button>
            ))}
          </div>
        )}
      </div>
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
          className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90"
          onClick={() => accept(value)}
        >
          Use this folder
        </button>
      </div>
      {result?.parent && (
        <div className="text-xs text-muted-foreground font-mono truncate">
          Looking in <span className="text-foreground">{result.parent}</span>
        </div>
      )}
    </div>
  )
}
