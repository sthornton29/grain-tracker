import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'

export const dynamic = 'force-dynamic'

type Row = {
  id: string
  date: string
  ticket_number: string | null
  crop_year: number | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  to_type: string | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  buyer: { name: string } | null
  contract: { contract_number: string } | null
}

export default async function UnpaidLoadsPage({
  searchParams,
}: {
  searchParams: { crop_year?: string }
}) {
  const supabase = createClient()
  const cropYear = searchParams.crop_year ? Number(searchParams.crop_year) : null

  const [loadsRes, linesRes] = await Promise.all([
    supabase
      .from('loads')
      .select(`
        id, date, ticket_number, crop_year, net_weight, moisture, dry_bushels_override, to_type,
        crop:crops(name, base_moisture_pct, base_lb_per_bushel),
        buyer:buyers!loads_to_buyer_id_fkey(name),
        contract:contracts(contract_number)
      `)
      .eq('to_type', 'buyer')
      .order('date', { ascending: false }),
    supabase.from('settlement_lines').select('ticket_number'),
  ])

  const loads = (loadsRes.data as unknown as Row[]) ?? []
  const paid = new Set<string>()
  for (const l of (linesRes.data ?? []) as Array<{ ticket_number: string | null }>) {
    if (l.ticket_number) paid.add(l.ticket_number.trim().toLowerCase())
  }

  const unpaid = loads.filter((r) => {
    const t = r.ticket_number?.trim().toLowerCase()
    const isPaid = t ? paid.has(t) : false
    if (isPaid) return false
    if (cropYear != null && r.crop_year !== cropYear) return false
    return true
  })

  const cropYearOptions = Array.from(
    new Set(loads.map((l) => l.crop_year).filter((y): y is number => y != null))
  ).sort((a, b) => b - a)

  const totalDryBu = unpaid.reduce((sum, r) => {
    const { dryBushels } = computeBushels({
      netWeightLb: r.net_weight,
      moisturePct: r.moisture,
      baseMoisturePct: r.crop?.base_moisture_pct ?? null,
      baseLbPerBushel: r.crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: r.dry_bushels_override,
    })
    return sum + (dryBushels ?? 0)
  }, 0)

  const fmt = (n: number | null) => n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ''

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Unpaid Loads</h1>
        <Link href="/loads" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">All loads</Link>
        <form className="flex items-center gap-2">
          <select name="crop_year" defaultValue={cropYear ?? ''} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
          <button className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm">Apply</button>
        </form>
      </div>
      <p className="text-sm text-slate-500">
        Buyer-delivered loads with no settlement line matching the ticket number.{' '}
        {unpaid.length} load{unpaid.length === 1 ? '' : 's'} · {fmt(totalDryBu)} dry bu outstanding.
      </p>

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Date', 'Ticket', 'Crop', 'Crop year', 'Buyer', 'Contract', 'Dry bu']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {unpaid.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No unpaid buyer-delivered loads.</td></tr>
            )}
            {unpaid.map((r) => {
              const { dryBushels } = computeBushels({
                netWeightLb: r.net_weight,
                moisturePct: r.moisture,
                baseMoisturePct: r.crop?.base_moisture_pct ?? null,
                baseLbPerBushel: r.crop?.base_lb_per_bushel ?? null,
                dryBushelsOverride: r.dry_bushels_override,
              })
              return (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 whitespace-nowrap">{r.date}</td>
                  <td className="px-3 py-2">{r.ticket_number ?? <span className="text-amber-700">no ticket</span>}</td>
                  <td className="px-3 py-2">{r.crop?.name}</td>
                  <td className="px-3 py-2">{r.crop_year ?? ''}</td>
                  <td className="px-3 py-2">{r.buyer?.name ?? ''}</td>
                  <td className="px-3 py-2">{r.contract?.contract_number ? `#${r.contract.contract_number}` : ''}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(dryBushels)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
