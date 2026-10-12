'use client'

// Cotton module layout — the left rail every cotton page shares, under the
// single "Cotton" top-nav tab. The rail reads as the cotton's own route from
// the field to the sale: Seed Cotton Loads (modules off the field, the gin
// yard), Gin Receipts (the gin's statements), Bales & Grades (PBI tags and
// classing), Marketing (contracts, loans, LDP — producer-only: hidden for gin
// operators; the middleware also blocks the route and 044 RLS the data).

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const COTTON_PAGES: Array<{ href: string; label: string; sub: string; ownerOnly?: boolean }> = [
  { href: '/cotton/loads', label: 'Seed Cotton Loads', sub: 'Modules off the field · the gin yard' },
  { href: '/cotton/receipts', label: 'Gin Receipts', sub: 'Statements of Ginning' },
  { href: '/cotton/bales', label: 'Bales & Grades', sub: 'PBI tags · HVI classing' },
  { href: '/cotton/marketing', label: 'Marketing', sub: 'Contracts · CCC loans · LDP', ownerOnly: true },
]

export default function CottonLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])
  const [isGin, setIsGin] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data } = await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
      if (!cancelled) setIsGin((data as { role?: string } | null)?.role === 'gin')
    })()
    return () => { cancelled = true }
  }, [supabase])
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 print-area">
      <aside className="bg-white rounded-xl shadow p-3 space-y-3 self-start no-print lg:sticky lg:top-3">
        <Link href="/cotton/loads" className="flex items-center gap-2 px-2 pt-1 font-display font-bold text-lg text-slate-900">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-fuchsia-600" />
          Cotton
        </Link>
        <ul className="space-y-0.5" aria-label="Cotton pages">
          {COTTON_PAGES.filter((p) => !(p.ownerOnly && isGin)).map((p) => {
            const active = pathname === p.href || pathname?.startsWith(p.href + '/')
            return (
              <li key={p.href}>
                <Link
                  href={p.href}
                  aria-current={active ? 'page' : undefined}
                  className={`block px-2 py-2 rounded-lg min-h-11 border-l-2 ${active ? 'bg-green-50 border-brand font-semibold text-slate-900' : 'border-transparent hover:bg-slate-100 text-slate-800'}`}
                >
                  <span className="block text-sm leading-tight">{p.label}</span>
                  <span className={`block text-[11px] leading-tight mt-0.5 ${active ? 'text-slate-600' : 'text-slate-400'}`}>{p.sub}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  )
}
