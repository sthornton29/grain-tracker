import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type Row = {
  id: string
  settlement_date: string
  settlement_number: string | null
  notes: string | null
  buyer: { name: string } | null
  settlement_lines: Array<{
    net_bushels: number | null
    net_revenue: number | null
    load_id: string | null
  }>
}

export default async function SettlementsListPage() {
  const supabase = createClient()
  const { data } = await supabase
    .from('settlements')
    .select('id, settlement_date, settlement_number, notes, buyer:buyers(name), settlement_lines(net_bushels, net_revenue, load_id)')
    .order('settlement_date', { ascending: false })

  const rows = (data as unknown as Row[]) ?? []
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Settlements</h1>
        <Link href="/settlements/new" className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">+ New Settlement</Link>
      </div>

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Date', 'Settlement #', 'Buyer', 'Lines', 'Unmatched', 'Net bu', 'Net revenue', '']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No settlements yet.</td></tr>
            )}
            {rows.map((r) => {
              const lines = r.settlement_lines ?? []
              const unmatched = lines.filter((l) => !l.load_id).length
              const netBu = lines.reduce((s, l) => s + Number(l.net_bushels ?? 0), 0)
              const netRev = lines.reduce((s, l) => s + Number(l.net_revenue ?? 0), 0)
              return (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{r.settlement_date}</td>
                  <td className="px-3 py-2 font-semibold">{r.settlement_number ?? '—'}</td>
                  <td className="px-3 py-2">{r.buyer?.name ?? ''}</td>
                  <td className="px-3 py-2 text-right">{lines.length}</td>
                  <td className="px-3 py-2 text-right">
                    {unmatched > 0
                      ? <span className="text-amber-700 font-semibold">{unmatched}</span>
                      : <span className="text-slate-400">0</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{fmt(netBu)}</td>
                  <td className="px-3 py-2 text-right">${fmt(netRev)}</td>
                  <td className="px-3 py-2"><Link href={`/settlements/${r.id}`} className="text-sky-700">Review →</Link></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
