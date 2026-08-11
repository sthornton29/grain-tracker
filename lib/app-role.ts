import type { AppRole } from '@/lib/types'

/** The role stored in user_profiles, defensively narrowed: anything unknown
 *  (or no profile row) is 'owner' — the 042 backward-compatible default. */
export function coerceAppRole(raw: string | null | undefined): AppRole {
  return raw === 'gin' || raw === 'viewer' || raw === 'agronomist' ? raw : 'owner'
}

/** May this role edit Yields-page data (irr/dry breakouts, per-variety bushel
 *  allocations, "count anyway" overrides)? Owners only — viewers and
 *  agronomists (061) are read-only there. The Yields write functions check
 *  this before calling Supabase and the RESTRICTIVE RLS write-blocks
 *  (052/061) enforce it server-side regardless. */
export function roleCanEditYields(role: AppRole): boolean {
  return role === 'owner'
}
