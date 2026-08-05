// The caller's organization, resolved SERVER-SIDE from their membership row —
// never from anything the client supplies. Works with both the browser client
// and the cookie-based server client (RLS lets a user read only their own
// membership; the 054 org-isolation policies are the real enforcement
// underneath). Cached per user id: upload loops and layout+page pairs resolve
// it repeatedly.

import type { SupabaseClient } from '@supabase/supabase-js'

let cached: { userId: string; orgId: string | null } | null = null

export async function getOrgId(supabase: SupabaseClient): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  if (cached?.userId === user.id) return cached.orgId
  const { data } = await supabase
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()
  const orgId = (data as { org_id?: string } | null)?.org_id ?? null
  cached = { userId: user.id, orgId }
  return orgId
}

/** Test hook / logout hygiene. */
export function clearOrgCache() {
  cached = null
}
