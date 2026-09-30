import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { navLinksFor } from '@/lib/nav-links'
import type { AppRole } from '@/lib/types'
import { coerceAppRole } from '@/lib/app-role'
import FirstRunChecklist, { type ChecklistItem } from '@/components/first-run-checklist'
import AddToHomeHint from '@/components/add-to-home-hint'

// Landing page: quick-action tiles that MIRROR the top nav exactly — same
// items, same order, same labels — both rendered from lib/nav-links.ts so
// they cannot drift (cotton tab included when Cotton is on; the gin role
// gets its restricted set, though middleware routes gin users to /cotton).
// A NEW org's owner sees the first-run checklist above the tiles until the
// first load is recorded (or they hide it) — the existing settings pages and
// document/spreadsheet importers ARE the onboarding; this just points at
// them in order.
//
// The Ask Turnrow strip below the tiles is deliberately LANDING-ONLY (not in
// lib/nav-links.ts): /assistant never gets a top-nav tab — the nav row is
// already tight on a phone, and the help drawer's "?" remains the everywhere
// entry point.

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
      // Head counts only — RLS scopes them to the org. Shown until the first
      // load exists (or the owner hides it); an established operation never
      // sees this.
      const [en, fa, fi, pl, tr, bi, lo] = await Promise.all([
        supabase.from('entities').select('id', { count: 'exact', head: true }),
        supabase.from('farms').select('id', { count: 'exact', head: true }),
        supabase.from('fields').select('id', { count: 'exact', head: true }),
        supabase.from('field_plantings').select('id', { count: 'exact', head: true }),
        supabase.from('trucks').select('id', { count: 'exact', head: true }),
        supabase.from('bins').select('id', { count: 'exact', head: true }),
        supabase.from('loads').select('id', { count: 'exact', head: true }),
      ])
      const counts = {
        entities: en.count ?? 0, farms: fa.count ?? 0, fields: fi.count ?? 0, plantings: pl.count ?? 0,
        trucks: tr.count ?? 0, bins: bi.count ?? 0, loads: lo.count ?? 0,
      }
      const basicsIn = counts.entities > 0 && counts.farms > 0 && counts.fields > 0
      if (counts.loads === 0 || !basicsIn) {
        checklist = [
          { label: 'Upload your FSA-578 / 156-EZ or a lease', href: '/settings', done: basicsIn, hint: 'Turnrow fills in entities, farms, fields and plantings at once from the document. Or work through the steps below by hand.' },
          { label: 'Create your entities', href: '/settings/entities', done: counts.entities > 0, hint: 'The companies and people that farm — LLCs, partnerships, individuals.' },
          { label: 'Add your farms', href: '/settings/farms', done: counts.farms > 0, hint: 'Each FSA farm, linked to its entity, county, and landowner.' },
          { label: 'Add your fields', href: '/settings/fields', done: counts.fields > 0, hint: 'The fields on each farm, with acres. A spreadsheet or a photographed field list works too.' },
          { label: 'Record this year’s plantings', href: '/settings/plantings', done: counts.plantings > 0, hint: 'Which crop went in which field this season — yields, insurance, and marketing all build on this.' },
          // Done once a load exists: by then the crops have been used in anger.
          { label: 'Confirm your crops', href: '/settings/crops', done: counts.loads > 0, review: true, hint: 'The standard crops come pre-loaded — check the names and harvest seasons match how you farm.' },
          { label: 'Trucks & bins', href: '/settings/trucks', done: counts.trucks > 0 && counts.bins > 0, optional: true, hint: 'Your trucks and the bins you haul to. Add them here or the first time the load form asks.' },
          { label: 'Enter your first loads', href: '/loads/new', done: counts.loads > 0, hint: 'Type one in, or photograph scale tickets at Loads → Scan.' },
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
      <AddToHomeHint />
      {checklist && <FirstRunChecklist items={checklist} />}
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
            {/* The "turnrow" tick — the area's wayfinding hue; it extends on
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
