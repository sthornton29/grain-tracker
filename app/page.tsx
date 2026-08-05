import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { navLinksFor } from '@/lib/nav-links'
import type { AppRole } from '@/lib/types'
import { coerceAppRole } from '@/lib/app-role'

// Landing page: quick-action tiles that MIRROR the top nav exactly — same
// items, same order, same labels — both rendered from lib/nav-links.ts so
// they cannot drift (cotton tab included when the module is on; the gin role
// gets its restricted set, though middleware routes gin users to /cotton).
export default async function Home() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  let cottonEnabled = false
  let role: AppRole = 'owner'
  if (user) {
    const [settings, profile] = await Promise.all([
      supabase.from('app_settings').select('cotton_module_enabled').limit(1).maybeSingle() /* org row via RLS (054) */,
      supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle(),
    ])
    cottonEnabled = Boolean((settings.data as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled)
    role = coerceAppRole((profile.data as { role?: string } | null)?.role)
  }
  const tiles = navLinksFor({ cottonEnabled: cottonEnabled || role === 'gin', role })
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
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
  )
}
