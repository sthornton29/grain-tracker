'use client'

// Users & Modules — the module flags (Cotton) and the app's role system.
// Roles: 'owner' (everything — the default for any user without a profile
// row), 'gin' (ONLY the Cotton intake pages), 'viewer' (read-only
// stakeholder: ONLY Yields + Reports, scoped to the entities granted here),
// and 'agronomist' (ONLY the Yields page, org-wide — no entity grants) —
// enforced by nav, middleware redirect, and the 042/052/061 RLS policies.
// Login credentials are still created in the Supabase Auth dashboard (this
// app has no self-serve signup and no service key in the browser) — this
// page assigns ROLES to those logins: by email in the form, or inline per
// row in the users table (Edit). Assigning 'viewer' REQUIRES picking at
// least one entity; the grants replace any previous set. You cannot change
// YOUR OWN role — the last owner demoting themselves would lock everyone
// out of role management.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { openHelp } from '@/lib/help-bus'
import { coerceAppRole } from '@/lib/app-role'
import type { AppRole, Entity } from '@/lib/types'

type UserRow = { user_id: string; email: string; role: string; entity_ids: string[] | null }

// ONE option list for all three role dropdowns (invite / assign / inline
// edit) — adding a role means adding a line here, nowhere else.
const ROLE_OPTIONS: Array<{ value: AppRole; label: string }> = [
  { value: 'owner', label: 'owner (full access)' },
  { value: 'gin', label: 'gin (Cotton intake only)' },
  { value: 'viewer', label: 'viewer (reports & yields, read-only)' },
  { value: 'agronomist', label: 'agronomist (yields only, read-only)' },
]

export default function UsersModulesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [cottonEnabled, setCottonEnabled] = useState<boolean | null>(null)
  const [settingsId, setSettingsId] = useState<number | null>(null)
  const [users, setUsers] = useState<UserRow[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AppRole>('owner')
  const [grantIds, setGrantIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // Invite-by-email (055): Supabase emails a set-your-password link; the
  // user lands in this org with the chosen role already assigned.
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<AppRole>('owner')
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

  async function inviteUser(delivery: 'email' | 'link') {
    setErr(null); setMsg(null); setInviteLink(null)
    if (!inviteEmail.trim()) { setErr('Enter the email to invite.'); return }
    if (inviteRole === 'viewer' && inviteGrantIds.size === 0) { setErr('Pick at least one entity the viewer may see.'); return }
    setBusy(true)
    const res = await fetch('/api/admin/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: inviteEmail.trim(),
        role: inviteRole,
        entity_ids: inviteRole === 'viewer' ? Array.from(inviteGrantIds) : undefined,
        delivery,
      }),
    })
    const json = await res.json().catch(() => null)
    setBusy(false)
    if (!res.ok) { setErr(json?.error ?? 'Invite failed.'); return }
    if (delivery === 'link' && json?.link) {
      setInviteLink({ email: inviteEmail.trim(), link: json.link })
      setMsg(null)
    } else {
      setMsg(`Invited ${inviteEmail.trim()} as ${inviteRole} — they'll get an email to set their password and land in this organization.`)
    }
    setInviteEmail(''); setInviteGrantIds(new Set())
    refresh()
  }

  function toggleInviteGrant(id: string) {
    setInviteGrantIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function refresh() {
    const [settings, roles, ents] = await Promise.all([
      // The org's own settings row via RLS (054) — no fixed id.
      supabase.from('app_settings').select('id, cotton_module_enabled').limit(1).maybeSingle(),
      supabase.rpc('list_user_roles'),
      supabase.from('entities').select('*').order('name'),
    ])
    if (settings.error) { setErr(settings.error.message); return }
    const row = settings.data as { id?: number; cotton_module_enabled?: boolean } | null
    setCottonEnabled(Boolean(row?.cotton_module_enabled))
    setSettingsId(row?.id ?? null)
    if (!roles.error) setUsers((roles.data as UserRow[]) || [])
    if (!ents.error) setEntities((ents.data as Entity[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function toggleCotton(next: boolean) {
    if (settingsId == null) return
    setBusy(true); setErr(null)
    const { error } = await supabase.from('app_settings')
      .update({ cotton_module_enabled: next, updated_at: new Date().toISOString() })
      .eq('id', settingsId)
    setBusy(false)
    if (error) { setErr(error.message); return }
    setCottonEnabled(next)
    setMsg(`Cotton module ${next ? 'enabled — the Cotton nav appears after the next page load' : 'disabled'}.`)
  }

  function toggleGrant(id: string) {
    setGrantIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function assignRole(e: React.FormEvent) {
    e.preventDefault()
    setErr(null); setMsg(null)
    if (!email.trim()) { setErr('Enter the user’s email.'); return }
    if (role === 'viewer' && grantIds.size === 0) { setErr('Pick at least one entity the viewer may see.'); return }
    setBusy(true)
    const { error } = await supabase.rpc('assign_user_role', {
      user_email: email.trim(),
      new_role: role,
      entity_ids: role === 'viewer' ? Array.from(grantIds) : null,
    })
    setBusy(false)
    if (error) { setErr(error.message.includes('no auth user') ? `No login exists for ${email.trim()} yet — use “Invite a user” above to add them.` : error.message); return }
    const grantNames = entities.filter((en) => grantIds.has(en.id)).map((en) => en.name).join(', ')
    setMsg(
      role === 'gin' ? `${email.trim()} is now a gin operator (Cotton intake only).`
      : role === 'viewer' ? `${email.trim()} is now a viewer (reports & yields for: ${grantNames}).`
      : role === 'agronomist' ? `${email.trim()} is now an agronomist (Yields only, whole operation, read-only).`
      : `${email.trim()} is now an owner (full access).`
    )
    setEmail('')
    setGrantIds(new Set())
    refresh()
  }

  const entityName = (id: string) => entities.find((en) => en.id === id)?.name ?? '…'

  function startEdit(u: UserRow) {
    setErr(null); setMsg(null)
    setEditingId(u.user_id)
    setEditRole(coerceAppRole(u.role))
    setEditGrantIds(new Set(u.entity_ids ?? []))
  }

  function toggleEditGrant(id: string) {
    setEditGrantIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function saveEdit(u: UserRow) {
    setErr(null); setMsg(null)
    if (editRole === 'viewer' && editGrantIds.size === 0) { setErr('Pick at least one entity the viewer may see.'); return }
    setBusy(true)
    const { error } = await supabase.rpc('assign_user_role', {
      user_email: u.email,
      new_role: editRole,
      entity_ids: editRole === 'viewer' ? Array.from(editGrantIds) : null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    const grantNames = entities.filter((en) => editGrantIds.has(en.id)).map((en) => en.name).join(', ')
    setMsg(
      editRole === 'gin' ? `${u.email} is now a gin operator (Cotton intake only).`
      : editRole === 'viewer' ? `${u.email} is now a viewer (reports & yields for: ${grantNames}).`
      : editRole === 'agronomist' ? `${u.email} is now an agronomist (Yields only, whole operation, read-only).`
      : `${u.email} is now an owner (full access).`
    )
    setEditingId(null)
    refresh()
  }
  const rolePill = (r: string) =>
    r === 'gin' ? 'bg-amber-100 text-amber-800'
    : r === 'viewer' ? 'bg-violet-100 text-violet-800'
    : r === 'agronomist' ? 'bg-sky-100 text-sky-800'
    : 'bg-green-100 text-green-800'
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Users &amp; Modules</h1>

      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold text-lg">Modules</h2>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={cottonEnabled ?? false}
            disabled={busy || cottonEnabled == null}
            onChange={(e) => toggleCotton(e.target.checked)}
            className="h-5 w-5"
          />
          <span>
            <b>Cotton module</b> — seed cotton loads, gin receipts, bales &amp; classing data, cotton yields and
            hedging. When off, no cotton nav, pages, or report sections appear.
          </span>
        </label>
      </section>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold text-lg">Invite a user</h2>
        <p className="text-sm text-slate-500">
          Sends an email with a set-your-password link; they land in this organization with the role you pick.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); inviteUser('email') }} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <input type="email" placeholder="user@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className={`${inputCls} w-64`} />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as AppRole)} className={inputCls}>
              {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button type="submit" disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
              Send invite
            </button>
            <button type="button" disabled={busy} onClick={() => inviteUser('link')}
              title="Create the invitation without sending an email — copy the link and text/email it yourself"
              className="rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 font-semibold disabled:opacity-50">
              Invite link
            </button>
          </div>
          {inviteLink && (
            <div className="rounded-lg bg-sky-50 border border-sky-300 px-3 py-2 text-sm text-sky-900 space-y-1">
              <div><b>Invite link for {inviteLink.email}</b> — no email was sent. Text or email it to them
              yourself; it&rsquo;s their one-time set-a-password link:</div>
              <code className="block font-mono text-xs break-all bg-white rounded border border-sky-200 px-2 py-1">{inviteLink.link}</code>
              <button type="button" className="text-xs underline" onClick={() => { navigator.clipboard?.writeText(inviteLink.link); setMsg('Link copied.') }}>Copy to clipboard</button>
            </div>
          )}
          {inviteRole === 'viewer' && (
            <fieldset className="rounded-lg border border-slate-200 p-3">
              <legend className="text-sm font-semibold px-1">Entities this viewer may see (required — pick at least one)</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {entities.map((en) => (
                  <label key={en.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={inviteGrantIds.has(en.id)} onChange={() => toggleInviteGrant(en.id)} className="h-4 w-4" />
                    <span>{en.name}{en.entity_role === 'marketing_agent' ? ' (marketing agent)' : ''}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </form>
      </section>

      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold text-lg">Users &amp; Roles</h2>
        <p className="text-sm text-slate-500">
          <b>owner</b> = everything · <b>gin</b> = cotton intake only · <b>viewer</b> = read-only reports for
          chosen entities · <b>agronomist</b> = the Yields page only, whole operation, read-only. Prefer the
          invite above for new people; this form assigns roles to logins that already exist.{' '}
          <button type="button" onClick={() => openHelp('/settings/users')} className="text-brand-deep underline decoration-dotted">
            Learn more about roles
          </button>
          {isSuperAdmin && <> {' '}· <a href="/admin" className="text-brand-deep underline decoration-dotted">Platform admin →</a></>}
        </p>
        <form onSubmit={assignRole} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <input type="email" placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputCls} w-64`} />
            <select value={role} onChange={(e) => setRole(e.target.value as AppRole)} className={inputCls}>
              {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button type="submit" disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
              Assign role
            </button>
          </div>
          {role === 'viewer' && (
            <fieldset className="rounded-lg border border-slate-200 p-3">
              <legend className="text-sm font-semibold px-1">Entities this viewer may see (required — pick at least one)</legend>
              {entities.length === 0 && <p className="text-sm text-slate-400">No entities yet — add them under Settings → Entities first.</p>}
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {entities.map((en) => (
                  <label key={en.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={grantIds.has(en.id)} onChange={() => toggleGrant(en.id)} className="h-4 w-4" />
                    <span>{en.name}{en.entity_role === 'marketing_agent' ? ' (marketing agent)' : ''}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                “All entities” for this viewer means all of the entities checked here, combined. Agent-held contracts
                and hedges show only these entities’ pro-rata shares.
              </p>
            </fieldset>
          )}
        </form>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {msg && <p className="text-sm text-green-700">{msg}</p>}
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr>{['Email', 'Role', 'Entities', ''].map((h, i) => <th key={i} className="text-left px-3 py-2">{h}</th>)}</tr></thead>
          <tbody>
            {users.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-slate-400">No users listed — this part of Turnrow isn’t set up yet. Contact support.</td></tr>}
            {users.map((u) => {
              const isSelf = u.user_id === myUserId
              const isEditing = editingId === u.user_id
              return (
              <Fragment key={u.user_id}>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2">{u.email}{isSelf && <span className="ml-1.5 text-xs text-slate-400">(you)</span>}</td>
                <td className="px-3 py-2">
                  {isEditing ? (
                    <select value={editRole} onChange={(e) => setEditRole(e.target.value as AppRole)} className="rounded border border-slate-300 px-2 py-1 text-sm bg-white">
                      {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <span className={`text-xs rounded-full px-2 py-0.5 ${rolePill(u.role)}`}>{u.role}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {!isEditing && (u.role === 'viewer' ? ((u.entity_ids ?? []).map(entityName).join(', ') || '—') : '')}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {isEditing ? (
                    <span className="inline-flex gap-2">
                      <button type="button" disabled={busy} onClick={() => saveEdit(u)}
                        className="rounded bg-brand hover:bg-brand-deep text-white px-2.5 py-1 text-xs font-semibold disabled:opacity-50">Save</button>
                      <button type="button" onClick={() => setEditingId(null)} className="text-slate-500 text-xs">Cancel</button>
                    </span>
                  ) : isSelf ? (
                    <span className="text-xs text-slate-400 cursor-help" title="You can't change your own role — the last owner demoting themselves would lock everyone out of role management. Have another owner change it, or contact support.">—</span>
                  ) : (
                    <button type="button" onClick={() => startEdit(u)} className="text-brand-deep text-xs underline decoration-dotted">Edit</button>
                  )}
                </td>
              </tr>
              {isEditing && editRole === 'viewer' && (
                <tr className="border-t border-slate-50 bg-violet-50/40">
                  <td colSpan={4} className="px-3 py-2">
                    <div className="text-xs font-semibold text-slate-600 mb-1.5">Entities this viewer may see (required — pick at least one)</div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                      {entities.map((en) => (
                        <label key={en.id} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={editGrantIds.has(en.id)} onChange={() => toggleEditGrant(en.id)} className="h-4 w-4" />
                          <span>{en.name}{en.entity_role === 'marketing_agent' ? ' (marketing agent)' : ''}</span>
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              )
            })}
          </tbody>
        </table>
      </section>
    </div>
  )
}
