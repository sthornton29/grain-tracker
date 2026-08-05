// POST /api/admin/invite — invite a user by email into an org (beta flow:
// manual, no self-serve signup). Supabase sends the invite email; the link
// lands on /reset-password where the user sets a password, and their
// profile/membership/grants are already in place so they arrive IN their org
// with the assigned role.
//
// Who may call:
//   * a SUPER ADMIN (super_admins) — into any org, any role (viewer grants
//     validated against the TARGET org's entities);
//   * an org OWNER — into their own org only (org_id from their membership,
//     never the request body).
// The caller is identified by their SESSION (cookie client); the service
// role is used only for auth.admin.inviteUserByEmail and the RLS-bypassing
// profile/grant writes, which are all validated here first.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient, serviceClientMissingResponse } from '@/lib/partner-api-server'

type Body = {
  email?: string
  role?: 'owner' | 'gin' | 'viewer'
  org_id?: string
  entity_ids?: string[]
}

export async function POST(req: NextRequest) {
  const session = createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as Body | null
  const email = (body?.email ?? '').trim().toLowerCase()
  const role = body?.role
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })
  }
  if (role !== 'owner' && role !== 'gin' && role !== 'viewer') {
    return NextResponse.json({ error: 'role must be owner, gin, or viewer.' }, { status: 400 })
  }

  // Caller powers — via the SESSION client, so RLS vouches for every row.
  const [{ data: sa }, { data: membership }, { data: profile }] = await Promise.all([
    session.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    session.from('organization_members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle(),
    session.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle(),
  ])
  const isSuperAdmin = sa != null
  const callerOrg = (membership as { org_id?: string } | null)?.org_id ?? null
  const callerRole = (profile as { role?: string } | null)?.role ?? 'owner'

  let targetOrg: string | null
  if (isSuperAdmin) {
    targetOrg = (body?.org_id ?? '').trim() || callerOrg
  } else {
    if (callerRole !== 'owner') return NextResponse.json({ error: 'Only owners may invite users.' }, { status: 403 })
    targetOrg = callerOrg // NEVER from the request body for non-super-admins
  }
  if (!targetOrg) return NextResponse.json({ error: 'No target organization.' }, { status: 400 })

  const service = createServiceClient()
  if (!service) return serviceClientMissingResponse()

  // Validate the org and (for viewers) the entity grants against IT.
  const { data: org } = await service.from('organizations').select('id, name').eq('id', targetOrg).maybeSingle()
  if (!org) return NextResponse.json({ error: 'Unknown organization.' }, { status: 400 })
  const entityIds = Array.from(new Set(body?.entity_ids ?? []))
  if (role === 'viewer') {
    if (entityIds.length === 0) {
      return NextResponse.json({ error: 'A viewer needs at least one granted entity.' }, { status: 400 })
    }
    const { data: ents } = await service.from('entities').select('id').eq('org_id', targetOrg).in('id', entityIds)
    if ((ents ?? []).length !== entityIds.length) {
      return NextResponse.json({ error: 'Grant list contains entities outside the target organization.' }, { status: 400 })
    }
  }

  const origin = new URL(req.url).origin
  const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/reset-password`,
  })
  if (inviteError || !invited?.user) {
    const msg = inviteError?.message ?? 'Invite failed.'
    const already = /already/i.test(msg)
    return NextResponse.json(
      { error: already ? `${email} already has a login — assign their role on Settings → Users instead.` : msg },
      { status: already ? 409 : 500 },
    )
  }

  // Profile stamps role + org; the sync trigger creates the membership row.
  const { error: profileError } = await service.from('user_profiles').upsert(
    { user_id: invited.user.id, role, org_id: targetOrg },
    { onConflict: 'user_id' },
  )
  if (profileError) return NextResponse.json({ error: `Invited, but role assignment failed: ${profileError.message}` }, { status: 500 })
  if (role === 'viewer') {
    const { error: grantError } = await service.from('user_entity_access').insert(
      entityIds.map((eid) => ({ user_id: invited.user!.id, entity_id: eid, org_id: targetOrg })),
    )
    if (grantError) return NextResponse.json({ error: `Invited, but entity grants failed: ${grantError.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true, email, org: (org as { name: string }).name, role })
}
