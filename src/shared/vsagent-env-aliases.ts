// Why (VSAgent fork): operators should be able to configure everything with
// VSAGENT_* names. Read sites stay 100% upstream (process.env.ORCA_*) — this
// normalizer maps the aliases once at process start, so the fork carries no
// per-site diffs. No Electron imports: the plain-node CLI uses it too.

const VSAGENT_ENV_ALIASES = {
  VSAGENT_SERVE_OPEN_PAIRING: 'ORCA_SERVE_OPEN_PAIRING',
  VSAGENT_SERVE_PAIRING_PROXY_SECRET: 'ORCA_SERVE_PAIRING_PROXY_SECRET',
  VSAGENT_GITEA_TOKEN: 'ORCA_GITEA_TOKEN',
  VSAGENT_GITEA_API_BASE_URL: 'ORCA_GITEA_API_BASE_URL',
  VSAGENT_DISABLE_HTTP2: 'ORCA_DISABLE_HTTP2',
  VSAGENT_TELEMETRY_DISABLED: 'ORCA_TELEMETRY_DISABLED',
  VSAGENT_DIAGNOSTICS_DISABLED: 'ORCA_DIAGNOSTICS_DISABLED',
  VSAGENT_SERVE_KEEP_STALE_SINGLETON_LOCK: 'ORCA_SERVE_KEEP_STALE_SINGLETON_LOCK',
  VSAGENT_E2E_USER_DATA_DIR: 'ORCA_E2E_USER_DATA_DIR',
  // Why: reserved ahead of the upstream-port steps that read these ORCA_*
  // names directly (serve --name/--storage-namespace, the displayless-serve
  // fallback, the managed-install skip) — keeping every VSAGENT_*->ORCA_*
  // mapping in this one map, even before its reader lands, avoids a second
  // brand-alias seam appearing later.
  VSAGENT_SERVER_NAME: 'ORCA_SERVE_NAME',
  VSAGENT_ALLOW_DISPLAYLESS_SERVE: 'ORCA_ALLOW_DISPLAYLESS_SERVE',
  VSAGENT_STORAGE_NAMESPACE: 'ORCA_STORAGE_NAMESPACE',
  VSAGENT_MANAGED_INSTALL: 'ORCA_MANAGED_INSTALL'
} as const

/**
 * Copy each set VSAGENT_* alias onto its ORCA_* target. When both are set and
 * differ, VSAGENT_* wins (a migrating operator set the new name deliberately;
 * a stale ORCA_* in an old unit file must not silently shadow it) — with one
 * warning naming both. Idempotent.
 */
export function applyVSAgentEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [alias, target] of Object.entries(VSAGENT_ENV_ALIASES)) {
    const aliasValue = env[alias]
    if (aliasValue === undefined) {
      continue
    }
    const targetValue = env[target]
    if (targetValue !== undefined && targetValue !== aliasValue) {
      console.warn(
        `[env] Both ${alias} and ${target} are set with different values; using ${alias}.`
      )
    }
    env[target] = aliasValue
  }
}
