'use client'

// Platform admin (super-admin only; middleware bounces everyone else and the
// admin_* RPCs re-check is_super_admin). Beta scope: create orgs, see org
// METADATA (counts + last activity — deliberately NO cross-org record
// browsing; "support access" is not built, by choice), invite each org's
// first owner, and mint per-org partner API tokens (shown once).

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type OrgRow = {
  id: string; name: string; slug: string; created_at: string
  user_count: number; entity_count: number; load_count: number
  cotton_enabled: boolean; last_activity: string | null
}

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), [])
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [orgs, setOrgs] = useState<OrgRow[]>([])
  const [newOrgName, setNewOrgName] = useState('')
  const [inviteEmailByOrg, setInviteEmailByOrg] = useState<Record<string, string>>({})
  const [mintedToken, setMintedToken] = useState<{ org: string; token: string } | null>(null)
  const [inviteLink, setInviteLink] = useState<{ email: string; org: string; link: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function refresh() {
    const { data, error } = await supabase.rpc('admin_list_orgs')
    if (error) { setAllowed(false); return }
    setAllowed(true)
    setOrgs((data as OrgRow[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function createOrg(e: React.FormEvent) {
    e.preventDefault()
    setErr(null); setMsg(null)
    if (!newOrgName.trim()) { setErr('Enter the organization name.'); return }
    setBusy(true)
    const { error } = await supabase.rpc('admin_create_org', { org_name: newOrgName.trim() })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setMsg(`Created "${newOrgName.trim()}" — seeded with the standard crops, cotton module off. Invite its first owner below.`)
    setNewOrgName('')
    refresh()
  }

  async function inviteOwner(org: OrgRow, delivery: 'email' | 'link') {
    const email = (inviteEmailByOrg[org.id] ?? '').trim()
    setErr(null); setMsg(null); setInviteLink(null)
    if (!email) { setErr('Enter the email to invite.'); return }
    setBusy(true)
    const res = await fetch('/api/admin/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, role: 'owner', org_id: org.id, delivery }),
    })
    const json = await res.json().catch(() => null)
    setBusy(false)
    if (!res.ok) { setErr(json?.error ?? 'Invite failed.'); return }
    if (delivery === 'link' && json?.link) {
      setInviteLink({ email, org: org.name, link: json.link })
    } else {
      setMsg(`Invited ${email} as an owner of ${org.name} — they'll get an email to set their password.`)
    }
    setInviteEmailByOrg((m) => ({ ...m, [org.id]: '' }))
    refresh()
  }

  async function mintToken(org: OrgRow) {
    setErr(null); setMsg(null); setMintedToken(null)
    if (!window.confirm(`Mint a new partner API token for ${org.name}? The token is shown ONCE.`)) return
    setBusy(true)
    const { data, error } = await supabase.rpc('admin_create_partner_token', {
      target_org: org.id, token_label: `minted ${new Date().toISOString().slice(0, 10)}`,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setMintedToken({ org: org.name, token: data as string })
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const fmtWhen = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—')

  if (allowed === null) return <p className="text-slate-500">Loading…</p>
  if (!allowed) return <p className="text-slate-500">Page not found.</p>

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Platform Admin</h1>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold text-lg">Create an organization</h2>
        <p className="text-sm text-slate-500">
          Seeds the standard four crops and the org&apos;s settings (cotton module off). Then invite its first
          owner from the list below — they take it from there on their own Settings pages.
        </p>
        <form onSubmit={createOrg} className="flex flex-wrap items-end gap-2">
          <input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Farm / organization name" className={`${inputCls} w-72`} />
          <button type="submit" disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">Create</button>
        </form>
      </section>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      {inviteLink && (
        <div className="rounded-lg bg-sky-50 border border-sky-300 px-3 py-2 text-sm text-sky-900 space-y-1">
          <div><b>Invite link for {inviteLink.email} ({inviteLink.org})</b> — no email was sent. Text or email
          this to them yourself; it&rsquo;s their one-time set-a-password link:</div>
          <code className="block font-mono text-xs break-all bg-white rounded border border-sky-200 px-2 py-1">{inviteLink.link}</code>
          <button type="button" className="text-xs underline" onClick={() => { navigator.clipboard?.writeText(inviteLink.link); setMsg('Link copied.') }}>Copy to clipboard</button>
        </div>
      )}
      {mintedToken && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-900 space-y-1">
          <div><b>Partner API token for {mintedToken.org}</b> — copy it NOW; it is shown once and only its hash is stored:</div>
          <code className="block font-mono text-xs break-all bg-white rounded border border-amber-200 px-2 py-1">{mintedToken.token}</code>
          <button type="button" className="text-xs underline" onClick={() => { navigator.clipboard?.writeText(mintedToken.token); setMsg('Token copied.') }}>Copy to clipboard</button>
        </div>
      )}

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold text-lg">Organizations</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>{['Organization', 'Users', 'Entities', 'Loads', 'Cotton', 'Last activity', 'Created', 'Invite first owner', ''].map((h, i) => <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id} className="border-t border-slate-100 align-middle">
                  <td className="px-3 py-2"><div className="font-semibold">{o.name}</div><div className="text-xs text-slate-400">{o.slug}</div></td>
                  <td className="px-3 py-2 tabular-nums">{o.user_count}</td>
                  <td className="px-3 py-2 tabular-nums">{o.entity_count}</td>
                  <td className="px-3 py-2 tabular-nums">{o.load_count}</td>
                  <td className="px-3 py-2">{o.cotton_enabled ? 'on' : 'off'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtWhen(o.last_activity)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtWhen(o.created_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="email" placeholder="owner@example.com"
                        value={inviteEmailByOrg[o.id] ?? ''}
                        onChange={(e) => setInviteEmailByOrg((m) => ({ ...m, [o.id]: e.target.value }))}
                        className="rounded border border-slate-300 px-2 py-1 text-sm w-52"
                      />
                      <button type="button" disabled={busy} onClick={() => inviteOwner(o, 'email')}
                        className="rounded bg-brand hover:bg-brand-deep text-white px-2.5 py-1 text-xs font-semibold disabled:opacity-50">Invite</button>
                      <button type="button" disabled={busy} onClick={() => inviteOwner(o, 'link')}
                        title="Create the invitation without sending an email — you copy the link and send it yourself (no email rate limit)"
                        className="rounded border border-slate-300 text-slate-700 hover:bg-slate-50 px-2.5 py-1 text-xs font-semibold disabled:opacity-50">Invite link</button>
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button type="button" disabled={busy} onClick={() => mintToken(o)} className="text-brand-deep text-xs underline decoration-dotted">Partner token</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          Counts and dates only — no cross-org record access exists here (or anywhere), by design. Gin and
          viewer users are invited by each org&apos;s own owners on their Settings → Users page.
        </p>
      </section>
    </div>
  )
}
