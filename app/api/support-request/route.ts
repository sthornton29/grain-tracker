// POST /api/support-request — the Contact Support form. Assembles the email
// (lib/support-request.ts, pure + tested) with the caller's context gathered
// SERVER-SIDE from their session (email, farm, role — never trusted from the
// body) and sends to support via Resend. Reply-To is the user, so support
// answers straight from the inbox. Graceful 503 when Resend isn't
// configured; per-user rate limit; sends logged server-side.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildSupportEmail } from '@/lib/support-request'

const SUPPORT_TO = 'stuart@turnrow.farm'
const MAX_MESSAGE = 8000
const MAX_TRANSCRIPT = 20000
const MAX_SHOT_BASE64 = 4.2 * 1024 * 1024 // ~3 MB binary
const RATE_LIMIT = 5 // per user per hour (per server instance)
const rateLog = new Map<string, number[]>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const seen = (rateLog.get(userId) ?? []).filter((t) => t > now - 60 * 60 * 1000)
  if (seen.length >= RATE_LIMIT) { rateLog.set(userId, seen); return true }
  seen.push(now)
  rateLog.set(userId, seen)
  return false
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 })
  if (rateLimited(user.id)) {
    return NextResponse.json({ error: 'A few messages are already on their way — give support a little time to reply.' }, { status: 429 })
  }

  const key = process.env.RESEND_API_KEY
  if (!key) {
    return NextResponse.json({ error: 'Support email isn’t set up yet — email stuart@turnrow.farm directly.' }, { status: 503 })
  }

  const body = (await req.json().catch(() => null)) as {
    subject?: string; message?: string; route?: string; transcript?: string
    screenshot?: { name?: string; type?: string; base64?: string }
  } | null
  const message = (body?.message ?? '').trim()
  if (!message) return NextResponse.json({ error: 'Tell us what you need help with.' }, { status: 400 })

  // Context comes from the SESSION, not the request body.
  const [{ data: membership }, { data: profile }] = await Promise.all([
    supabase.from('organization_members').select('org_id, organizations(name)').eq('user_id', user.id).limit(1).maybeSingle(),
    supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle(),
  ])
  const orgRef = (membership as { organizations?: { name?: string } | Array<{ name?: string }> } | null)?.organizations
  const orgName = (Array.isArray(orgRef) ? orgRef[0]?.name : orgRef?.name) ?? 'unknown'
  const role = (profile as { role?: string } | null)?.role ?? 'owner'
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev').slice(0, 7)

  const email = buildSupportEmail(
    {
      subject: (body?.subject ?? '').slice(0, 200),
      message: message.slice(0, MAX_MESSAGE),
      transcript: body?.transcript?.slice(0, MAX_TRANSCRIPT),
    },
    {
      userEmail: user.email,
      orgName,
      role,
      route: (body?.route ?? '/').slice(0, 200),
      version: commit,
      browser: (req.headers.get('user-agent') ?? 'unknown').slice(0, 300),
    },
  )

  const attachments: Array<{ filename: string; content: string }> = []
  const shot = body?.screenshot
  if (shot?.base64 && typeof shot.base64 === 'string') {
    if (!(shot.type ?? '').startsWith('image/')) {
      return NextResponse.json({ error: 'Screenshots must be an image.' }, { status: 400 })
    }
    if (shot.base64.length > MAX_SHOT_BASE64) {
      return NextResponse.json({ error: 'That image is too large — keep it under 3 MB.' }, { status: 400 })
    }
    attachments.push({ filename: (shot.name ?? 'screenshot.png').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 100), content: shot.base64 })
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.SUPPORT_FROM ?? 'Turnrow Support <support@turnrowgrain.com>',
      to: [SUPPORT_TO],
      reply_to: user.email,
      subject: email.subject,
      text: email.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error(`support-request send failed (${res.status}): ${detail.slice(0, 500)}`)
    return NextResponse.json({ error: 'Could not send right now — email stuart@turnrow.farm directly.' }, { status: 502 })
  }
  console.log(`support-request sent: ${user.email} (${orgName}) — "${email.subject}"${attachments.length ? ' +screenshot' : ''}${body?.transcript ? ' +transcript' : ''}`)
  return NextResponse.json({ ok: true })
}
