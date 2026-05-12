import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyDocumentTheme } from './lib/document-theme'
import { loadRuntimeFlavor } from './lib/runtime-flavor'

if (import.meta.env.DEV) {
  import('react-grab').then(({ init }) => init())
  import('react-grab/styles.css')
}

applyDocumentTheme('system', { disableTransitions: false })

// Why: read the runtime flavor before the first render so components can
// branch on `isWebMode()` synchronously. The await is a single round-trip
// that piggybacks on the bridge's connect handshake.
async function bootstrap(): Promise<void> {
  try {
    await loadRuntimeFlavor()
  } catch (err) {
    // Why: a failed flavor read is non-fatal — the helper falls back to
    // desktop mode. We continue to mount so the user sees something even
    // if the flavor IPC is unreachable.
    console.error('[boot] runtime flavor preload failed', err)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void bootstrap()
