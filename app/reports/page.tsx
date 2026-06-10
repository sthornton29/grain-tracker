import Link from 'next/link'
import { REPORT_GROUPS } from './reports-nav'

export default function ReportsLanding() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-slate-600 max-w-2xl mt-1">
          Pick a report below or from the sidebar. Reports that open inside this page have Excel,
          PDF, and Print buttons. Reports marked with <span className="text-slate-400">↗</span>{' '}
          open on their standalone pages.
        </p>
      </div>

      {REPORT_GROUPS.map((group) => (
        <section key={group.title} className="space-y-3">
          <h2 className="text-xs uppercase tracking-wide text-slate-500 font-semibold">{group.title}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {group.reports.map((r) => (
              <Link
                key={r.href + r.label}
                href={r.href}
                className="block bg-white rounded-xl shadow p-4 hover:bg-slate-50"
                {...(r.external ? { title: 'Opens the standalone page' } : {})}
              >
                <h3 className="font-bold mb-1">
                  {r.label}
                  {r.external && <span className="text-slate-400 text-xs ml-1 font-normal">↗</span>}
                </h3>
                <p className="text-sm text-slate-600">{r.description}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
