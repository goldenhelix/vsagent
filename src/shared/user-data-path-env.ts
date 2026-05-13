// Single source of truth for resolving the user-data-path override env var.
//
// VSAGENT_USER_DATA_PATH is the canonical name as of the rebrand. The legacy
// ORCA_USER_DATA_PATH is still honoured so external launch scripts and CI
// configs that haven't been updated keep working — VSAGENT wins when both
// are set.
export const USER_DATA_PATH_ENV = 'VSAGENT_USER_DATA_PATH'
export const LEGACY_USER_DATA_PATH_ENV = 'ORCA_USER_DATA_PATH'

export function readUserDataPathEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[USER_DATA_PATH_ENV] || env[LEGACY_USER_DATA_PATH_ENV] || undefined
}
