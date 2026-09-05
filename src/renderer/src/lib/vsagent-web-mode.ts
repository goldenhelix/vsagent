import { isWebClientLocation } from './web-client-location'

// Why (VSAgent fork): a single master switch for every web-deployment feature
// adjustment (hidden desktop integrations, no local host, browser-native
// keyboard chords, etc.) so the fork CONDITIONALLY hides behavior instead of
// deleting upstream code — keeping rebases clean. The signal is the web-client
// identity itself: the browser-hosted renderer is exactly "web mode", and the
// desktop app is never affected. VSAGENT_WEB_MODE=1 forces it on for local
// desktop testing of the web-mode UI.
let forcedByEnv: boolean | null = null

function envForcesWebMode(): boolean {
  if (forcedByEnv === null) {
    forcedByEnv =
      import.meta !== undefined &&
      (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
        ?.VITE_VSAGENT_WEB_MODE === '1'
  }
  return forcedByEnv
}

export function isVSAgentWebMode(): boolean {
  return isWebClientLocation() || envForcesWebMode()
}
