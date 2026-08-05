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
  /** 'email' (default) sends the Supabase invite email; 'link' creates the
   *  invitation WITHOUT sending anything and returns the one-time URL to
   *  hand over yourself — no mailer, no built-in email rate limit. */
  delivery?: 'email' | 'link'
}

// The PUBLIC address the invite email should send people back to. On Vercel,
// new URL(req.url).origin can be the internal DEPLOYMENT domain (protected by
// Vercel's own login wall — invited users would hit a "log in to Vercel"
// page). Prefer the configured site URL, then the forwarded host the visitor
// actually used, and only then the raw request origin.
function siteOrigin(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (host) return `${req.headers.get('x-forwarded-proto') ?? 'https'}://${host}`
  return new URL(req.url).origin
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

  const redirectTo = `${siteOrigin(req)}/reset-password`
  let invitedUserId: string
  let inviteLink: string | null = null

  if (body?.delivery === 'link') {
    // No email involved — mint the one-time URL directly. For a login that
    // already exists (e.g. an earlier invite that never completed), an
    // invite-type link is refused, so fall back to a magic link: it signs
    // them in and lands on the same set-a-password page.
    let { data: linkData, error: linkError } = await service.auth.admin.generateLink({
      type: 'invite', email, options: { redirectTo },
    })
    if (linkError && /already/i.test(linkError.message)) {
      ;({ data: linkData, error: linkError } = await service.auth.admin.generateLink({
        type: 'magiclink', email, options: { redirectTo },
      }))
    }
    if (linkError || !linkData?.user || !linkData.properties?.hashed_token) {
      return NextResponse.json({ error: linkError?.message ?? 'Could not create the invite link.' }, { status: 500 })
    }
    invitedUserId = linkData.user.id
    // token_hash form: /reset-password verifies it directly (verifyOtp), so
    // the link works in ANY browser — the verify-endpoint ?code= redirect
    // only works in a browser that started a flow, which a shared link never has.
    const linkType = linkData.properties.verification_type === 'magiclink' ? 'magiclink' : 'invite'
    inviteLink = `${siteOrigin(req)}/reset-password?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=${linkType}`
  } else {
    const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(email, { redirectTo })
    if (inviteError || !invited?.user) {
      const msg = inviteError?.message ?? 'Invite failed.'
      const already = /already/i.test(msg)
      return NextResponse.json(
        { error: already ? `${email} already has a login — use "Invite link" instead, or assign their role on Settings → Users.` : msg },
        { status: already ? 409 : 500 },
      )
    }
    invitedUserId = invited.user.id
  }

  // Profile stamps role + org; the sync trigger creates the membership row.
  const { error: profileError } = await service.from('user_profiles').upsert(
    { user_id: invitedUserId, role, org_id: targetOrg },
    { onConflict: 'user_id' },
  )
  if (profileError) return NextResponse.json({ error: `Invited, but role assignment failed: ${profileError.message}` }, { status: 500 })
  if (role === 'viewer') {
    const { error: grantError } = await service.from('user_entity_access').upsert(
      entityIds.map((eid) => ({ user_id: invitedUserId, entity_id: eid, org_id: targetOrg })),
      { onConflict: 'user_id,entity_id' },
    )
    if (grantError) return NextResponse.json({ error: `Invited, but entity grants failed: ${grantError.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true, email, org: (org as { name: string }).name, role, link: inviteLink })
}
