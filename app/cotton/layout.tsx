'use client'

// Cotton module layout — a Reports-style left sidebar for the cotton pages,
// under the single "Cotton" top-nav tab. Marketing (sales contracts, CCC
// loans, LDP, fees) is producer-only: hidden for gin operators (the
// middleware also blocks the route and 044 RLS blocks the data).

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const COTTON_PAGES = [
  { href: '/cotton/loads', label: 'Seed Cotton Loads' },
  { href: '/cotton/receipts', label: 'Gin Receipts' },
  { href: '/cotton/bales', label: 'Bales & Grades' },
  { href: '/cotton/marketing', label: 'Marketing', ownerOnly: true },
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
        <Link href="/cotton/loads" className="block font-bold text-lg">Cotton</Link>
        <ul className="space-y-0.5">
          {COTTON_PAGES.filter((p) => !(p.ownerOnly && isGin)).map((p) => {
            const active = pathname === p.href || pathname?.startsWith(p.href + '/')
            return (
              <li key={p.href}>
                <Link
                  href={p.href}
                  className={`block px-2 py-1.5 rounded text-sm ${active ? 'bg-green-100 font-semibold' : 'hover:bg-slate-100'}`}
                >
                  {p.label}
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
