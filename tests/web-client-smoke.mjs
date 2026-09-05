#!/usr/bin/env node
// VSAgent web-client smoke test: boots `orca serve` headless from this checkout,
// drives the browser web client with Playwright, and asserts the core flows a
// self-hosted deployment depends on:
//   1. serve boots display-less and serves the web bundle
//   2. web client pairs over WS and renders
//   3. a gitless folder can be added as a project ("Open as Folder")
//   4. a terminal can be created from the UI and executes commands
//   5. terminal scrollback survives a full page reload
//   6. the webpreview proxy serves a host-local HTTP server through an iframe
//      path (and its WS tunnel echoes)
//   7. trusted-proxy mode: GET / redirects with an embedded offer and pairs
//
// Usage: node tests/web-client-smoke.mjs   (requires out/ built: pnpm build:cli
// && pnpm build:electron-vite && pnpm build:web, plus @playwright/test chromium)
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createElectronHomeIsolation } from './e2e/helpers/electron-home-isolation.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const results = []
let serveChild = null
let browser = null
let localServer = null
const scratch = mkdtempSync(join(tmpdir(), 'vsagent-smoke-'))

function step(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cleanup() {
  try {
    await browser?.close()
  } catch {}
  try {
    serveChild?.kill('SIGTERM')
  } catch {}
  try {
    localServer?.close()
  } catch {}
  // Give serve a moment to exit before wiping its user-data dir.
  await delay(2000)
  try {
    serveChild?.kill('SIGKILL')
  } catch {}
  rmSync(scratch, { recursive: true, force: true })
}

process.on('SIGINT', () => cleanup().then(() => process.exit(130)))

try {
  // ── 1. Boot serve ─────────────────────────────────────────────────────────
  const userData = join(scratch, 'userdata')
  const projectDir = join(scratch, 'bioinfo-scripts')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'run_pipeline.sh'), '#!/bin/bash\necho pipeline\n')

  const electronBin = join(repoRoot, 'node_modules', '.bin', 'electron')
  // Why: a parent launched via the CLI shim would otherwise force node mode.
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  // Why: configure-process.ts refuses to start E2E outside its disposable HOME
  // boundary (tests/e2e/helpers/electron-home-isolation.ts is the upstream
  // primitive for that contract) — reuse it instead of hand-rolling isolation.
  const homeIsolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir: userData
  })
  // Why: ORCA_SERVE_OPEN_PAIRING covers the trusted-proxy flow (step 7) and
  // does not change the tokenized-URL flow the earlier steps exercise.
  const serveEnv = {
    ...homeIsolation.env,
    ORCA_SERVE_OPEN_PAIRING: '1'
  }
  serveChild = spawn(electronBin, ['.', '--serve', '--serve-port', '0', '--serve-json'], {
    cwd: repoRoot,
    env: serveEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let serveStdout = ''
  let serveStderr = ''
  serveChild.stdout.on('data', (d) => {
    serveStdout += String(d)
  })
  serveChild.stderr.on('data', (d) => {
    serveStderr += String(d)
  })

  let ready = null
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !ready) {
    for (const line of serveStdout.split('\n')) {
      if (line.includes('orca_server_ready')) {
        try {
          ready = JSON.parse(line.trim())
        } catch {}
      }
    }
    if (serveChild.exitCode !== null) {
      break
    }
    if (!ready) {
      await delay(500)
    }
  }
  if (!ready || !ready.pairing?.webClientUrl) {
    step('serve boots display-less with web client URL', false, serveStderr.slice(-800))
    throw new Error('serve did not become ready')
  }
  const webClientUrl = ready.pairing.webClientUrl
  step('serve boots display-less with web client URL', true, webClientUrl.split('#')[0])

  // ── local HTTP+WS target for the webpreview test ──────────────────────────
  const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  const { createHash } = await import('node:crypto')
  localServer = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>local-target</title><h1 id="marker">WEBPREVIEW_TARGET_OK</h1>')
  })
  localServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1')
      .update(key + WS_MAGIC)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    // Minimal echo: reflect any masked client frame back unmasked.
    socket.on('data', (buf) => {
      if (buf.length < 6 || (buf[0] & 0x0f) !== 1) {
        return
      }
      const len = buf[1] & 0x7f
      if (len > 125) {
        return
      }
      const mask = buf.subarray(2, 6)
      const payload = Buffer.from(buf.subarray(6, 6 + len))
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4]
      }
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    })
  })
  await new Promise((res2) => localServer.listen(0, '127.0.0.1', res2))
  const localPort = localServer.address().port

  // ── 2. Drive the web client ───────────────────────────────────────────────
  const { chromium } = await import('@playwright/test')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(webClientUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const addProject = page.getByRole('button', { name: /add project/i }).first()
  let rendered = false
  try {
    await addProject.waitFor({ state: 'visible', timeout: 30000 })
    rendered = true
  } catch {}
  step('web client pairs and renders', rendered)
  if (!rendered) {
    throw new Error('web client did not render')
  }

  // Why: first-run education tips render pointer-blocking overlays.
  const dismissTips = async () => {
    for (let i = 0; i < 3; i++) {
      const gotIt = page.getByRole('button', { name: /got it/i }).first()
      if (await gotIt.isVisible().catch(() => false)) {
        await gotIt.click().catch(() => {})
        await delay(500)
        continue
      }
      break
    }
    await page.keyboard.press('Escape')
  }
  await dismissTips()

  // ── 3. Add gitless folder project ─────────────────────────────────────────
  await addProject.click()
  await page.getByText('Browse folder', { exact: false }).first().click()
  const pathInput = page.locator('[role="dialog"] input').first()
  await pathInput.waitFor({ state: 'visible', timeout: 10000 })
  await pathInput.fill(projectDir)
  await delay(800)
  await pathInput.press('Enter')
  await delay(1200)
  const selectBtn = page.getByRole('button', { name: /select folder/i }).first()
  if (await selectBtn.isVisible().catch(() => false)) {
    await selectBtn.click()
  }
  const openAsFolder = page.getByRole('button', { name: /open as folder/i }).first()
  await openAsFolder.waitFor({ state: 'visible', timeout: 10000 })
  await openAsFolder.click()
  await delay(4000)
  const projectVisible = await page
    .getByText('bioinfo-scripts', { exact: true })
    .first()
    .isVisible()
    .catch(() => false)
  step('gitless folder added as project', projectVisible)

  // ── 4. Open workspace + terminal ──────────────────────────────────────────
  await dismissTips()
  await page.getByText('bioinfo-scripts', { exact: true }).nth(1).click({ force: true })
  // Why: session tabs and settings mirror from the host asynchronously; give
  // the workspace time to settle so terminal creation routes to the runtime.
  await delay(8000)
  await dismissTips()
  const xtermCountBefore = await page.locator('.xterm').count()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+t')
  await delay(1000)
  const newTerm = page.getByText('New Terminal', { exact: true }).first()
  if (await newTerm.isVisible().catch(() => false)) {
    await newTerm.click()
  }
  const spawnDeadline = Date.now() + 15000
  while (Date.now() < spawnDeadline) {
    if ((await page.locator('.xterm').count()) > xtermCountBefore) {
      break
    }
    await delay(500)
  }
  await delay(3000)
  const xterm = page.locator('.xterm').last()
  const marker = `SMOKE_${Date.now() % 100000}`
  let terminalOk = false
  if (await xterm.isVisible().catch(() => false)) {
    await xterm.click({ force: true })
    await delay(1500)
    await page.keyboard.type(`echo ${marker}_$((21*2))`, { delay: 30 })
    await page.keyboard.press('Enter')
    const outDeadline = Date.now() + 20000
    while (Date.now() < outDeadline && !terminalOk) {
      const text = await page.evaluate(() => document.body.innerText)
      terminalOk = text.includes(`${marker}_42`)
      if (!terminalOk) {
        await delay(1000)
      }
    }
  }
  step('terminal created via UI executes command', terminalOk)

  // ── 5. Reload → scrollback replay ─────────────────────────────────────────
  let replayOk = false
  if (terminalOk) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(9000)
    await dismissTips()
    // Why: a reload can land on the workspace list; reopen the workspace so
    // the terminal pane mounts and replays the host scrollback.
    if (
      !(await page
        .locator('.xterm')
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      await page.getByText('bioinfo-scripts', { exact: true }).nth(1).click({ force: true })
    }
    const replayDeadline = Date.now() + 40000
    while (Date.now() < replayDeadline && !replayOk) {
      const text = await page.evaluate(() => document.body.innerText)
      replayOk = text.includes(`${marker}_42`)
      if (!replayOk) {
        await delay(1500)
      }
    }
  }
  step('terminal scrollback survives page reload', replayOk)

  // ── 6. webpreview proxy (HTTP + WS tunnel) ────────────────────────────────
  // Exercise the proxy directly over HTTP: mint a session via the page's
  // paired RPC (window.api is not exposed; use the RPC through the UI is
  // brittle — instead hit the proxy after creating a session over a raw
  // fetch from the page context using the same-origin RPC bridge if exposed).
  // Simplest robust path: use the webPreview preload API through the page.
  const proxyResult = await page.evaluate(
    async (args) => {
      const api = window.api
      if (!api?.webPreview) {
        return { ok: false, reason: 'api.webPreview missing' }
      }
      try {
        const session = await api.webPreview.create({
          targetOrigin: `http://127.0.0.1:${args.localPort}`
        })
        const resp = await fetch(`${session.proxyPath}/`, { credentials: 'omit' })
        const text = await resp.text()
        const httpOk = resp.status === 200 && text.includes('WEBPREVIEW_TARGET_OK')
        const wsOk = await new Promise((resolveWs) => {
          // Why: session.proxyPath is an absolute http(s) URL (webpreview.create's
          // contract per S17/C4), not a bare path — swap only the scheme, don't
          // re-prefix with location.host or the URL doubles up and throws.
          const ws = new WebSocket(`${session.proxyPath}/echo`.replace(/^http/, 'ws'))
          const timer = setTimeout(() => {
            ws.close()
            resolveWs(false)
          }, 8000)
          ws.onopen = () => ws.send('tunnel-ping')
          ws.onmessage = (ev) => {
            clearTimeout(timer)
            ws.close()
            resolveWs(ev.data === 'tunnel-ping')
          }
          ws.onerror = () => {
            clearTimeout(timer)
            resolveWs(false)
          }
        })
        return { ok: httpOk && wsOk, httpOk, wsOk, status: resp.status }
      } catch (error) {
        return { ok: false, reason: String(error) }
      }
    },
    { localPort }
  )
  step(
    'webpreview proxy serves host-local HTTP + WS tunnel',
    proxyResult.ok === true,
    JSON.stringify(proxyResult)
  )

  // ── 7. Trusted-proxy mode: bare / pairs without a tokenized URL ───────────
  const rootUrl = `${webClientUrl.split('/web-index.html')[0]}/`
  const redirectResp = await fetch(rootUrl, { redirect: 'manual' })
  const location = redirectResp.headers.get('location') ?? ''
  const redirectOk = redirectResp.status === 302 && location.startsWith('web-index.html#pairing=')
  const bare = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  let bareRendered = false
  try {
    await bare.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await bare
      .getByRole('button', { name: /add project/i })
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
    bareRendered = true
  } catch {}
  await bare.close()
  step(
    'open pairing: bare / redirects and pairs a fresh browser',
    redirectOk && bareRendered,
    `302=${redirectOk} rendered=${bareRendered}`
  )
} catch (error) {
  console.error('smoke aborted:', error)
} finally {
  await cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
process.exit(failed.length === 0 && results.length >= 7 ? 0 : 1)
