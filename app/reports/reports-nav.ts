// Single source of truth for the Reports navigation: group order, item order,
// display names, routes, and the ↗ "opens the standalone page" flag. Both the
// sidebar (layout.tsx) and the landing-page cards (page.tsx) render from this,
// so they never drift apart. Routes are unchanged — only names and ordering.

export type ReportNavItem = {
  label: string
  href: string
  // true = links out to an existing standalone page (marked ↗), not embedded.
  external?: boolean
  description: string
}

export type ReportNavGroup = { title: string; reports: ReportNavItem[] }

export const REPORT_GROUPS: ReportNavGroup[] = [
  {
    title: 'Main Reports',
    reports: [
      { label: 'Season Summary', href: '/reports/season', description: 'Acres and yield by crop for a season, with the same views and exports as before.' },
      { label: 'Marketing Dashboard', href: '/reports/marketing', description: 'Per-crop marketing position for a crop year — production, contracted vs. remaining bushels, average futures/basis/cash price, cost, and projected profit, with assumptions and supporting detail.' },
      { label: 'Revenue Projections', href: '/reports/revenue-projections', description: 'Every revenue source for a crop year — crop sales, insurance proceeds, and government payments — with cost, profit, and breakeven. A one-page financial summary.' },
      { label: 'Income Sensitivity', href: '/reports/income-sensitivity', description: 'A futures-price × yield data table per crop: revenue or net profit per acre in every scenario, with locked contract prices held, crop-insurance indemnities net of premium, and an optional flat government-payment layer.' },
      { label: 'Crop Budget Planner', href: '/reports/crop-budget', description: 'Pre-season budgeting for next crop year: whole-farm allocation scenarios (acres × yield × price × cost → profit) seeded from your APH, budget-year new-crop futures, and last year\'s costs — with a simple price × yield matrix per crop. A sandbox, isolated from actuals.' },
      { label: 'Cash Flow Forecast', href: '/reports/cash-flow', description: 'Monthly projected revenue from contracts and delivered grain, plus the projected ARC/PLC, crop-insurance, and other USDA safety net.' },
      { label: 'Hedging Summary', href: '/reports/hedging-summary', description: 'All futures positions (open and closed) with realized and unrealized P&L, summarized by crop year. Suitable for a lender or business partner.' },
    ],
  },
  {
    title: 'Crop Insurance',
    reports: [
      { label: 'Crop Insurance Production Report', href: '/reports/crop-insurance', description: 'County × practice (irrigated / dryland) production report formatted for crop insurance agents. Summary plus a detail sheet per county/practice, with Excel, PDF, and print exports.' },
      { label: 'Crop Insurance Claims Monitor', href: '/reports/crop-insurance-claims', description: 'Estimated indemnity for each RP / RP-HPE / YP policy (with SCO & ECO) at your current yields and the running harvest-price estimate, netted against premium. For scenarios, see the Income Sensitivity Report.' },
      { label: 'Bundled Settlement Statements (Production Audit)', href: '/reports/settlement-pdfs', description: 'Bundles every attached buyer settlement PDF for a crop & crop year into a single zip — what an auditor needs to confirm sales match self-reported production.' },
    ],
  },
  {
    title: 'Production Reports',
    reports: [
      { label: 'Yields by Field', href: '/yields', external: true, description: 'Per-field dry-bushel yields for a season. Opens the standalone Yields page.' },
      { label: 'Yields by Farm', href: '/yields', external: true, description: 'Yields rolled up by farm. Opens the standalone Yields page.' },
      { label: 'Yields by Landowner', href: '/reports/yields-by-landowner', description: 'Per-landowner production grouped by farm and field. Splits-aware. Export to Excel, PDF, or print as a handout.' },
      { label: 'Share Rent Report', href: '/reports/share-rent', description: 'For each share-rent farm: production by crop and field, plus the landlord’s share of bushels at the configured percentage. Ready to hand to a landowner.' },
      { label: 'Bale Quality Summary', href: '/reports/bale-quality', description: 'Cotton module: per-field bales, lint pounds, weighted avg loan ¢/lb, and HVI grade distributions (color, staple, mic, strength) — the quality package for buyers.' },
    ],
  },
  {
    title: 'Government Payments',
    reports: [
      { label: 'ARC/PLC Decision Aid', href: '/reports/arc-plc-decision-aid', description: 'Compare projected PLC vs ARC-CO payments per farm and commodity, test MYA price assumptions, set your election, and export the decision for the FSA office.' },
      { label: 'Government Payment Tracker', href: '/reports/government-payments', description: 'Projected ARC/PLC payments per farm and commodity plus other USDA payments, with per-entity payment-limit tracking and a per-farm calculation breakdown.' },
    ],
  },
  {
    title: 'Operational Reports',
    reports: [
      { label: 'Load Log', href: '/loads', external: true, description: 'The full load log — search, filter, and export. Opens the standalone Loads page.' },
      { label: 'Contract Tracker', href: '/contracts', external: true, description: 'Delivered vs. contracted with pricing and payment status. Opens the standalone Contracts page.' },
      { label: 'Unpaid Loads', href: '/loads/unpaid', external: true, description: 'Buyer-delivered loads with no matching settlement line. Opens the standalone page.' },
      { label: 'Bin Inventory Summary', href: '/inventory', external: true, description: 'Live bushels on hand per bin, grouped by site. Opens the standalone Inventory page.' },
    ],
  },
]
