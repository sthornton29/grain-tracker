'use client'

// Users & Modules — the module flags (Cotton) and the app's first role
// system. Roles: 'owner' (everything — the default for any user without a
// profile row) and 'gin' (ONLY the Cotton intake pages; enforced by nav,
// middleware redirect, and the 042 RLS policies). Login credentials are
// still created in the Supabase Auth dashboard (this app has no self-serve
// signup and no service key in the browser) — this page assigns ROLES to
// those logins by email. TRUE multi-producer gin access (one gin login
// across separate farmer accounts) requires the multi-tenant conversion,
// which extends this same role/RLS foundation.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type UserRow = { user_id: string; email: string; role: string }

export default function UsersModulesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [cottonEnabled, setCottonEnabled] = useState<boolean | null>(null)
  const [users, setUsers] = useState<UserRow[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'owner' | 'gin'>('gin')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function refresh() {
    const [settings, roles] = await Promise.all([
      supabase.from('app_settings').select('cotton_module_enabled').eq('id', 1).maybeSingle(),
      supabase.rpc('list_user_roles'),
    ])
    if (settings.error) { setErr(settings.error.message); return }
    setCottonEnabled(Boolean((settings.data as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled))
    if (!roles.error) setUsers((roles.data as UserRow[]) || [])
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

  async function assignRole(e: React.FormEvent) {
    e.preventDefault()
    setErr(null); setMsg(null)
    if (!email.trim()) { setErr('Enter the user’s email.'); return }
    setBusy(true)
    const { error } = await supabase.rpc('assign_user_role', { user_email: email.trim(), new_role: role })
    setBusy(false)
    if (error) { setErr(error.message.includes('no auth user') ? `No login exists for ${email.trim()} — create the user in the Supabase Auth dashboard first, then assign the role here.` : error.message); return }
    setMsg(`${email.trim()} is now ${role === 'gin' ? 'a gin operator (Cotton intake only)' : 'an owner (full access)'}.`)
    setEmail('')
    refresh()
  }

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
          (Seed Cotton Loads, Gin Receipts, Bales &amp; Grades) — no grain, contracts, hedging, financials, reports, or
          settings, enforced in the nav, by server-side redirect, and by row-level security. Create the login itself
          (email + password) in the <b>Supabase Auth dashboard</b> first, then assign its role here.
        </p>
        <form onSubmit={assignRole} className="flex flex-wrap items-end gap-2">
          <input type="email" placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputCls} w-64`} />
          <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'gin')} className={inputCls}>
            <option value="gin">gin (Cotton intake only)</option>
            <option value="owner">owner (full access)</option>
          </select>
          <button type="submit" disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
            Assign role
          </button>
        </form>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {msg && <p className="text-sm text-green-700">{msg}</p>}
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr>{['Email', 'Role'].map((h) => <th key={h} className="text-left px-3 py-2">{h}</th>)}</tr></thead>
          <tbody>
            {users.length === 0 && <tr><td colSpan={2} className="px-3 py-4 text-slate-400">No users listed (run migration 042).</td></tr>}
            {users.map((u) => (
              <tr key={u.user_id} className="border-t border-slate-100">
                <td className="px-3 py-2">{u.email}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs rounded-full px-2 py-0.5 ${u.role === 'gin' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>{u.role}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
