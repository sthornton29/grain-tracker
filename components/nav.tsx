'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { AppRole } from '@/lib/types'

const GRAIN_LINKS = [
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

// The Cotton module is ONE top-level tab; its three pages live in a
// Reports-style sidebar (app/cotton/layout.tsx).
const COTTON_TAB = { href: '/cotton/loads', label: 'Cotton' }

export default function Nav({ cottonEnabled = false, role = 'owner' }: { cottonEnabled?: boolean; role?: AppRole }) {
  const pathname = usePathname()
  // Gin operators see ONLY the Cotton tab (the sidebar inside gives them the
  // three intake pages). Owners with the module enabled get Cotton after
  // Hedging.
  const hedgingIdx = GRAIN_LINKS.findIndex((l) => l.label === 'Hedging') + 1
  const links = role === 'gin'
    ? [COTTON_TAB]
    : cottonEnabled
      ? [...GRAIN_LINKS.slice(0, hedgingIdx), COTTON_TAB, ...GRAIN_LINKS.slice(hedgingIdx)]
      : GRAIN_LINKS
  return (
    <nav className="sticky top-0 z-10 bg-green-800 text-white shadow">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2 overflow-x-auto">
        <Link href={role === 'gin' ? '/cotton/loads' : '/'} className="font-bold text-lg whitespace-nowrap mr-4">
          Turnrow Grain
        </Link>
        <div className="flex gap-1 flex-1">
          {links.map((l) => {
            const active = l.label === 'Cotton'
              ? pathname?.startsWith('/cotton')
              : pathname === l.href || pathname?.startsWith(l.href + '/')
            return (
              <Link
                key={l.label}
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
