import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'

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
  buyer_id: string | null
  crop_id: string | null
  entity_id: string | null
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

function inWindow(start: string | null, end: string | null): boolean {
  if (!start && !end) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (start && today < new Date(start + 'T00:00:00')) return false
  if (end && today > new Date(end + 'T00:00:00')) return false
  return true
}

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: { entity?: string; crop_year?: string; crop?: string; sort?: string; dir?: string }
}) {
  const supabase = createClient()
  const entityId = searchParams.entity ?? ''
  const cropFilter = searchParams.crop ?? ''
  const cropYear = searchParams.crop_year ? Number(searchParams.crop_year) : null
  const sortKey = searchParams.sort ?? ''
  const sortDir: 'asc' | 'desc' = searchParams.dir === 'desc' ? 'desc' : 'asc'

  const [contractsRes, loads, cropsRes, fieldsRes, farmsRes, entitiesRes, linesRes, plantingsRes] = await Promise.all([
    supabase
      .from('contracts')
      .select(`
        id, contract_number, contracted_bushels, price_per_bushel, notes,
        crop_year, delivery_type, delivery_start_date, delivery_end_date,
        buyer_id, crop_id, entity_id,
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

  const visible = allContracts.filter((c) => {
    if (cropYear != null && c.crop_year !== cropYear) return false
    if (cropFilter && c.crop_id !== cropFilter) return false
    // Strict entity match: only contracts whose own entity_id matches show up.
    // Contracts with no entity_id are excluded under an entity filter so loads
    // delivered against a different entity's contract can't smuggle this one in.
    if (entityId && c.entity_id !== entityId) return false
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

  function sortHref(col: string) {
    const params = new URLSearchParams()
    if (entityId) params.set('entity', entityId)
    if (cropYear != null) params.set('crop_year', String(cropYear))
    if (cropFilter) params.set('crop', cropFilter)
    const nextDir = sortKey === col && sortDir === 'asc' ? 'desc' : 'asc'
    params.set('sort', col)
    params.set('dir', nextDir)
    return `?${params.toString()}`
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Contract Tracker</h1>
        <Link
          href="/settings/contracts"
          className="rounded-lg bg-green-700 text-white px-3 py-2 text-sm font-semibold"
        >
          New Contract
        </Link>
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
          <button className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm">Apply</button>
        </form>
      </div>

      <p className="text-sm text-slate-500">
        <span className="inline-block h-2 w-2 rounded-full bg-green-500 mr-1 align-middle" /> open delivery window
        <span className="ml-4 inline-block h-2 w-2 rounded-full bg-amber-500 mr-1 align-middle" /> end date ≤ 14 days away
      </p>

      {orphanLoadCount > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>{orphanLoadCount}</strong> load{orphanLoadCount === 1 ? '' : 's'} reference a contract that doesn&rsquo;t exist
          in the contracts table. Their bushels can&rsquo;t be totaled here.
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
              {['Year', 'Location', 'Delivery window', 'Contracted', 'Delivered', 'Progress', '$/bu', 'Revenue', 'Paid (bu)', 'Unpaid (bu)']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={13} className="px-3 py-6 text-center text-slate-400">No contracts.</td></tr>}
            {visible.map((c) => {
              const agg = aggByContract.get(c.id) ?? { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set<string>(), loadCount: 0 }
              const isDup = (numberCounts.get(c.contract_number) ?? 0) > 1
              const remaining = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
              const pct = Number(c.contracted_bushels) > 0 ? Math.min(100, (agg.delivered / Number(c.contracted_bushels)) * 100) : 0
              const contractPrice = c.price_per_bushel != null ? Number(c.price_per_bushel) : null
              const contractRevenue = contractPrice != null ? contractPrice * Number(c.contracted_bushels) : null

              const isOpen = inWindow(c.delivery_start_date, c.delivery_end_date)
              const endIn = daysUntil(c.delivery_end_date)
              const endWarning = endIn != null && endIn >= 0 && endIn <= 14

              return (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-semibold">
                    {isOpen && <span className="inline-block h-2 w-2 rounded-full bg-green-500 mr-1 align-middle" />}
                    {!isOpen && endWarning && <span className="inline-block h-2 w-2 rounded-full bg-amber-500 mr-1 align-middle" />}
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
                  <td className="px-3 py-2">{c.crop_year ?? ''}</td>
                  <td className="px-3 py-2">
                    {c.delivery_type === 'delivered'
                      ? <>Del → {c.delivery_location?.name ?? '—'}</>
                      : 'Pickup'}
                  </td>
                  <td className={`px-3 py-2 text-xs whitespace-nowrap ${endWarning ? 'text-amber-700 font-semibold' : ''}`}>
                    {(c.delivery_start_date || c.delivery_end_date)
                      ? <>{c.delivery_start_date ?? '?'} → {c.delivery_end_date ?? '?'}{endWarning ? ` (${endIn}d)` : ''}</>
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
                  <td className="px-3 py-2 text-right font-mono">{contractPrice != null ? contractPrice.toFixed(2) : ''}</td>
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
