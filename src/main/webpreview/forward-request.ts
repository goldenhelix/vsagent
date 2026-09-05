// HTTP forwarding engine for the webpreview proxy: dial the upstream, follow
// top-level redirects server-side (retargeting the session on cross-origin
// hops), rewrite Set-Cookie/Location headers, and rewrite HTML/CSS/JS bodies
// so root-relative URLs stay inside the proxy. Split from proxy.ts (routing)
// so each file stays a focused, reviewable unit.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import { connectableLoopbackHost } from '../../shared/localhost-worktree-labels'
import { followSessionOrigin } from './registry'
import {
  injectRewriteScript,
  rewriteCssUrls,
  rewriteHtmlAttributes,
  rewriteJsImports
} from './response-rewrite'
import { sendLoopError, sendUpstreamError } from './error-pages'

export const WEBPREVIEW_PROXY_PREFIX = '/__orca/webpreview'
const PROXY_PREFIX = WEBPREVIEW_PROXY_PREFIX

// Headers stripped from the upstream request before forwarding — hop-by-hop or
// browser-specific things that don't belong to the origin.
const HOP_BY_HOP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'accept-encoding', // intentional — we want plain text so we can inject
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user'
])

// Headers stripped from the upstream response — hop-by-hop plus security
// headers that would stop the iframe rendering. The gateway is the source of
// truth for content security; the upstream's CSP never applied here because
// the client never actually contacted them.
const HOP_BY_HOP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-encoding', // we asked for uncompressed
  'content-length', // recomputed after HTML injection
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  // Why: a proxy session's upstream ORIGIN changes over time (address-bar
  // retargets reuse the same proxy path), so the browser must never reuse a
  // cached response for that path — a cached example.com document would keep
  // rendering after the session points at another site. Strip the upstream's
  // caching directives/validators; every writer stamps no-store below.
  'cache-control',
  'expires',
  'etag',
  'last-modified',
  'age'
])

export type ForwardArgs = {
  req: IncomingMessage
  res: ServerResponse
  target: URL
  sessionId: string
  // Origin used for the injection script's same-origin check. For _ext
  // proxy requests this is the target URL's own origin (no rewriting in
  // those responses), so passing undefined disables injection.
  targetOrigin?: string
  injectHtml: boolean
  // Why: on the top-level (session-rooted) proxy path, a cross-origin
  // redirect should mutate the session's target so the address bar tracks
  // the final URL — same semantics as a real browser tab following a 30x.
  // For _ext (itself a cross-origin escape hatch), don't mutate.
  followCrossOriginRedirect: boolean
}

// A real browser typically allows ~20 redirects; we cap lower because our
// session-update side effects compound on each hop.
const MAX_REDIRECT_FOLLOWS = 8

function isRedirectStatus(s: number): boolean {
  return s === 301 || s === 302 || s === 303 || s === 307 || s === 308
}

function doUpstreamRequest(
  target: URL,
  reqHeaders: IncomingMessage['headers'],
  method: string,
  reqBodyPipe: IncomingMessage | null
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:'
    const requester = isHttps ? httpsRequest : httpRequest
    const upstreamHeaders: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(reqHeaders)) {
      if (value === undefined) {
        continue
      }
      if (HOP_BY_HOP_REQUEST.has(name.toLowerCase())) {
        continue
      }
      upstreamHeaders[name] = value as string | string[]
    }
    upstreamHeaders['host'] = target.host
    upstreamHeaders['origin'] = `${target.protocol}//${target.host}`
    upstreamHeaders['referer'] =
      `${target.protocol}//${target.host}${target.pathname}${target.search}`
    upstreamHeaders['accept-encoding'] = 'identity'
    const upstreamReq = requester({
      method,
      protocol: target.protocol,
      // Why: a wildcard bind (0.0.0.0 / ::) is not a connectable destination on
      // Windows; same dial normalization as the WS tunnel and as
      // localhost-worktree-label-proxy. The `host` header above keeps the
      // origin the page believes it is talking to.
      hostname: connectableLoopbackHost(target.hostname),
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: upstreamHeaders,
      // Intentional: HTTPS dev servers are almost always self-signed, and the
      // operator explicitly pointed the pane at this origin (ignored for http).
      rejectUnauthorized: false
    })
    upstreamReq.on('error', reject)
    upstreamReq.on('response', resolve)
    if (reqBodyPipe) {
      reqBodyPipe.pipe(upstreamReq)
    } else {
      upstreamReq.end()
    }
  })
}

export async function forwardRequest(args: ForwardArgs): Promise<void> {
  const { req, res, sessionId } = args
  const dbg = process.env.ORCA_WEBPREVIEW_DEBUG === '1'
  const isTopLevelNav =
    req.headers['sec-fetch-dest'] === 'document' ||
    String(req.headers['accept'] || '').includes('text/html')
  // Why: follow redirects server-side instead of bouncing the browser.
  // For cross-origin redirects, update the session's targetOrigin so the
  // address bar (via postNav) tracks the final URL, and the rest of the
  // page's same-origin requests resolve against the right place. The
  // browser only ever sees the final, non-redirect response.
  let currentTarget = args.target
  const hops: string[] = []
  for (let depth = 0; depth <= MAX_REDIRECT_FOLLOWS; depth++) {
    hops.push(currentTarget.toString())
    let upstreamRes: IncomingMessage
    try {
      upstreamRes = await doUpstreamRequest(
        currentTarget,
        req.headers,
        req.method || 'GET',
        depth === 0 && req.method && req.method !== 'GET' && req.method !== 'HEAD' ? req : null
      )
    } catch (err) {
      return sendUpstreamError(req, res, currentTarget, err as NodeJS.ErrnoException)
    }
    const status = upstreamRes.statusCode ?? 0
    if (dbg) {
      console.log(
        `[webpreview] ${req.method} ${currentTarget.toString()} -> ${status}${
          isRedirectStatus(status)
            ? ` location=${String(upstreamRes.headers['location'] ?? '')}`
            : ''
        } depth=${depth} topNav=${isTopLevelNav} followCO=${args.followCrossOriginRedirect}`
      )
    }
    // Should we follow this redirect server-side?
    const loc = upstreamRes.headers['location']
    const shouldFollow =
      isRedirectStatus(status) &&
      typeof loc === 'string' &&
      isTopLevelNav &&
      depth < MAX_REDIRECT_FOLLOWS
    if (!shouldFollow) {
      // Terminal response — stream it to the client (with body rewriting).
      return streamResponseToClient(args, upstreamRes, currentTarget)
    }
    // Resolve the redirect target.
    let nextTarget: URL
    try {
      nextTarget = new URL(loc as string, currentTarget)
    } catch {
      // Can't parse the redirect — stream this 30x to the client as-is.
      return streamResponseToClient(args, upstreamRes, currentTarget)
    }
    // Discard the redirect's body — we don't show 30x bodies.
    upstreamRes.resume()
    if (nextTarget.origin !== currentTarget.origin) {
      if (!args.followCrossOriginRedirect) {
        // Renderer told us not to retarget (e.g. _ext path). Stream the
        // redirect itself with a rewritten _ext Location.
        return streamRedirectThroughExt(args, upstreamRes, currentTarget, nextTarget)
      }
      const updated = followSessionOrigin(sessionId, nextTarget.origin)
      if (!updated) {
        // Cap hit — bail with a 508-style error so the browser doesn't
        // try its own loop on a chain we know is bad.
        return sendLoopError(req, res, hops, MAX_REDIRECT_FOLLOWS)
      }
    }
    currentTarget = nextTarget
  }
  // Exhausted the depth budget without resolving.
  return sendLoopError(req, res, hops, MAX_REDIRECT_FOLLOWS)
}

function streamResponseToClient(
  args: ForwardArgs,
  upstreamRes: IncomingMessage,
  finalTarget: URL
): Promise<void> {
  const { res, sessionId } = args
  return new Promise((resolve) => {
    const proxyPathPrefix = `${PROXY_PREFIX}/${sessionId}`
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) {
        continue
      }
      const lower = name.toLowerCase()
      if (HOP_BY_HOP_RESPONSE.has(lower)) {
        continue
      }
      if (lower === 'location' && typeof value === 'string') {
        // Why: same-origin (relative to finalTarget) -> proxy-relative.
        // We only reach here for non-followed redirects; cross-origin
        // ones go through streamRedirectThroughExt.
        try {
          const u = new URL(value, finalTarget)
          if (u.origin === finalTarget.origin) {
            res.setHeader(name, proxyPathPrefix + u.pathname + u.search + u.hash)
          } else {
            res.setHeader(name, `${proxyPathPrefix}/_ext?u=${encodeURIComponent(u.toString())}`)
          }
        } catch {
          res.setHeader(name, value)
        }
        continue
      }
      if (lower === 'set-cookie') {
        const cookies = Array.isArray(value) ? value : [value]
        const rescoped = cookies.map((c) =>
          c.replace(/;\s*Path=[^;]*/gi, '').concat(`; Path=${proxyPathPrefix}`)
        )
        res.setHeader('Set-Cookie', rescoped)
        continue
      }
      res.setHeader(name, value as string | string[])
    }
    res.setHeader('Cache-Control', 'no-store')
    res.statusCode = upstreamRes.statusCode ?? 502
    const contentType = String(upstreamRes.headers['content-type'] || '')
    const isHtml = args.injectHtml && args.targetOrigin && contentType.includes('text/html')
    const isJs =
      args.injectHtml &&
      (contentType.includes('javascript') ||
        contentType.includes('application/x-javascript') ||
        contentType.includes('text/jsx'))
    const isCss = args.injectHtml && contentType.includes('text/css')
    if (!isHtml && !isJs && !isCss) {
      upstreamRes.pipe(res)
      upstreamRes.on('end', () => resolve())
      return
    }
    const chunks: Buffer[] = []
    upstreamRes.on('data', (c: Buffer) => chunks.push(c))
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      let rewritten = body
      if (isHtml) {
        rewritten = rewriteHtmlAttributes(rewritten, proxyPathPrefix)
        // Why: the injected script's TO must match the final upstream origin
        // (a server-side redirect may have changed it) so postNav reports the
        // right URL.
        if (args.targetOrigin) {
          rewritten = injectRewriteScript(rewritten, {
            prefix: proxyPathPrefix,
            targetOrigin: `${finalTarget.protocol}//${finalTarget.host}`
          })
        }
      } else if (isJs) {
        rewritten = rewriteJsImports(rewritten, proxyPathPrefix)
      } else if (isCss) {
        rewritten = rewriteCssUrls(rewritten, proxyPathPrefix)
      }
      const out = Buffer.from(rewritten, 'utf-8')
      res.setHeader('Content-Length', String(out.length))
      res.end(out)
      resolve()
    })
  })
}

function streamRedirectThroughExt(
  args: ForwardArgs,
  upstreamRes: IncomingMessage,
  finalTarget: URL,
  redirectTarget: URL
): Promise<void> {
  const { res, sessionId } = args
  return new Promise((resolve) => {
    const proxyPathPrefix = `${PROXY_PREFIX}/${sessionId}`
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) {
        continue
      }
      const lower = name.toLowerCase()
      if (HOP_BY_HOP_RESPONSE.has(lower)) {
        continue
      }
      if (lower === 'location') {
        continue
      }
      if (lower === 'set-cookie') {
        const cookies = Array.isArray(value) ? value : [value]
        const rescoped = cookies.map((c) =>
          c.replace(/;\s*Path=[^;]*/gi, '').concat(`; Path=${proxyPathPrefix}`)
        )
        res.setHeader('Set-Cookie', rescoped)
        continue
      }
      res.setHeader(name, value as string | string[])
    }
    res.setHeader(
      'Location',
      `${proxyPathPrefix}/_ext?u=${encodeURIComponent(redirectTarget.toString())}`
    )
    res.setHeader('Cache-Control', 'no-store')
    res.statusCode = upstreamRes.statusCode ?? 302
    res.end()
    void finalTarget
    resolve()
  })
}
