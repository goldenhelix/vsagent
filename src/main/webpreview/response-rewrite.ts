// Server-side body rewriting for the webpreview proxy. Root-relative URLs in
// initial HTML attributes, CSS url()/@import, and JS import specifiers are
// resolved by the browser against the document origin (the gateway) at load
// time — they never reach the runtime rewriter, so absolute paths would 404.
// Rewrite them here so every `/path` becomes `<proxyPrefix>/path`, and inject
// the runtime rewriter script so in-page navigation stays inside the proxy.
import { buildRewriteScript } from './rewrite-script'

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function injectRewriteScript(
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
export function rewriteHtmlAttributes(html: string, proxyPathPrefix: string): string {
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

// Why: rewrite root-relative URLs inside CSS — `url(/path)` (optionally quoted)
// and `@import "/path"` — so fonts/images/imported sheets stay under the proxy
// prefix instead of 404ing against the gateway. Only absolute-path (`/`, not
// `//`) targets need it; relative and data:/http(s) URLs are left alone.
export function rewriteCssUrls(css: string, proxyPathPrefix: string): string {
  return css
    .replace(
      /(url\(\s*["']?)(\/(?!\/))/gi,
      (_m, lead: string, slash: string) => `${lead}${proxyPathPrefix}${slash}`
    )
    .replace(
      /(@import\s+["'])(\/(?!\/))/gi,
      (_m, lead: string, slash: string) => `${lead}${proxyPathPrefix}${slash}`
    )
}

// Why: ES module imports use raw URL strings inside JS files (Vite serves
// modules whose body looks like `import "/docs/@vite/client"`). Those URLs
// resolve against the document origin (the gateway), bypassing the proxy.
// Rewrite only ABSOLUTE-path specifiers (`/...`); relative (`./`, `../`)
// resolve against the importing module's already-proxied URL.
export function rewriteJsImports(js: string, proxyPathPrefix: string): string {
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
