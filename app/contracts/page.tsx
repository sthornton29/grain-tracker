import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'

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
  searchParams: { entity?: string; crop_year?: string }
}) {
  const supabase = createClient()
  const entityId = searchParams.entity ?? ''
  const cropYear = searchParams.crop_year ? Number(searchParams.crop_year) : null

  const [contractsRes, loadsRes, cropsRes, fieldsRes, farmsRes, entitiesRes, linesRes] = await Promise.all([
    supabase
      .from('contracts')
      .select(`
        id, contract_number, contracted_bushels, price_per_bushel, notes,
        crop_year, delivery_type, delivery_start_date, delivery_end_date,
        buyer_id, crop_id, entity_id,
        buyer:buyers(name), crop:crops(name), delivery_location:delivery_locations(name)
      `)
      .order('contract_number'),
    supabase.from('loads').select('id, contract_id, ticket_number, net_weight, moisture, crop_id, dry_bushels_override, from_type, from_field_id'),
    supabase.from('crops').select('id, base_moisture_pct, base_lb_per_bushel'),
    supabase.from('fields').select('id, farm_id'),
    supabase.from('farms').select('id, entity_id'),
    supabase.from('entities').select('id, name').order('name'),
    supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue'),
  ])

  const allContracts = (contractsRes.data as unknown as ContractRow[]) ?? []
  const loads = (loadsRes.data ?? []) as LoadRow[]
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

  const cropYearOptions = Array.from(
    new Set(allContracts.map((c) => c.crop_year).filter((y): y is number => y != null))
  ).sort((a, b) => b - a)

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
  }
  const aggByContract = new Map<string, Agg>()
  function ensure(id: string): Agg {
    let a = aggByContract.get(id)
    if (!a) { a = { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set() }; aggByContract.set(id, a) }
    return a
  }
  for (const load of loads) {
    if (!load.contract_id) continue
    const agg = ensure(load.contract_id)
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

  const visible = allContracts.filter((c) => {
    if (cropYear != null && c.crop_year !== cropYear) return false
    if (entityId) {
      // Honor an explicit contract.entity_id when set; otherwise fall back to
      // attribution derived from the source fields of delivered loads.
      if (c.entity_id) {
        if (c.entity_id !== entityId) return false
      } else {
        const agg = aggByContract.get(c.id)
        if (!agg || !agg.entityIds.has(entityId)) return false
      }
    }
    return true
  })

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Contract Tracker</h1>
        <form className="flex items-center gap-2 flex-wrap">
          <select name="entity" defaultValue={entityId} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">All entities</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
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

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Contract #', 'Buyer', 'Crop', 'Year', 'Location', 'Delivery window', 'Contracted', 'Delivered', 'Paid (bu)', 'Unpaid (bu)', 'Revenue', 'Avg $/bu', 'Progress']
                .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={13} className="px-3 py-6 text-center text-slate-400">No contracts.</td></tr>}
            {visible.map((c) => {
              const agg = aggByContract.get(c.id) ?? { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set<string>() }
              const remaining = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
              const pct = Number(c.contracted_bushels) > 0 ? Math.min(100, (agg.delivered / Number(c.contracted_bushels)) * 100) : 0
              const avgPrice = agg.paidBushels > 0 ? agg.revenue / agg.paidBushels : null

              const isOpen = inWindow(c.delivery_start_date, c.delivery_end_date)
              const endIn = daysUntil(c.delivery_end_date)
              const endWarning = endIn != null && endIn >= 0 && endIn <= 14

              return (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-semibold">
                    {isOpen && <span className="inline-block h-2 w-2 rounded-full bg-green-500 mr-1 align-middle" />}
                    {!isOpen && endWarning && <span className="inline-block h-2 w-2 rounded-full bg-amber-500 mr-1 align-middle" />}
                    {c.contract_number}
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
                  <td className="px-3 py-2 text-right">{fmt(agg.delivered)}</td>
                  <td className="px-3 py-2 text-right">{fmt(agg.paidBushels)}</td>
                  <td className={`px-3 py-2 text-right ${agg.deliveredUnpaid > 0 ? 'text-amber-700 font-semibold' : ''}`}>{fmt(agg.deliveredUnpaid)}</td>
                  <td className="px-3 py-2 text-right">${fmt(agg.revenue)}</td>
                  <td className="px-3 py-2 text-right font-mono">{avgPrice != null ? avgPrice.toFixed(4) : ''}</td>
                  <td className="px-3 py-2 w-40">
                    <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-2 bg-green-600" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{pct.toFixed(1)}% · {fmt(remaining)} bu left</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
