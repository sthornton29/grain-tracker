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
      </div>
    </div>
  )
}
