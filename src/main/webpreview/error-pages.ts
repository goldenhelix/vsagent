// Branded HTML/plain error responses for the webpreview proxy: the redirect-
// loop guard and the upstream-unreachable page (the "Is your dev server
// running?" screen). Split from forward-request.ts to keep that engine focused.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { escapeHtml } from './response-rewrite'

export function sendLoopError(
  req: IncomingMessage,
  res: ServerResponse,
  hops: string[],
  maxFollows: number
): Promise<void> {
  const isHtmlRequest = String(req.headers['accept'] || '').includes('text/html')
  const summary = hops.slice(0, 6).join(' →\n  ') + (hops.length > 6 ? ' →\n  …' : '')
  const ct = isHtmlRequest ? 'text/html; charset=utf-8' : 'text/plain'
  const body = isHtmlRequest
    ? `<!doctype html><meta charset="utf-8"><title>Too many redirects</title>
<style>
  html,body{height:100%}
  body{margin:0;display:grid;place-items:center;background:#0a0a0a;color:#e7e7e7;font:14px ui-sans-serif,system-ui,sans-serif}
  .card{max-width:640px;padding:24px;border:1px solid #2a2a2a;border-radius:12px;background:#141414}
  h1{margin:0 0 8px;font-size:15px;font-weight:600;color:#f87171}
  p{margin:6px 0;color:#a1a1aa}
  pre{font:12px ui-monospace,Menlo,monospace;background:#1c1c1c;padding:8px;border-radius:6px;color:#e7e7e7;white-space:pre-wrap;overflow:auto}
</style>
<div class="card">
  <h1>Too many redirects</h1>
  <p>The upstream sent us through a redirect chain that didn't settle within ${maxFollows} hops:</p>
  <pre>${escapeHtml(summary)}</pre>
</div>`
    : `webpreview: too many redirects\n  ${hops.join('\n  ')}`
  res.statusCode = 508
  res.setHeader('Content-Type', ct)
  res.end(body)
  return Promise.resolve()
}

export function sendUpstreamError(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  err: NodeJS.ErrnoException
): Promise<void> {
  const code = err.code
  const msg = err.message || String(err)
  console.warn(`[webpreview] upstream error for ${target.toString()}: code=${code} msg=${msg}`)
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
  return Promise.resolve()
}
