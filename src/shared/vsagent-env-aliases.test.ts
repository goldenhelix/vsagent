import { describe, expect, it, vi } from 'vitest'
import { applyVSAgentEnvAliases } from './vsagent-env-aliases'

describe('applyVSAgentEnvAliases', () => {
  it('copies set aliases onto their ORCA_* targets', () => {
    const env: NodeJS.ProcessEnv = {
      VSAGENT_SERVE_OPEN_PAIRING: '1',
      VSAGENT_GITEA_TOKEN: 'tok-123'
    }
    applyVSAgentEnvAliases(env)
    expect(env.ORCA_SERVE_OPEN_PAIRING).toBe('1')
    expect(env.ORCA_GITEA_TOKEN).toBe('tok-123')
  })

  it('leaves unset aliases and unrelated vars alone', () => {
    const env: NodeJS.ProcessEnv = { ORCA_GITEA_TOKEN: 'orig', PATH: '/usr/bin' }
    applyVSAgentEnvAliases(env)
    expect(env.ORCA_GITEA_TOKEN).toBe('orig')
    expect(env.ORCA_SERVE_OPEN_PAIRING).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('VSAGENT_* wins over a conflicting ORCA_* value, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env: NodeJS.ProcessEnv = {
      VSAGENT_GITEA_TOKEN: 'new-token',
      ORCA_GITEA_TOKEN: 'stale-token'
    }
    applyVSAgentEnvAliases(env)
    expect(env.ORCA_GITEA_TOKEN).toBe('new-token')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('is silent and idempotent when values already agree', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env: NodeJS.ProcessEnv = {
      VSAGENT_TELEMETRY_DISABLED: '1',
      ORCA_TELEMETRY_DISABLED: '1'
    }
    applyVSAgentEnvAliases(env)
    applyVSAgentEnvAliases(env)
    expect(env.ORCA_TELEMETRY_DISABLED).toBe('1')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('maps the serve/storage/install aliases reserved for later port steps', () => {
    const env: NodeJS.ProcessEnv = {
      VSAGENT_SERVER_NAME: 'My Server',
      VSAGENT_ALLOW_DISPLAYLESS_SERVE: '1',
      VSAGENT_STORAGE_NAMESPACE: 'team-a',
      VSAGENT_MANAGED_INSTALL: '1'
    }
    applyVSAgentEnvAliases(env)
    expect(env.ORCA_SERVE_NAME).toBe('My Server')
    expect(env.ORCA_ALLOW_DISPLAYLESS_SERVE).toBe('1')
    expect(env.ORCA_STORAGE_NAMESPACE).toBe('team-a')
    expect(env.ORCA_MANAGED_INSTALL).toBe('1')
  })
})
