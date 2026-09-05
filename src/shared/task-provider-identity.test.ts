import { describe, expect, it } from 'vitest'
import {
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart
} from './task-provider-identity'

describe('Gitea task provider identity round-trip', () => {
  it('normalizes a full identity and stamps a host-scoped cache part', () => {
    const raw = { provider: 'gitea', owner: 'acme', repo: 'widgets', host: 'git.acme.dev' }
    const identity = normalizeTaskProviderIdentity('gitea', raw)
    expect(identity).toEqual({
      provider: 'gitea',
      owner: 'acme',
      repo: 'widgets',
      host: 'git.acme.dev',
      webUrl: null
    })
    expect(isStoredTaskProviderIdentity('gitea', identity)).toBe(true)
    expect(taskProviderIdentityCachePart(identity)).toBe('git.acme.dev/acme/widgets')
  })

  it('does not require owner/repo the way GitHub does — Gitea identities are never constructed today', () => {
    const identity = normalizeTaskProviderIdentity('gitea', { provider: 'gitea' })
    expect(identity).toEqual({
      provider: 'gitea',
      owner: null,
      repo: null,
      host: null,
      webUrl: null
    })
    expect(isStoredTaskProviderIdentity('gitea', identity)).toBe(true)
    expect(taskProviderIdentityCachePart(identity)).toBe('')
  })

  it('rejects a stored identity for a mismatched provider', () => {
    expect(isStoredTaskProviderIdentity('gitea', { provider: 'gitlab', projectId: '1' })).toBe(
      false
    )
  })
})
