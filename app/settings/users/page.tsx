'use client'

// Settings → Users — who can sign in and what each person sees.
// Roles: 'owner' (everything — the default for any user without a profile
// row), 'gin' (ONLY the Cotton intake pages), 'viewer' (read-only
// stakeholder: ONLY Yields + Reports, scoped to the entities granted here),
// and 'agronomist' (ONLY the Yields page, org-wide — no entity grants) —
// enforced by nav, middleware redirect, and the 042/052/061 RLS policies.
// ONE way to add someone: the "Add a person" card invites by email (055) with
// the role chosen up front — no pre-selected role, so nobody gets full
// access by accident. Existing people are changed from their row (Edit),
// which uses the same assign_user_role RPC the old standalone form did.
// Assigning 'viewer' REQUIRES picking at least one entity; the grants
// replace any previous set. You cannot change YOUR OWN role — the last
// owner demoting themselves would lock everyone out of role management.
// The Cotton switch lives on Settings → Organization.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { openHelp } from '@/lib/help-bus'
import { coerceAppRole } from '@/lib/app-role'
import { reportError } from '@/lib/friendly-error'
import type { AppRole, Entity } from '@/lib/types'

type UserRow = { user_id: string; email: string; role: string; entity_ids: string[] | null }

// ONE role list for the add card and the row editor — adding a role means
// adding a line here, nowhere else. Farmer terms, not role codes.
const ROLES: Array<{ value: AppRole; label: string; blurb: string }> = [
  { value: 'owner', label: 'Farm owner or manager', blurb: 'Everything — loads, contracts, reports, settings.' },
  { value: 'gin', label: 'Gin', blurb: 'Enters seed cotton loads only. No dollars, no reports.' },
  { value: 'viewer', label: 'Landlord or stakeholder', blurb: 'Read-only reports for the farms you pick.' },
  { value: 'agronomist', label: 'Agronomist', blurb: 'Yields only, for the whole operation — no dollars.' },
]
const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r

export default function UsersPage() {
  const supabase = useMemo(() => createClient(), [])
  const [users, setUsers] = useState<UserRow[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // Add a person (invite by email).
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<AppRole | ''>('')
  const [inviteGrantIds, setInviteGrantIds] = useState<Set<string>>(new Set())
  const [inviteLink, setInviteLink] = useState<{ email: string; link: string } | null>(null)
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  // Inline per-row role editing.
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRole, setEditRole] = useState<AppRole>('owner')
  const [editGrantIds, setEditGrantIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setMyUserId(user?.id ?? null)
      if (user) {
        const { data: sa } = await supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle()
        setIsSuperAdmin(sa != null)
      }
    })()
  }, [supabase])

  async function refresh() {
    const [roles, ents] = await Promise.all([
      supabase.rpc('list_user_roles'),
      supabase.from('entities').select('*').order('name'),
    ])
    if (roles.error) { setErr(reportError(roles.error, { action: 'load the people on this operation' })); return }
    setUsers((roles.data as UserRow[]) || [])
    if (!ents.error) setEntities((ents.data as Entity[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())
  const inviteBlocker =
    !inviteEmail.trim() ? 'Enter their email address.'
    : !emailOk ? 'That doesn’t look like an email address.'
    : !inviteRole ? 'Choose what they should see.'
    : inviteRole === 'viewer' && inviteGrantIds.size === 0 ? 'Pick at least one entity they may see.'
    : null

  async function inviteUser(delivery: 'email' | 'link') {
    setErr(null); setMsg(null); setInviteLink(null)
    if (inviteBlocker || !inviteRole) { setErr(inviteBlocker); return }
    setBusy(true)
    let json: { error?: string; link?: string } | null = null
    let ok = false
    try {
      const res = await fetch('/api/admin/invite', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole,
          entity_ids: inviteRole === 'viewer' ? Array.from(inviteGrantIds) : undefined,
          delivery,
        }),
      })
      json = await res.json().catch(() => null)
      ok = res.ok
    } catch (e) {
      setBusy(false)
      setErr(reportError(e as Error, { action: 'send the invitation' }))
      return
    }
    setBusy(false)
    if (!ok) { setErr(json?.error ?? reportError({ message: json?.error ?? null }, { action: 'send the invitation' })); return }
    if (delivery === 'link' && json?.link) {
      setInviteLink({ email: inviteEmail.trim(), link: json.link })
    } else {
      setMsg(`Invited ${inviteEmail.trim()} as ${roleLabel(inviteRole).toLowerCase()} — they’ll get an email to set their password and land in this operation.`)
    }
    setInviteEmail(''); setInviteRole(''); setInviteGrantIds(new Set())
    refresh()
  }

  const toggleIn = (set: (f: (prev: Set<string>) => Set<string>) => void) => (id: string) =>
    set((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleInviteGrant = toggleIn(setInviteGrantIds)
  const toggleEditGrant = toggleIn(setEditGrantIds)

  const entityName = (id: string) => entities.find((en) => en.id === id)?.name ?? '…'

  function startEdit(u: UserRow) {
    setErr(null); setMsg(null)
    setEditingId(u.user_id)
    setEditRole(coerceAppRole(u.role))
    setEditGrantIds(new Set(u.entity_ids ?? []))
  }

  async function saveEdit(u: UserRow) {
    setErr(null); setMsg(null)
    if (editRole === 'viewer' && editGrantIds.size === 0) { setErr('Pick at least one entity they may see.'); return }
    setBusy(true)
    const { error } = await supabase.rpc('assign_user_role', {
      user_email: u.email,
      new_role: editRole,
      entity_ids: editRole === 'viewer' ? Array.from(editGrantIds) : null,
    })
    setBusy(false)
    if (error) { setErr(reportError(error, { action: `change what ${u.email} can see` })); return }
    const grantNames = entities.filter((en) => editGrantIds.has(en.id)).map((en) => en.name).join(', ')
    setMsg(
      editRole === 'viewer'
        ? `${u.email} now sees read-only reports for: ${grantNames}.`
        : `${u.email} is now set to “${roleLabel(editRole)}”.`
    )
    setEditingId(null)
    refresh()
  }

  const rolePill = (r: string) =>
    r === 'gin' ? 'bg-amber-100 text-amber-800'
    : r === 'viewer' ? 'bg-violet-100 text-violet-800'
    : r === 'agronomist' ? 'bg-sky-100 text-sky-800'
    : 'bg-green-100 text-green-800'
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11'

  const entityPicker = (selected: Set<string>, toggle: (id: string) => void, name: string) => (
    <fieldset className="rounded-lg border border-slate-200 p-3">
      <legend className="text-sm font-semibold px-1">Entities they may see (pick at least one)</legend>
      {entities.length === 0 && <p className="text-sm text-slate-500">No entities yet — add them under Settings → Entities first.</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {entities.map((en) => (
          <label key={en.id} className="flex items-center gap-2 text-sm min-h-11">
            <input type="checkbox" name={name} checked={selected.has(en.id)} onChange={() => toggle(en.id)} className="h-5 w-5" />
            <span>{en.name}{en.entity_role === 'marketing_agent' ? ' (marketing agent)' : ''}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500 mt-2">
        They see only these entities’ share of the numbers. Contracts and hedges held by a marketing agent show only these entities’ pro-rata part.
      </p>
    </fieldset>
  )

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-sm text-slate-500 mt-1">
          Who can sign in to this operation and what each person sees.{' '}
          <button type="button" onClick={() => openHelp('/settings/users')} className="text-brand-deep underline decoration-dotted">
            How the access levels work
          </button>
          {isSuperAdmin && <> {' '}· <a href="/admin" className="text-brand-deep underline decoration-dotted">Platform admin →</a></>}
        </p>
      </div>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold text-lg">Add a person</h2>
        <form onSubmit={(e) => { e.preventDefault(); inviteUser('email') }} className="space-y-3">
          <label className="block text-sm text-slate-700 max-w-sm">
            Their email address
            <input
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className={`${inputCls} mt-1 w-full`}
            />
          </label>

          <fieldset>
            <legend className="text-sm text-slate-700 mb-1.5">What should they see?</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ROLES.map((r) => {
                const checked = inviteRole === r.value
                return (
                  <label
                    key={r.value}
                    className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer min-h-11 ${checked ? 'border-brand bg-green-50/50' : 'border-slate-200 hover:border-slate-300'}`}
                  >
                    <input
                      type="radio"
                      name="invite-role"
                      value={r.value}
                      checked={checked}
                      onChange={() => setInviteRole(r.value)}
                      className="mt-1 h-5 w-5 accent-brand"
                    />
                    <span>
                      <span className="block font-semibold text-sm">{r.label}</span>
                      <span className="block text-sm text-slate-600">{r.blurb}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          {inviteRole === 'viewer' && entityPicker(inviteGrantIds, toggleInviteGrant, 'invite-entity')}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || inviteBlocker != null}
              className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send invitation'}
            </button>
            <button
              type="button"
              disabled={busy || inviteBlocker != null}
              onClick={() => inviteUser('link')}
              title="Create the invitation without sending an email — copy the link and text or email it yourself"
              className="rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 min-h-11 font-semibold disabled:opacity-50"
            >
              Get a link instead
            </button>
            {inviteBlocker && <span className="text-sm text-slate-500">{inviteBlocker}</span>}
          </div>
          <p className="text-xs text-slate-500">
            They get an email with a set-your-password link and land in this operation with the access you chose.
          </p>

          {inviteLink && (
            <div className="rounded-lg bg-sky-50 border border-sky-300 px-3 py-2 text-sm text-sky-900 space-y-1">
              <div><b>Invite link for {inviteLink.email}</b> — no email was sent. Text or email it to them
              yourself; it&rsquo;s their one-time set-a-password link:</div>
              <code className="block font-mono text-xs break-all bg-white rounded border border-sky-200 px-2 py-1">{inviteLink.link}</code>
              <button type="button" className="text-xs underline min-h-11" onClick={() => { navigator.clipboard?.writeText(inviteLink.link); setMsg('Link copied.') }}>Copy to clipboard</button>
            </div>
          )}
        </form>
      </section>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold text-lg">People on this operation</h2>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {msg && <p className="text-sm text-green-700">{msg}</p>}
        <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr>{['Email', 'Sees', 'Entities', ''].map((h, i) => <th key={i} className="text-left px-3 py-2">{h}</th>)}</tr></thead>
          <tbody>
            {users.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-slate-500">Nobody listed yet. Add the first person above — you’ll appear here once your own login is set up.</td></tr>}
            {users.map((u) => {
              const isSelf = u.user_id === myUserId
              const isEditing = editingId === u.user_id
              return (
              <Fragment key={u.user_id}>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2">{u.email}{isSelf && <span className="ml-1.5 text-xs text-slate-400">(you)</span>}</td>
                <td className="px-3 py-2">
                  {isEditing ? (
                    <select value={editRole} onChange={(e) => setEditRole(e.target.value as AppRole)} aria-label={`Access for ${u.email}`} className="rounded border border-slate-300 px-2 py-1 text-sm bg-white min-h-11">
                      {ROLES.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.blurb}</option>)}
                    </select>
                  ) : (
                    <span className={`text-xs rounded-full px-2 py-0.5 whitespace-nowrap ${rolePill(u.role)}`}>{roleLabel(u.role)}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {!isEditing && (u.role === 'viewer' ? ((u.entity_ids ?? []).map(entityName).join(', ') || '—') : '')}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {isEditing ? (
                    <span className="inline-flex gap-1">
                      <button type="button" disabled={busy} onClick={() => saveEdit(u)}
                        className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-11 text-sm font-semibold disabled:opacity-50">Save</button>
                      <button type="button" onClick={() => setEditingId(null)} className="text-slate-500 text-sm px-3 min-h-11">Cancel</button>
                    </span>
                  ) : isSelf ? (
                    <span className="text-xs text-slate-400 cursor-help" title="You can't change your own access — if the last owner stepped down, nobody could manage people. Have another owner change it, or contact support.">—</span>
                  ) : (
                    <button type="button" onClick={() => startEdit(u)} className="text-brand-deep text-sm px-3 min-h-11 underline decoration-dotted">Edit</button>
                  )}
                </td>
              </tr>
              {isEditing && editRole === 'viewer' && (
                <tr className="border-t border-slate-50 bg-violet-50/40">
                  <td colSpan={4} className="px-3 py-2">
                    {entityPicker(editGrantIds, toggleEditGrant, `edit-entity-${u.user_id}`)}
                  </td>
                </tr>
              )}
              </Fragment>
              )
            })}
          </tbody>
        </table>
        </div>
      </section>
    </div>
  )
}
