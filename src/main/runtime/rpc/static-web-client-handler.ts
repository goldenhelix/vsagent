import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, isAbsolute, posix, relative, resolve } from 'node:path'

const STATIC_WEB_ALLOWED_PATHS = new Set(['/web-index.html'])
const STATIC_WEB_ALLOWED_PREFIXES = ['/assets/']
const STATIC_WEB_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2']
])

export function createStaticWebClientHandler(
  staticRoot: string,
  options: { storageNamespace?: string | null } = {}
): RequestListener {
  const resolvedRoot = resolve(staticRoot)
  // Why: --serve-storage-namespace is normalized into this env var at
  // startup (serve-options.ts), so the handler needs no plumbing through the
  // transport when the caller doesn't pass one explicitly.
  const storageNamespace =
    (options.storageNamespace ?? process.env.ORCA_STORAGE_NAMESPACE)?.trim() || null
  return (request, response) => {
    void handleStaticRequest(resolvedRoot, request, response, storageNamespace)
  }
}

// Why: multiple VSAgent apps can share one browser origin under sub-URL
// routes; the web client scopes its localStorage by this namespace
// (--serve-storage-namespace) so workspaces never share pairings/settings.
// Injected as a boot global so it exists before any module reads storage.
function injectStorageNamespace(html: string, namespace: string): string {
  const safe = JSON.stringify(namespace).replace(/</g, '\\u003c')
  return html.replace(
    '<head>',
    `<head><script>window.__VSAGENT_STORAGE_NAMESPACE__=${safe};</script>`
  )
}

async function handleStaticRequest(
  staticRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
  storageNamespace: string | null = null
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    writeHttpStatus(response, 405)
    return
  }

  const pathname = parseStaticPathname(request.url)
  if (!pathname) {
    writeHttpStatus(response, 400)
    return
  }
  if (!isAllowedStaticWebPath(pathname)) {
    writeHttpStatus(response, 404)
    return
  }

  const absolutePath = resolve(staticRoot, pathname.slice(1))
  const relativePath = relative(staticRoot, absolutePath)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    writeHttpStatus(response, 404)
    return
  }

  let fileStat
  try {
    fileStat = await stat(absolutePath)
  } catch {
    writeHttpStatus(response, 404)
    return
  }
  if (!fileStat.isFile()) {
    writeHttpStatus(response, 404)
    return
  }

  response.statusCode = 200
  response.setHeader(
    'Content-Type',
    STATIC_WEB_CONTENT_TYPES.get(extname(absolutePath)) ?? 'application/octet-stream'
  )
  if (storageNamespace && pathname === '/web-index.html') {
    const html = injectStorageNamespace(await readFile(absolutePath, 'utf8'), storageNamespace)
    const body = Buffer.from(html, 'utf8')
    response.setHeader('Content-Length', body.length)
    response.setHeader('Cache-Control', 'no-cache')
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    response.end(body)
    return
  }
  response.setHeader('Content-Length', fileStat.size)
  response.setHeader(
    'Cache-Control',
    pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  )
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const stream = createReadStream(absolutePath)
  stream.on('error', () => {
    if (!response.headersSent) {
      writeHttpStatus(response, 500)
      return
    }
    response.destroy()
  })
  stream.pipe(response)
}

function parseStaticPathname(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return '/web-index.html'
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname)
  } catch {
    return null
  }
  if (pathname === '/' || pathname === '/index.html') {
    return '/web-index.html'
  }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
    return null
  }
  if (posix.normalize(pathname) !== pathname) {
    return null
  }
  return mapProxyPrefixedStaticPathname(pathname)
}

function mapProxyPrefixedStaticPathname(pathname: string): string {
  if (pathname === '/web-index.html' || pathname.endsWith('/web-index.html')) {
    return '/web-index.html'
  }
  const assetMarker = '/assets/'
  const assetIndex = pathname.indexOf(assetMarker)
  if (assetIndex !== -1) {
    // Why: reverse proxies may forward the external path prefix through to
    // Orca. Only the bundled /assets subtree is served after the prefix.
    return pathname.slice(assetIndex)
  }
  return pathname
}

function isAllowedStaticWebPath(pathname: string): boolean {
  return (
    STATIC_WEB_ALLOWED_PATHS.has(pathname) ||
    STATIC_WEB_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
}

function writeHttpStatus(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode
  response.end()
}
