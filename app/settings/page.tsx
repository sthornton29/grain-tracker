import Link from 'next/link'
import SettingsDocImport from '@/components/settings-doc-import'
import { SETTINGS_GROUPS } from './settings-nav'

// The Settings hub: the catch-all document uploader up top, then one tile
// per settings page, grouped and described exactly as the left rail
// (app/settings/layout.tsx) lists them — both render from settings-nav.ts.
export default function SettingsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold font-display">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Where your operation&rsquo;s structure lives. Set it up once — most of it can come straight from your paperwork.
        </p>
      </div>
      {/* The catch-all uploader: no target hint — the reader sorts what it
          finds and the review presents it, most-populated section first. */}
      <SettingsDocImport title="Upload any document — FSA-578, 156-EZ, a lease, a field list" />

      {SETTINGS_GROUPS.map((g) => (
        <section key={g.title}>
          <h2 className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-2">{g.title}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {g.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group bg-white rounded-xl border border-slate-200 p-4 hover:border-slate-300 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <div className="font-semibold text-slate-900 group-hover:text-brand-deep">{item.label}</div>
                <div className="mt-0.5 text-xs sm:text-sm text-slate-500">{item.description}</div>
              </Link>
            ))}
          </div>
        </section>
      ))}

      <div className="border-t border-slate-200 pt-6 mt-4">
        <form action="/logout" method="post">
          <button
            type="submit"
            className="rounded-xl bg-slate-800 text-white px-5 min-h-11 font-semibold hover:bg-slate-900"
          >
            Sign Out
          </button>
        </form>
      </div>
    </div>
  )
}
