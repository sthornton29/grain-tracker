'use client'

// Settings layout — a Reports-style left rail grouped the way farmers think
// about their operation, rendered from app/settings/settings-nav.ts (the
// same config the hub tiles use). The hub itself (/settings) renders full
// width; every subpage gets the rail (a collapsible menu on phones) and a
// "Settings › Page" breadcrumb, so no page has to add its own.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Breadcrumb from '@/components/breadcrumb'
import { SETTINGS_GROUPS, settingsItemFor } from './settings-nav'

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const current = settingsItemFor(pathname)
  const isHub = !current

  if (isHub) return <>{children}</>

  const rail = (
    <>
      <Link href="/settings" className="font-bold text-lg font-display min-h-11 flex items-center">Settings</Link>
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{g.title}</div>
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const active = current?.href === item.href
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`block px-2 py-2 rounded text-sm min-h-11 flex items-center ${active ? 'bg-green-100 font-semibold' : 'hover:bg-slate-100'}`}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </>
  )

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4 print-area">
      <aside className="hidden lg:block bg-white rounded-xl shadow p-3 space-y-3 self-start no-print lg:sticky lg:top-3">
        {rail}
      </aside>
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <Breadcrumb items={[{ label: 'Settings', href: '/settings' }, { label: current.label }]} className="flex-1" />
          <details className="lg:hidden no-print relative">
            <summary className="cursor-pointer select-none rounded-lg border border-slate-300 bg-white px-3 min-h-11 flex items-center text-sm font-semibold list-none">
              All settings
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-72 max-h-[70vh] overflow-y-auto bg-white rounded-xl shadow-lg border border-slate-200 p-3 space-y-3">
              {rail}
            </div>
          </details>
        </div>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  )
}
