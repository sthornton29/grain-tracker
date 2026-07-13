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

// The Cotton module's own operational area (feature-flagged).
const COTTON_LINKS = [
  { href: '/cotton/loads', label: 'Seed Cotton Loads' },
  { href: '/cotton/receipts', label: 'Gin Receipts' },
  { href: '/cotton/bales', label: 'Bales & Grades' },
]

export default function Nav({ cottonEnabled = false, role = 'owner' }: { cottonEnabled?: boolean; role?: AppRole }) {
  const pathname = usePathname()
  // Gin operators see ONLY the cotton intake pages.
  const links = role === 'gin'
    ? COTTON_LINKS
    : cottonEnabled
      ? [...GRAIN_LINKS.slice(0, -1), { href: '/cotton/loads', label: 'Cotton' }, GRAIN_LINKS[GRAIN_LINKS.length - 1]]
      : GRAIN_LINKS
  const inCotton = pathname?.startsWith('/cotton')
  return (
    <nav className="sticky top-0 z-10 bg-green-800 text-white shadow">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2 overflow-x-auto">
        <Link href={role === 'gin' ? '/cotton/loads' : '/'} className="font-bold text-lg whitespace-nowrap mr-4">
          Turnrow Grain
        </Link>
        <div className="flex gap-1 flex-1">
          {links.map((l) => {
            const active = l.label === 'Cotton'
              ? inCotton
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
      {/* Cotton sub-nav inside the module (gin users already have these as the main nav). */}
      {role !== 'gin' && cottonEnabled && inCotton && (
        <div className="bg-green-900/60">
          <div className="max-w-6xl mx-auto px-4 py-1.5 flex gap-1 overflow-x-auto">
            {COTTON_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`px-3 py-1.5 rounded-lg text-xs whitespace-nowrap ${
                  pathname === l.href || pathname?.startsWith(l.href + '/') ? 'bg-green-950' : 'hover:bg-green-800'
                }`}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </nav>
  )
}
