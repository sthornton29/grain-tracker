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
//
// The Ask Turnrow strip below the tiles is deliberately LANDING-ONLY (not in
// lib/nav-links.ts): /assistant never gets a top-nav tab — the nav row is
// already tight on a phone, and the help drawer's "?" remains the everywhere
// entry point.

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
      // setup basics are missing; an established operation never sees this.
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
  // "New Load" (first in the config) renders as the page's one saturated
  // surface — the primary harvest action, sized for a gloved thumb on the
  // truck iPad. Order is preserved: it stays first, just bigger. Roles whose
  // set doesn't include it (viewer, agronomist, gin) get the quiet grid only.
  const primary = tiles.find((t) => t.href === '/loads/new')
  const rest = tiles.filter((t) => t.href !== '/loads/new')
  return (
    <div className="space-y-3 mt-4">
      {checklist && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
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
      {primary && (
        <Link
          href={primary.href}
          className="block rounded-xl bg-brand hover:bg-brand-deep transition-colors p-5 sm:p-6 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-dark"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-display text-2xl font-bold tracking-tight">{primary.label}</div>
              <div className="mt-0.5 text-sm text-white/85">{primary.sub}</div>
            </div>
            <span aria-hidden className="text-2xl text-white/80">→</span>
          </div>
        </Link>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {rest.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group rounded-xl border border-slate-200 bg-white p-4 sm:p-5 transition-colors hover:border-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {/* The "turnrow" tick — the module's wayfinding hue; it extends on
                hover, the one motion on the page. */}
            <span aria-hidden className={`block h-[3px] w-7 rounded-full ${t.tick} transition-all duration-300 group-hover:w-12 motion-reduce:transition-none`} />
            <div className="mt-3 font-display text-base sm:text-lg font-semibold tracking-tight text-slate-900 transition-colors group-hover:text-brand-deep">{t.label}</div>
            <div className="mt-0.5 text-xs sm:text-sm text-slate-500">{t.sub}</div>
          </Link>
        ))}
      </div>

      <Link
        href="/assistant"
        className="group block rounded-xl border border-slate-200 bg-white p-4 sm:p-5 transition-colors hover:border-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <span aria-hidden className="block h-[3px] w-7 rounded-full bg-brand transition-all duration-300 group-hover:w-12 motion-reduce:transition-none" />
        <div className="mt-3 font-display text-lg font-semibold tracking-tight text-slate-900 transition-colors group-hover:text-brand-deep">Ask Turnrow</div>
        <div className="mt-0.5 text-sm text-slate-500">
          Ask anything about your own numbers — &ldquo;What&rsquo;s my average corn price?&rdquo;, &ldquo;Which field yielded best?&rdquo;, &ldquo;What&rsquo;s in the bins?&rdquo;
        </div>
      </Link>
    </div>
  )
}
