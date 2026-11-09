// The ops API's gate (2026-11-08; the contract is turnrow-farm
// docs/OPS_API.md): one read-only bearer token shared with the Turnrow
// Morning Brief and Turnrow Farm's Assignments. OPS_TOKEN (and OPS_TOKEN_NEXT
// during a rotation) live in the environment; digests are compared in
// constant time. Unset: 503. Missing or wrong: 401.

import { createHash, timingSafeEqual } from 'crypto'

export type OpsAuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string }

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

export function bearerOf(header: string | null | undefined): string | null {
  const m = (header ?? '').trim().match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() || null : null
}

export function checkOpsAuth(header: string | null | undefined, env: Record<string, string | undefined> = process.env): OpsAuthResult {
  const accepted = [env.OPS_TOKEN, env.OPS_TOKEN_NEXT].map((t) => (t ?? '').trim()).filter(Boolean)
  if (!accepted.length) return { ok: false, status: 503, error: 'The ops API is not configured.' }
  const token = bearerOf(header)
  if (!token) return { ok: false, status: 401, error: 'A bearer token is needed.' }
  const got = digest(token)
  let match = false
  for (const t of accepted) if (timingSafeEqual(got, digest(t))) match = true
  return match ? { ok: true } : { ok: false, status: 401, error: 'That token is not accepted.' }
}

/** The write half (2026-11-09; turnrow-farm docs/OPS_ACTIONS.md): the ops
 *  actions take ONLY OPS_WRITE_TOKEN (or OPS_WRITE_TOKEN_NEXT). The read
 *  token never opens them, even if someone set the two to the same value. */
export function checkOpsWriteAuth(header: string | null | undefined, env: Record<string, string | undefined> = process.env): OpsAuthResult {
  const reads = [env.OPS_TOKEN, env.OPS_TOKEN_NEXT].map((t) => (t ?? '').trim()).filter(Boolean)
  const accepted = [env.OPS_WRITE_TOKEN, env.OPS_WRITE_TOKEN_NEXT].map((t) => (t ?? '').trim()).filter((t) => t && !reads.includes(t))
  if (!accepted.length) return { ok: false, status: 503, error: 'Ops actions are not configured.' }
  const token = bearerOf(header)
  if (!token) return { ok: false, status: 401, error: 'A bearer token is needed.' }
  const got = digest(token)
  let match = false
  for (const t of accepted) if (timingSafeEqual(got, digest(t))) match = true
  return match ? { ok: true } : { ok: false, status: 401, error: 'That token is not accepted.' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** OPS_ORG names the one organization served: its id, or its slug
 *  (Stuart's is 'turnrow-farm'). */
export function orgFilter(value: string | undefined): { column: 'id' | 'slug'; value: string } | null {
  const v = (value ?? '').trim()
  if (!v) return null
  return { column: UUID.test(v) ? 'id' : 'slug', value: v }
}
