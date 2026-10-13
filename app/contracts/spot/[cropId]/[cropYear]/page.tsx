import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { coerceAppRole } from '@/lib/app-role'
import { fetchSalesForContracts, fetchSettlementLinesForSales, fmtAvgPrice, settlementLinesByLoad, spotRowFacts } from '@/lib/contracts-sales-fetch'
import { buildSpotContracts, type VirtualSpotContract } from '@/lib/virtual-contracts'
import { describeSale } from '@/lib/load-sales'
import { spotPriceChip } from '@/lib/spot-price'
import { fmtDate } from '@/lib/format-date'
import StaticExportBar from '@/components/static-export-bar'
import { DataTable, EmptyState, ReportHeader, SourceChip, SummaryCards, type DataRow } from '@/components/reports/report-kit'
// Pure helpers come from the plain module — this is a SERVER component.
import { fmtInt, fmtNum, fmtUsd } from '@/components/reports/report-format'
import type { ExportCell, ExportPayload, RowKind } from '@/lib/exports'

export const dynamic = 'force-dynamic'

// The SPOT contract for one crop × crop year (094): every load sold at the
// buyer's posted bid, priced together at the bushel-weighted average. Held by
// the marketing-agent entity; in an org without one, `?entity=` narrows to
// one field entity's loads (the tracker links that way), else every spot
// load of the year shows together.

function fmtBasis(n: number): string {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`
}

export default async function SpotContractPage({
  params, searchParams,
}: {
  params: { cropId: string; cropYear: string }
  searchParams: Record<string, string | string[] | undefined>
}) {
  const cropYear = Number(params.cropYear)
  if (!/^\d{4}$/.test(params.cropYear) || !Number.isFinite(cropYear)) notFound()
  const entityParam = typeof searchParams.entity === 'string' ? searchParams.entity : ''

  const supabase = createClient()
  const [salesData, { data: { user } }] = await Promise.all([
    fetchSalesForContracts(supabase, { cropYear }),
    supabase.auth.getUser(),
  ])
  const { data: profile } = user
    ? await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
    : { data: null }
  const role = coerceAppRole((profile as { role?: string } | null)?.role)

  const crop = salesData.crops.find((c) => c.id === params.cropId)
  if (!crop) notFound()
  const { loads, sales, allocations, entities, buyers, marketingAgentEntityId } = salesData

  let spot: VirtualSpotContract | undefined
  if (marketingAgentEntityId) {
    spot = salesData.spots.find((s) => s.crop_id === crop.id && s.crop_year === cropYear)
  } else if (entityParam) {
    spot = salesData.spots.find((s) => s.crop_id === crop.id && s.crop_year === cropYear && s.entity_id === entityParam)
  } else {
    // No agent and no entity asked for: every spot load of the year, together.
    spot = buildSpotContracts({ loads, sales, marketingAgentEntityId: null }).find((s) => s.crop_id === crop.id && s.crop_year === cropYear)
  }

  const entityName = marketingAgentEntityId
    ? entities.find((e) => e.id === marketingAgentEntityId)?.name ?? null
    : entityParam ? entities.find((e) => e.id === entityParam)?.name ?? 'Entity' : null
  const title = `Spot · ${crop.name} ${cropYear}`
  const filterSummary = [entityName ?? 'All entities', `${cropYear} crop`, crop.name].join(' · ')

  if (!spot || spot.rows.length === 0) {
    return (
      <div className="space-y-4">
        <Link href="/contracts" className="text-sm text-brand-deep">← Back to contracts</Link>
        <ReportHeader title={title} filterSummary={filterSummary} />
        <EmptyState
          message={`No spot loads for ${crop.name} ${cropYear} yet.`}
          hint="A load sold at the buyer's posted bid shows here once its sale type is Spot."
          linkHref="/loads"
          linkLabel="Open Loads"
          role={role}
        />
      </div>
    )
  }

  const buyerName = (id: string | null | undefined) => (id ? buyers.find((b) => b.id === id)?.name ?? null : null)
  const facts = spotRowFacts(spot, crop.name, (id) => buyerName(id))

  // Settlement links and the contract numbers behind any split notes.
  const spotLoads = spot.rows.map((r) => r.load)
  const contractIds = [...new Set(sales.filter((s) => spotLoads.some((l) => l.id === s.load_id) && s.contract_id).map((s) => s.contract_id as string))]
  const [lines, contractsQ] = await Promise.all([
    fetchSettlementLinesForSales(supabase, {
      loadIds: spotLoads.map((l) => l.id),
      ticketNumbers: spotLoads.map((l) => l.ticket_number).filter((t): t is string => !!t),
    }),
    contractIds.length > 0
      ? supabase.from('contracts').select('id, contract_number').in('id', contractIds)
      : Promise.resolve({ data: [] as Array<{ id: string; contract_number: string }> }),
  ])
  const contractNumberById = new Map(((contractsQ.data ?? []) as Array<{ id: string; contract_number: string }>).map((c) => [c.id, c.contract_number]))
  const lineById = new Map(lines.map((l) => [l.id, l]))
  const linesFor = settlementLinesByLoad(lines)
  function settlementIdFor(row: VirtualSpotContract['rows'][number]): string | null {
    const byRow = row.alloc.sale?.settlement_line_id ? lineById.get(row.alloc.sale.settlement_line_id) : null
    if (byRow) return byRow.settlement_id
    const own = linesFor({ id: row.load.id, ticket_number: row.load.ticket_number ?? null, buyer_ticket_number: row.load.buyer_ticket_number ?? null })
    const spotLine = own.find((l) => l.sale_type === 'spot') ?? (own.every((l) => l.contract_id == null && l.sale_type == null) ? own[0] : null)
    return spotLine?.settlement_id ?? null
  }

  // Rows grouped by buyer (largest first, as the virtual contract orders them),
  // a subtotal under each buyer, one total.
  type Line = { row: VirtualSpotContract['rows'][number]; splitNote: string | null; settlementId: string | null; chip: string }
  const groups = spot.buyers.map((b) => ({
    buyer: b,
    name: buyerName(b.buyerId) ?? 'No buyer',
    lines: spot!.rows.filter((r) => r.load.to_buyer_id === b.buyerId).map((row): Line => {
      const allocs = allocations.get(row.load.id) ?? []
      return {
        row,
        splitNote: allocs.length > 1 ? describeSale(allocs, (id) => contractNumberById.get(id)) : null,
        settlementId: settlementIdFor(row),
        chip: row.alloc.sale ? spotPriceChip(row.alloc.sale, buyerName(row.load.to_buyer_id)) : 'no price yet',
      }
    }),
  }))

  const columns = [
    { label: 'Date' }, { label: 'Buyer' }, { label: 'Ticket' },
    { label: 'Bushels', align: 'right' as const }, { label: '$/bu', align: 'right' as const }, { label: 'Price from' },
    { label: 'Futures', align: 'right' as const }, { label: 'Basis', align: 'right' as const }, { label: 'Settlement' },
  ]
  const tableRows: DataRow[] = []
  const exportRows: ExportCell[][] = []
  const exportMeta: RowKind[] = []
  for (const g of groups) {
    for (const { row, splitNote, settlementId, chip } of g.lines) {
      const s = row.alloc.sale
      const price = s?.spot_price ?? null
      tableRows.push({
        key: `${row.load.id}-${row.entityId ?? ''}`,
        cells: [
          <Link key="d" href={`/loads/${row.load.id}`} className="text-brand-deep hover:underline whitespace-nowrap">{fmtDate(row.load.date)}</Link>,
          g.name,
          <span key="t">
            {row.load.ticket_number ?? ''}
            {splitNote && <span className="block text-xs text-slate-500">{splitNote}</span>}
          </span>,
          fmtNum(row.alloc.bushels, 3),
          price != null ? fmtUsd(price, 2) : <span className="text-slate-400">—</span>,
          <SourceChip key="c">{chip}</SourceChip>,
          s?.est_futures_price != null ? `${s.est_futures_symbol ? `${s.est_futures_symbol} ` : ''}${fmtUsd(s.est_futures_price, 2)}` : <span className="text-slate-400">—</span>,
          s?.est_basis != null ? fmtBasis(s.est_basis) : <span className="text-slate-400">—</span>,
          settlementId
            ? <Link key="s" href={`/settlements/${settlementId}`} className="text-brand-deep hover:underline">settlement</Link>
            : <span className="text-slate-400">not yet</span>,
        ],
      })
      exportRows.push([
        fmtDate(row.load.date), g.name, `${row.load.ticket_number ?? ''}${splitNote ? ` (${splitNote})` : ''}`,
        row.alloc.bushels, price ?? '', chip,
        s?.est_futures_price ?? '', s?.est_basis ?? '', settlementId ? 'yes' : '',
      ])
      exportMeta.push('data')
    }
    const sub = g.buyer.summary
    const subLabel = `${g.name} · ${fmtNum(g.buyer.bushels, 3)} bu · ${fmtAvgPrice(g.buyer.avgPrice)}`
    tableRows.push({
      key: `sub-${g.buyer.buyerId ?? 'none'}`,
      kind: 'subtotal',
      cells: [
        { content: subLabel, className: 'whitespace-nowrap' }, '', '',
        fmtNum(g.buyer.bushels, 3), fmtAvgPrice(g.buyer.avgPrice), { content: sub.statusText, className: 'text-xs font-normal text-slate-500' },
        sub.futures ? fmtUsd(sub.futures.avgFutures, 2) : '', sub.futures ? fmtBasis(sub.futures.avgBasis) : '', '',
      ],
    })
    exportRows.push([subLabel, '', '', g.buyer.bushels, g.buyer.avgPrice ?? '', sub.statusText, sub.futures?.avgFutures ?? '', sub.futures?.avgBasis ?? '', ''])
    exportMeta.push('subtotal')
  }
  tableRows.push({
    key: 'total',
    kind: 'total',
    cells: [
      'Total', '', `${facts.loadCount} load${facts.loadCount === 1 ? '' : 's'}`,
      fmtNum(spot.bushels, 3), facts.avgText, { content: facts.statusText, className: 'text-xs font-normal text-slate-500' },
      spot.summary.futures ? fmtUsd(spot.summary.futures.avgFutures, 2) : '', spot.summary.futures ? fmtBasis(spot.summary.futures.avgBasis) : '', '',
    ],
  })
  exportRows.push(['Total', '', `${facts.loadCount} loads`, spot.bushels, spot.avgPrice ?? '', facts.statusText, spot.summary.futures?.avgFutures ?? '', spot.summary.futures?.avgBasis ?? '', ''])
  exportMeta.push('total')

  const exportPayload: ExportPayload = {
    title,
    filters: filterSummary,
    summary: [
      { label: 'Bushels', value: `${fmtInt(spot.bushels)} bu` },
      { label: 'Average price', value: `${facts.avgText}${facts.estimated ? ' (est.)' : ''}` },
      { label: 'Revenue', value: fmtUsd(facts.value) },
      { label: 'Settled', value: `${spot.summary.settledCount} of ${facts.loadCount}` },
    ],
    sections: [{
      title: 'Spot loads',
      columns: [
        { label: 'Date' }, { label: 'Buyer' }, { label: 'Ticket' },
        { label: 'Bushels', align: 'right', format: 'bu' }, { label: '$/bu', align: 'right', format: 'price' }, { label: 'Price from' },
        { label: 'Futures', align: 'right', format: 'price' }, { label: 'Basis', align: 'right', format: 'dec2' }, { label: 'Settled' },
      ],
      rows: exportRows,
      rowMeta: exportMeta,
    }],
  }

  return (
    <div className="space-y-4">
      <Link href="/contracts" className="text-sm text-brand-deep">← Back to contracts</Link>
      <ReportHeader
        title={title}
        filterSummary={filterSummary}
        actions={<StaticExportBar payload={exportPayload} />}
      />
      <SummaryCards cards={[
        { label: 'Spot bushels', value: `${fmtInt(spot.bushels)} bu`, sub: `${facts.loadCount} load${facts.loadCount === 1 ? '' : 's'} · ${facts.buyersLabel || 'no buyer'}` },
        { label: 'Average price', value: facts.avgText, sub: facts.estimated ? 'est. — some loads are not settled yet' : 'bushel-weighted', tone: facts.estimated ? 'warning' : 'neutral' },
        { label: 'Revenue', value: fmtUsd(facts.value), sub: facts.unpaidBu > 0 ? `${fmtUsd(facts.paidRevenue)} settled · ${fmtUsd(facts.unpaidRevenue)} still to settle` : 'all settled', tone: 'favorable' },
        { label: 'Settled', value: `${spot.summary.settledCount} of ${facts.loadCount}`, sub: facts.statusText, tone: spot.summary.settledCount === facts.loadCount ? 'favorable' : 'warning' },
      ]} />
      <DataTable columns={columns} rows={tableRows} />
      <p className="text-xs text-slate-500">
        Every spot load of the crop year is priced together at the bushel-weighted average, and that average enters Marketing and the revenue reports like a fully priced contract.
        A price marked est. is our estimate (futures close plus the buyer&rsquo;s basis) until the settlement arrives; a split load shows only its spot bushels here.
      </p>
    </div>
  )
}
