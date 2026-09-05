// A webpreview session id is a bearer capability on the serve port, so the
// registry's bounds are security behaviour, not housekeeping: idle sessions
// must expire, the table must not grow without limit, and upstream-driven
// retargets must not be able to walk a session anywhere they like.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WEBPREVIEW_MAX_SESSIONS,
  WEBPREVIEW_SESSION_IDLE_TTL_MS,
  createSession,
  deleteSession,
  followSessionOrigin,
  getLeakedPathSession,
  getSession,
  listSessions,
  rememberLeakedPath,
  updateSessionOrigin
} from './registry'

beforeEach(() => {
  for (const session of listSessions()) {
    deleteSession(session.id)
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('webpreview session registry', () => {
  it('normalizes a scheme-less target and mints an unguessable id', () => {
    const session = createSession('localhost:3000')
    expect(session.targetOrigin).toBe('http://localhost:3000')
    expect(session.id).toMatch(/^[0-9a-f]{32}$/)
    expect(getSession(session.id)?.targetOrigin).toBe('http://localhost:3000')
  })

  it('rejects an empty target origin', () => {
    expect(() => createSession('   ')).toThrow(/target origin is empty/)
  })

  it('drops a session that has been idle past the TTL, on the next create', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const abandoned = createSession('http://127.0.0.1:3000')

    vi.setSystemTime(Date.now() + WEBPREVIEW_SESSION_IDLE_TTL_MS + 1_000)
    createSession('http://127.0.0.1:4000')

    expect(getSession(abandoned.id)).toBeUndefined()
  })

  it('expires an idle session on read, with no create to trigger the sweep', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const abandoned = createSession('http://127.0.0.1:3000')

    vi.setSystemTime(Date.now() + WEBPREVIEW_SESSION_IDLE_TTL_MS + 1_000)

    expect(getSession(abandoned.id)).toBeUndefined()
    expect(updateSessionOrigin(abandoned.id, 'http://127.0.0.1:4000')).toBeNull()
    expect(listSessions()).toHaveLength(0)
  })

  it('keeps a session alive while it is still being used', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const busy = createSession('http://127.0.0.1:3000')

    // Two-thirds of the TTL twice over: idle-since-last-use, not since-creation.
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(Date.now() + Math.floor(WEBPREVIEW_SESSION_IDLE_TTL_MS * (2 / 3)))
      expect(getSession(busy.id)).toBeDefined()
    }
    vi.setSystemTime(Date.now() + 1_000)
    createSession('http://127.0.0.1:4000')

    expect(getSession(busy.id)).toBeDefined()
  })

  it('caps the table and evicts the oldest session first', () => {
    const first = createSession('http://127.0.0.1:3000')
    for (let i = 1; i < WEBPREVIEW_MAX_SESSIONS; i++) {
      createSession(`http://127.0.0.1:${4000 + i}`)
    }
    expect(listSessions()).toHaveLength(WEBPREVIEW_MAX_SESSIONS)

    const newest = createSession('http://127.0.0.1:9999')

    expect(listSessions()).toHaveLength(WEBPREVIEW_MAX_SESSIONS)
    expect(getSession(first.id)).toBeUndefined()
    expect(getSession(newest.id)).toBeDefined()
  })

  it('lets the proxy follow at most four upstream retargets per navigation', () => {
    const session = createSession('http://a.test')
    for (let i = 1; i <= 4; i++) {
      expect(followSessionOrigin(session.id, `http://hop${i}.test`)).not.toBeNull()
    }
    expect(followSessionOrigin(session.id, 'http://hop5.test')).toBeNull()
    expect(getSession(session.id)?.targetOrigin).toBe('http://hop4.test')
  })

  it('resets the follow budget on a renderer-driven navigate', () => {
    const session = createSession('http://a.test')
    for (let i = 1; i <= 4; i++) {
      followSessionOrigin(session.id, `http://hop${i}.test`)
    }
    expect(followSessionOrigin(session.id, 'http://hop5.test')).toBeNull()

    expect(updateSessionOrigin(session.id, 'b.test:8080')?.targetOrigin).toBe('http://b.test:8080')

    expect(followSessionOrigin(session.id, 'http://c.test')).not.toBeNull()
  })

  it('stops rescuing a leaked path once its session has expired', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const session = createSession('http://127.0.0.1:3000')
    rememberLeakedPath('/assets/app.js', session.id)
    expect(getLeakedPathSession('/assets/app.js')).toBe(session.id)

    vi.setSystemTime(Date.now() + WEBPREVIEW_SESSION_IDLE_TTL_MS + 1_000)

    expect(getLeakedPathSession('/assets/app.js')).toBeUndefined()
  })

  it('returns null when retargeting a session that no longer exists', () => {
    expect(followSessionOrigin('deadbeef', 'http://a.test')).toBeNull()
    expect(updateSessionOrigin('deadbeef', 'http://a.test')).toBeNull()
  })
})
