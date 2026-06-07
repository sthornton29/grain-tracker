import Link from 'next/link'

export default function ReportsLanding() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Reports</h1>
      <p className="text-slate-600 max-w-2xl">
        Pick a report from the sidebar. Reports that open inside this page have Excel,
        PDF, and Print buttons. Reports marked with <span className="text-slate-400">↗</span>{' '}
        still live on their standalone pages — they’ll move in here over time.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
        <Link
          href="/reports/yields-by-landowner"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Yields by Landowner</h2>
          <p className="text-sm text-slate-600">
            Per-landowner production grouped by farm and field. Splits-aware. Export to
            Excel, PDF, or print as a handout.
          </p>
        </Link>
        <Link
          href="/reports/share-rent"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Share Rent Report</h2>
          <p className="text-sm text-slate-600">
            For each share-rent farm: production by crop and field, plus the landlord’s
            share of bushels at the configured percentage. Ready to hand to a landowner.
          </p>
        </Link>
        <Link
          href="/reports/crop-insurance"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Crop Insurance Production Report</h2>
          <p className="text-sm text-slate-600">
            County × practice (irrigated / dryland) production report formatted for crop
            insurance agents. Summary plus a detail sheet per county/practice, with Excel,
            PDF, and print exports.
          </p>
        </Link>
        <Link
          href="/marketing"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Marketing Dashboard <span className="text-slate-400 text-sm">↗</span></h2>
          <p className="text-sm text-slate-600">
            Per-crop marketing position for a crop year — production, contracted vs. remaining bushels, average
            futures/basis/cash price, cost, and projected profit. Base and Detailed views, with assumptions and
            supporting contract/hedge detail.
          </p>
        </Link>
        <Link
          href="/reports/hedging-summary"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Hedging Summary</h2>
          <p className="text-sm text-slate-600">
            All futures positions (open and closed) with realized and unrealized P&amp;L, summarized by
            crop year. Excel and PDF exports suitable for a lender or business partner.
          </p>
        </Link>
        <Link
          href="/reports/crop-insurance-claims"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Crop Insurance Claims Monitor</h2>
          <p className="text-sm text-slate-600">
            Estimated indemnity for each RP / RP-HPE / YP policy (with SCO &amp; ECO) at your current yields and the
            running harvest-price estimate, netted against premium. What-If sliders, per-policy math, and Excel/PDF exports.
          </p>
        </Link>
        <Link
          href="/reports/revenue-projections"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Revenue Projections</h2>
          <p className="text-sm text-slate-600">
            Every revenue source for a crop year — crop sales, insurance proceeds, and government payments (coming
            soon) — with cost, profit, and breakeven. A one-page financial summary for a lender or farm meeting.
          </p>
        </Link>
        <Link
          href="/reports/settlement-pdfs"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Settlement Statements (Crop Insurance Audit)</h2>
          <p className="text-sm text-slate-600">
            Bundles every attached buyer settlement PDF for a crop &amp; crop year into a
            single zip — what the auditor needs to confirm sales match your self-reported
            production.
          </p>
        </Link>
        <Link
          href="/cash-flow"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Cash Flow Forecast <span className="text-slate-400 text-sm">↗</span></h2>
          <p className="text-sm text-slate-600">
            Monthly projected revenue from contracts and delivered grain — the same forecast view,
            filters, and exports as before.
          </p>
        </Link>
        <Link
          href="/season"
          className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
        >
          <h2 className="font-bold mb-1">Season Summary <span className="text-slate-400 text-sm">↗</span></h2>
          <p className="text-sm text-slate-600">
            Acres and yield by crop for a season, with the same views and exports as before.
          </p>
        </Link>
      </div>
    </div>
  )
}
