import { describe, expect, it } from 'vitest'
import { getWebClientStorageScope, scopeWebStorageKey } from './web-storage-scope'

describe('web storage scope', () => {
  it('root-path serves keep the legacy unscoped keys', () => {
    expect(getWebClientStorageScope('/web-index.html')).toBe('')
    expect(getWebClientStorageScope('/')).toBe('')
    expect(scopeWebStorageKey('orca.web.settings.v1', '/web-index.html')).toBe(
      'orca.web.settings.v1'
    )
  })

  it('sub-path apps get keys scoped by their base path', () => {
    const path = '/w/data_curation/app_instance/app_01KY2C3G/web-index.html'
    expect(getWebClientStorageScope(path)).toBe('/w/data_curation/app_instance/app_01KY2C3G')
    expect(scopeWebStorageKey('orca.web.runtimeEnvironments.v2', path)).toBe(
      'orca.web.runtimeEnvironments.v2:/w/data_curation/app_instance/app_01KY2C3G'
    )
  })

  it('two workspace routes on one origin never share a key', () => {
    const a = scopeWebStorageKey(
      'orca.web.runtimeEnvironments.v2',
      '/w/data_curation/app_instance/app_A/web-index.html'
    )
    const b = scopeWebStorageKey(
      'orca.web.runtimeEnvironments.v2',
      '/w/test_automation/app_instance/app_B/web-index.html'
    )
    expect(a).not.toBe(b)
  })

  it('trailing slashes normalize to the same scope', () => {
    expect(getWebClientStorageScope('/w/ws/app_instance/x/')).toBe('/w/ws/app_instance/x')
    expect(getWebClientStorageScope('/w/ws/app_instance/x/web-index.html')).toBe(
      '/w/ws/app_instance/x'
    )
  })
})
