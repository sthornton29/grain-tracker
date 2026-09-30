// The page the service worker serves when a navigation fails with no
// connection (public/sw.js). Plain and static on purpose: nothing here can
// depend on data. The load form does not keep an unsaved draft across a
// reload, so this page promises only what is true — reconnect and try again.

export const metadata = { title: 'Offline — Turnrow' }

export default function OfflinePage() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow p-6 space-y-3 text-center">
        <div aria-hidden className="text-4xl">📡</div>
        <h1 className="text-xl font-bold font-display">You&rsquo;re offline</h1>
        <p className="text-sm text-slate-600">
          Turnrow needs a connection to load pages. Check your signal, then reconnect and try again.
        </p>
        <a href="/" className="inline-flex items-center justify-center rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold">
          Try again
        </a>
      </div>
    </div>
  )
}
