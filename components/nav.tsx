'use client'

/* eslint-disable @next/next/no-img-element */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { navLinksFor, navLinkActive } from '@/lib/nav-links'
import HelpDrawer from '@/components/help/help-drawer'
import { AppModal } from '@/components/app-dialog'
import type { AppRole } from '@/lib/types'

// Top nav — Turnrow brand chrome: forest-green bar, white mark + spaced-caps
// wordmark, kelly-green active tab. Links come from lib/nav-links.ts (the
// SAME config the landing tiles render from).
//
// On a tablet the row scrolls sideways: a gradient fade on the right edge
// shows there is more, the row snaps link-by-link, and the active tab is
// scrolled into view on arrival. On a phone the row collapses to the first
// few links plus a "More" button that opens a bottom sheet with the rest.
const PHONE_VISIBLE = 5

export default function Nav({ cottonEnabled = false, role = 'owner' }: { cottonEnabled?: boolean; role?: AppRole }) {
  const pathname = usePathname()
  const links = navLinksFor({ cottonEnabled, role })
  const row = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const updateFade = useCallback(() => {
    const el = row.current
    if (!el) return
    setFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 4)
  }, [])

  useEffect(() => {
    const el = row.current
    if (!el) return
    const active = el.querySelector<HTMLElement>('[aria-current="page"]')
    active?.scrollIntoView({ inline: 'center', block: 'nearest' })
    updateFade()
    el.addEventListener('scroll', updateFade, { passive: true })
    window.addEventListener('resize', updateFade)
    return () => {
      el.removeEventListener('scroll', updateFade)
      window.removeEventListener('resize', updateFade)
    }
  }, [pathname, updateFade])

  const closeMore = useCallback(() => setMoreOpen(false), [])
  const phoneLinks = links.slice(0, PHONE_VISIBLE)
  const overflow = links.slice(PHONE_VISIBLE)

  const linkCls = (active: boolean) =>
    `px-3 py-2 min-h-11 flex items-center rounded-lg text-sm whitespace-nowrap snap-start ${active ? 'bg-brand font-semibold' : 'hover:bg-white/10'}`

  return (
    <nav className="sticky top-0 z-10 bg-brand-dark text-white shadow no-print">
      {/* The links scroll horizontally on narrow screens; the logo and the
          Help "?" sit OUTSIDE the scroll region so they are always visible
          and tappable — the help entry point must never scroll away. */}
      <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-2">
        <Link
          href={role === 'gin' ? '/cotton/loads' : '/'}
          className="flex items-center whitespace-nowrap mr-2 sm:mr-4 shrink-0 min-h-11"
        >
          <img src="/brand/logo-lockup-white.png" alt="Turnrow" className="h-6 w-auto" />
        </Link>

        {/* Tablet and up: the scrolling row. */}
        <div className="relative flex-1 min-w-0 hidden sm:block">
          <div ref={row} className="flex gap-1 overflow-x-auto snap-x snap-proximity [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {links.map((l) => {
              const active = navLinkActive(l, pathname)
              return (
                <Link key={l.label} href={l.href} aria-current={active ? 'page' : undefined} className={linkCls(active)}>
                  {l.label}
                </Link>
              )
            })}
          </div>
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-brand-dark to-transparent transition-opacity ${fade ? 'opacity-100' : 'opacity-0'}`}
          />
        </div>

        {/* Phone: the first few links + More. */}
        <div className="flex-1 min-w-0 flex gap-1 overflow-x-auto sm:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {phoneLinks.map((l) => {
            const active = navLinkActive(l, pathname)
            return (
              <Link key={l.label} href={l.href} aria-current={active ? 'page' : undefined} className={linkCls(active)}>
                {l.label}
              </Link>
            )
          })}
          {overflow.length > 0 && (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className={linkCls(overflow.some((l) => navLinkActive(l, pathname)))}
              aria-haspopup="dialog"
            >
              More ▾
            </button>
          )}
        </div>

        <HelpDrawer role={role} />
      </div>

      <AppModal open={moreOpen} title="More" onClose={closeMore} size="sm">
        <ul className="divide-y divide-slate-100 -mx-1">
          {overflow.map((l) => {
            const active = navLinkActive(l, pathname)
            return (
              <li key={l.label}>
                <Link
                  href={l.href}
                  onClick={closeMore}
                  className={`flex items-center justify-between px-2 min-h-12 text-slate-800 ${active ? 'font-semibold text-brand-deep' : ''}`}
                >
                  <span>
                    {l.label}
                    <span className="block text-xs font-normal text-slate-500">{l.sub}</span>
                  </span>
                  <span aria-hidden className="text-slate-400">›</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </AppModal>
    </nav>
  )
}
