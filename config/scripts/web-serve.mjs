#!/usr/bin/env node
// Launches the Orca backend in headless web-mode and serves the renderer
// bundle through the gateway. Intended for shipping Orca as a hosted
// service: a single command stands up everything a browser client needs.
//
// Environment variables:
//   ORCA_WEB_PORT          HTTP port to serve the bundle + WS on (default 8080)
//   ORCA_WEB_TOKEN         Optional shared bearer token (PoC auth)
//   ORCA_WEB_PICKER_ROOTS  Colon-separated roots the folder picker is allowed
//                          to traverse (defaults to $HOME)
//   ORCA_USER_DATA_PATH    Backend data dir (default: ~/.orca-web)
//
// Defines internally:
//   ORCA_WEB_GATEWAY=1
//   ORCA_WEB_HEADLESS=1
//   ORCA_WEB_ROOT=<repoRoot>/out/web

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const electronPath = require('electron')
const wrapperPath = path.join(repoRoot, 'config/scripts/web-cjs-wrapper.cjs')
const webRoot = path.join(repoRoot, 'out/web')
const mainEntry = path.join(repoRoot, 'out/main/index.js')

function ensure(condition, message) {
  if (!condition) {
    console.error(`[web-serve] ${message}`)
    process.exit(1)
  }
}

ensure(existsSync(webRoot), `web bundle not found at ${webRoot}. Run \`pnpm web:build\` first.`)
ensure(
  existsSync(mainEntry),
  `main bundle not found at ${mainEntry}. Run \`pnpm build:electron-vite\` first.`
)

const userDataPath =
  process.env.ORCA_USER_DATA_PATH ||
  path.join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.orca-web')
mkdirSync(userDataPath, { recursive: true })

const env = {
  ...process.env,
  ORCA_WEB_GATEWAY: '1',
  ORCA_WEB_HEADLESS: '1',
  ORCA_WEB_ROOT: webRoot,
  ORCA_WEB_PORT: process.env.ORCA_WEB_PORT || '8080',
  ORCA_USER_DATA_PATH: userDataPath,
  ORCA_DEV_USER_DATA_PATH: userDataPath
}

const args = [
  '--no-sandbox',
  // Why: --headless=new uses Chromium's new headless mode, which avoids
  // creating any GTK widgets — so backend boots on display-less Linux
  // hosts without xvfb. Note: BrowserWindow is never created at all in
  // ORCA_WEB_HEADLESS mode (see web-gateway/headless-window.ts).
  '--headless=new',
  '--disable-gpu',
  '--enable-logging=stderr',
  wrapperPath
]

console.log(`[web-serve] starting on http://0.0.0.0:${env.ORCA_WEB_PORT}`)
console.log(`[web-serve] data dir: ${userDataPath}`)
console.log(`[web-serve] web root: ${webRoot}`)

const child = spawn(electronPath, args, { env, stdio: 'inherit' })
child.on('exit', (code, signal) => {
  console.log(`[web-serve] backend exited code=${code} signal=${signal}`)
  process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig)
  })
}
