import Link from 'next/link'

const items = [
  { href: '/settings/entities', label: 'Entities' },
  { href: '/settings/landowners', label: 'Landowners' },
  { href: '/settings/farms', label: 'Farms' },
  { href: '/settings/fields', label: 'Fields' },
  { href: '/settings/plantings', label: 'Field Plantings' },
  { href: '/settings/bin-sites', label: 'Bin Sites & Bins' },
  { href: '/settings/trucks', label: 'Trucks' },
  { href: '/settings/buyers', label: 'Buyers & Delivery Locations' },
  { href: '/settings/crops', label: 'Crops' },
  { href: '/settings/contracts', label: 'Contracts' },
  { href: '/settings/crop-insurance', label: 'Crop Insurance' },
]

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {items.map((i) => (
          <Link key={i.href} href={i.href} className="bg-white rounded-xl shadow p-4 text-center font-semibold hover:bg-slate-50">
            {i.label}
          </Link>
        ))}
      </div>

      <div className="border-t border-slate-200 pt-6 mt-4">
        <form action="/logout" method="post">
          <button
            type="submit"
            className="rounded-xl bg-slate-800 text-white px-5 py-2.5 font-semibold hover:bg-slate-900"
          >
            Sign Out
          </button>
        </form>
      </div>
    </div>
  )
}
