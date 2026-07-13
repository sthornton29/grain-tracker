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

// The Cotton module's pages, flattened into the top bar when enabled — one
// tap to any cotton page, same as Loads (routes unchanged).
const COTTON_LINKS = [
  { href: '/cotton/loads', label: 'Cotton Loads' },
  { href: '/cotton/receipts', label: 'Gin Receipts' },
  { href: '/cotton/bales', label: 'Bales & Grades' },
]

export default function Nav({ cottonEnabled = false, role = 'owner' }: { cottonEnabled?: boolean; role?: AppRole }) {
  const pathname = usePathname()
  // Gin operators see ONLY the cotton intake pages. Owners with the module
  // enabled get the three cotton pages as direct top-level tabs after the
  // grain operational tabs (the bar already scrolls/overflows on narrow
  // screens — no sub-menu).
  const hedgingIdx = GRAIN_LINKS.findIndex((l) => l.label === 'Hedging') + 1
  const links = role === 'gin'
    ? COTTON_LINKS
    : cottonEnabled
      ? [...GRAIN_LINKS.slice(0, hedgingIdx), ...COTTON_LINKS, ...GRAIN_LINKS.slice(hedgingIdx)]
      : GRAIN_LINKS
  return (
    <nav className="sticky top-0 z-10 bg-green-800 text-white shadow">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2 overflow-x-auto">
        <Link href={role === 'gin' ? '/cotton/loads' : '/'} className="font-bold text-lg whitespace-nowrap mr-4">
          Turnrow Grain
        </Link>
        <div className="flex gap-1 flex-1">
          {links.map((l) => {
            const active = pathname === l.href || pathname?.startsWith(l.href + '/')
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
