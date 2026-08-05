import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { navLinksFor } from '@/lib/nav-links'
import type { AppRole } from '@/lib/types'
import { coerceAppRole } from '@/lib/app-role'

// Landing page: quick-action tiles that MIRROR the top nav exactly — same
// items, same order, same labels — both rendered from lib/nav-links.ts so
// they cannot drift (cotton tab included when the module is on; the gin role
// gets its restricted set, though middleware routes gin users to /cotton).
// A NEW org's owner sees the first-run checklist above the tiles until the
// basics exist — the existing settings pages and CSV/AI importers ARE the
// onboarding; this just points at them in order.

type ChecklistItem = { label: string; href: string; done: boolean; hint: string }

export default async function Home() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  let cottonEnabled = false
  let role: AppRole = 'owner'
  let checklist: ChecklistItem[] | null = null
  if (user) {
    const [settings, profile] = await Promise.all([
      supabase.from('app_settings').select('cotton_module_enabled').limit(1).maybeSingle() /* org row via RLS (054) */,
      supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle(),
    ])
    cottonEnabled = Boolean((settings.data as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled)
    role = coerceAppRole((profile.data as { role?: string } | null)?.role)

    if (role === 'owner') {
      // Head counts only — RLS scopes them to the org. Shown while any of the
      // setup basics are missing; a going concern (Turnrow) never sees this.
      const [en, fa, fi, lo] = await Promise.all([
        supabase.from('entities').select('id', { count: 'exact', head: true }),
        supabase.from('farms').select('id', { count: 'exact', head: true }),
        supabase.from('fields').select('id', { count: 'exact', head: true }),
        supabase.from('loads').select('id', { count: 'exact', head: true }),
      ])
      const counts = { entities: en.count ?? 0, farms: fa.count ?? 0, fields: fi.count ?? 0, loads: lo.count ?? 0 }
      if (counts.entities === 0 || counts.farms === 0 || counts.fields === 0) {
        checklist = [
          { label: 'Create your entities', href: '/settings/entities', done: counts.entities > 0, hint: 'The legal entities (LLCs, partnerships) that farm.' },
          { label: 'Add your farms', href: '/settings/farms', done: counts.farms > 0, hint: 'Each FSA farm, linked to its entity.' },
          { label: 'Add your fields', href: '/settings/fields', done: counts.fields > 0, hint: 'Fields on each farm — the AI/CSV importers on the page can load them from a file.' },
          { label: 'Confirm your crops', href: '/settings/crops', done: true, hint: 'The standard four are pre-seeded — adjust names and test weights to taste.' },
          { label: 'Enter your first loads', href: '/loads/new', done: counts.loads > 0, hint: 'Type one in, or scan tickets with the AI importer at Loads → Scan.' },
        ]
      }
    }
  }
  const tiles = navLinksFor({ cottonEnabled: cottonEnabled || role === 'gin', role })
  return (
    <div className="space-y-4 mt-4">
      {checklist && (
        <div className="bg-white rounded-2xl shadow p-6 space-y-3">
          <h2 className="text-xl font-bold">Welcome — let&apos;s set up your operation</h2>
          <p className="text-sm text-slate-500">
            Work down the list; each step opens the page that does it. The importers accept CSVs and
            photos/PDFs, so most of this is uploading what you already have.
          </p>
          <ol className="space-y-2">
            {checklist.map((item, i) => (
              <li key={item.href}>
                <Link href={item.href} className="flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50">
                  <span aria-hidden className={`mt-0.5 h-5 w-5 shrink-0 rounded-full text-xs font-bold flex items-center justify-center ${item.done ? 'bg-green-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                    {item.done ? '✓' : i + 1}
                  </span>
                  <span>
                    <span className={`font-semibold ${item.done ? 'text-slate-400 line-through' : ''}`}>{item.label}</span>
                    <span className="block text-xs text-slate-500">{item.hint}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`${t.tileColor} text-white rounded-2xl p-6 shadow hover:opacity-95`}
          >
            <div className="text-xl font-bold">{t.label}</div>
            <div className="text-sm opacity-90">{t.sub}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
