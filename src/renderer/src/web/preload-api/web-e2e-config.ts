import { createE2EConfig } from '../../../../shared/e2e-config'

// Why: this module stays dependency-light so the query/storage snapshot evaluates before runtime state.
const webE2EQueryParams = new URLSearchParams(window.location.search)
// Why (VSAgent): the released tarball is a production build, so the smoke test
// needs a runtime opt-in, not a build-time env var.
const webE2EExposeStore =
  String(import.meta.env.VITE_EXPOSE_STORE) === 'true' ||
  webE2EQueryParams.get('orcaExposeStore') === '1'
const webE2EQuery = webE2EExposeStore ? webE2EQueryParams : null

export const webE2EConfig = createE2EConfig({
  exposeStore: webE2EExposeStore,
  terminalParkingDelayMs: Number(webE2EQuery?.get('orcaE2ETerminalParkingDelayMs')) || null,
  terminalRetentionLimit: Number(webE2EQuery?.get('orcaE2ETerminalRetentionLimit')) || null
})
