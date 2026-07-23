import type { AppRole } from '@/lib/types'

// SINGLE SOURCE OF TRUTH for top-level navigation. The top nav bar
// (components/nav.tsx) and the landing page's quick-action tiles
// (app/page.tsx) BOTH render from navLinksFor, so they cannot drift:
// same items, same order, same labels — including the Cotton tab when the
// module is enabled and the gin role's restricted set.

export type NavLink = {
  href: string
  label: string
  /** One-line description for the landing tile. */
  sub: string
  /** Landing-tile background (brand/status palette; nav styles itself). */
  tileColor: string
}

export const GRAIN_LINKS: NavLink[] = [
  { href: '/loads/new', label: 'New Load', sub: 'Record a truck load', tileColor: 'bg-brand' },
  { href: '/loads', label: 'Loads', sub: 'Search, edit, export', tileColor: 'bg-slate-700' },
  { href: '/inventory', label: 'Bin Inventory', sub: 'Bushels on hand', tileColor: 'bg-amber-700' },
  { href: '/contracts', label: 'Contracts', sub: 'Delivered vs contracted', tileColor: 'bg-sky-700' },
  { href: '/settlements', label: 'Settlements', sub: 'Upload & reconcile payments', tileColor: 'bg-teal-700' },
  { href: '/yields', label: 'Yields', sub: 'Bushels per acre by field', tileColor: 'bg-emerald-700' },
  { href: '/hedging', label: 'Hedging', sub: 'Futures & options positions', tileColor: 'bg-indigo-700' },
  { href: '/reports', label: 'Reports', sub: 'Cash flow, insurance, marketing…', tileColor: 'bg-rose-700' },
  { href: '/settings', label: 'Settings', sub: 'Entities, farms, plantings…', tileColor: 'bg-slate-500' },
]

// The Cotton module is ONE top-level tab; its three pages live in a
// Reports-style sidebar (app/cotton/layout.tsx). Inserted after Hedging.
export const COTTON_TAB: NavLink = { href: '/cotton/loads', label: 'Cotton', sub: 'Gin loads, bales, marketing', tileColor: 'bg-fuchsia-800' }

/** The exact link set for a user: gin operators see ONLY the Cotton tab;
 *  owners get Cotton after Hedging when the module is enabled. */
export function navLinksFor(args: { cottonEnabled: boolean; role: AppRole }): NavLink[] {
  if (args.role === 'gin') return [COTTON_TAB]
  if (!args.cottonEnabled) return GRAIN_LINKS
  const hedgingIdx = GRAIN_LINKS.findIndex((l) => l.label === 'Hedging') + 1
  return [...GRAIN_LINKS.slice(0, hedgingIdx), COTTON_TAB, ...GRAIN_LINKS.slice(hedgingIdx)]
}

/** Active-state test shared by nav renderers. */
export function navLinkActive(link: Pick<NavLink, 'href' | 'label'>, pathname: string | null): boolean {
  if (link.label === 'Cotton') return !!pathname?.startsWith('/cotton')
  return pathname === link.href || !!pathname?.startsWith(link.href + '/')
}
