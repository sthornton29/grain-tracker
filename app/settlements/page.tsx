import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type Row = {
  id: string
  settlement_date: string
  settlement_number: string | null
  notes: string | null
  source_pdf_url: string | null
  buyer_id: string | null
  buyer: { name: string } | null
  settlement_lines: Array<{
    net_bushels: number | null
    net_revenue: number | null
    load_id: string | null
    ticket_number: string | null
  }>
}

const EMPTY_COUNTS: Map<string, number> = new Map()

export default async function SettlementsListPage() {
  const supabase = createClient()
  const { data } = await supabase
    .from('settlements')
    .select('id, settlement_date, settlement_number, notes, source_pdf_url, buyer_id, buyer:buyers(name), settlement_lines(net_bushels, net_revenue, load_id, ticket_number)')
    .order('settlement_date', { ascending: false })

  const rows = (data as unknown as Row[]) ?? []

  // Mirror the Review screen's matching rule so the Unmatched count agrees with
  // it. A line counts as matched when its load_id FK is set (the Review screen
  // persists every unambiguous match) OR its ticket maps to exactly one buyer
  // load. Tickets matching more than one load (ambiguous) or none count as
  // unmatched — exactly what the Review screen flags for manual resolution.
  const buyerIds = Array.from(new Set(rows.map((r) => r.buyer_id).filter((b): b is string => !!b)))
  const { data: buyerLoads } = buyerIds.length
    ? await supabase
        .from('loads')
        .select('to_buyer_id, ticket_number')
        .eq('to_type', 'buyer')
        .in('to_buyer_id', buyerIds)
    : { data: [] as { to_buyer_id: string | null; ticket_number: string | null }[] }
  const ticketCountsByBuyer = new Map<string, Map<string, number>>()
  for (const l of buyerLoads ?? []) {
    if (!l.to_buyer_id) continue
    const t = (l.ticket_number ?? '').trim().toLowerCase()
    if (!t) continue
    let m = ticketCountsByBuyer.get(l.to_buyer_id)
    if (!m) { m = new Map(); ticketCountsByBuyer.set(l.to_buyer_id, m) }
    m.set(t, (m.get(t) ?? 0) + 1)
  }

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
              {['Date', 'Settlement #', 'Buyer', 'Lines', 'Unmatched', 'Net bu', 'Net revenue', 'PDF', '']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No settlements yet.</td></tr>
            )}
            {rows.map((r) => {
              const lines = r.settlement_lines ?? []
              const buyerCounts = (r.buyer_id && ticketCountsByBuyer.get(r.buyer_id)) || EMPTY_COUNTS
              const unmatched = lines.filter((l) => {
                if (l.load_id) return false
                const t = (l.ticket_number ?? '').trim().toLowerCase()
                if (t && buyerCounts.get(t) === 1) return false
                return true
              }).length
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
                  <td className="px-3 py-2">
                    {r.source_pdf_url ? (
                      <a
                        href={r.source_pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-700"
                      >
                        View ↗
                      </a>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
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
