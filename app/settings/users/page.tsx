'use client'

// Users & Modules — the module flags (Cotton) and the app's role system.
// Roles: 'owner' (everything — the default for any user without a profile
// row), 'gin' (ONLY the Cotton intake pages), and 'viewer' (read-only
// stakeholder: ONLY Yields + Reports, scoped to the entities granted here —
// enforced by nav, middleware redirect, and the 042/052 RLS policies).
// Login credentials are still created in the Supabase Auth dashboard (this
// app has no self-serve signup and no service key in the browser) — this
// page assigns ROLES to those logins by email. Assigning 'viewer' REQUIRES
// picking at least one entity; the grants replace any previous set.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Entity } from '@/lib/types'

type UserRow = { user_id: string; email: string; role: string; entity_ids: string[] | null }

export default function UsersModulesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [cottonEnabled, setCottonEnabled] = useState<boolean | null>(null)
  const [users, setUsers] = useState<UserRow[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'owner' | 'gin' | 'viewer'>('gin')
  const [grantIds, setGrantIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function refresh() {
    const [settings, roles, ents] = await Promise.all([
      supabase.from('app_settings').select('cotton_module_enabled').eq('id', 1).maybeSingle(),
      supabase.rpc('list_user_roles'),
      supabase.from('entities').select('*').order('name'),
    ])
    if (settings.error) { setErr(settings.error.message); return }
    setCottonEnabled(Boolean((settings.data as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled))
    if (!roles.error) setUsers((roles.data as UserRow[]) || [])
    if (!ents.error) setEntities((ents.data as Entity[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function toggleCotton(next: boolean) {
    setBusy(true); setErr(null)
    const { error } = await supabase.from('app_settings')
      .update({ cotton_module_enabled: next, updated_at: new Date().toISOString() })
      .eq('id', 1)
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
    if (error) { setErr(error.message.includes('no auth user') ? `No login exists for ${email.trim()} — create the user in the Supabase Auth dashboard first, then assign the role here.` : error.message); return }
    const grantNames = entities.filter((en) => grantIds.has(en.id)).map((en) => en.name).join(', ')
    setMsg(
      role === 'gin' ? `${email.trim()} is now a gin operator (Cotton intake only).`
      : role === 'viewer' ? `${email.trim()} is now a viewer (reports & yields for: ${grantNames}).`
      : `${email.trim()} is now an owner (full access).`
    )
    setEmail('')
    setGrantIds(new Set())
    refresh()
  }

  const entityName = (id: string) => entities.find((en) => en.id === id)?.name ?? '…'
  const rolePill = (r: string) =>
    r === 'gin' ? 'bg-amber-100 text-amber-800'
    : r === 'viewer' ? 'bg-violet-100 text-violet-800'
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
        <h2 className="font-semibold text-lg">Users &amp; Roles</h2>
        <p className="text-sm text-slate-500">
          <b>owner</b> = full access (the default). <b>gin</b> = the gin operator role: ONLY the Cotton intake pages
          (Seed Cotton Loads, Gin Receipts, Bales &amp; Grades). <b>viewer</b> = read-only stakeholder: ONLY the Yields
          page and the Reports, limited to the entities you pick below, with no editing anywhere (their report
          assumption tweaks are private to them and never touch your numbers). All of it enforced in the nav, by
          server-side redirect, and by row-level security. Create the login itself (email + password) in the{' '}
          <b>Supabase Auth dashboard</b> first, then assign its role here.
        </p>
        <form onSubmit={assignRole} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <input type="email" placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputCls} w-64`} />
            <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'gin' | 'viewer')} className={inputCls}>
              <option value="gin">gin (Cotton intake only)</option>
              <option value="viewer">viewer (reports &amp; yields, read-only)</option>
              <option value="owner">owner (full access)</option>
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
          <thead className="bg-slate-50 text-slate-600"><tr>{['Email', 'Role', 'Entities'].map((h) => <th key={h} className="text-left px-3 py-2">{h}</th>)}</tr></thead>
          <tbody>
            {users.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-slate-400">No users listed (run migration 042).</td></tr>}
            {users.map((u) => (
              <tr key={u.user_id} className="border-t border-slate-100">
                <td className="px-3 py-2">{u.email}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs rounded-full px-2 py-0.5 ${rolePill(u.role)}`}>{u.role}</span>
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {u.role === 'viewer' ? ((u.entity_ids ?? []).map(entityName).join(', ') || '—') : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
