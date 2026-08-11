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
  /** Landing-tile background — a full gradient class string (STATIC, so
   *  Tailwind's JIT sees it; nav styles itself). */
  tileColor: string
}

export const GRAIN_LINKS: NavLink[] = [
  { href: '/loads/new', label: 'New Load', sub: 'Record a truck load', tileColor: 'bg-gradient-to-br from-brand to-brand-dark' },
  { href: '/loads', label: 'Loads', sub: 'Search, edit, export', tileColor: 'bg-gradient-to-br from-slate-600 to-slate-800' },
  { href: '/inventory', label: 'Bin Inventory', sub: 'Bushels on hand', tileColor: 'bg-gradient-to-br from-amber-600 to-amber-800' },
  { href: '/contracts', label: 'Contracts', sub: 'Delivered vs contracted', tileColor: 'bg-gradient-to-br from-sky-600 to-sky-800' },
  { href: '/settlements', label: 'Settlements', sub: 'Upload & reconcile payments', tileColor: 'bg-gradient-to-br from-teal-600 to-teal-800' },
  { href: '/yields', label: 'Yields', sub: 'Bushels per acre by field', tileColor: 'bg-gradient-to-br from-emerald-600 to-emerald-800' },
  { href: '/hedging', label: 'Hedging', sub: 'Futures & options positions', tileColor: 'bg-gradient-to-br from-indigo-600 to-indigo-800' },
  { href: '/reports', label: 'Reports', sub: 'Cash flow, insurance, marketing…', tileColor: 'bg-gradient-to-br from-rose-600 to-rose-800' },
  { href: '/settings', label: 'Settings', sub: 'Entities, farms, plantings…', tileColor: 'bg-gradient-to-br from-slate-500 to-slate-700' },
]

// The Cotton module is ONE top-level tab; its three pages live in a
// Reports-style sidebar (app/cotton/layout.tsx). Inserted after Hedging.
export const COTTON_TAB: NavLink = { href: '/cotton/loads', label: 'Cotton', sub: 'Gin loads, bales, marketing', tileColor: 'bg-gradient-to-br from-fuchsia-700 to-fuchsia-900' }

/** The exact link set for a user: gin operators see ONLY the Cotton tab;
 *  viewers (read-only stakeholders) see ONLY Yields and Reports;
 *  agronomists see ONLY Yields (org-wide production data, no financials);
 *  owners get Cotton after Hedging when the module is enabled. */
export function navLinksFor(args: { cottonEnabled: boolean; role: AppRole }): NavLink[] {
  if (args.role === 'gin') return [COTTON_TAB]
  if (args.role === 'viewer') return GRAIN_LINKS.filter((l) => l.label === 'Yields' || l.label === 'Reports')
  if (args.role === 'agronomist') return GRAIN_LINKS.filter((l) => l.label === 'Yields')
  if (!args.cottonEnabled) return GRAIN_LINKS
  const hedgingIdx = GRAIN_LINKS.findIndex((l) => l.label === 'Hedging') + 1
  return [...GRAIN_LINKS.slice(0, hedgingIdx), COTTON_TAB, ...GRAIN_LINKS.slice(hedgingIdx)]
}

/** Active-state test shared by nav renderers. */
export function navLinkActive(link: Pick<NavLink, 'href' | 'label'>, pathname: string | null): boolean {
  if (link.label === 'Cotton') return !!pathname?.startsWith('/cotton')
  return pathname === link.href || !!pathname?.startsWith(link.href + '/')
}
