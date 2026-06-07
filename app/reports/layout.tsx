import Link from 'next/link'

// Static categories list. Reports marked `external: true` open the existing
// standalone page (phase 1); the others render inside this layout. As more
// reports get embedded, set external to false and add an `href` under
// /reports/*.
const categories = [
  {
    title: 'Production Reports',
    reports: [
      { label: 'Yields by Field', href: '/yields', external: true },
      { label: 'Yields by Farm', href: '/yields', external: true },
      { label: 'Yields by Landowner', href: '/reports/yields-by-landowner', external: false },
      { label: 'Crop Insurance Production', href: '/reports/crop-insurance', external: false },
      { label: 'Season Summary', href: '/season', external: true },
    ],
  },
  {
    title: 'Inventory Reports',
    reports: [
      { label: 'Bin Inventory Summary', href: '/inventory', external: true },
    ],
  },
  {
    title: 'Contract & Sales Reports',
    reports: [
      { label: 'Contract Tracker', href: '/contracts', external: true },
      { label: 'Unpaid Loads', href: '/loads/unpaid', external: true },
      { label: 'Settlement Statements (Audit)', href: '/reports/settlement-pdfs', external: false },
    ],
  },
  {
    title: 'Financial Reports',
    reports: [
      { label: 'Cash Flow Forecast', href: '/cash-flow', external: true },
      { label: 'Share Rent Report', href: '/reports/share-rent', external: false },
    ],
  },
  {
    title: 'Risk Management',
    reports: [
      { label: 'Hedging Summary', href: '/reports/hedging-summary', external: false },
      { label: 'Crop Insurance Claims Monitor', href: '/reports/crop-insurance-claims', external: false },
      { label: 'Revenue Projections', href: '/reports/revenue-projections', external: false },
      { label: 'Marketing Dashboard', href: '/marketing', external: true },
    ],
  },
  {
    title: 'Operations Reports',
    reports: [
      { label: 'Load Log', href: '/loads', external: true },
    ],
  },
]

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 print-area">
      <aside className="bg-white rounded-xl shadow p-3 space-y-3 self-start no-print lg:sticky lg:top-3">
        <Link href="/reports" className="block font-bold text-lg">Reports</Link>
        {categories.map((cat) => (
          <div key={cat.title}>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{cat.title}</div>
            <ul className="space-y-0.5">
              {cat.reports.map((r) => (
                <li key={`${cat.title}-${r.label}`}>
                  <Link
                    href={r.href}
                    className="block px-2 py-1.5 rounded text-sm hover:bg-slate-100"
                    {...(r.external ? { title: 'Opens the standalone page' } : {})}
                  >
                    {r.label}{r.external && <span className="text-slate-400 text-xs ml-1">↗</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  )
}
