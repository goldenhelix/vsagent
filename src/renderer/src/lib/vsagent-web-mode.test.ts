import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the `VITE_VSAGENT_WEB_MODE` desktop-dev escape hatch reads
// `import.meta.env` through a cast (`(import.meta as ImportMeta & {...}).env`,
// copied verbatim from the fork). Vitest's SSR transform only special-cases the
// literal `import.meta.env.KEY` member-expression shape for live env stubbing
// (see `vi.stubEnv` docs) and does not recognize that shape once a cast sits
// between `import.meta` and `.env`, so `vi.stubEnv` cannot reach it here. That is
// a test-harness limitation, not a behavior bug — real Vite/esbuild builds erase
// the TypeScript cast before bundling and still see a plain `import.meta.env`
// member chain. Coverage below sticks to what a unit test can prove: delegation
// to `isWebClientLocation()`.
describe('isVSAgentWebMode', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('./web-client-location')
  })

  it('delegates to isWebClientLocation() when it reports the web client', async () => {
    vi.doMock('./web-client-location', () => ({ isWebClientLocation: () => true }))
    const { isVSAgentWebMode } = await import('./vsagent-web-mode')

    expect(isVSAgentWebMode()).toBe(true)
  })

  it('stays off on desktop when isWebClientLocation() is false', async () => {
    vi.doMock('./web-client-location', () => ({ isWebClientLocation: () => false }))
    const { isVSAgentWebMode } = await import('./vsagent-web-mode')

    expect(isVSAgentWebMode()).toBe(false)
  })
})
