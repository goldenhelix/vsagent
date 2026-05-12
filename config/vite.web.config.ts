// Why: standalone Vite config for the browser bundle of Orca. The normal
// electron-vite pipeline assumes a Node-flavoured renderer with the
// `electron` module resolvable. Here we alias `electron` and
// `@electron-toolkit/preload` to browser-friendly WebSocket shims so the
// existing preload + renderer source can run unchanged inside a real browser
// tab while talking to a remote Orca backend over WebSocket.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repoRoot = resolve(__dirname, '..')

export default defineConfig({
  // Why: the index.html lives next to the bootstrap entry. Setting root to
  // its directory makes Vite emit `out/web/index.html` at the bundle root so
  // the gateway can serve it directly from `/`.
  root: resolve(repoRoot, 'src/web-bridge'),
  base: '/',
  resolve: {
    alias: {
      '@renderer': resolve(repoRoot, 'src/renderer/src'),
      '@': resolve(repoRoot, 'src/renderer/src'),
      // Why: redirect all `import ... from 'electron'` (and the toolkit
      // preload) sites to browser polyfills that round-trip every IPC call
      // over WebSocket.
      electron: resolve(repoRoot, 'src/web-bridge/electron-shim.ts'),
      '@electron-toolkit/preload': resolve(
        repoRoot,
        'src/web-bridge/electron-toolkit-preload-shim.ts'
      )
    }
  },
  plugins: [react(), tailwindcss()],
  // Why: the renderer reads telemetry-gate constants that electron-vite's
  // main config substitutes at build time. The web bundle never ships
  // telemetry (no PostHog write key), so substitute literal `null`.
  define: {
    ORCA_BUILD_IDENTITY: 'null',
    ORCA_POSTHOG_WRITE_KEY: 'null'
  },
  build: {
    outDir: resolve(repoRoot, 'out/web'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false
  },
  server: {
    host: '0.0.0.0',
    port: 8090,
    // Why: dev-mode proxy points HMR + bridge traffic to the backend
    // gateway. Production serving happens through the gateway directly.
    proxy: {
      '/__orca/ws': {
        target: 'ws://localhost:8765',
        ws: true
      }
    }
  },
  worker: {
    format: 'es'
  }
})
