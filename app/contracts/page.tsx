import Link from 'next/link'
import { Suspense } from 'react'
import ContractFilterPersistence from '@/components/contract-filter-persistence'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import ContractFlagIcon, { type ContractFlag } from '@/components/contract-flag'
import StaticExportBar from '@/components/static-export-bar'
import type { ExportPayload } from '@/lib/exports'
import { CONTRACT_TYPE_LABEL, effectiveContractType, type ContractType, type PricingStatus } from '@/lib/contracts'
import { parseContractMonth } from '@/lib/hedging'
import { blendedElectedPrice, cumulativePricedPct, effectivePriceWalk, missingPremiumRows } from '@/lib/seed-contracts'
import type { SeedContractDetails, SeedContractPayment, SeedContractPremium, SeedPricingElection } from '@/lib/seed-contracts'

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
  date_sold: string | null
  completed_at: string | null
  buyer_id: string | null
  crop_id: string | null
  entity_id: string | null
  contract_month: string | null
  contract_type: ContractType
  contract_kind: 'grain' | 'seed_production' | null
  pricing_status: PricingStatus
  futures_price: number | null
  basis: number | null
  cash_price: number | null
  buyer: { name: string } | null
  crop: { name: string } | null
  delivery_location: { name: string } | null
}

function isSeedKind(c: Pick<ContractRow, 'contract_kind'>): boolean {
  return c.contract_kind === 'seed_production'
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
  const anyFilters = Boolean(entityId || cropFilter || typeFilter || pricingFilter || cropYear != null || hideCompleted || hideFuture)

  const [contractsRes, loads, cropsRes, fieldsRes, farmsRes, entitiesRes, linesRes, plantingsRes] = await Promise.all([
    supabase
      .from('contracts')
      .select(`
        id, contract_number, contracted_bushels, price_per_bushel, notes,
        crop_year, delivery_type, delivery_start_date, delivery_end_date, date_sold, completed_at,
        buyer_id, crop_id, entity_id,
        contract_month, contract_type, contract_kind, pricing_status, futures_price, basis, cash_price,
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

  // Seed production contracts (077): pricing elections + staged payments drive
  // their progress semantics (% priced, complete on the received final
  // payment) instead of delivered-vs-contracted.
  const seedIds = allContracts.filter(isSeedKind).map((c) => c.id)
  const seedDetailsBy = new Map<string, SeedContractDetails>()
  const seedElectionsBy = new Map<string, SeedPricingElection[]>()
  const seedPremiumsBy = new Map<string, SeedContractPremium[]>()
  const seedPaymentsBy = new Map<string, SeedContractPayment[]>()
  if (seedIds.length > 0) {
    const [dQ, eQ, prQ, pQ] = await Promise.all([
      supabase.from('seed_contract_details').select('*').in('contract_id', seedIds),
      supabase.from('seed_pricing_elections').select('*').in('contract_id', seedIds).order('election_date'),
      supabase.from('seed_contract_premiums').select('*').in('contract_id', seedIds).order('sort_order'),
      supabase.from('seed_contract_payments').select('*').in('contract_id', seedIds),
    ])
    for (const d of ((dQ.data ?? []) as SeedContractDetails[])) seedDetailsBy.set(d.contract_id, d)
    for (const e of ((eQ.data ?? []) as SeedPricingElection[])) {
      const arr = seedElectionsBy.get(e.contract_id) ?? []
      arr.push(e); seedElectionsBy.set(e.contract_id, arr)
    }
    for (const p of ((prQ.data ?? []) as SeedContractPremium[])) {
      const arr = seedPremiumsBy.get(p.contract_id!) ?? []
      arr.push(p); seedPremiumsBy.set(p.contract_id!, arr)
    }
    for (const p of ((pQ.data ?? []) as SeedContractPayment[])) {
      const arr = seedPaymentsBy.get(p.contract_id) ?? []
      arr.push(p); seedPaymentsBy.set(p.contract_id, arr)
    }
  }

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
    if (c.completed_at != null) return 'complete'
    if (isSeedKind(c)) {
      // A seed contract is done when the final base payment has been received
      // (delivered bushels don't close it — settlement does).
      const pays = seedPaymentsBy.get(c.id) ?? []
      if (pays.some((p) => p.payment_type === 'base_final' && p.status === 'received')) return 'complete'
      if (isFuture(c.delivery_start_date)) return 'future'
      return 'open'
    }
    const agg = aggByContract.get(c.id)
    const delivered = agg?.delivered ?? 0
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
    if (typeFilter && (isSeedKind(c) ? typeFilter !== 'seed' : effectiveContractType(c) !== typeFilter)) return false
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

  // Seed-row display facts: committed bushels (contract estimate), % priced
  // from the elections ledger, the blended elected price, and — when fully
  // priced — the expected settlement revenue (elected + premiums − usage fee;
  // premiums valued conservatively without the irrigated share, which needs
  // the linked plantings the Marketing dashboard has).
  function seedRowInfo(c: ContractRow): {
    committedBu: number
    pricedPct: number
    electedPrice: number | null
    expectedRevenue: number | null
    /** The selected expected outcome has no premium rows: the projection is
     *  base-only — a data gap the row flags, never a silent $0 premium. */
    missingPremiums: boolean
  } {
    const details = seedDetailsBy.get(c.id) ?? null
    const elections = seedElectionsBy.get(c.id) ?? []
    const premiums = seedPremiumsBy.get(c.id) ?? []
    const committedBu = details != null ? Number(details.estimated_bushels) : Number(c.contracted_bushels)
    const pricedPct = Math.min(100, cumulativePricedPct(elections))
    const electedPrice = blendedElectedPrice(elections)
    let expectedRevenue: number | null = null
    if (details) {
      const walk = effectivePriceWalk({ details, premiums, elections, referencePlusBasis: null, irrigatedShare: 0 })
      if (walk.expectedNetPerBu != null) expectedRevenue = walk.expectedNetPerBu * committedBu
    }
    const missingPremiums = details != null && missingPremiumRows(premiums, details.expected_outcome)
    return { committedBu, pricedPct, electedPrice, expectedRevenue, missingPremiums }
  }

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
        { label: 'Sold' }, { label: 'Location' }, { label: 'Delivery window' },
        { label: 'Contracted', align: 'right', format: 'bu' }, { label: 'Delivered', align: 'right', format: 'bu' }, { label: 'Remaining', align: 'right', format: 'bu' },
        { label: 'Progress %', align: 'right', format: 'pct1' }, { label: '$/bu', align: 'right', format: 'price' },
        { label: 'Revenue', align: 'right', format: 'usd0' }, { label: 'Paid bu', align: 'right', format: 'bu' }, { label: 'Unpaid bu', align: 'right', format: 'bu' },
      ],
      rows: visible.map((c) => {
        const agg = aggByContract.get(c.id)
        const delivered = agg?.delivered ?? 0
        const location = c.delivery_type === 'delivered' ? `Del → ${c.delivery_location?.name ?? '—'}` : 'Pickup'
        const window = (c.delivery_start_date || c.delivery_end_date) ? `${fmtDate(c.delivery_start_date)} → ${fmtDate(c.delivery_end_date)}` : '—'
        if (isSeedKind(c)) {
          const seed = seedRowInfo(c)
          return [
            c.contract_number, c.buyer?.name ?? '', c.crop?.name ?? '', seed.missingPremiums ? 'Seed (no premiums)' : 'Seed', c.crop_year ?? '',
            c.date_sold ? fmtDate(c.date_sold) : '', location, window,
            seed.committedBu, delivered, Math.max(0, seed.committedBu - delivered),
            seed.pricedPct, seed.electedPrice ?? '', seed.expectedRevenue ?? '', agg?.paidBushels ?? 0, agg?.deliveredUnpaid ?? 0,
          ]
        }
        const contracted = Number(c.contracted_bushels)
        const remaining = Math.max(0, contracted - delivered)
        const pct = contracted > 0 ? Math.min(100, (delivered / contracted) * 100) : 0
        const price = c.price_per_bushel != null ? Number(c.price_per_bushel) : ''
        const revenue = c.price_per_bushel != null ? Number(c.price_per_bushel) * contracted : ''
        return [
          c.contract_number, c.buyer?.name ?? '', c.crop?.name ?? '', CONTRACT_TYPE_LABEL[effectiveContractType(c)], c.crop_year ?? '',
          c.date_sold ? fmtDate(c.date_sold) : '', location, window, contracted, delivered, remaining, pct, price, revenue, agg?.paidBushels ?? 0, agg?.deliveredUnpaid ?? 0,
        ]
      }),
    }],
  }

  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <ContractFilterPersistence />
      </Suspense>
      <h1 className="text-2xl font-bold">Contract Tracker</h1>
      <div className="flex items-end gap-3 flex-wrap">
        <details className="relative">
          <summary className="list-none cursor-pointer rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold select-none">
            New Contract ▾
          </summary>
          <div className="absolute z-10 mt-1 w-52 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
            <Link href="/settings/contracts" className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Grain contract
              <span className="block text-xs text-slate-400">Forward · HTA · Basis</span>
            </Link>
            <Link href="/contracts/seed/new" className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Seed contract
              <span className="block text-xs text-slate-400">Acreage-based seed production</span>
            </Link>
          </div>
        </details>
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
            <option value="seed">Seed</option>
          </select>
          <select name="pricing" defaultValue={pricingFilter} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All pricing</option>
            <option value="fully_priced">Fully priced</option>
            <option value="awaiting_basis">Awaiting basis</option>
            <option value="awaiting_futures">Awaiting futures</option>
          </select>
          {/* Keep the toggle/sort state through an Apply — a GET form drops
              params its inputs don't carry. */}
          {hideCompleted && <input type="hidden" name="hide_completed" value="1" />}
          {hideFuture && <input type="hidden" name="hide_future" value="1" />}
          {sortKey && <input type="hidden" name="sort" value={sortKey} />}
          {sortKey && <input type="hidden" name="dir" value={sortDir} />}
          <button className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm">Apply</button>
          {anyFilters && (
            <Link href="/contracts" className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
              Clear filters
            </Link>
          )}
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
              {['Type', 'Year', 'Sold', 'Location', 'Delivery window', 'Contracted', 'Delivered', 'Progress', '$/bu', 'Revenue', 'Paid (bu)', 'Unpaid (bu)']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={15} className="px-3 py-6 text-center text-slate-400">No contracts.</td></tr>}
            {visible.map((c) => {
              const agg = aggByContract.get(c.id) ?? { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set<string>(), loadCount: 0 }
              const isDup = (numberCounts.get(c.contract_number) ?? 0) > 1
              const seed = isSeedKind(c) ? seedRowInfo(c) : null
              const contractedShown = seed ? seed.committedBu : Number(c.contracted_bushels)
              const remaining = Math.max(0, contractedShown - agg.delivered)
              const pct = seed
                ? seed.pricedPct
                : Number(c.contracted_bushels) > 0 ? Math.min(100, (agg.delivered / Number(c.contracted_bushels)) * 100) : 0
              const contractPrice = seed ? seed.electedPrice : (c.price_per_bushel != null ? Number(c.price_per_bushel) : null)
              const contractRevenue = seed
                ? seed.expectedRevenue
                : contractPrice != null ? contractPrice * Number(c.contracted_bushels) : null

              const flag = flagFor(c)
              const endIn = daysUntil(c.delivery_end_date)
              // Don't flag a closing delivery window on a finished contract.
              const endWarning = flag !== 'complete' && endIn != null && endIn >= 0 && endIn <= 14

              return (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-semibold">
                    <ContractFlagIcon variant={flag} />
                    <Link href={`/contracts/${c.id}`} className="text-brand-deep hover:underline">
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
                    {seed
                      ? (
                        <span className="whitespace-nowrap">
                          <span className="text-xs rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5">Seed</span>
                          {seed.missingPremiums && (
                            <span
                              className="ml-1 text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5"
                              title="No premium rows for the contract's expected outcome — projections show the base price only. Open the contract to add rows or apply the standard schedule."
                            >no premiums</span>
                          )}
                        </span>
                      )
                      : <span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{CONTRACT_TYPE_LABEL[effectiveContractType(c)]}</span>}
                  </td>
                  <td className="px-3 py-2">{c.crop_year ?? ''}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {c.date_sold ? fmtDate(c.date_sold) : <span className="text-slate-400">—</span>}
                  </td>
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
                  <td className="px-3 py-2 text-right">
                    {fmt(contractedShown)}
                    {seed && <span className="ml-1 text-xs text-slate-400">(est.)</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {fmt(agg.delivered)}
                    <span className="ml-1 text-xs text-slate-400">({agg.loadCount} load{agg.loadCount === 1 ? '' : 's'})</span>
                  </td>
                  <td className="px-3 py-2 w-40">
                    <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div className={`h-2 ${seed ? 'bg-emerald-500' : 'bg-green-600'}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {seed ? `${pct.toFixed(0)}% priced` : `${pct.toFixed(1)}% · ${fmt(remaining)} bu left`}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                    {seed
                      ? (contractPrice != null
                          ? <span>${contractPrice.toFixed(2)}{seed.pricedPct < 100 && <span className="ml-1 text-[10px] rounded bg-amber-100 text-amber-800 px-1">{100 - seed.pricedPct}% unpriced</span>}</span>
                          : <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">unpriced</span>)
                      : c.pricing_status === 'fully_priced'
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
