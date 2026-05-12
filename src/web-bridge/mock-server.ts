// Standalone mock backend. Serves the built renderer + a WebSocket bridge
// that answers a small subset of Orca IPC calls with plausible stub data.
//
// Purpose: demonstrate end-to-end that the renderer boots in a real browser
// and the ipcRenderer.invoke / ipcRenderer.on path round-trips through the
// gateway protocol. The full Electron backend can be substituted for this
// once the gateway is wired into main/index.ts and the host has a display
// (or the daemon-skip flags are honored).
//
// Run with: pnpm tsx src/web-bridge/mock-server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFile, stat } from 'fs/promises'
import { extname, join, normalize, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, WebSocket } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const webRoot = resolve(repoRoot, 'out/web')

const PORT = Number(process.env.ORCA_WEB_PORT || 8080)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}

type WireIn =
  | { kind: 'invoke'; id: number; channel: string; args: unknown[] }
  | { kind: 'send'; channel: string; args: unknown[] }
  | { kind: 'subscribe'; channel: string }
  | { kind: 'unsubscribe'; channel: string }

type WireOut =
  | { kind: 'invoke-ok'; id: number; value: unknown }
  | { kind: 'invoke-err'; id: number; error: string }
  | { kind: 'event'; channel: string; args: unknown[] }

// Why: the renderer issues a burst of invoke calls during boot to populate
// initial UI state. Returning shape-matching stubs (rather than throwing) lets
// React get past hydration so we can confirm DOM mounts in the browser.
const stubInvokes: Record<string, (...args: unknown[]) => unknown> = {
  // App / platform
  'app:getKeyboardInputSourceId': () => null,
  'app:relaunch': () => undefined,
  'app:setUnreadDockBadgeCount': () => undefined,
  'wsl:isAvailable': () => false,
  'pwsh:isAvailable': () => false,
  // UI state
  'ui:get': () => ({
    statusBarVisible: true,
    leftSidebarOpen: true,
    rightSidebarOpen: false,
    leftSidebarWidth: 260,
    rightSidebarWidth: 320,
    bottomPaneHeight: 240,
    appZoomLevel: 0,
    terminalZoomLevel: 0,
    activeTabIdByWorktree: {},
    lastVisitedAtByWorktreeId: {},
    expandedRepos: {}
  }),
  'ssh:listTargets': () => [],
  'ssh:listConnections': () => [],
  'ui:set': () => undefined,
  'ui:isMaximized': () => false,
  'ui:isFullScreen': () => false,
  'ui:minimize': () => undefined,
  'ui:maximize': () => undefined,
  'ui:requestClose': () => undefined,
  // Settings
  'settings:get': () => ({
    theme: 'dark',
    showTasksButton: true,
    showTitlebarAppName: true,
    claudeManagedAccounts: [],
    codexManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    activeCodexManagedAccountId: null,
    fontSize: 13,
    terminalFontSize: 13
  }),
  'settings:set': () => undefined,
  'settings:update': () => undefined,
  // Repos / worktrees
  'repos:list': () => [],
  'repos:pickFolder': () => null,
  'repos:pickDirectory': () => null,
  'worktrees:list': () => [],
  'worktrees:listAll': () => [],
  // Sessions
  'session:get': () => ({
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeWorktreeIdsOnShutdown: [],
    openFilesByWorktree: {},
    activeFileIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeConnectionIdsAtShutdown: []
  }),
  // Onboarding
  'onboarding:get': () => ({ closedAt: Date.now() }),
  'onboarding:set': () => undefined,
  'onboarding:close': () => undefined,
  // Stats / telemetry consent
  'stats:summary': () => ({ totalAgents: 0, sessionsToday: 0 }),
  'telemetryConsent:get': () => ({ effective: 'enabled', explicit: 'enabled' }),
  // Memory
  'memory:get': () => ({ entries: [] }),
  // Rate limits
  'rateLimits:get': () => ({
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }),
  'rateLimits:refresh': () => ({
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }),
  'updater:status': () => ({ state: 'idle' }),
  'updater:getStatus': () => ({ state: 'idle' }),
  // Claude / codex accounts
  'claudeAccounts:list': () => [],
  'codexAccounts:list': () => [],
  // Cli installation
  'cli:getInstallStatus': () => ({ status: 'unknown' }),
  // Preflight
  'preflight:check': () => ({
    git: { installed: true },
    gh: { installed: true, authenticated: true }
  }),
  'preflight:detectAgents': () => ['claude', 'codex'],
  'preflight:refreshAgents': () => ({ agents: ['claude', 'codex'] }),
  // Agent hooks
  'agentHooks:getInstallStatus': () => ({ status: 'unknown' }),
  'agentStatus:getSnapshot': () => [],
  // Notifications
  'notifications:getPermissionStatus': () => ({ status: 'granted' }),
  // Mobile
  'mobile:isWebSocketReady': () => ({ ready: false, endpoint: null }),
  'mobile:listDevices': () => [],
  // Runtime
  'runtime:status': () => ({
    handles: [],
    waiters: [],
    summaries: {}
  }),
  'runtime:getTerminalFitOverrides': () => [],
  'runtime:list': () => [],
  'runtime:getSyncWindowGraph': () => null,
  'pty:listSessions': () => [],
  // System fonts
  'systemFonts:list': () => ['monospace', 'system-ui']
}

function dispatchInvoke(channel: string, args: unknown[]): unknown {
  const stub = stubInvokes[channel]
  if (stub) return stub(...args)
  // Why: many channels expect arrays. Anything that ends in `:list` or
  // starts with `list…` defaults to `[]`. Others fall through to `null`.
  // Real handlers replace this with strict behavior.
  console.log(`[mock] no stub for "${channel}" — defaulting`)
  if (
    channel.endsWith(':list') ||
    channel.endsWith(':listAll') ||
    channel.endsWith(':all') ||
    channel.endsWith('s:get')
  ) {
    return []
  }
  return null
}

type ClientState = {
  ws: WebSocket
  subs: Set<string>
}

const clients = new Map<WebSocket, ClientState>()

async function serveFile(res: ServerResponse, path: string): Promise<void> {
  try {
    const data = await readFile(path)
    const ext = extname(path).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    })
    res.end(data)
  } catch (err) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain')
    res.end(`Not found: ${path}\n${(err as Error).message}`)
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) {
    res.statusCode = 400
    return res.end()
  }
  if (req.url === '/__orca/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, mode: 'mock', ts: Date.now() }))
  }
  const u = new URL(req.url, 'http://localhost')
  let pathname = decodeURIComponent(u.pathname)
  if (pathname === '/' || pathname === '/index.html') {
    pathname = '/index.html'
  }
  const safe = normalize(pathname).replace(/^([./\\]+)+/, '')
  const candidate = resolve(webRoot, safe)
  if (!candidate.startsWith(webRoot)) {
    res.statusCode = 403
    return res.end()
  }
  try {
    const st = await stat(candidate)
    if (!st.isFile()) {
      return serveFile(res, join(webRoot, 'index.html'))
    }
    return serveFile(res, candidate)
  } catch {
    return serveFile(res, join(webRoot, 'index.html'))
  }
}

function sendMessage(ws: WebSocket, msg: WireOut): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

const httpServer = createServer((req, res) => handleHttp(req, res))
const wss = new WebSocketServer({ noServer: true })

httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/__orca/ws')) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws) => {
  const state: ClientState = { ws, subs: new Set() }
  clients.set(ws, state)
  console.log('[mock] client connected')
  ws.on('message', (data) => {
    let msg: WireIn
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (msg.kind === 'invoke') {
      try {
        const value = dispatchInvoke(msg.channel, msg.args)
        Promise.resolve(value)
          .then((v) => sendMessage(ws, { kind: 'invoke-ok', id: msg.id, value: v }))
          .catch((err) =>
            sendMessage(ws, {
              kind: 'invoke-err',
              id: msg.id,
              error: (err as Error)?.message ?? String(err)
            })
          )
      } catch (err) {
        sendMessage(ws, {
          kind: 'invoke-err',
          id: msg.id,
          error: (err as Error)?.message ?? String(err)
        })
      }
    } else if (msg.kind === 'send') {
      console.log(`[mock] send "${msg.channel}"`, msg.args)
    } else if (msg.kind === 'subscribe') {
      state.subs.add(msg.channel)
    } else if (msg.kind === 'unsubscribe') {
      state.subs.delete(msg.channel)
    }
  })
  ws.on('close', () => {
    clients.delete(ws)
    console.log('[mock] client disconnected')
  })
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock] Orca mock backend listening on http://0.0.0.0:${PORT}`)
  console.log(`[mock] webRoot: ${webRoot}`)
})
