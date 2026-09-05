// Bind-candidate policy for the WebSocket transport: which ports to try, in which order, and which
// listen failures may fall through to the next candidate.

// Why: bind a persisted fallback first so devices paired to it aren't stranded (STA-1511); serve --port flips to pinned-first (issue #8535); on failure each candidate falls through to OS-assigned port 0.
export function resolveBindCandidatePorts(options: {
  port: number
  fallbackPort: number | undefined
  preferPinnedPort: boolean
}): { candidatePorts: number[]; persistedFallbackPort: number | undefined } {
  const { port, fallbackPort, preferPinnedPort } = options
  const persistedFallbackPort =
    fallbackPort !== undefined && fallbackPort !== 0 && fallbackPort !== port
      ? fallbackPort
      : undefined
  const candidatePorts =
    persistedFallbackPort === undefined
      ? [port]
      : preferPinnedPort
        ? [port, persistedFallbackPort]
        : [persistedFallbackPort, port]
  return { candidatePorts, persistedFallbackPort }
}

// Why: EADDRINUSE, and an EACCES raised by this very listen, are the only failures another port could fix.
export function isPortListenFallbackError(error: unknown, port: number): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }
  if (error.code === 'EADDRINUSE') {
    return true
  }
  return (
    error.code === 'EACCES' &&
    'syscall' in error &&
    error.syscall === 'listen' &&
    'port' in error &&
    error.port === port
  )
}
