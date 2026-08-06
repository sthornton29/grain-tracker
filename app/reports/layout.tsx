import Link from 'next/link'
import { reportGroupsFor } from './reports-nav'
import PrintHeader from '@/components/reports/print-header'
import { createClient } from '@/lib/supabase/server'
import { coerceAppRole } from '@/lib/app-role'

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
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
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 print-area">
      <aside className="bg-white rounded-xl shadow p-3 space-y-3 self-start no-print lg:sticky lg:top-3">
        <Link href="/reports" className="block font-bold text-lg">Reports</Link>
        {groups.map((cat) => (
          <div key={cat.title}>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{cat.title}</div>
            <ul className="space-y-0.5">
              {cat.reports.map((r) => (
                <li key={`${cat.title}-${r.label}`}>
                  <Link
                    href={r.href}
                    className="block px-2 py-1.5 rounded text-sm hover:bg-slate-100"
                    {...(r.external ? { title: 'Opens the standalone page' } : {})}
                  >
                    {r.label}{r.external && <span className="text-slate-400 text-xs ml-1">↗</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <main className="min-w-0"><PrintHeader />{children}</main>
    </div>
  )
}
