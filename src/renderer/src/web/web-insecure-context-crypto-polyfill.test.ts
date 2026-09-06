import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const html = readFileSync(join(__dirname, '..', '..', 'web-index.html'), 'utf8')

function inlinePolyfillSource(): string {
  const match = /<script data-vsagent="crypto-polyfill">([\s\S]*?)<\/script>/.exec(html)
  if (!match) {
    throw new Error('web-index.html has no crypto-polyfill inline script')
  }
  return match[1]
}

type FakeCrypto = { randomUUID?: () => string; getRandomValues?: Crypto['getRandomValues'] }

// Runs the shipped inline script against a stand-in for the page's crypto.
function bootWith(cryptoApi: FakeCrypto | undefined): void {
  const context = createContext({ crypto: cryptoApi, Uint8Array })
  runInContext(inlinePolyfillSource(), context)
}

// Mirrors a browser Crypto in a non-secure context: getRandomValues only.
function insecureContextCrypto(): FakeCrypto {
  return { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) as Crypto['getRandomValues'] }
}

describe('web-index.html crypto.randomUUID polyfill', () => {
  it('fills in randomUUID from getRandomValues when the browser hides it', () => {
    const cryptoApi = insecureContextCrypto()
    bootWith(cryptoApi)
    const first = cryptoApi.randomUUID!()
    const second = cryptoApi.randomUUID!()
    expect(first).toMatch(UUID_V4)
    expect(second).toMatch(UUID_V4)
    expect(first).not.toBe(second)
  })

  it('leaves a native randomUUID untouched (secure contexts)', () => {
    const native = (): string => 'native'
    const cryptoApi: FakeCrypto = { ...insecureContextCrypto(), randomUUID: native }
    bootWith(cryptoApi)
    expect(cryptoApi.randomUUID).toBe(native)
  })

  it('is inert without getRandomValues or without crypto at all', () => {
    const cryptoApi: FakeCrypto = {}
    bootWith(cryptoApi)
    expect(cryptoApi.randomUUID).toBeUndefined()
    expect(() => bootWith(undefined)).not.toThrow()
  })

  // Why: module bodies run after their imports, and imported chunks call
  // crypto.randomUUID at load — only a classic script ahead of the module
  // entry is early enough.
  it('runs before the module entry as a classic script', () => {
    const polyfillAt = html.indexOf('<script data-vsagent="crypto-polyfill">')
    const entryAt = html.indexOf('<script type="module" src="/src/web/main.tsx">')
    expect(polyfillAt).toBeGreaterThan(-1)
    expect(entryAt).toBeGreaterThan(polyfillAt)
    expect(html.slice(polyfillAt, entryAt)).not.toContain('type="module"')
  })
})
