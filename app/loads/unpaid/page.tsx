import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import StaticExportBar from '@/components/static-export-bar'
import { fmtDate } from '@/lib/format-date'
import type { ExportPayload } from '@/lib/exports'
import { loadTicketKeys } from '@/lib/ticket-matching'
import { describeSale, fetchLoadSales, saleAllocations, saleKind, type LoadSale, type SaleAllocation, type SaleLoad } from '@/lib/load-sales'
import { spotPriceChip } from '@/lib/spot-price'

export const dynamic = 'force-dynamic'

type Row = {
  id: string
  date: string
  ticket_number: string | null
  buyer_ticket_number?: string | null
  crop_year: number | null
  crop_id: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  to_type: string | null
  to_buyer_id: string | null
  contract_id: string | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  buyer: { name: string } | null
}

type ContractLite = { id: string; contract_number: string; cash_price: number | null; price_per_bushel: number | null }

/** A load as the report shows it: its sale, the price it is worth per
 *  bushel (contract parts at the contract price, spot parts at their
 *  current price), its value and the spot chips explaining the price. */
type UnpaidRow = {
  load: Row
  dryBu: number
  allocs: SaleAllocation[]
  kind: ReturnType<typeof saleKind>
  saleText: string
  /** Weighted $/bu over the priced parts; null when nothing is priced. */
  pricePerBu: number | null
  /** Dollars the priced parts are worth; null when nothing is priced. */
  value: number | null
  chips: string[]
  /** True when a spot part's price is an estimate (or missing). */
  estimated: boolean
}

export default async function UnpaidLoadsPage({
  searchParams,
}: {
  searchParams: { crop_year?: string }
}) {
  const supabase = createClient()
  const cropYear = searchParams.crop_year ? Number(searchParams.crop_year) : null

  const [loadsRes, linesRes, plantingsRes, contractsRes] = await Promise.all([
    fetchAllRows((f, t) => supabase
      .from('loads')
      .select(`
        id, date, ticket_number, buyer_ticket_number, crop_year, crop_id, net_weight, moisture, dry_bushels_override, to_type, to_buyer_id, contract_id,
        crop:crops(name, base_moisture_pct, base_lb_per_bushel),
        buyer:buyers!loads_to_buyer_id_fkey(name)
      `)
      .eq('to_type', 'buyer')
      .order('date', { ascending: false })
      .order('id')
      .range(f, t)),
    fetchAllRows((f, t) => supabase.from('settlement_lines').select('ticket_number, load_id').order('id').range(f, t)),
    fetchAllRows((f, t) => supabase.from('field_plantings').select('season_year').order('id').range(f, t)),
    fetchAllRows((f, t) => supabase.from('contracts').select('id, contract_number, cash_price, price_per_bushel').order('id').range(f, t)),
  ])

  const loads = (loadsRes.data as unknown as Row[]) ?? []
  const paid = new Set<string>()
  const paidLoadIds = new Set<string>()
  for (const l of (linesRes.data ?? []) as Array<{ ticket_number: string | null; load_id: string | null }>) {
    if (l.ticket_number) paid.add(l.ticket_number.trim().toLowerCase())
    if (l.load_id) paidLoadIds.add(l.load_id)
  }

  const unpaid = loads.filter((r) => {
    // A manual match on the Review screen links the line by load_id (not ticket),
    // so treat a load as paid if it's linked OR its ticket matches a line.
    if (paidLoadIds.has(r.id)) return false
    if (loadTicketKeys(r).some((k) => paid.has(k))) return false
    if (cropYear != null && r.crop_year !== cropYear) return false
    return true
  })

  const plantingYears = ((plantingsRes.data ?? []) as Array<{ season_year: number | null }>).map((p) => p.season_year)
  const cropYearOptions = cropYearOptionsFromPlantings(plantingYears, cropYear)

  const dryBuOf = (r: Row): number => computeBushels({
    netWeightLb: r.net_weight, moisturePct: r.moisture,
    baseMoisturePct: r.crop?.base_moisture_pct ?? null, baseLbPerBushel: r.crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: r.dry_bushels_override,
  }).dryBushels ?? 0

  // How each load was sold (094): contract / spot / price later / a split.
  // A database before 094 reads as no rows — every load with a contract is a
  // full contract load, the rest unassigned.
  let sales: LoadSale[] = []
  try { sales = await fetchLoadSales(supabase, { loadIds: unpaid.map((r) => r.id) }) } catch { sales = [] }
  const contractById = new Map(((contractsRes.data ?? []) as ContractLite[]).map((c) => [c.id, c]))
  const contractNumber = (id: string) => contractById.get(id)?.contract_number
  const contractPrice = (id: string): number | null => {
    const c = contractById.get(id)
    if (!c) return null
    const p = c.cash_price ?? c.price_per_bushel
    return p != null ? Number(p) : null
  }
  const saleLoads: SaleLoad[] = unpaid.map((r) => ({ id: r.id, contract_id: r.contract_id, to_type: 'buyer' as const, dryBu: dryBuOf(r) }))
  const allocsByLoad = saleAllocations(saleLoads, sales)

  const rows: UnpaidRow[] = unpaid.map((load) => {
    const dryBu = dryBuOf(load)
    const allocs = allocsByLoad.get(load.id) ?? []
    const kind = saleKind(allocs, { to_type: 'buyer' })
    let pricedBu = 0, value = 0, estimated = false
    const chips: string[] = []
    for (const a of allocs) {
      if (a.saleType === 'contract' && a.contractId) {
        const p = contractPrice(a.contractId)
        if (p != null) { pricedBu += a.bushels; value += a.bushels * p }
      } else if (a.saleType === 'spot') {
        const p = a.sale?.spot_price ?? null
        if (p != null) { pricedBu += a.bushels; value += a.bushels * p }
        if (p == null || a.sale?.spot_price_source === 'estimate') estimated = true
        if (a.sale) chips.push(spotPriceChip(a.sale, load.buyer?.name))
      }
    }
    return {
      load, dryBu, allocs, kind,
      saleText: describeSale(allocs, contractNumber, { to_type: 'buyer' }),
      pricePerBu: pricedBu > 0 ? value / pricedBu : null,
      value: pricedBu > 0 ? value : null,
      chips, estimated,
    }
  })

  // Price-later loads wait under their own heading: delivered, unpaid, and
  // not yet priced — they have no value to show until the farmer prices them.
  const priced = rows.filter((r) => r.kind !== 'price_later')
  const priceLater = rows.filter((r) => r.kind === 'price_later')
  const totals = (list: UnpaidRow[]) => ({
    loads: list.length,
    dryBu: list.reduce((s, r) => s + r.dryBu, 0),
    value: list.reduce((s, r) => s + (r.value ?? 0), 0),
    anyValue: list.some((r) => r.value != null),
    estimated: list.some((r) => r.estimated),
  })
  const pricedTotals = totals(priced)
  const laterTotals = totals(priceLater)
  const allTotals = totals(rows)

  // Per-buyer subtotals from the loads in view: the contract parts' bushels
  // at their weighted contract price, the spot parts' bushels at their
  // weighted current price, and the price-later bushels waiting.
  type BuyerSub = { name: string; contractBu: number; contractDollars: number; contractPricedBu: number; spotBu: number; spotDollars: number; spotPricedBu: number; laterBu: number; unassignedBu: number; estimated: boolean }
  const byBuyer = new Map<string, BuyerSub>()
  for (const r of rows) {
    const key = r.load.to_buyer_id ?? ''
    let b = byBuyer.get(key)
    if (!b) { b = { name: r.load.buyer?.name ?? 'No buyer', contractBu: 0, contractDollars: 0, contractPricedBu: 0, spotBu: 0, spotDollars: 0, spotPricedBu: 0, laterBu: 0, unassignedBu: 0, estimated: false }; byBuyer.set(key, b) }
    if (r.allocs.length === 0) { b.unassignedBu += r.dryBu; continue }
    for (const a of r.allocs) {
      if (a.saleType === 'contract') {
        b.contractBu += a.bushels
        const p = a.contractId ? contractPrice(a.contractId) : null
        if (p != null) { b.contractPricedBu += a.bushels; b.contractDollars += a.bushels * p }
      } else if (a.saleType === 'spot') {
        b.spotBu += a.bushels
        const p = a.sale?.spot_price ?? null
        if (p != null) { b.spotPricedBu += a.bushels; b.spotDollars += a.bushels * p }
        if (p == null || a.sale?.spot_price_source === 'estimate') b.estimated = true
      } else {
        b.laterBu += a.bushels
      }
    }
  }
  const buyerSubs = [...byBuyer.values()].sort((a, b) => a.name.localeCompare(b.name))
  const buyerLine = (b: BuyerSub): string => {
    const parts: string[] = []
    if (b.contractBu > 0) parts.push(`contract ${fmt(b.contractBu)} bu${b.contractPricedBu > 0 ? ` @ ${usd2(b.contractDollars / b.contractPricedBu)}` : ''}`)
    if (b.spotBu > 0) parts.push(`spot ${fmt(b.spotBu)} bu${b.spotPricedBu > 0 ? ` @ ${usd4(b.spotDollars / b.spotPricedBu)}${b.estimated ? ' (est.)' : ''}` : ' (no price yet)'}`)
    if (b.laterBu > 0) parts.push(`price later ${fmt(b.laterBu)} bu`)
    if (b.unassignedBu > 0) parts.push(`unassigned ${fmt(b.unassignedBu)} bu`)
    return parts.join(' · ')
  }

  // Bushels on screen are whole numbers (lib/exports 'bu'); dollars whole.
  const fmt = (n: number | null) => n != null ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : ''
  const usd0 = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  const usd2 = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const usd4 = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`

  const exportRow = (r: UnpaidRow) => [
    fmtDate(r.load.date), r.load.ticket_number ?? '', r.load.crop?.name ?? '', r.load.crop_year ?? '', r.load.buyer?.name ?? '',
    r.saleText + (r.chips.length > 0 ? ` (${r.chips.join('; ')})` : ''),
    r.pricePerBu != null ? Math.round(r.pricePerBu * 10000) / 10000 : '', r.dryBu, r.value != null ? r.value : '',
  ]
  const exportColumns: ExportPayload['sections'][number]['columns'] = [
    { label: 'Date' }, { label: 'Ticket' }, { label: 'Crop' }, { label: 'Crop year', format: 'text' },
    { label: 'Buyer' }, { label: 'Sale' }, { label: 'Price/bu', align: 'right', format: 'price' },
    { label: 'Dry bu', align: 'right', format: 'bu' }, { label: 'Value', align: 'right', format: 'usd0' },
  ]
  const exportPayload: ExportPayload = {
    title: 'Unpaid Loads',
    filters: cropYear != null ? `${cropYear} crop` : 'All crop years',
    summary: [
      { label: 'Unpaid loads', value: String(allTotals.loads) },
      { label: 'Outstanding dry bu', value: fmt(allTotals.dryBu) },
      { label: 'Value at current prices', value: `${usd0(pricedTotals.value)}${pricedTotals.estimated ? ' (est.)' : ''}` },
      { label: 'Price later (not yet priced)', value: `${fmt(laterTotals.dryBu)} bu` },
    ],
    sections: [
      {
        title: 'Contract and spot',
        columns: exportColumns,
        rows: [...priced.map(exportRow), ['Total', '', '', '', '', '', '', pricedTotals.dryBu, pricedTotals.value]],
        rowMeta: [...priced.map(() => 'data' as const), 'total'],
      },
      ...(priceLater.length > 0
        ? [{
            title: 'Price later (not yet priced)',
            columns: exportColumns,
            rows: [...priceLater.map(exportRow), ['Total', '', '', '', '', '', '', laterTotals.dryBu, '']],
            rowMeta: [...priceLater.map(() => 'data' as const), 'total' as const],
          }]
        : []),
      {
        title: 'By buyer',
        columns: [{ label: 'Buyer' }, { label: 'Outstanding' }],
        rows: buyerSubs.map((b) => [b.name, buyerLine(b)]),
      },
    ],
  }

  const Table = ({ list, totalsOf, showValue }: { list: UnpaidRow[]; totalsOf: ReturnType<typeof totals>; showValue: boolean }) => (
    <div className="overflow-x-auto bg-white rounded-xl shadow">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-100 text-slate-700">
          <tr>
            {['Date', 'Ticket', 'Crop', 'Crop year', 'Buyer', 'Sale', 'Price/bu', 'Dry bu', 'Value']
              .map((h, i) => <th key={h} className={`${i >= 6 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.load.id} className="border-t border-slate-100 align-top">
              <td className="px-3 py-2 whitespace-nowrap tabular-nums">{fmtDate(r.load.date)}</td>
              <td className="px-3 py-2">
                <Link href={`/loads/${r.load.id}`} className="text-brand-deep underline">{r.load.ticket_number ?? <span className="text-amber-700">no ticket</span>}</Link>
              </td>
              <td className="px-3 py-2">{r.load.crop?.name}</td>
              <td className="px-3 py-2">{r.load.crop_year ?? ''}</td>
              <td className="px-3 py-2">{r.load.buyer?.name ?? ''}</td>
              <td className="px-3 py-2">
                <span className={r.kind === 'unassigned' ? 'text-amber-700' : ''}>{r.saleText}</span>
                {r.chips.map((c, i) => (
                  <span key={i} className={`ml-1.5 inline-block rounded-full px-2 py-0.5 text-xs ${c.startsWith('settled') ? 'bg-green-100 text-green-800' : c.startsWith('your bid') ? 'bg-sky-100 text-sky-800' : 'bg-amber-100 text-amber-800'}`}>{c}</span>
                ))}
              </td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{r.pricePerBu != null ? usd2(r.pricePerBu) : <span className="text-slate-400">—</span>}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(r.dryBu)}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{showValue && r.value != null ? `${usd0(r.value)}${r.estimated ? ' (est.)' : ''}` : <span className="text-slate-400">—</span>}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
            <td className="px-3 py-2" colSpan={7}>{totalsOf.loads} load{totalsOf.loads === 1 ? '' : 's'}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmt(totalsOf.dryBu)}</td>
            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{showValue && totalsOf.anyValue ? `${usd0(totalsOf.value)}${totalsOf.estimated ? ' (est.)' : ''}` : <span className="text-slate-400">—</span>}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Unpaid Loads</h1>
        <Link href="/loads" className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm">All loads</Link>
        {rows.length > 0 && <StaticExportBar payload={exportPayload} />}
        <form className="flex items-center gap-2">
          <select name="crop_year" aria-label="Crop year" defaultValue={cropYear ?? ''} className="rounded-lg border border-slate-300 px-3 min-h-11">
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
          <button className="rounded-lg bg-slate-700 text-white px-3 min-h-11 text-sm">Apply</button>
        </form>
      </div>
      <p className="text-sm text-slate-500">
        Buyer-delivered loads not matched to any settlement line (by ticket or manual match).{' '}
        {allTotals.loads} load{allTotals.loads === 1 ? '' : 's'} · {fmt(allTotals.dryBu)} dry bu outstanding
        {pricedTotals.anyValue ? <> · about {usd0(pricedTotals.value)} at current prices{pricedTotals.estimated ? ' (some estimated)' : ''}</> : null}.
      </p>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl shadow px-3 py-6 text-center text-slate-400">No unpaid buyer-delivered loads.</div>
      ) : (
        <>
          <Table list={priced} totalsOf={pricedTotals} showValue />

          {priceLater.length > 0 && (
            <div className="space-y-2">
              <h2 className="font-semibold">Price later (not yet priced)</h2>
              <p className="text-xs text-slate-500">
                Delivered to the buyer and waiting to be priced — no value until you price them. Pricing happens from the contracts page.
              </p>
              <Table list={priceLater} totalsOf={laterTotals} showValue={false} />
            </div>
          )}

          {buyerSubs.length > 0 && (
            <div className="bg-white rounded-xl shadow px-4 py-3 space-y-1">
              <h2 className="font-semibold">By buyer</h2>
              <ul className="text-sm space-y-1">
                {buyerSubs.map((b) => (
                  <li key={b.name} className="tabular-nums"><span className="font-semibold">{b.name}</span> · {buyerLine(b)}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
