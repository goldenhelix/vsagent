// Why (VSAgent fork): deployments behind an authenticated reverse proxy
// (Tailscale serve, VSWarehouse SSO) treat network reachability as the auth
// boundary, so requiring users to know a tokenized pairing URL adds nothing.
// When enabled, GET on the root path 302-redirects to the web client with a
// STABLE shared pairing offer in the URL fragment: http://host:port/ "just
// works". Fragments resolve client-side and never appear in proxy access logs.
import type { IncomingMessage, ServerResponse } from 'node:http'

export type OpenPairingConfig = {
  enabled: boolean
  // When set, only requests carrying `x-vsagent-proxy-auth: <secret>` are
  // redirected — the reverse proxy injects the header, so direct-to-port
  // visitors on a shared network cannot mint a session.
  headerSecret: string | null
}

export function readOpenPairingConfig(env: NodeJS.ProcessEnv = process.env): OpenPairingConfig {
  const headerSecret = env.ORCA_SERVE_PAIRING_PROXY_SECRET?.trim() || null
  return {
    enabled: env.ORCA_SERVE_OPEN_PAIRING === '1' || headerSecret !== null,
    headerSecret
  }
}

// Derive the WebSocket endpoint browsers should dial, from the proxied
// request. X-Forwarded-* lets a TLS proxy advertise wss://proxy-host; a bare
// LAN/tailnet hit falls back to the Host header with the ws scheme.
export function deriveEndpointFromRequest(req: IncomingMessage): string | null {
  const forwardedHost = headerValue(req, 'x-forwarded-host')
  const host = forwardedHost ?? headerValue(req, 'host')
  if (!host) {
    return null
  }
  // Why: a TLS proxy advertises wss via X-Forwarded-Proto; a direct HTTPS serve
  // (--serve-https, no proxy) has no such header, so also treat an encrypted
  // socket as wss so browsers dial wss:// and avoid mixed-content blocking.
  const forwardedProto = headerValue(req, 'x-forwarded-proto')
  const directlyEncrypted = Boolean(req.socket && 'encrypted' in req.socket && req.socket.encrypted)
  const scheme =
    forwardedProto === 'https' || forwardedProto === 'wss' || directlyEncrypted ? 'wss' : 'ws'
  const prefix = headerValue(req, 'x-forwarded-prefix')
  const path = prefix && prefix !== '/' ? (prefix.startsWith('/') ? prefix : `/${prefix}`) : ''
  try {
    // Validates host syntax (rejects header junk) and normalizes the URL.
    const url = new URL(`${scheme}://${host}${path}`)
    const formatted = url.toString()
    return url.pathname === '/' && !url.search ? formatted.replace(/\/$/, '') : formatted
  } catch {
    return null
  }
}

// Returns true when it owned the response. mintPairingUrl receives the derived
// endpoint and returns the orca://pair offer for the shared device (or null
// when the runtime cannot mint offers yet).
export function handleOpenPairingRedirect(
  req: IncomingMessage,
  res: ServerResponse,
  config: OpenPairingConfig,
  mintPairingUrl: (endpoint: string) => string | null
): boolean {
  if (!config.enabled) {
    return false
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false
  }
  const pathname = (req.url ?? '').split('?')[0]
  // Why: only the bare root redirects. /web-index.html must stay fragment-run
  // (a same-path redirect would loop: fragments are never sent to the server).
  if (pathname !== '/') {
    return false
  }
  if (config.headerSecret !== null) {
    if (headerValue(req, 'x-vsagent-proxy-auth') !== config.headerSecret) {
      return false
    }
  }
  const endpoint = deriveEndpointFromRequest(req)
  if (!endpoint) {
    return false
  }
  const pairingUrl = mintPairingUrl(endpoint)
  if (!pairingUrl) {
    return false
  }
  // Why: a RELATIVE Location survives reverse-proxy path prefixes — the
  // browser resolves it against the externally visible URL.
  res.statusCode = 302
  res.setHeader('Location', `web-index.html#pairing=${encodeURIComponent(pairingUrl)}`)
  res.setHeader('Cache-Control', 'no-store')
  res.end()
  return true
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed ? (trimmed.split(',')[0]?.trim() ?? null) : null
}
