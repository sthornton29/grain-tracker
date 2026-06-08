'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/loads/new', label: 'New Load' },
  { href: '/loads', label: 'Loads' },
  { href: '/inventory', label: 'Bin Inventory' },
  { href: '/contracts', label: 'Contracts' },
  { href: '/settlements', label: 'Settlements' },
  { href: '/yields', label: 'Yields' },
  { href: '/hedging', label: 'Hedging' },
  { href: '/reports', label: 'Reports' },
  { href: '/settings', label: 'Settings' },
]

export default function Nav() {
  const pathname = usePathname()
  return (
    <nav className="sticky top-0 z-10 bg-green-800 text-white shadow">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2 overflow-x-auto">
        <Link href="/" className="font-bold text-lg whitespace-nowrap mr-4">
          Turnrow Grain
        </Link>
        <div className="flex gap-1 flex-1">
          {links.map((l) => {
            const active = pathname === l.href || pathname?.startsWith(l.href + '/')
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`px-3 py-2 rounded-lg text-sm whitespace-nowrap ${
                  active ? 'bg-green-900' : 'hover:bg-green-700'
                }`}
              >
                {l.label}
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
