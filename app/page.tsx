import Link from 'next/link'

export default function Home() {
  const tiles = [
    { href: '/loads/new', label: 'New Load', sub: 'Record a truck load', color: 'bg-green-700' },
    { href: '/loads', label: 'Loads', sub: 'Search, edit, export', color: 'bg-slate-700' },
    { href: '/inventory', label: 'Bin Inventory', sub: 'Bushels on hand', color: 'bg-amber-700' },
    { href: '/contracts', label: 'Contracts', sub: 'Delivered vs contracted', color: 'bg-sky-700' },
    { href: '/settlements', label: 'Settlements', sub: 'Upload & reconcile payments', color: 'bg-teal-700' },
    { href: '/cash-flow', label: 'Cash Flow', sub: 'Monthly revenue forecast', color: 'bg-indigo-700' },
    { href: '/yields', label: 'Yields', sub: 'Bushels per acre by field', color: 'bg-emerald-700' },
    { href: '/season', label: 'Season Summary', sub: 'Acres + yield by crop', color: 'bg-lime-700' },
    { href: '/settings', label: 'Settings', sub: 'Entities, farms, plantings…', color: 'bg-slate-500' },
  ]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
      {tiles.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`${t.color} text-white rounded-2xl p-6 shadow hover:opacity-95`}
        >
          <div className="text-xl font-bold">{t.label}</div>
          <div className="text-sm opacity-90">{t.sub}</div>
        </Link>
      ))}
    </div>
  )
}
