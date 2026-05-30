// Session-to-origin registry for the webpreview proxy. A "session" is a
// short-lived mapping from an opaque ID to a target origin (scheme + host +
// port). The renderer creates one when the user opens a browser tab and a
// URL is set; the proxy looks it up on every incoming request.
//
// Sessions are not persisted: a backend restart drops them, and the
// renderer recreates them on the next address-bar enter. They're keyed by
// random 16-byte IDs, so guessing one for cross-tenant snooping is
// infeasible — but the gateway is a single-user assumption anyway.

import { randomBytes } from 'crypto'

export type WebPreviewSession = {
  id: string
  targetOrigin: string
  createdAt: number
  // Why: cap how many times the proxy will retarget a session in response
  // to upstream 30x's so a flip-flop redirect chain (http→https→http→…)
  // can't pin us in an infinite loop. Reset to 0 on a fresh navigate from
  // the renderer (setOrigin).
  followsSinceLastSetOrigin: number
}

const sessions = new Map<string, WebPreviewSession>()

export function createSession(targetOrigin: string): WebPreviewSession {
  // Normalize the origin so callers can pass scheme+host+port without a
  // path, and so URL parsing of the user input fails fast on garbage.
  const normalized = normalizeOrigin(targetOrigin)
  const id = randomBytes(16).toString('hex')
  const session: WebPreviewSession = {
    id,
    targetOrigin: normalized,
    createdAt: Date.now(),
    followsSinceLastSetOrigin: 0
  }
  sessions.set(id, session)
  return session
}

export function getSession(id: string): WebPreviewSession | undefined {
  return sessions.get(id)
}

export function updateSessionOrigin(id: string, targetOrigin: string): WebPreviewSession | null {
  const existing = sessions.get(id)
  if (!existing) {
    return null
  }
  existing.targetOrigin = normalizeOrigin(targetOrigin)
  // Why: reset the follow counter — this is a fresh navigate from the
  // renderer, not an upstream-driven retarget.
  existing.followsSinceLastSetOrigin = 0
  return existing
}

// Why: separate entry point for proxy-side retargeting so the depth cap
// only applies to upstream-driven follows, not renderer-driven navigations.
// Returns null when the cap is exceeded so the caller can fall back to _ext.
const MAX_FOLLOWS_PER_NAV = 4
export function followSessionOrigin(id: string, targetOrigin: string): WebPreviewSession | null {
  const existing = sessions.get(id)
  if (!existing) {
    return null
  }
  if (existing.followsSinceLastSetOrigin >= MAX_FOLLOWS_PER_NAV) {
    return null
  }
  existing.targetOrigin = normalizeOrigin(targetOrigin)
  existing.followsSinceLastSetOrigin += 1
  return existing
}

export function deleteSession(id: string): void {
  sessions.delete(id)
}

export function listSessions(): WebPreviewSession[] {
  return [...sessions.values()]
}

// Why: SPA routers (and root-relative assets) sometimes request a path WITHOUT
// the /__orca/webpreview/<id> prefix. The proxy rescues those via the Referer,
// but a follow-up request (e.g. a font referenced from a rescued CSS file) has
// a Referer that is itself a prefix-less leaked path, not a preview route. We
// remember which session first claimed each leaked path so the chain resolves —
// the same trick as MidTerm's leaked-path route cache. Bounded to avoid growth.
const leakedPathToSession = new Map<string, string>()
const MAX_LEAKED_PATHS = 2048

function normalizeLeakedPath(path: string): string {
  return path.split('?')[0].split('#')[0]
}

export function rememberLeakedPath(path: string, sessionId: string): void {
  const key = normalizeLeakedPath(path)
  if (!key || key === '/') {
    return
  }
  // Bounded FIFO: drop the oldest entry once we hit the cap.
  if (leakedPathToSession.size >= MAX_LEAKED_PATHS && !leakedPathToSession.has(key)) {
    const oldest = leakedPathToSession.keys().next().value
    if (oldest !== undefined) {
      leakedPathToSession.delete(oldest)
    }
  }
  leakedPathToSession.set(key, sessionId)
}

export function getLeakedPathSession(path: string): string | undefined {
  const id = leakedPathToSession.get(normalizeLeakedPath(path))
  // Only return live sessions; a dropped session's stale mapping is ignored.
  return id && sessions.has(id) ? id : undefined
}

function normalizeOrigin(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('webpreview: target origin is empty')
  }
  // If no scheme, assume http (the common dev-server case is localhost:3000).
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  return `${url.protocol}//${url.host}`
}
