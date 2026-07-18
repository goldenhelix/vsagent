// HTTP+WS routing for the in-app browser feature. Mounted under
// `/__orca/webpreview/<sessionId>/<rest>` on the serve HTTP server. Resolves
// the session's upstream target and hands HTTP requests to forwardRequest
// (which forwards, follows redirects, and rewrites the body); the forwarding
// engine lives in forward-request.ts and the body rewriters in
// response-rewrite.ts so each file stays a focused, reviewable unit.
//
// Inspired by MidTerm's WebPreviewProxyMiddleware. Scope notes:
//   - GET-first (the address bar issues GETs; SPA fetch POSTs route here too).
//   - WebSocket upgrades ARE proxied (handleWebPreviewUpgrade): a transparent
//     raw byte tunnel to the session's upstream, so KasmVNC's binary VNC
//     stream and dev-server HMR sockets work inside the in-app browser.
//   - No service-worker shim; compressed responses pass through (we request
//     `accept-encoding: identity` upstream so the body rewrite can mutate it).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'
import { getSession, getLeakedPathSession, rememberLeakedPath } from './registry'
import { forwardRequest, WEBPREVIEW_PROXY_PREFIX } from './forward-request'

export { WEBPREVIEW_PROXY_PREFIX } from './forward-request'
const PROXY_PREFIX = WEBPREVIEW_PROXY_PREFIX

export function isWebPreviewPath(reqUrl: string | undefined): boolean {
  if (!reqUrl) {
    return false
  }
  return reqUrl === PROXY_PREFIX || reqUrl.startsWith(`${PROXY_PREFIX}/`)
}

export async function handleWebPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) {
    res.statusCode = 400
    res.end('webpreview: empty url')
    return
  }

  // URL form: /__orca/webpreview/<sessionId>/<rest...>
  const afterPrefix = req.url.slice(PROXY_PREFIX.length)
  const trimmed = afterPrefix.startsWith('/') ? afterPrefix.slice(1) : afterPrefix
  const firstSlash = trimmed.indexOf('/')
  let sessionId: string
  let restPath: string
  if (firstSlash === -1) {
    sessionId = trimmed.split('?')[0]
    const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?')) : ''
    restPath = `/${query}`
  } else {
    sessionId = trimmed.slice(0, firstSlash)
    restPath = `/${trimmed.slice(firstSlash + 1)}`
  }
  if (!sessionId) {
    res.statusCode = 400
    res.end('webpreview: missing session id')
    return
  }

  // Special path: /_ext?u=<encoded-url> — cross-origin escape hatch used by
  // the in-page rewriter when a script tries to load from a different host.
  if (restPath.startsWith('/_ext')) {
    const u = new URL(restPath, 'http://x').searchParams.get('u')
    if (!u) {
      res.statusCode = 400
      res.end('webpreview: _ext requires ?u=')
      return
    }
    try {
      const ext = new URL(u)
      return forwardRequest({
        req,
        res,
        target: ext,
        sessionId,
        injectHtml: false,
        followCrossOriginRedirect: false
      })
    } catch {
      res.statusCode = 400
      res.end('webpreview: invalid _ext URL')
      return
    }
  }

  const session = getSession(sessionId)
  if (!session) {
    res.statusCode = 404
    res.end(`webpreview: unknown session "${sessionId}"`)
    return
  }

  let upstreamUrl: URL
  try {
    upstreamUrl = new URL(restPath, session.targetOrigin)
  } catch {
    res.statusCode = 400
    res.end('webpreview: failed to resolve upstream url')
    return
  }

  return forwardRequest({
    req,
    res,
    target: upstreamUrl,
    sessionId,
    targetOrigin: session.targetOrigin,
    injectHtml: true,
    followCrossOriginRedirect: true
  })
}

// Why: SPA routers and root-relative assets sometimes hit the gateway WITHOUT
// the /__orca/webpreview/<id> prefix (e.g. VitePress pushes a base-relative URL,
// or a stylesheet references `/font.woff`). Without rescue those fall through to
// the gateway's SPA fallback and load the Orca renderer (recursion) or 404.
// Mirroring MidTerm's referer-based leak rescue: if the request's Referer is a
// preview route (or a previously-rescued leaked path), proxy it to that
// session's upstream instead.
function resolvePreviewSessionFromReferer(req: IncomingMessage): string | null {
  const referer = req.headers['referer']
  if (typeof referer !== 'string') {
    return null
  }
  let refPath: string
  try {
    refPath = new URL(referer).pathname
  } catch {
    return null
  }
  // Referer is a proxy route: /__orca/webpreview/<id>/...
  if (refPath.startsWith(`${PROXY_PREFIX}/`)) {
    const id = refPath.slice(PROXY_PREFIX.length + 1).split('/')[0]
    if (id && getSession(id)) {
      return id
    }
  }
  // Referer is itself a previously-rescued leaked path (asset-from-asset chain).
  return getLeakedPathSession(refPath) ?? null
}

export async function handleLeakedPreviewRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (!req.url || req.url.startsWith('/__orca/')) {
    // Never rescue gateway-owned paths (ws, health, the proxy itself).
    return false
  }
  const sessionId = resolvePreviewSessionFromReferer(req)
  if (!sessionId) {
    return false
  }
  const session = getSession(sessionId)
  if (!session) {
    return false
  }
  let upstreamUrl: URL
  try {
    upstreamUrl = new URL(req.url, session.targetOrigin)
  } catch {
    return false
  }
  // Remember this path so a follow-up request refered from it resolves too.
  rememberLeakedPath(req.url, sessionId)
  // followCrossOriginRedirect:false — a leaked asset must not retarget the
  // session (only top-level document navs adopt a new origin).
  await forwardRequest({
    req,
    res,
    target: upstreamUrl,
    sessionId,
    targetOrigin: session.targetOrigin,
    injectHtml: true,
    followCrossOriginRedirect: false
  })
  return true
}

// ── WebSocket upgrade proxying ─────────────────────────────────────────────
// The in-app browser proxies WebSockets too (KasmVNC's VNC stream, dev-server
// HMR, etc.). We open a raw socket to the session's upstream, replay the
// client's upgrade handshake (verbatim Sec-WebSocket-* so the end-to-end
// Key/Accept check still validates at the browser), and pipe bytes both ways.
// No frame interpretation — binary VNC frames pass through untouched.

// True when this upgrade is something the webpreview proxy should handle (a
// proxy-prefixed URL, or a prefix-less leaked path resolvable via Referer).
export function isWebPreviewUpgrade(req: IncomingMessage): boolean {
  return isWebPreviewPath(req.url) || resolvePreviewSessionFromReferer(req) !== null
}

// Resolve the upstream URL for an upgrade, from either the proxy-prefixed path
// or the Referer-based leaked-path rescue. Returns null when no live session
// owns it (caller destroys the socket).
function resolveUpgradeTarget(req: IncomingMessage): URL | null {
  if (!req.url) {
    return null
  }
  if (isWebPreviewPath(req.url)) {
    const afterPrefix = req.url.slice(PROXY_PREFIX.length)
    const trimmed = afterPrefix.startsWith('/') ? afterPrefix.slice(1) : afterPrefix
    const firstSlash = trimmed.indexOf('/')
    let sessionId: string
    let restPath: string
    if (firstSlash === -1) {
      sessionId = trimmed.split('?')[0]
      const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?')) : ''
      restPath = `/${query}`
    } else {
      sessionId = trimmed.slice(0, firstSlash)
      restPath = `/${trimmed.slice(firstSlash + 1)}`
    }
    const session = getSession(sessionId)
    if (!session) {
      return null
    }
    try {
      return new URL(restPath, session.targetOrigin)
    } catch {
      return null
    }
  }
  // Prefix-less leaked WS (e.g. a client that built the URL outside the
  // rewriter's reach): resolve via Referer like the HTTP leak rescue.
  const sessionId = resolvePreviewSessionFromReferer(req)
  if (!sessionId) {
    return null
  }
  const session = getSession(sessionId)
  if (!session) {
    return null
  }
  try {
    return new URL(req.url, session.targetOrigin)
  } catch {
    return null
  }
}

export function handleWebPreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const dbg = process.env.VSAGENT_PROXY_DEBUG === '1' || process.env.ORCA_WEBPREVIEW_DEBUG === '1'
  const target = resolveUpgradeTarget(req)
  if (!target) {
    socket.destroy()
    return
  }
  // ws→http / wss→https for the transport decision.
  const isTls = target.protocol === 'https:' || target.protocol === 'wss:'
  const port = Number(target.port) || (isTls ? 443 : 80)

  let piped = false
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  const onUpstreamReady = (upstream: Duplex): void => {
    piped = true
    if (connectTimer) {
      clearTimeout(connectTimer)
    }
    // Replay the handshake to the upstream. Preserve header casing/order via
    // rawHeaders (some WS servers are picky), but rewrite Host + Origin so an
    // origin-checking upstream (KasmVNC does) sees a same-origin request.
    const lines = [`${req.method || 'GET'} ${target.pathname}${target.search} HTTP/1.1`]
    const raw = req.rawHeaders
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const lower = raw[i].toLowerCase()
      if (lower === 'host' || lower === 'origin') {
        continue
      }
      lines.push(`${raw[i]}: ${raw[i + 1]}`)
    }
    lines.push(`Host: ${target.host}`)
    lines.push(`Origin: ${target.protocol}//${target.host}`)
    lines.push('', '')
    upstream.write(lines.join('\r\n'))
    // Forward any bytes the server already read past the request headers.
    if (head && head.length) {
      upstream.write(head)
    }
    if (dbg) {
      console.log(`[webpreview] ws tunnel ${req.url} -> ${target.toString()}`)
    }
    // Transparent byte relay (pipe handles backpressure for high-throughput
    // binary streams like VNC). The upstream's 101 + all frames flow back.
    socket.pipe(upstream)
    upstream.pipe(socket)
  }

  const upstream: Duplex = isTls
    ? tlsConnect(
        { host: target.hostname, port, servername: target.hostname, rejectUnauthorized: false },
        () => onUpstreamReady(upstream)
      )
    : netConnect({ host: target.hostname, port }, () => onUpstreamReady(upstream))

  // Why: a silently-dropped SYN (firewalled/unreachable upstream) fires neither
  // the connect callback nor a prompt 'error', so without this the client +
  // upstream sockets would leak until the OS TCP timeout (minutes). Bound it;
  // destroy(err) routes through the 'error' handler below for the 502 + cleanup.
  connectTimer = setTimeout(() => {
    upstream.destroy(new Error('webpreview: ws upstream connect timeout'))
  }, 15000)

  upstream.on('error', (err: NodeJS.ErrnoException) => {
    if (connectTimer) {
      clearTimeout(connectTimer)
    }
    if (dbg) {
      console.warn(
        `[webpreview] ws upstream error ${target.toString()}: ${err.code ?? err.message}`
      )
    }
    // If we never reached the relay, the client is still expecting an HTTP
    // handshake response — give it a 502 so it fails cleanly instead of hanging.
    if (!piped) {
      try {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      } catch {
        // socket already gone
      }
    }
    socket.destroy()
    upstream.destroy()
  })
  socket.on('error', () => {
    socket.destroy()
    upstream.destroy()
  })
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
}
