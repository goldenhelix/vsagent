// HTTP proxy for the in-app browser feature. Mounted under
// `/__orca/webpreview/<sessionId>/<rest>` on the gateway. Forwards GET
// requests to `<targetOrigin>/<rest>`, rewrites Set-Cookie + Location
// headers, and injects a URL-rewriting script into HTML response bodies so
// in-page navigation stays inside the proxy.
//
// Inspired by MidTerm's WebPreviewProxyMiddleware. Trimmed scope:
//   - GET only (no POST/PUT yet — the renderer's address bar only issues
//     GETs; SPAs can still issue fetch POSTs via the rewriter and those
//     route through here too — TODO for future).
//   - No WebSocket upgrade yet (TODO).
//   - No service-worker shim.
//   - No content-encoding handling (we pass-through compressed responses).
//     We turn off Accept-Encoding on the upstream request so the response is
//     uncompressed and the HTML rewrite can mutate it.

import type { IncomingMessage, ServerResponse } from 'http'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import { getSession, updateSessionOrigin } from './registry'
import { buildRewriteScript } from './rewrite-script'

const PROXY_PREFIX = '/__orca/webpreview'

// Headers we strip from the upstream request before forwarding. These are
// hop-by-hop or browser-specific things that don't belong to the origin.
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

// Headers we strip from the upstream response before forwarding to the
// client. Hop-by-hop plus a few that would confuse the iframe context
// (security headers framing the page).
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
  // Why: these stop the iframe from rendering. The gateway is the source
  // of truth for content security; the upstream's CSP/X-Frame-Options
  // doesn't apply here because the client never actually contacted them.
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy'
])

export function isWebPreviewPath(reqUrl: string | undefined): boolean {
  if (!reqUrl) return false
  return reqUrl === PROXY_PREFIX || reqUrl.startsWith(PROXY_PREFIX + '/')
}

export async function handleWebPreview(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!req.url) {
    res.statusCode = 400
    return res.end('webpreview: empty url')
  }

  // URL form: /__orca/webpreview/<sessionId>/<rest...>
  // First path segment after PROXY_PREFIX is the session id.
  const afterPrefix = req.url.slice(PROXY_PREFIX.length)
  // Strip leading slash for split.
  const trimmed = afterPrefix.startsWith('/') ? afterPrefix.slice(1) : afterPrefix
  const firstSlash = trimmed.indexOf('/')
  let sessionId: string
  let restPath: string
  if (firstSlash === -1) {
    sessionId = trimmed.split('?')[0]
    const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?')) : ''
    restPath = '/' + query
  } else {
    sessionId = trimmed.slice(0, firstSlash)
    restPath = '/' + trimmed.slice(firstSlash + 1)
  }
  if (!sessionId) {
    res.statusCode = 400
    return res.end('webpreview: missing session id')
  }

  // Special path: /_ext?u=<encoded-url> — cross-origin escape hatch used by
  // the in-page rewriter when a script tries to load from a different host.
  if (restPath.startsWith('/_ext')) {
    const u = new URL(restPath, 'http://x').searchParams.get('u')
    if (!u) {
      res.statusCode = 400
      return res.end('webpreview: _ext requires ?u=')
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
      return res.end('webpreview: invalid _ext URL')
    }
  }

  const session = getSession(sessionId)
  if (!session) {
    res.statusCode = 404
    return res.end(`webpreview: unknown session "${sessionId}"`)
  }

  // Resolve the upstream URL: target origin + restPath.
  let upstreamUrl: URL
  try {
    upstreamUrl = new URL(restPath, session.targetOrigin)
  } catch {
    res.statusCode = 400
    return res.end('webpreview: failed to resolve upstream url')
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

type ForwardArgs = {
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
  // For _ext (which is itself a cross-origin escape hatch), don't mutate;
  // we let the redirect chain stay scoped to _ext.
  followCrossOriginRedirect: boolean
}

function forwardRequest(args: ForwardArgs): Promise<void> {
  const { req, res, target, sessionId } = args
  return new Promise((resolve) => {
    const isHttps = target.protocol === 'https:'
    const requester = isHttps ? httpsRequest : httpRequest
    const upstreamHeaders: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP_REQUEST.has(name.toLowerCase())) continue
      upstreamHeaders[name] = value as string | string[]
    }
    upstreamHeaders['host'] = target.host
    // Why: many SPA dev servers (Vite, webpack) check the Origin header for
    // HMR. Passing through the iframe's origin (the gateway) would fail —
    // set it to the target origin so dev tooling is happy.
    upstreamHeaders['origin'] = `${target.protocol}//${target.host}`
    upstreamHeaders['referer'] = `${target.protocol}//${target.host}${target.pathname}${target.search}`
    // Why: ask for uncompressed so HTML injection works without gunzipping.
    upstreamHeaders['accept-encoding'] = 'identity'

    const upstreamReq = requester({
      method: req.method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: upstreamHeaders,
      // Why: dev servers may serve a self-signed cert. The proxy is
      // user-driven and only reaches what the operator typed in the
      // address bar, so soft-checking TLS is acceptable here.
      rejectUnauthorized: false
    })

    upstreamReq.on('error', (err) => {
      // Why: node's `connect ECONNREFUSED` errors carry the code on the
      // error object itself; `.message` is usually populated too, but for
      // ENOTFOUND etc. it can be empty. Build a friendly explanation so
      // the renderer can show something users can act on (start your dev
      // server, check the port, etc.).
      const code = (err as NodeJS.ErrnoException).code
      const msg = err.message || String(err)
      console.warn(
        `[webpreview] upstream error for ${target.toString()}: code=${code} msg=${msg}`
      )
      const reason =
        code === 'ECONNREFUSED'
          ? `Nothing is listening on ${target.host}. Is your dev server running?`
          : code === 'ENOTFOUND'
            ? `Could not resolve ${target.hostname}. Check the hostname.`
            : code === 'ETIMEDOUT'
              ? `Connection to ${target.host} timed out.`
              : code === 'ECONNRESET'
                ? `${target.host} reset the connection.`
                : msg || 'Upstream error'
      const isHtmlRequest = (req.headers['accept'] || '').includes('text/html')
      const ct = isHtmlRequest ? 'text/html; charset=utf-8' : 'text/plain'
      // Why: an HTML body styled to look at home inside the iframe so the
      // user sees a real error page rather than raw text.
      const body = isHtmlRequest
        ? `<!doctype html><meta charset="utf-8"><title>Upstream error</title>
<style>
  html,body{height:100%}
  body{margin:0;display:grid;place-items:center;background:#0a0a0a;color:#e7e7e7;font:14px ui-sans-serif,system-ui,sans-serif}
  .card{max-width:560px;padding:24px;border:1px solid #2a2a2a;border-radius:12px;background:#141414}
  h1{margin:0 0 8px;font-size:15px;font-weight:600;color:#f87171}
  p{margin:6px 0;color:#a1a1aa}
  code{font:13px ui-monospace,Menlo,monospace;background:#1c1c1c;padding:1px 6px;border-radius:6px;color:#e7e7e7}
  .hint{margin-top:14px;color:#a1a1aa}
</style>
<div class="card">
  <h1>Can't reach the upstream</h1>
  <p>${escapeHtml(reason)}</p>
  <p>Target: <code>${escapeHtml(target.toString())}</code></p>
  ${code ? `<p>Code: <code>${escapeHtml(code)}</code></p>` : ''}
  <p class="hint">Start the server, then hit Reload (⟳) on the address bar.</p>
</div>`
        : `webpreview: ${reason} (target=${target.toString()}${code ? `, code=${code}` : ''})`
      res.statusCode = 502
      res.setHeader('Content-Type', ct)
      res.end(body)
      resolve()
    })

    upstreamReq.on('response', (upstreamRes) => {
      // Copy response headers, filter out hop-by-hop, rewrite Location +
      // Set-Cookie so they stay inside the proxy path.
      const proxyPathPrefix = `${PROXY_PREFIX}/${sessionId}`
      const statusCode = upstreamRes.statusCode ?? 0
      const isRedirect =
        statusCode === 301 ||
        statusCode === 302 ||
        statusCode === 303 ||
        statusCode === 307 ||
        statusCode === 308
      // Why: only follow on top-level navigations (the iframe load). Sub-resources
      // (scripts, images, XHR) handle redirects in the browser; updating the
      // session for those would break unrelated in-page fetches.
      const isTopLevelNav =
        (req.headers['sec-fetch-dest'] === 'document') ||
        String(req.headers['accept'] || '').includes('text/html')
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        const lower = name.toLowerCase()
        if (HOP_BY_HOP_RESPONSE.has(lower)) continue
        if (lower === 'location' && typeof value === 'string') {
          res.setHeader(
            name,
            rewriteLocation(value, target, proxyPathPrefix, {
              sessionId,
              followCrossOriginRedirect:
                args.followCrossOriginRedirect && isRedirect && isTopLevelNav
            })
          )
          continue
        }
        if (lower === 'set-cookie') {
          const cookies = Array.isArray(value) ? value : [value]
          // Why: scope cookies to the proxy path so different sessions
          // don't collide. The browser will only send these back to
          // requests under the same proxy session.
          const rescoped = cookies.map((c) =>
            c.replace(/;\s*Path=[^;]*/gi, '').concat(`; Path=${proxyPathPrefix}`)
          )
          res.setHeader('Set-Cookie', rescoped)
          continue
        }
        res.setHeader(name, value as string | string[])
      }
      res.statusCode = upstreamRes.statusCode ?? 502

      const contentType = String(upstreamRes.headers['content-type'] || '')
      const isHtml = args.injectHtml && args.targetOrigin && contentType.includes('text/html')

      // Determine whether we should rewrite the body. HTML and JS are the
      // two types that contain URLs the browser will resolve relative to
      // its document origin — and for an iframe-hosted page that's the
      // gateway, not the upstream. Without rewriting, absolute paths like
      // `<script src="/docs/@vite/client">` skip the proxy entirely.
      const isJs = args.injectHtml && (
        contentType.includes('javascript') ||
        contentType.includes('application/x-javascript') ||
        contentType.includes('text/jsx')
      )

      if (!isHtml && !isJs) {
        upstreamRes.pipe(res)
        upstreamRes.on('end', () => resolve())
        return
      }

      // Buffer the body so we can rewrite it.
      const chunks: Buffer[] = []
      upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
      upstreamRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        let rewritten = body
        if (isHtml) {
          rewritten = rewriteHtmlAttributes(rewritten, proxyPathPrefix)
          rewritten = injectRewriteScript(rewritten, {
            prefix: proxyPathPrefix,
            targetOrigin: args.targetOrigin!
          })
        } else if (isJs) {
          rewritten = rewriteJsImports(rewritten, proxyPathPrefix)
        }
        const out = Buffer.from(rewritten, 'utf-8')
        res.setHeader('Content-Length', String(out.length))
        res.end(out)
        resolve()
      })
    })

    // For GET/HEAD the request body is irrelevant; for POST/PUT pipe it
    // through. (We strip transfer-encoding above; node will set
    // content-length if the body is in memory.)
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(upstreamReq)
    } else {
      upstreamReq.end()
    }
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

type RewriteLocationOpts = {
  sessionId: string
  // Why: true only on top-level navigations under the session-rooted proxy
  // path. When the upstream 30x's to a different origin (e.g. http→https,
  // apex→www), retarget the session at the new origin and keep the
  // redirect same-origin. This is what a real browser tab does — the
  // address bar tracks the final URL, and subsequent sub-resource fetches
  // resolve against the new origin via the same session.
  followCrossOriginRedirect: boolean
}

function rewriteLocation(
  location: string,
  base: URL,
  proxyPathPrefix: string,
  opts: RewriteLocationOpts
): string {
  try {
    const u = new URL(location, base)
    if (u.origin === base.origin) {
      return proxyPathPrefix + u.pathname + u.search + u.hash
    }
    if (opts.followCrossOriginRedirect) {
      updateSessionOrigin(opts.sessionId, u.origin)
      return proxyPathPrefix + u.pathname + u.search + u.hash
    }
    // Cross-origin redirect that we shouldn't follow — route through _ext.
    return `${proxyPathPrefix}/_ext?u=${encodeURIComponent(u.toString())}`
  } catch {
    return location
  }
}

function injectRewriteScript(
  html: string,
  opts: { prefix: string; targetOrigin: string }
): string {
  const script = `<script>${buildRewriteScript(opts)}</script>`
  // Try to insert as the very first <head> child so the rewriter runs
  // before any inline scripts make network calls. If there's no <head>,
  // insert before <body>; if neither exists (unlikely), prepend.
  const headIdx = html.search(/<head[\s>]/i)
  if (headIdx !== -1) {
    const endOfHeadTag = html.indexOf('>', headIdx)
    if (endOfHeadTag !== -1) {
      return html.slice(0, endOfHeadTag + 1) + script + html.slice(endOfHeadTag + 1)
    }
  }
  const bodyIdx = html.search(/<body[\s>]/i)
  if (bodyIdx !== -1) {
    return html.slice(0, bodyIdx) + script + html.slice(bodyIdx)
  }
  return script + html
}

// Why: static `<script src="/...">` etc. in the served HTML are URL-resolved
// by the browser parser at load time — they don't go through any JS we
// override at runtime. So absolute paths in initial HTML never reach the
// proxy and 404 against the gateway's static-files handler. Rewrite them
// server-side: every `<attr="/path">` where attr is src/href/action/etc.
// gets `/path` swapped to `<proxyPrefix>/path`.
function rewriteHtmlAttributes(html: string, proxyPathPrefix: string): string {
  const urlAttrRe = /(\s(?:src|href|action|formaction|poster|data)\s*=\s*)(["'])(\/(?!\/))/gi
  let out = html.replace(urlAttrRe, (_m, lead, quote, slash) => {
    return `${lead}${quote}${proxyPathPrefix}${slash}`
  })
  // srcset is comma-separated url[+descriptor] pairs.
  const srcsetRe = /(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi
  out = out.replace(srcsetRe, (_m, lead, quote, value) => {
    const rewritten = value.replace(
      /(^|,\s*)(\/(?!\/)[^\s,]*)/g,
      (_n: string, pre: string, url: string) => pre + proxyPathPrefix + url
    )
    return `${lead}${quote}${rewritten}${quote}`
  })
  return out
}

// Why: ES module imports use raw URL strings inside JS files. Vite serves
// modules whose body looks like `import "/docs/@vite/client"`. Those URLs
// are resolved against the document origin (the gateway), bypassing the
// proxy. Rewrite the textual import specifiers so they get the proxy
// prefix. We only rewrite ABSOLUTE-path specifiers (`/...`) — relative
// (`./...`, `../...`) resolve against the importing module's URL which
// is already under the proxy, so those work without changes.
//
// Patterns matched:
//   import "/x"               — bare
//   import x from "/y"        — default
//   import { … } from "/z"    — named
//   export … from "/q"
//   import("/dyn")            — dynamic import (string literal arg)
function rewriteJsImports(js: string, proxyPathPrefix: string): string {
  // Static imports / re-exports: `from "/..."` or `from '/...'`
  const fromRe = /(from\s*)(["'])(\/(?!\/))([^"']*?)\2/g
  let out = js.replace(fromRe, (_m, lead, quote, slash, rest) => {
    return `${lead}${quote}${proxyPathPrefix}${slash}${rest}${quote}`
  })
  // Bare `import "/..."` (side-effect import)
  const bareImportRe = /(\bimport\s*)(["'])(\/(?!\/))([^"']*?)\2/g
  out = out.replace(bareImportRe, (_m, lead, quote, slash, rest) => {
    return `${lead}${quote}${proxyPathPrefix}${slash}${rest}${quote}`
  })
  // Dynamic `import("/...")` — only when arg is a STRING LITERAL.
  // Templated/concatenated args fall through to the runtime r() helper.
  const dynImportRe = /(\bimport\s*\(\s*)(["'])(\/(?!\/))([^"']*?)\2(\s*\))/g
  out = out.replace(dynImportRe, (_m, lead, quote, slash, rest, close) => {
    return `${lead}${quote}${proxyPathPrefix}${slash}${rest}${quote}${close}`
  })
  return out
}
