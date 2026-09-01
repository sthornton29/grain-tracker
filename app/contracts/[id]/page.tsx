import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { truckDisplay, truckExportLabel } from '@/lib/trucks'
import { CONTRACT_TYPE_LABEL, PRICING_STATUS_LABEL, effectiveContractType, type ContractType, type PricingStatus } from '@/lib/contracts'
import ContractActions from './contract-actions'
import ContractAttachments from '@/components/contract-attachments'
import SeedContractDetail from '@/components/seed-contract-detail'
import type { SeedContractDetails, SeedContractPayment, SeedContractPremium, SeedPricingElection } from '@/lib/seed-contracts'
import StaticExportBar from '@/components/static-export-bar'
import { formatNumber, type ExportPayload } from '@/lib/exports'

export const dynamic = 'force-dynamic'

type ContractDetail = {
  id: string
  contract_number: string
  contracted_bushels: number
  price_per_bushel: number | null
  notes: string | null
  crop_year: number | null
  contract_month: string | null
  contract_type: ContractType
  pricing_status: PricingStatus
  futures_price: number | null
  basis: number | null
  cash_price: number | null
  service_fee: number
  delivery_type: 'pickup' | 'delivered'
  delivery_start_date: string | null
  delivery_end_date: string | null
  date_sold: string | null
  completed_at: string | null
  created_at: string
  contract_kind: 'grain' | 'seed_production' | null
  buyer_id: string | null
  crop_id: string | null
  entity_id: string | null
  delivery_location_id: string | null
  buyer: { name: string } | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  entity: { name: string } | null
  delivery_location: { name: string; address: string | null } | null
}

type LoadRow = {
  id: string
  date: string
  ticket_number: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  crop_id: string | null
  from_type: string | null
  truck: { name_or_number: string } | null
  hauler_truck: string | null
  truck_label: string | null
  from_field: { name_or_number: string } | null
  from_bin: { name_or_number: string } | null
}

type SettlementLineRow = {
  load_id: string | null
  ticket_number: string | null
  net_bushels: number
  net_revenue: number | null
}

const fmt = (n: number, d = 2) =>
  n.toLocaleString(undefined, { maximumFractionDigits: d })

async function fetchAllLoadsForContract(
  supabase: SupabaseClient,
  contractId: string,
): Promise<LoadRow[]> {
  const PAGE = 1000
  const out: LoadRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('loads')
      .select(`
        id, date, ticket_number, net_weight, moisture, dry_bushels_override, crop_id, from_type, hauler_truck, truck_label,
        truck:trucks(name_or_number),
        from_field:fields!loads_from_field_id_fkey(name_or_number),
        from_bin:bins!loads_from_bin_id_fkey(name_or_number)
      `)
      .eq('contract_id', contractId)
      .order('date', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as unknown as LoadRow[]
    out.push(...batch)
    if (batch.length < PAGE) break
  }
  return out
}

export default async function ContractDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()

  const { data: contractData, error: contractErr } = await supabase
    .from('contracts')
    .select(`
      id, contract_number, contracted_bushels, price_per_bushel, notes,
      crop_year, contract_month, contract_type, contract_kind, pricing_status, futures_price, basis, cash_price, service_fee,
      delivery_type, delivery_start_date, delivery_end_date, date_sold, completed_at, created_at,
      buyer_id, crop_id, entity_id, delivery_location_id,
      buyer:buyers(name),
      crop:crops(name, base_moisture_pct, base_lb_per_bushel),
      entity:entities(name),
      delivery_location:delivery_locations(name, address)
    `)
    .eq('id', params.id)
    .single()

  if (contractErr || !contractData) notFound()
  const contract = contractData as unknown as ContractDetail

  const loads = await fetchAllLoadsForContract(supabase, contract.id)

  // Pull settlement lines that reference any of these loads (by id OR ticket #).
  const loadIds = loads.map((l) => l.id)
  const ticketNumbers = loads.map((l) => l.ticket_number).filter(Boolean) as string[]
  let lines: SettlementLineRow[] = []
  if (loadIds.length || ticketNumbers.length) {
    const filters: string[] = []
    if (loadIds.length) filters.push(`load_id.in.(${loadIds.join(',')})`)
    if (ticketNumbers.length) {
      const escaped = ticketNumbers.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(',')
      filters.push(`ticket_number.in.(${escaped})`)
    }
    const { data, error } = await fetchAllRows((f, t) => supabase
      .from('settlement_lines')
      .select('load_id, ticket_number, net_bushels, net_revenue')
      .or(filters.join(','))
      .order('id')
      .range(f, t))
    if (error) throw error
    lines = (data ?? []) as SettlementLineRow[]
  }

  const lineByLoadId = new Map<string, SettlementLineRow>()
  const lineByTicket = new Map<string, SettlementLineRow>()
  for (const l of lines) {
    if (l.load_id) lineByLoadId.set(l.load_id, l)
    if (l.ticket_number) lineByTicket.set(l.ticket_number.trim().toLowerCase(), l)
  }

  function dryBu(load: LoadRow): number {
    const { dryBushels } = computeBushels({
      netWeightLb: load.net_weight,
      moisturePct: load.moisture,
      baseMoisturePct: contract.crop?.base_moisture_pct ?? null,
      baseLbPerBushel: contract.crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: load.dry_bushels_override,
    })
    return dryBushels ?? 0
  }
  function lineFor(load: LoadRow): SettlementLineRow | null {
    if (lineByLoadId.has(load.id)) return lineByLoadId.get(load.id)!
    const t = load.ticket_number?.trim().toLowerCase()
    if (t && lineByTicket.has(t)) return lineByTicket.get(t)!
    return null
  }

  let delivered = 0
  let paidBu = 0
  let paidRev = 0
  for (const load of loads) {
    const bu = dryBu(load)
    delivered += bu
    const ln = lineFor(load)
    if (ln) {
      paidBu += Number(ln.net_bushels ?? 0)
      paidRev += Number(ln.net_revenue ?? 0)
    }
  }
  const remaining = Math.max(0, Number(contract.contracted_bushels) - delivered)
  const pct = Number(contract.contracted_bushels) > 0
    ? Math.min(100, (delivered / Number(contract.contracted_bushels)) * 100)
    : 0
  const contractPrice = contract.price_per_bushel != null ? Number(contract.price_per_bushel) : null
  const contractRevenue = contractPrice != null
    ? contractPrice * Number(contract.contracted_bushels)
    : null
  const autoComplete = Number(contract.contracted_bushels) > 0
    && delivered >= Number(contract.contracted_bushels)
  const isComplete = contract.completed_at != null || autoComplete

  // Seed production contract (077): its own detail page — elections + payments
  // ledgers, expected-outcome selector, linked fields, effective price walk.
  if (contract.contract_kind === 'seed_production') {
    const [detailsQ, premiumsQ, electionsQ, paymentsQ, junctionQ, assumptionQ] = await Promise.all([
      supabase.from('seed_contract_details').select('*').eq('contract_id', contract.id).maybeSingle(),
      supabase.from('seed_contract_premiums').select('*').eq('contract_id', contract.id).order('sort_order'),
      supabase.from('seed_pricing_elections').select('*').eq('contract_id', contract.id).order('election_date'),
      supabase.from('seed_contract_payments').select('*').eq('contract_id', contract.id).order('payment_date'),
      supabase.from('seed_contract_plantings').select('planting_id').eq('contract_id', contract.id),
      contract.crop_id != null && contract.crop_year != null
        ? supabase.from('crop_assumptions').select('assumed_basis, assumed_futures, expected_yield, expected_yield_irr, expected_yield_dry, harvest_complete').eq('crop_id', contract.crop_id).eq('crop_year', contract.crop_year).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    const plantingIds = ((junctionQ.data ?? []) as Array<{ planting_id: string }>).map((j) => j.planting_id)
    let linkedPlantings: Array<{
      id: string; planted_acres: number; irrigated_acres: number; dryland_acres: number
      field: { name_or_number: string; farm: { name: string } | null } | null
    }> = []
    if (plantingIds.length > 0) {
      const { data } = await supabase
        .from('field_plantings')
        .select('id, planted_acres, irrigated_acres, dryland_acres, field:fields(name_or_number, farm:farms(name))')
        .in('id', plantingIds)
      linkedPlantings = (data ?? []) as unknown as typeof linkedPlantings
    }
    const a = (assumptionQ.data ?? null) as { assumed_basis: number | null; assumed_futures: number | null } | null
    return (
      <SeedContractDetail
        contract={{
          id: contract.id,
          contract_number: contract.contract_number,
          buyerName: contract.buyer?.name ?? null,
          cropName: contract.crop?.name ?? null,
          entityName: contract.entity?.name ?? null,
          crop_year: contract.crop_year,
          completed_at: contract.completed_at,
          notes: contract.notes,
        }}
        details={(detailsQ.data ?? null) as SeedContractDetails | null}
        premiums={((premiumsQ.data ?? []) as SeedContractPremium[])}
        elections={((electionsQ.data ?? []) as SeedPricingElection[])}
        payments={((paymentsQ.data ?? []) as SeedContractPayment[])}
        linkedPlantings={linkedPlantings.map((p) => ({
          id: p.id,
          fieldName: p.field?.name_or_number ?? '—',
          farmName: p.field?.farm?.name ?? null,
          plantedAcres: Number(p.planted_acres ?? 0),
          irrigatedAcres: Number(p.irrigated_acres ?? 0),
        }))}
        referencePlusBasis={
          a?.assumed_futures != null ? Number(a.assumed_futures) + Number(a.assumed_basis ?? 0) : null
        }
        deliveredBu={delivered}
        loadCount={loads.length}
      />
    )
  }

  const detailRows: Array<[string, React.ReactNode]> = [
    ['Buyer', contract.buyer?.name ?? '—'],
    ['Crop', contract.crop?.name ?? '—'],
    ['Crop year', contract.crop_year ?? '—'],
    ['Contract month', contract.contract_month ?? '—'],
    ['Contract type', CONTRACT_TYPE_LABEL[effectiveContractType(contract)]],
    ['Pricing status', PRICING_STATUS_LABEL[contract.pricing_status]],
    ['Entity', contract.entity?.name ?? '—'],
    ['Contracted bushels', fmt(Number(contract.contracted_bushels))],
    ['Futures price', contract.futures_price != null ? `$${Number(contract.futures_price).toFixed(4)}` : '—'],
    ['Basis', contract.basis != null ? Number(contract.basis).toFixed(4) : '—'],
    ['Service fee', contract.service_fee ? `$${Number(contract.service_fee).toFixed(4)}` : '—'],
    ['Cash price', contract.cash_price != null ? `$${Number(contract.cash_price).toFixed(4)}` : (contract.pricing_status === 'awaiting_basis' ? 'Pending — awaiting basis' : contract.pricing_status === 'awaiting_futures' ? 'Pending — awaiting futures' : '—')],
    ['Total revenue (at cash price)', contractRevenue != null ? `$${fmt(contractRevenue)}` : '—'],
    ['Delivery type', contract.delivery_type === 'delivered' ? 'Delivered' : 'Pickup'],
    [
      'Delivery location',
      contract.delivery_type === 'delivered'
        ? <>
            {contract.delivery_location?.name ?? '—'}
            {contract.delivery_location?.address && (
              <div className="text-xs text-slate-500">{contract.delivery_location.address}</div>
            )}
          </>
        : '—',
    ],
    [
      'Delivery window',
      (contract.delivery_start_date || contract.delivery_end_date)
        ? `${contract.delivery_start_date ?? '?'} → ${contract.delivery_end_date ?? '?'}`
        : '—',
    ],
    ['Date sold', contract.date_sold ?? '—'],
    ['Notes', contract.notes ?? '—'],
  ]

  // Formatted PDF/Excel of the contract document (plain data → StaticExportBar).
  const contractExportPayload: ExportPayload = {
    title: `Contract #${contract.contract_number}`,
    filters: [contract.buyer?.name, contract.crop?.name, contract.crop_year != null ? `${contract.crop_year} crop` : null].filter(Boolean).join(' · '),
    summary: [
      { label: 'Contracted', value: `${formatNumber(Number(contract.contracted_bushels), 'bu')} bu` },
      { label: 'Delivered', value: `${formatNumber(delivered, 'bu')} bu` },
      { label: 'Remaining', value: `${formatNumber(remaining, 'bu')} bu` },
      { label: 'Total revenue', value: contractRevenue != null ? formatNumber(contractRevenue, 'usd0') : '—' },
    ],
    sections: [
      {
        title: 'Contract',
        columns: [{ label: 'Field' }, { label: 'Value', align: 'right' }],
        rows: [
          ['Contract #', contract.contract_number ?? ''],
          ['Buyer', contract.buyer?.name ?? '—'],
          ['Crop', contract.crop?.name ?? '—'],
          ['Crop year', contract.crop_year != null ? String(contract.crop_year) : '—'],
          ['Contract month', contract.contract_month ?? '—'],
          ['Type', CONTRACT_TYPE_LABEL[effectiveContractType(contract)]],
          ['Pricing status', PRICING_STATUS_LABEL[contract.pricing_status]],
          ['Entity', contract.entity?.name ?? '—'],
          ['Contracted bushels', formatNumber(Number(contract.contracted_bushels), 'bu')],
          ['Futures price', contract.futures_price != null ? formatNumber(Number(contract.futures_price), 'price') : '—'],
          ['Basis', contract.basis != null ? Number(contract.basis).toFixed(4) : '—'],
          ['Cash price', contract.cash_price != null ? formatNumber(Number(contract.cash_price), 'price') : '—'],
          ['Total revenue', contractRevenue != null ? formatNumber(contractRevenue, 'usd0') : '—'],
          ['Delivery', contract.delivery_type === 'delivered' ? `Delivered → ${contract.delivery_location?.name ?? '—'}` : 'Pickup'],
        ],
      },
      {
        title: 'Loads delivered',
        columns: [
          { label: 'Date' }, { label: 'Ticket' }, { label: 'Truck' }, { label: 'From' },
          { label: 'Net wt (lb)', align: 'right', format: 'int' }, { label: 'Moisture %', align: 'right', format: 'dec1' },
          { label: 'Dry bu', align: 'right', format: 'bu' }, { label: 'Paid bu', align: 'right', format: 'bu' }, { label: 'Revenue', align: 'right', format: 'usd0' },
        ],
        rows: [
          ...loads.map((l) => {
            const ln = lineFor(l)
            const fromName = l.from_type === 'bin' ? l.from_bin?.name_or_number : l.from_field?.name_or_number
            return [
              l.date, l.ticket_number ?? '', truckExportLabel(l), fromName ?? '',
              l.net_weight ?? '', l.moisture ?? '', dryBu(l), ln ? Number(ln.net_bushels) : '', ln?.net_revenue != null ? Number(ln.net_revenue) : '',
            ]
          }),
          ['Totals', '', '', '', '', '', delivered, paidBu, paidRev],
        ],
        rowMeta: [...loads.map(() => 'data' as const), 'total'],
      },
    ],
  }

  return (
    <div className="space-y-4 print:space-y-2">
      <div className="flex items-center gap-3 flex-wrap print:hidden">
        <Link href="/contracts" className="text-sm text-brand-deep">← Back to contracts</Link>
        <div className="flex-1" />
        <StaticExportBar payload={contractExportPayload} />
        <ContractActions
          contractId={contract.id}
          contractNumber={contract.contract_number}
          isManuallyComplete={contract.completed_at != null}
          isAutoComplete={autoComplete}
        />
      </div>

      <div className="bg-white rounded-xl shadow p-6 print:shadow-none print:rounded-none print:p-0 space-y-6">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Contract</div>
            <h1 className="text-3xl font-bold">#{contract.contract_number}</h1>
            <div className="text-sm text-slate-600 mt-1">
              {contract.buyer?.name ?? ''}
              {contract.crop?.name ? ` · ${contract.crop.name}` : ''}
              {contract.crop_year != null ? ` · ${contract.crop_year} crop` : ''}
            </div>
          </div>
          <div className="text-right text-xs text-slate-500 space-y-1">
            <div>Created {contract.created_at?.slice(0, 10)}</div>
            {isComplete && (
              <div className="inline-flex items-center gap-1 rounded-full bg-slate-900 text-white px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">
                Complete{contract.completed_at ? ` · ${contract.completed_at.slice(0, 10)}` : ' · auto'}
              </div>
            )}
          </div>
        </header>

        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Contract details</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {detailRows.map(([label, val]) => (
              <div key={label} className="flex justify-between gap-4 border-b border-slate-100 py-1.5">
                <dt className="text-sm text-slate-500">{label}</dt>
                <dd className="text-sm font-medium text-right">{val}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Progress</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-slate-500">Delivered</div>
              <div className="text-lg font-semibold">{fmt(delivered)} bu</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Remaining</div>
              <div className="text-lg font-semibold">{fmt(remaining)} bu</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Paid (bu)</div>
              <div className="text-lg font-semibold">{fmt(paidBu)} bu</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Paid revenue</div>
              <div className="text-lg font-semibold">${fmt(paidRev)}</div>
            </div>
          </div>
          <div className="mt-3 h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-2 bg-green-600" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-slate-500 mt-1">{pct.toFixed(1)}% delivered</div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-2">
            Loads ({loads.length})
          </h2>
          {loads.length === 0 ? (
            <p className="text-sm text-slate-400">No loads delivered against this contract yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Date</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Ticket</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Truck</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">From</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Net wt (lb)</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Moisture</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Paid bu</th>
                    <th className="text-right px-3 py-2 whitespace-nowrap">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {loads.map((l) => {
                    const bu = dryBu(l)
                    const ln = lineFor(l)
                    const fromName = l.from_type === 'bin'
                      ? l.from_bin?.name_or_number
                      : l.from_field?.name_or_number
                    return (
                      <tr key={l.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 whitespace-nowrap">{l.date}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{l.ticket_number ?? ''}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {truckDisplay(l).name}
                          {truckDisplay(l).hauler && <span className="ml-1.5 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">hauler</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{fromName ?? ''}</td>
                        <td className="px-3 py-2 text-right">{l.net_weight != null ? fmt(Number(l.net_weight), 0) : ''}</td>
                        <td className="px-3 py-2 text-right">{l.moisture != null ? Number(l.moisture).toFixed(2) : ''}</td>
                        <td className="px-3 py-2 text-right">{fmt(bu)}</td>
                        <td className="px-3 py-2 text-right">{ln ? fmt(Number(ln.net_bushels)) : ''}</td>
                        <td className="px-3 py-2 text-right">{ln?.net_revenue != null ? `$${fmt(Number(ln.net_revenue))}` : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold">
                    <td className="px-3 py-2" colSpan={6}>Totals</td>
                    <td className="px-3 py-2 text-right">{fmt(delivered)}</td>
                    <td className="px-3 py-2 text-right">{fmt(paidBu)}</td>
                    <td className="px-3 py-2 text-right">${fmt(paidRev)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>

      <ContractAttachments contractId={contract.id} />
    </div>
  )
}
