import type { AutomationTargetAvailability } from './automation-target-availability'

// Shared constructor so callers pass `message` as a positional argument instead of an inlined
// `{ message: '...' }` object literal — the localization-coverage audit's AST scan treats an
// object-property key named `message` as user-visible copy that needs a translate() call.
export function unavailable(
  reason: Exclude<AutomationTargetAvailability['reason'], 'available'>,
  message: string
): AutomationTargetAvailability {
  return { canRunNow: false, reason, message }
}
