import Link from 'next/link'
import { reportGroupsFor } from './reports-nav'
import { createClient } from '@/lib/supabase/server'
import { coerceAppRole } from '@/lib/app-role'

export default async function ReportsLanding() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const [{ data: profile }, { data: settings }] = user
    ? await Promise.all([
        supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle(),
        supabase.from('app_settings').select('cotton_module_enabled').limit(1).maybeSingle() /* org row via RLS (054) */,
      ])
    : [{ data: null }, { data: null }]
  const cottonEnabled = Boolean((settings as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled)
  const groups = reportGroupsFor(coerceAppRole((profile as { role?: string } | null)?.role), cottonEnabled)
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-slate-600 max-w-2xl mt-1">
          Pick a report below or from the sidebar. Reports that open inside this page have Excel,
          PDF, and Print buttons. Reports marked with <span className="text-slate-400">↗</span>{' '}
          open on their standalone pages.
        </p>
      </div>

      {groups.map((group) => (
        <section key={group.title} className="space-y-3">
          <h2 className="text-xs uppercase tracking-wide text-slate-500 font-semibold">{group.title}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {group.reports.map((r) => (
              <Link
                key={r.href + r.label}
                href={r.href}
                className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
                {...(r.external ? { title: 'Opens the standalone page' } : {})}
              >
                <h3 className="font-bold mb-1">
                  {r.label}
                  {r.external && <span className="text-slate-400 text-xs ml-1 font-normal">↗</span>}
                </h3>
                <p className="text-sm text-slate-600">{r.description}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
