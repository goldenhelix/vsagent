import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyDocumentTheme } from './lib/document-theme'
import { isWebMode, loadRuntimeFlavor } from './lib/runtime-flavor'
import { ensureAudioUnlockListeners } from './lib/web-notifications'
import { shouldEnableReactGrab } from './lib/react-grab-dev-gate'

if (
  import.meta.env.DEV &&
  shouldEnableReactGrab({
    dev: import.meta.env.DEV,
    enableFlag: import.meta.env.VITE_ENABLE_REACT_GRAB
  })
) {
  void import('react-grab').then(({ init }) => init())
  void import('react-grab/styles.css')
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
  // Why: in web mode, arm a one-shot user-gesture listener so the browser grants
  // audio activation early — event-driven notification sounds carry no gesture
  // of their own and would otherwise be blocked by the autoplay policy.
  if (isWebMode()) {
    ensureAudioUnlockListeners()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void bootstrap()
