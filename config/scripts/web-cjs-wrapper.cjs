// CJS wrapper to load the Orca main bundle via `require()` rather than
// Electron's default ESM-from-CJS entry path. Electron 41's
// `loadCJSModuleWithModuleLoad` interop emits a misleading
// "Cannot read properties of undefined (reading 'prototype')" stack at the
// `ipcMain.handle = ...` reassignment site if main/index.js is loaded as the
// entry directly. Going through require() avoids that path entirely. The
// underlying bundle is identical either way.
const path = require('path')

process.on('uncaughtException', (err) => {
  console.error('[web-serve] uncaughtException:', err && err.stack ? err.stack : err)
})

const mainEntry = path.resolve(__dirname, '../../out/main/index.js')
require(mainEntry)
