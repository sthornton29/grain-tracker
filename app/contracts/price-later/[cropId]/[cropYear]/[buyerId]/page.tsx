import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { coerceAppRole } from '@/lib/app-role'
import { fetchSalesForContracts, priceLaterRowFacts } from '@/lib/contracts-sales-fetch'
import { priceLaterPoolId } from '@/lib/virtual-contracts'
import { describeSale } from '@/lib/load-sales'
import { fmtDate } from '@/lib/format-date'
import StaticExportBar from '@/components/static-export-bar'
import { DataTable, EmptyState, ReportHeader, SummaryCards, type DataRow } from '@/components/reports/report-kit'
// Pure helpers come from the plain module — this is a SERVER component.
import { fmtInt, fmtNum, fmtUsd } from '@/components/reports/report-format'
import type { ExportPayload } from '@/lib/exports'
import PriceBushels from './price-bushels'

export const dynamic = 'force-dynamic'

// A PRICE-LATER pool (094): bushels delivered to one buyer for a crop year
// and left unpriced (delayed price / stored at the elevator). Valued at
// today's assumed price from Marketing until the farmer prices them, which
// "Price bushels" does by creating a contract and moving the oldest bushels
// onto it.

export default async function PriceLaterPoolPage({
  params,
}: {
  params: { cropId: string; cropYear: string; buyerId: string }
}) {
  const cropYear = Number(params.cropYear)
  if (!/^\d{4}$/.test(params.cropYear) || !Number.isFinite(cropYear)) notFound()

  const supabase = createClient()
  const [salesData, { data: { user } }, assumptionQ] = await Promise.all([
    fetchSalesForContracts(supabase, { cropYear }),
    supabase.auth.getUser(),
    supabase.from('crop_assumptions').select('assumed_futures, assumed_basis').eq('crop_id', params.cropId).eq('crop_year', cropYear).maybeSingle(),
  ])
  const { data: profile } = user
    ? await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
    : { data: null }
  const role = coerceAppRole((profile as { role?: string } | null)?.role)

  const crop = salesData.crops.find((c) => c.id === params.cropId)
  const buyer = salesData.buyers.find((b) => b.id === params.buyerId)
  if (!crop || !buyer) notFound()

  const pool = salesData.pools.find((p) => p.id === priceLaterPoolId(crop.id, cropYear, buyer.id))
  const assumption = (assumptionQ.data ?? null) as { assumed_futures: number | null; assumed_basis: number | null } | null
  const title = `Price later · ${crop.name} ${cropYear} · ${buyer.name}`
  const filterSummary = [`${cropYear} crop`, crop.name, buyer.name].join(' · ')

  if (!pool || pool.rows.length === 0) {
    return (
      <div className="space-y-4">
        <Link href="/contracts" className="text-sm text-brand-deep">← Back to contracts</Link>
        <ReportHeader title={title} filterSummary={filterSummary} />
        <EmptyState
          message={`No unpriced bushels at ${buyer.name} for ${crop.name} ${cropYear}.`}
          hint="Loads delivered as price later show here until you price them."
          linkHref="/contracts"
          linkLabel="Back to contracts"
          role={role}
        />
      </div>
    )
  }

  const facts = priceLaterRowFacts(pool, crop.name, buyer.name, assumption)

  // Contract numbers behind any split notes.
  const poolLoadIds = new Set(pool.rows.map((r) => r.load.id))
  const contractIds = [...new Set(salesData.sales.filter((s) => poolLoadIds.has(s.load_id) && s.contract_id).map((s) => s.contract_id as string))]
  const contractsQ = contractIds.length > 0
    ? await supabase.from('contracts').select('id, contract_number').in('id', contractIds)
    : { data: [] as Array<{ id: string; contract_number: string }> }
  const contractNumberById = new Map(((contractsQ.data ?? []) as Array<{ id: string; contract_number: string }>).map((c) => [c.id, c.contract_number]))

  const lines = pool.rows.map((r) => {
    const allocs = salesData.allocations.get(r.load.id) ?? []
    return { row: r, splitNote: allocs.length > 1 ? describeSale(allocs, (id) => contractNumberById.get(id)) : null }
  })

  const tableRows: DataRow[] = [
    ...lines.map(({ row, splitNote }) => ({
      key: row.load.id,
      cells: [
        <Link key="d" href={`/loads/${row.load.id}`} className="text-brand-deep hover:underline whitespace-nowrap">{fmtDate(row.load.date)}</Link>,
        <span key="t">
          {row.load.ticket_number ?? ''}
          {splitNote && <span className="block text-xs text-slate-500">{splitNote}</span>}
        </span>,
        fmtNum(row.alloc.bushels, 3),
      ],
    })),
    {
      key: 'total',
      kind: 'total' as const,
      cells: ['Total', `${facts.loadCount} load${facts.loadCount === 1 ? '' : 's'}`, fmtNum(pool.bushels, 3)],
    },
  ]

  const valueText = facts.value != null ? fmtUsd(facts.value) : '—'
  const exportPayload: ExportPayload = {
    title,
    filters: filterSummary,
    summary: [
      { label: 'Unpriced bushels', value: `${fmtInt(pool.bushels)} bu` },
      { label: 'Loads', value: String(facts.loadCount) },
      { label: 'Oldest delivery', value: facts.oldestDate ? fmtDate(facts.oldestDate) : '—' },
      { label: "Value at today's assumed price", value: `${valueText} (unpriced)` },
    ],
    sections: [{
      title: 'Price-later loads',
      columns: [{ label: 'Date' }, { label: 'Ticket' }, { label: 'Bushels unpriced', align: 'right', format: 'bu' }],
      rows: [
        ...lines.map(({ row, splitNote }) => [fmtDate(row.load.date), `${row.load.ticket_number ?? ''}${splitNote ? ` (${splitNote})` : ''}`, row.alloc.bushels]),
        ['Total', `${facts.loadCount} loads`, pool.bushels],
      ],
      rowMeta: [...lines.map(() => 'data' as const), 'total'],
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
        { label: 'Unpriced bushels', value: `${fmtInt(pool.bushels)} bu`, tone: 'warning' },
        { label: 'Loads', value: String(facts.loadCount), sub: pool.newestDate && pool.newestDate !== pool.oldestDate ? `through ${fmtDate(pool.newestDate)}` : undefined },
        { label: 'Oldest delivery', value: facts.oldestDate ? fmtDate(facts.oldestDate) : '—', sub: 'priced first' },
        {
          label: "Value at today's assumed price",
          value: valueText,
          sub: facts.assumedPrice != null
            ? `unpriced · ${fmtUsd(facts.assumedPrice, 2)}/bu from Marketing assumptions`
            : 'unpriced · enter an assumed futures price on the Marketing page to value these',
          tone: 'muted',
        },
      ]} />
      {role === 'owner' && (
        <PriceBushels cropId={crop.id} cropYear={cropYear} buyerId={buyer.id} poolBushels={pool.bushels} />
      )}
      <DataTable
        columns={[{ label: 'Date' }, { label: 'Ticket' }, { label: 'Bushels unpriced', align: 'right' }]}
        rows={tableRows}
      />
      <p className="text-xs text-slate-500">
        These bushels are delivered but not sold at a price yet. Marketing values them like any unpriced bushel (assumed futures plus assumed basis).
        Pricing them creates a contract at the price you lock in and moves the oldest bushels onto it first; a load that does not fit whole is split.
      </p>
    </div>
  )
}
