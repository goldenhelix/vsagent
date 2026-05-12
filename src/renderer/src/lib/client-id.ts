// Per-renderer-instance unique identifier. Two browser tabs against the
// same backend each get a different id. Used to dedupe session-state
// broadcasts: the originating renderer recognises its own id and skips
// re-hydrating with the value it just wrote.
//
// Why a renderer-side mint (not a backend-issued cookie): we want the id
// to be stable for the lifetime of a single browser tab — across renderer
// reloads it MAY change (we mint a new one) and that's fine, since a
// reload also re-reads the entire session via session.get anyway.
const clientId = crypto.randomUUID()

export function getClientId(): string {
  return clientId
}
