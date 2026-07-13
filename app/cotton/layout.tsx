'use client'

// Cotton module layout — a Reports-style left sidebar for the three cotton
// pages, under the single "Cotton" top-nav tab.

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const COTTON_PAGES = [
  { href: '/cotton/loads', label: 'Seed Cotton Loads' },
  { href: '/cotton/receipts', label: 'Gin Receipts' },
  { href: '/cotton/bales', label: 'Bales & Grades' },
]

export default function CottonLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 print-area">
      <aside className="bg-white rounded-xl shadow p-3 space-y-3 self-start no-print lg:sticky lg:top-3">
        <Link href="/cotton/loads" className="block font-bold text-lg">Cotton</Link>
        <ul className="space-y-0.5">
          {COTTON_PAGES.map((p) => {
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
