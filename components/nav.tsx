'use client'

/* eslint-disable @next/next/no-img-element */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { navLinksFor, navLinkActive } from '@/lib/nav-links'
import HelpDrawer from '@/components/help/help-drawer'
import type { AppRole } from '@/lib/types'

// Top nav — Turnrow brand chrome: forest-green bar, white mark + spaced-caps
// wordmark, kelly-green active tab. Links come from lib/nav-links.ts (the
// SAME config the landing tiles render from).
export default function Nav({ cottonEnabled = false, role = 'owner' }: { cottonEnabled?: boolean; role?: AppRole }) {
  const pathname = usePathname()
  const links = navLinksFor({ cottonEnabled, role })
  return (
    <nav className="sticky top-0 z-10 bg-brand-dark text-white shadow">
      {/* The links scroll horizontally on narrow screens; the logo and the
          Help "?" sit OUTSIDE the scroll region so they are always visible
          and tappable — the help entry point must never scroll away. */}
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2">
        <Link
          href={role === 'gin' ? '/cotton/loads' : '/'}
          className="flex items-center whitespace-nowrap mr-2 sm:mr-4 shrink-0"
        >
          <img src="/brand/logo-lockup-white.png" alt="Turnrow" className="h-6 w-auto" />
        </Link>
        <div className="flex gap-1 flex-1 min-w-0 overflow-x-auto">
          {links.map((l) => {
            const active = navLinkActive(l, pathname)
            return (
              <Link
                key={l.label}
                href={l.href}
                className={`px-3 py-2 rounded-lg text-sm whitespace-nowrap ${
                  active ? 'bg-brand font-semibold' : 'hover:bg-white/10'
                }`}
              >
                {l.label}
              </Link>
            )
          })}
        </div>
        <HelpDrawer />
      </div>
    </nav>
  )
}
