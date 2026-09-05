// Why: storage scoping must install before any other module touches
// localStorage (see web-storage-scope-boot.ts) — keep this import FIRST.
import './web-storage-scope-boot'
import '../assets/main.css'

import { Suspense, useMemo, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import ReactDOM from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import WebConnect from './WebConnect'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  clearPairingInputFromAddressBar,
  decideWebPairingStartup,
  defaultWebEnvironmentName,
  readPairingInputFromLocation
} from './web-pairing'
import { createStoredWebRuntimeEnvironment } from './web-runtime-environment'
import {
  findWebRuntimeEnvironmentByOfferKey,
  pruneStaleOriginPairings,
  readWebRuntimeEnvironments,
  upsertStoredWebRuntimeEnvironment,
  writeActiveWebRuntimeEnvironmentId
} from './web-runtime-environment-registry'
import { sessionStorageKeyForHost } from './preload-api/web-workspace-session-api'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { installWebPreloadApi } from './web-preload-api'
import { I18nProvider } from '../i18n/I18nProvider'
import { translate } from '../i18n/i18n'

const App = lazy(() => import('../App'))

function WebRoot(): React.JSX.Element {
  const initialPairingInput = useMemo(() => readPairingInputFromLocation(window.location), [])
  // Why: current runtime links carry scope metadata. Runtime-scope offers keep
  // the instant save path; mobile/legacy-unknown offers must be shown/probed.
  const startupDecision = useMemo(() => {
    const decision = decideWebPairingStartup({
      initialPairingInput,
      hasStoredEnvironment: readWebRuntimeEnvironments().length > 0
    })
    if (
      decision.kind === 'auto-save-runtime-offer' ||
      (decision.kind === 'show-connect' && decision.initialPairingInput !== null)
    ) {
      clearPairingInputFromAddressBar()
    }
    return decision
  }, [initialPairingInput])
  const [hasEnvironment, setHasEnvironment] = useState(() => {
    if (startupDecision.kind === 'auto-save-runtime-offer') {
      // Why: a URL-fragment pairing comes from the page-origin server — the
      // browser's PRIMARY. A re-pair of the same server key keeps saved
      // secondaries and their persisted sessions intact.
      const stored = upsertStoredWebRuntimeEnvironment(
        createStoredWebRuntimeEnvironment({
          name: defaultWebEnvironmentName(startupDecision.offer),
          offer: startupDecision.offer,
          previousEnvironment: findWebRuntimeEnvironmentByOfferKey(
            startupDecision.offer.publicKeyB64
          ),
          pairedVia: 'origin'
        })
      )
      writeActiveWebRuntimeEnvironmentId(stored.id)
      // Why: ephemeral deployments mint a new backend per rebuild and re-pair
      // through this fragment every boot; earlier same-host origin pairings are
      // dead instances — drop them and their session state so the sidebar and
      // Remote Hosts list stop accumulating corpses.
      for (const removedId of pruneStaleOriginPairings(stored.id)) {
        window.localStorage.removeItem(
          sessionStorageKeyForHost(toRuntimeExecutionHostId(removedId))
        )
      }
      return true
    }
    return startupDecision.kind === 'use-stored-environment'
  })

  if (!hasEnvironment) {
    return (
      <WebConnect
        initialPairingInput={
          startupDecision.kind === 'show-connect' ? startupDecision.initialPairingInput : null
        }
        onConnected={() => setHasEnvironment(true)}
      />
    )
  }

  installWebPreloadApi()
  return (
    <Suspense fallback={<div className="min-h-dvh bg-background" />}>
      <App />
    </Suspense>
  )
}

function WebRootBoundary(): React.JSX.Element {
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="web.root"
      surface="web-root"
      title={translate('app.recoverableError.webTitle', 'Orca web hit a renderer error.')}
      description={translate(
        'app.recoverableError.webDescription',
        'Retry the web client or reconnect to the paired runtime.'
      )}
    >
      <WebRoot />
    </RecoverableRenderErrorBoundary>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <I18nProvider>
    <WebRootBoundary />
  </I18nProvider>
)

// Why: the web client is its own entry point and hosts terminals too, so it has
// to start the deferred WebGL addon load itself (see main.tsx). Dynamic because
// this entry deliberately keeps the whole App graph — pane manager included —
// out of its own startup chunk.
void import('../lib/pane-manager/pane-webgl-renderer').then((module) =>
  module.primeTerminalWebglAddon()
)
