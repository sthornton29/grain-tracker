import type { AppRole } from '@/lib/types'

/** The role stored in user_profiles, defensively narrowed: anything unknown
 *  (or no profile row) is 'owner' — the 042 backward-compatible default. */
export function coerceAppRole(raw: string | null | undefined): AppRole {
  return raw === 'gin' || raw === 'viewer' ? raw : 'owner'
}
