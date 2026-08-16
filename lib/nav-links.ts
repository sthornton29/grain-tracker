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
  /** The landing tile's "turnrow" tick — the module's wayfinding hue as a
   *  small solid mark, not a background (STATIC full class string, so
   *  Tailwind's JIT sees it; nav styles itself). */
  tick: string
}

export const GRAIN_LINKS: NavLink[] = [
  { href: '/loads/new', label: 'New Load', sub: 'Record a truck load', tick: 'bg-brand' },
  { href: '/loads', label: 'Loads', sub: 'Search, edit, export', tick: 'bg-slate-400' },
  { href: '/inventory', label: 'Bin Inventory', sub: 'Bushels on hand', tick: 'bg-amber-500' },
  { href: '/contracts', label: 'Contracts', sub: 'Delivered vs contracted', tick: 'bg-sky-500' },
  { href: '/settlements', label: 'Settlements', sub: 'Upload & reconcile payments', tick: 'bg-teal-500' },
  { href: '/yields', label: 'Yields', sub: 'Bushels per acre by field', tick: 'bg-emerald-500' },
  { href: '/hedging', label: 'Hedging', sub: 'Futures & options positions', tick: 'bg-indigo-500' },
  { href: '/reports', label: 'Reports', sub: 'Cash flow, insurance, marketing…', tick: 'bg-rose-500' },
  { href: '/settings', label: 'Settings', sub: 'Entities, farms, plantings…', tick: 'bg-slate-400' },
]

// The Cotton module is ONE top-level tab; its three pages live in a
// Reports-style sidebar (app/cotton/layout.tsx). Inserted after Hedging.
export const COTTON_TAB: NavLink = { href: '/cotton/loads', label: 'Cotton', sub: 'Gin loads, bales, marketing', tick: 'bg-fuchsia-600' }

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
