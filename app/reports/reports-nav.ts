// Single source of truth for the Reports navigation: group order, item order,
// display names, routes, and the ↗ "opens the standalone page" flag. Both the
// sidebar (layout.tsx) and the landing-page cards (page.tsx) render from this,
// so they never drift apart. Groups are organized by the question a farmer is
// asking, and every description is one plain sentence.
//
// Routes are unchanged (the help-coverage test reads `href:` from this file).
// A `query` carries the ?view=… that picks a Yields tab; use `reportHref()`
// to build the link.

import type { AppRole } from '@/lib/types'
import { roleAllowsPath } from '@/lib/route-guard'

export type ReportNavItem = {
  label: string
  href: string
  // Query string (without the "?") appended to href when linking.
  query?: string
  // true = links out to an existing standalone page (marked ↗), not embedded.
  external?: boolean
  description: string
}

export type ReportNavGroup = { title: string; reports: ReportNavItem[] }

/** The full link for a catalog item. */
export function reportHref(r: ReportNavItem): string {
  return r.query ? `${r.href}?${r.query}` : r.href
}

// Reports that exist only when the Cotton module is on for the org.
const COTTON_REPORT_ROUTES = ['/reports/bale-quality']

/** The groups a user may see. Viewers keep every embedded /reports page and
 *  the Yields links, but lose the ↗ links into operational pages (Loads,
 *  Contracts, Inventory…) — the middleware (lib/route-guard.ts) redirects
 *  those paths anyway. Cotton-only reports (Bale Quality) drop out when the
 *  org's Cotton module is off — the middleware guards the route too. Empty
 *  groups drop out. */
export function reportGroupsFor(role: AppRole, cottonEnabled = true, groups: ReportNavGroup[] = REPORT_GROUPS): ReportNavGroup[] {
  let out = groups
  if (!cottonEnabled) {
    out = out.map((g) => ({ ...g, reports: g.reports.filter((r) => !COTTON_REPORT_ROUTES.includes(r.href)) }))
  }
  if (role === 'viewer') {
    out = out.map((g) => ({ ...g, reports: g.reports.filter((r) => roleAllowsPath('viewer', r.href)) }))
  }
  return out.filter((g) => g.reports.length > 0)
}

export const REPORT_GROUPS: ReportNavGroup[] = [
  {
    title: 'How is harvest going',
    reports: [
      { label: 'Season Summary', href: '/reports/season', description: 'Acres, dry bushels, and yield by crop for the crop year, with how much is harvested.' },
      { label: 'Yields by Field', href: '/yields', query: 'view=field', external: true, description: 'Dry bushels and yield for every field, with the loads behind each number.' },
      { label: 'Yields by Farm', href: '/yields', query: 'view=farm', external: true, description: 'Yields rolled up by farm, so you can compare farms side by side.' },
      { label: 'Yields by Landowner', href: '/reports/yields-by-landowner', description: 'Each landowner’s production by farm and field, ready to print as a handout.' },
      { label: 'Bale Quality Summary', href: '/reports/bale-quality', description: 'Cotton bales, lint pounds, loan value, and grade breakdown by field for buyers.' },
    ],
  },
  {
    title: 'Where do I stand on selling',
    reports: [
      { label: 'Marketing Dashboard', href: '/reports/marketing', description: 'Per crop: what you have, what is sold or hedged, what is still unpriced, and projected profit.' },
      { label: 'Hedging Summary', href: '/reports/hedging-summary', description: 'Every futures and option position with realized and unrealized gains, by crop year.' },
    ],
  },
  {
    title: 'What will I make',
    reports: [
      { label: 'Revenue Projections', href: '/reports/revenue-projections', description: 'Crop sales, insurance, and government payments against costs — profit and breakeven on one page.' },
      { label: 'Income Sensitivity', href: '/reports/income-sensitivity', description: 'What income looks like at different prices and yields, with contracts and insurance held in.' },
      { label: 'Cash Flow Forecast', href: '/reports/cash-flow', description: 'Month by month: money received, money owed to you, and what contracts and programs should pay.' },
      { label: 'Crop Budget Planner', href: '/reports/crop-budget', description: 'Plan next year: acres, yield, price, and cost per crop, kept separate from actual numbers.' },
    ],
  },
  {
    title: 'Landowners',
    reports: [
      { label: 'Share Rent Report', href: '/reports/share-rent', description: 'Each share-rent farm’s production and the landowner’s share of bushels, ready to hand over.' },
      { label: 'Rent Settlement', href: '/reports/rent-settlement', description: 'Build a landowner’s dollar settlement from the lease, your production, and your sales.' },
    ],
  },
  {
    title: 'Insurance & USDA',
    reports: [
      { label: 'Crop Insurance Production Report', href: '/reports/crop-insurance', description: 'Production by county and practice in the layout your crop insurance agent expects.' },
      { label: 'Crop Insurance Claims Monitor', href: '/reports/crop-insurance-claims', description: 'What each policy would pay at today’s yields and prices, after premium.' },
      { label: 'Bundled Settlement Statements', href: '/reports/settlement-pdfs', description: 'Every buyer settlement for a crop and year in one file, for a production audit.' },
      { label: 'ARC/PLC Decision Aid', href: '/reports/arc-plc-decision-aid', description: 'Compare what ARC and PLC would pay per farm and pick your election.' },
      { label: 'Government Payment Tracker', href: '/reports/government-payments', description: 'Expected ARC/PLC and other USDA payments by farm, with payment limits per entity.' },
    ],
  },
  {
    title: 'Calculators',
    reports: [
      { label: 'Freight Math', href: '/reports/freight-math', description: 'What a haul costs per load and per bushel, and what a delivered contract must pay extra.' },
      { label: 'Grain Dryer Math', href: '/reports/dryer-math', description: 'Drying cost per bushel at every moisture, and whether drying beats hauling wet.' },
    ],
  },
  {
    title: 'Records',
    reports: [
      { label: 'Load Log', href: '/loads', external: true, description: 'The full load log — search, filter, and export.' },
      { label: 'Contract Tracker', href: '/contracts', external: true, description: 'Delivered against contracted, with pricing and payment status.' },
      { label: 'Unpaid Loads', href: '/loads/unpaid', external: true, description: 'Loads delivered to a buyer with no settlement yet.' },
      { label: 'Bin Inventory Summary', href: '/inventory', external: true, description: 'Bushels on hand in every bin, grouped by site.' },
    ],
  },
]
