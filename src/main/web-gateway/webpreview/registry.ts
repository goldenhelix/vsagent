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
    createdAt: Date.now()
  }
  sessions.set(id, session)
  return session
}

export function getSession(id: string): WebPreviewSession | undefined {
  return sessions.get(id)
}

export function updateSessionOrigin(id: string, targetOrigin: string): WebPreviewSession | null {
  const existing = sessions.get(id)
  if (!existing) return null
  existing.targetOrigin = normalizeOrigin(targetOrigin)
  return existing
}

export function deleteSession(id: string): void {
  sessions.delete(id)
}

export function listSessions(): WebPreviewSession[] {
  return [...sessions.values()]
}

function normalizeOrigin(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('webpreview: target origin is empty')
  // If no scheme, assume http (the common dev-server case is localhost:3000).
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  return `${url.protocol}//${url.host}`
}
