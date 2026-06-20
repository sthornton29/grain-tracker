import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import ContractFlagIcon, { type ContractFlag } from '@/components/contract-flag'
import StaticExportBar from '@/components/static-export-bar'
import type { ExportPayload } from '@/lib/exports'
import { CONTRACT_TYPE_LABEL, effectiveContractType, type ContractType, type PricingStatus } from '@/lib/contracts'
import { parseContractMonth } from '@/lib/hedging'

export const dynamic = 'force-dynamic'

type ContractRow = {
  id: string
  contract_number: string
  contracted_bushels: number
  price_per_bushel: number | null
  notes: string | null
  crop_year: number | null
  delivery_type: 'pickup' | 'delivered'
  delivery_start_date: string | null
  delivery_end_date: string | null
  completed_at: string | null
  buyer_id: string | null
  crop_id: string | null
  entity_id: string | null
  contract_month: string | null
  contract_type: ContractType
  pricing_status: PricingStatus
  futures_price: number | null
  basis: number | null
  cash_price: number | null
  buyer: { name: string } | null
  crop: { name: string } | null
  delivery_location: { name: string } | null
}

type LoadRow = {
  id: string
  contract_id: string | null
  ticket_number: string | null
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
}

type CropRow = {
  id: string
  name: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}

type SettlementLineRow = {
  load_id: string | null
  ticket_number: string | null
  net_bushels: number
  net_revenue: number | null
}

type FieldRow = { id: string; farm_id: string | null }
type FarmRow = { id: string; entity_id: string | null }
type EntityRow = { id: string; name: string }

const fmt = (n: number, d = 2) =>
  n.toLocaleString(undefined, { maximumFractionDigits: d })

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

// ISO (YYYY-MM-DD) -> m/dd/YYYY for display (month has no leading zero).
function fmtDate(iso: string | null): string {
  if (!iso) return '?'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[2])}/${m[3]}/${m[1]}` : iso
}

// Days until a contract month's first notice day, approximated as the last
// calendar day of the month before the delivery month (CBOT grain convention).
// Negative = already passed. null when the month can't be parsed.
function daysUntilFirstNotice(contractMonth: string | null): number | null {
  const p = parseContractMonth(contractMonth)
  if (!p) return null
  const fnd = new Date(p.year4, p.monthNum - 1, 0)
  fnd.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((fnd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

// Page-scoped paginated fetch of every load with a contract_id. We can't trust
// .limit() to override the Supabase project-level db-max-rows cap, so we
// .range() through the table until a short page comes back.
async function fetchAllContractLoads(supabase: SupabaseClient): Promise<LoadRow[]> {
  const PAGE = 1000
  const out: LoadRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('loads')
      .select('id, contract_id, ticket_number, net_weight, moisture, crop_id, dry_bushels_override, from_type, from_field_id')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as LoadRow[]
    out.push(...batch)
    if (batch.length < PAGE) break
  }
  return out
}

function isFuture(start: string | null): boolean {
  if (!start) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today < new Date(start + 'T00:00:00')
}

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: {
    entity?: string
    crop_year?: string
    crop?: string
    sort?: string
    dir?: string
    hide_completed?: string
    hide_future?: string
    type?: string
    pricing?: string
  }
}) {
  const supabase = createClient()
  const entityId = searchParams.entity ?? ''
  const cropFilter = searchParams.crop ?? ''
  const typeFilter = searchParams.type ?? ''
  const pricingFilter = searchParams.pricing ?? ''
  const cropYear = searchParams.crop_year ? Number(searchParams.crop_year) : null
  const sortKey = searchParams.sort ?? ''
  const sortDir: 'asc' | 'desc' = searchParams.dir === 'desc' ? 'desc' : 'asc'
  const hideCompleted = searchParams.hide_completed === '1'
  const hideFuture = searchParams.hide_future === '1'

  const [contractsRes, loads, cropsRes, fieldsRes, farmsRes, entitiesRes, linesRes, plantingsRes] = await Promise.all([
    supabase
      .from('contracts')
      .select(`
        id, contract_number, contracted_bushels, price_per_bushel, notes,
        crop_year, delivery_type, delivery_start_date, delivery_end_date, completed_at,
        buyer_id, crop_id, entity_id,
        contract_month, contract_type, pricing_status, futures_price, basis, cash_price,
        buyer:buyers(name), crop:crops(name), delivery_location:delivery_locations(name)
      `)
      .order('contract_number'),
    fetchAllContractLoads(supabase),
    supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').order('name'),
    supabase.from('fields').select('id, farm_id'),
    supabase.from('farms').select('id, entity_id'),
    supabase.from('entities').select('id, name').order('name'),
    supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue'),
    supabase.from('field_plantings').select('season_year'),
  ])

  const allContracts = (contractsRes.data as unknown as ContractRow[]) ?? []
  const crops = (cropsRes.data ?? []) as CropRow[]
  const fields = (fieldsRes.data ?? []) as FieldRow[]
  const farms = (farmsRes.data ?? []) as FarmRow[]
  const entities = (entitiesRes.data ?? []) as EntityRow[]
  const lines = (linesRes.data ?? []) as SettlementLineRow[]

  const cropById = new Map(crops.map((c) => [c.id, c]))
  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const fieldEntity = new Map(fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null]))

  // Build maps:
  //   loadIdToLine:     load_id    -> line (paid lookup by load_id)
  //   ticketToLine:     ticket#    -> line (paid lookup by ticket, for loads whose line was added later)
  const loadIdToLine = new Map<string, SettlementLineRow>()
  const ticketToLine = new Map<string, SettlementLineRow>()
  for (const l of lines) {
    if (l.load_id) loadIdToLine.set(l.load_id, l)
    if (l.ticket_number) ticketToLine.set(l.ticket_number.trim().toLowerCase(), l)
  }

  function lineForLoad(load: LoadRow): SettlementLineRow | null {
    if (loadIdToLine.has(load.id)) return loadIdToLine.get(load.id)!
    const t = load.ticket_number?.trim().toLowerCase()
    if (t && ticketToLine.has(t)) return ticketToLine.get(t)!
    return null
  }

  const plantingYears = ((plantingsRes.data ?? []) as Array<{ season_year: number | null }>).map((p) => p.season_year)
  const cropYearOptions = cropYearOptionsFromPlantings(plantingYears, cropYear)

  function loadDryBu(l: LoadRow): number {
    const crop = l.crop_id ? cropById.get(l.crop_id) : null
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    return dryBushels ?? 0
  }

  type Agg = {
    delivered: number
    paidBushels: number
    revenue: number
    deliveredUnpaid: number
    entityIds: Set<string>
    loadCount: number
  }
  const aggByContract = new Map<string, Agg>()
  function ensure(id: string): Agg {
    let a = aggByContract.get(id)
    if (!a) { a = { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set(), loadCount: 0 }; aggByContract.set(id, a) }
    return a
  }
  // Tally loads attached to contract_ids that don't actually exist in the
  // contracts table — a sign the contract was deleted (FK on delete set null
  // would normally clear this) or that something else has gone sideways.
  const knownContractIds = new Set(allContracts.map((c) => c.id))
  let orphanLoadCount = 0
  for (const load of loads) {
    if (!load.contract_id) continue
    if (!knownContractIds.has(load.contract_id)) { orphanLoadCount++; continue }
    const agg = ensure(load.contract_id)
    agg.loadCount++
    const bu = loadDryBu(load)
    agg.delivered += bu
    const line = lineForLoad(load)
    if (line) {
      agg.paidBushels += Number(line.net_bushels ?? 0)
      agg.revenue += Number(line.net_revenue ?? 0)
    } else {
      agg.deliveredUnpaid += bu
    }
    if (load.from_type === 'field' && load.from_field_id) {
      const ent = fieldEntity.get(load.from_field_id) ?? null
      if (ent) agg.entityIds.add(ent)
    }
  }

  // contract_number has no unique constraint, so detect dupes and surface them
  // with an id suffix in the UI (otherwise two rows look identical and the user
  // can't tell which one their loads are attached to).
  const numberCounts = new Map<string, number>()
  for (const c of allContracts) numberCounts.set(c.contract_number, (numberCounts.get(c.contract_number) ?? 0) + 1)

  function flagFor(c: ContractRow): ContractFlag {
    const agg = aggByContract.get(c.id)
    const delivered = agg?.delivered ?? 0
    if (c.completed_at != null) return 'complete'
    if (delivered >= Number(c.contracted_bushels) && Number(c.contracted_bushels) > 0) return 'complete'
    if (isFuture(c.delivery_start_date)) return 'future'
    return 'open'
  }

  const visible = allContracts.filter((c) => {
    if (cropYear != null && c.crop_year !== cropYear) return false
    if (cropFilter && c.crop_id !== cropFilter) return false
    // Strict entity match: only contracts whose own entity_id matches show up.
    // Contracts with no entity_id are excluded under an entity filter so loads
    // delivered against a different entity's contract can't smuggle this one in.
    if (entityId && c.entity_id !== entityId) return false
    if (typeFilter && effectiveContractType(c) !== typeFilter) return false
    if (pricingFilter && c.pricing_status !== pricingFilter) return false
    const flag = flagFor(c)
    if (hideCompleted && flag === 'complete') return false
    if (hideFuture && flag === 'future') return false
    return true
  })

  if (sortKey === 'crop') {
    const m = sortDir === 'asc' ? 1 : -1
    visible.sort((a, b) => {
      const ac = a.crop?.name ?? ''
      const bc = b.crop?.name ?? ''
      const byCrop = m * ac.localeCompare(bc)
      return byCrop !== 0 ? byCrop : a.contract_number.localeCompare(b.contract_number)
    })
  }

  function baseParams(): URLSearchParams {
    const params = new URLSearchParams()
    if (entityId) params.set('entity', entityId)
    if (cropYear != null) params.set('crop_year', String(cropYear))
    if (cropFilter) params.set('crop', cropFilter)
    if (typeFilter) params.set('type', typeFilter)
    if (pricingFilter) params.set('pricing', pricingFilter)
    if (hideCompleted) params.set('hide_completed', '1')
    if (hideFuture) params.set('hide_future', '1')
    if (sortKey) params.set('sort', sortKey)
    if (sortKey) params.set('dir', sortDir)
    return params
  }

  function sortHref(col: string) {
    const params = baseParams()
    const nextDir = sortKey === col && sortDir === 'asc' ? 'desc' : 'asc'
    params.set('sort', col)
    params.set('dir', nextDir)
    return `?${params.toString()}`
  }

  function toggleHref(key: 'hide_completed' | 'hide_future', currentlyOn: boolean): string {
    const params = baseParams()
    if (currentlyOn) params.delete(key)
    else params.set(key, '1')
    return `?${params.toString()}`
  }

  // First-notice-day warning: HTAs awaiting basis / basis contracts awaiting
  // futures whose contract month's first notice day is within 30 days (or past).
  // Computed over all contracts so a filter can't hide a looming deadline — but
  // skip completed contracts (marked complete or fully delivered): there's nothing
  // left to price on a finished contract, so the deadline no longer applies.
  const fndWarnings = allContracts
    .filter((c) => c.pricing_status === 'awaiting_basis' || c.pricing_status === 'awaiting_futures')
    .filter((c) => flagFor(c) !== 'complete')
    .map((c) => ({ c, days: daysUntilFirstNotice(c.contract_month) }))
    .filter((x): x is { c: ContractRow; days: number } => x.days != null && x.days <= 30)
    .sort((a, b) => a.days - b.days)

  // Formatted PDF/Excel of the visible contracts (mirrors the table; payload is
  // plain data handed to the client StaticExportBar).
  const contractsExportPayload: ExportPayload = {
    title: 'Contract Tracker',
    filters: [
      entityId ? entities.find((e) => e.id === entityId)?.name ?? 'Entity' : 'All entities',
      cropFilter ? crops.find((c) => c.id === cropFilter)?.name ?? 'Crop' : 'All crops',
      cropYear ? `${cropYear} crop` : 'All crop years',
      typeFilter ? CONTRACT_TYPE_LABEL[typeFilter as ContractType] : null,
      pricingFilter ? pricingFilter.replace(/_/g, ' ') : null,
    ].filter(Boolean).join(' · '),
    sections: [{
      columns: [
        { label: 'Contract #' }, { label: 'Buyer' }, { label: 'Crop' }, { label: 'Type' }, { label: 'Year', format: 'text' },
        { label: 'Location' }, { label: 'Delivery window' },
        { label: 'Contracted', align: 'right', format: 'bu' }, { label: 'Delivered', align: 'right', format: 'bu' }, { label: 'Remaining', align: 'right', format: 'bu' },
        { label: '% Delivered', align: 'right', format: 'pct1' }, { label: '$/bu', align: 'right', format: 'price' },
        { label: 'Revenue', align: 'right', format: 'usd0' }, { label: 'Paid bu', align: 'right', format: 'bu' }, { label: 'Unpaid bu', align: 'right', format: 'bu' },
      ],
      rows: visible.map((c) => {
        const agg = aggByContract.get(c.id)
        const delivered = agg?.delivered ?? 0
        const contracted = Number(c.contracted_bushels)
        const remaining = Math.max(0, contracted - delivered)
        const pct = contracted > 0 ? Math.min(100, (delivered / contracted) * 100) : 0
        const price = c.price_per_bushel != null ? Number(c.price_per_bushel) : ''
        const revenue = c.price_per_bushel != null ? Number(c.price_per_bushel) * contracted : ''
        const location = c.delivery_type === 'delivered' ? `Del → ${c.delivery_location?.name ?? '—'}` : 'Pickup'
        const window = (c.delivery_start_date || c.delivery_end_date) ? `${fmtDate(c.delivery_start_date)} → ${fmtDate(c.delivery_end_date)}` : '—'
        return [
          c.contract_number, c.buyer?.name ?? '', c.crop?.name ?? '', CONTRACT_TYPE_LABEL[effectiveContractType(c)], c.crop_year ?? '',
          location, window, contracted, delivered, remaining, pct, price, revenue, agg?.paidBushels ?? 0, agg?.deliveredUnpaid ?? 0,
        ]
      }),
    }],
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Contract Tracker</h1>
      <div className="flex items-end gap-3 flex-wrap">
        <Link
          href="/settings/contracts"
          className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold"
        >
          New Contract
        </Link>
        {visible.length > 0 && <StaticExportBar payload={contractsExportPayload} />}
        <form className="flex items-center gap-2 flex-wrap">
          <select name="entity" defaultValue={entityId} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All entities</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <select name="crop" defaultValue={cropFilter} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All crops</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select name="crop_year" defaultValue={cropYear ?? ''} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
          <select name="type" defaultValue={typeFilter} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All types</option>
            <option value="forward">Forward</option>
            <option value="hta">HTA</option>
            <option value="basis">Basis</option>
          </select>
          <select name="pricing" defaultValue={pricingFilter} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All pricing</option>
            <option value="fully_priced">Fully priced</option>
            <option value="awaiting_basis">Awaiting basis</option>
            <option value="awaiting_futures">Awaiting futures</option>
          </select>
          <button className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm">Apply</button>
        </form>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Link
            href={toggleHref('hide_completed', hideCompleted)}
            scroll={false}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
              hideCompleted
                ? 'border-slate-300 bg-white text-slate-500'
                : 'border-slate-700 bg-slate-700 text-white'
            }`}
          >
            {hideCompleted ? 'Show completed' : 'Hide completed'}
          </Link>
          <Link
            href={toggleHref('hide_future', hideFuture)}
            scroll={false}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
              hideFuture
                ? 'border-slate-300 bg-white text-slate-500'
                : 'border-slate-700 bg-slate-700 text-white'
            }`}
          >
            {hideFuture ? 'Show not-yet-open' : 'Hide not-yet-open'}
          </Link>
        </div>
        <p className="text-sm text-slate-500 flex items-center gap-3 flex-wrap">
          <span className="flex items-center"><ContractFlagIcon variant="open" /> delivery period open</span>
          <span className="flex items-center"><ContractFlagIcon variant="complete" /> contract complete</span>
          <span className="flex items-center"><ContractFlagIcon variant="future" /> delivery period not open yet</span>
        </p>
      </div>

      {orphanLoadCount > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>{orphanLoadCount}</strong> load{orphanLoadCount === 1 ? '' : 's'} reference a contract that doesn&rsquo;t exist
          in the contracts table. Their bushels can&rsquo;t be totaled here.
        </div>
      )}

      {fndWarnings.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 space-y-1">
          <div className="font-semibold">
            {fndWarnings.length} contract{fndWarnings.length === 1 ? '' : 's'} approaching first notice day without pricing set:
          </div>
          <ul className="list-disc pl-5 space-y-0.5">
            {fndWarnings.map(({ c, days }) => (
              <li key={c.id}>
                <Link href={`/contracts/${c.id}`} className="underline font-semibold">#{c.contract_number}</Link>
                {' '}({CONTRACT_TYPE_LABEL[effectiveContractType(c)]} {c.contract_month}) — needs{' '}
                {c.pricing_status === 'awaiting_basis' ? 'basis' : 'futures'} set ·{' '}
                first notice {days < 0 ? `${-days}d ago` : days === 0 ? 'today' : `in ${days}d`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              <th className="text-left px-3 py-2 whitespace-nowrap">Contract #</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Buyer</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">
                <Link href={sortHref('crop')} className="hover:text-slate-900 select-none" scroll={false}>
                  Crop{sortKey === 'crop' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </Link>
              </th>
              {['Type', 'Year', 'Location', 'Delivery window', 'Contracted', 'Delivered', 'Progress', '$/bu', 'Revenue', 'Paid (bu)', 'Unpaid (bu)']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={14} className="px-3 py-6 text-center text-slate-400">No contracts.</td></tr>}
            {visible.map((c) => {
              const agg = aggByContract.get(c.id) ?? { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set<string>(), loadCount: 0 }
              const isDup = (numberCounts.get(c.contract_number) ?? 0) > 1
              const remaining = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
              const pct = Number(c.contracted_bushels) > 0 ? Math.min(100, (agg.delivered / Number(c.contracted_bushels)) * 100) : 0
              const contractPrice = c.price_per_bushel != null ? Number(c.price_per_bushel) : null
              const contractRevenue = contractPrice != null ? contractPrice * Number(c.contracted_bushels) : null

              const flag = flagFor(c)
              const endIn = daysUntil(c.delivery_end_date)
              // Don't flag a closing delivery window on a finished contract.
              const endWarning = flag !== 'complete' && endIn != null && endIn >= 0 && endIn <= 14

              return (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-semibold">
                    <ContractFlagIcon variant={flag} />
                    <Link href={`/contracts/${c.id}`} className="text-sky-700 hover:underline">
                      {c.contract_number}
                    </Link>
                    {isDup && (
                      <span className="ml-1 text-xs font-mono text-red-700" title="Duplicate contract number — id suffix shown to disambiguate">
                        ({c.id.slice(0, 6)})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{c.buyer?.name ?? ''}</td>
                  <td className="px-3 py-2">{c.crop?.name ?? ''}</td>
                  <td className="px-3 py-2">
                    <span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{CONTRACT_TYPE_LABEL[effectiveContractType(c)]}</span>
                  </td>
                  <td className="px-3 py-2">{c.crop_year ?? ''}</td>
                  <td className="px-3 py-2">
                    {c.delivery_type === 'delivered'
                      ? <>Del → {c.delivery_location?.name ?? '—'}</>
                      : 'Pickup'}
                  </td>
                  <td className={`px-3 py-2 text-xs whitespace-nowrap ${endWarning ? 'text-amber-700 font-semibold' : ''}`}>
                    {(c.delivery_start_date || c.delivery_end_date)
                      ? <>{fmtDate(c.delivery_start_date)} → {fmtDate(c.delivery_end_date)}{endWarning ? ` (${endIn}d)` : ''}</>
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{fmt(Number(c.contracted_bushels))}</td>
                  <td className="px-3 py-2 text-right">
                    {fmt(agg.delivered)}
                    <span className="ml-1 text-xs text-slate-400">({agg.loadCount} load{agg.loadCount === 1 ? '' : 's'})</span>
                  </td>
                  <td className="px-3 py-2 w-40">
                    <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-2 bg-green-600" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{pct.toFixed(1)}% · {fmt(remaining)} bu left</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                    {c.pricing_status === 'fully_priced'
                      ? (c.cash_price != null ? `$${Number(c.cash_price).toFixed(2)}` : '')
                      : c.pricing_status === 'awaiting_basis'
                      ? <span>F ${Number(c.futures_price ?? 0).toFixed(2)} <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">basis?</span></span>
                      : <span>B {Number(c.basis ?? 0).toFixed(2)} <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">futures?</span></span>}
                  </td>
                  <td className="px-3 py-2 text-right">{contractRevenue != null ? `$${fmt(contractRevenue)}` : ''}</td>
                  <td className="px-3 py-2 text-right">{fmt(agg.paidBushels)}</td>
                  <td className={`px-3 py-2 text-right ${agg.deliveredUnpaid > 0 ? 'text-amber-700 font-semibold' : ''}`}>{fmt(agg.deliveredUnpaid)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
