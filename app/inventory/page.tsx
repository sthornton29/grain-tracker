import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import EmptyBinButton from '@/components/empty-bin-button'
import BeginningInventoryButton from '@/components/beginning-inventory-button'
import ExportInventoryCsv, { type InventoryCsvRow } from '@/components/export-inventory-csv'
import type { BinInventoryAdjustment, Crop } from '@/lib/types'

type LoadRow = {
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  from_bin_id: string | null
  to_type: string | null
  to_bin_id: string | null
}

type FieldRow = { id: string; farm_id: string | null; county_id: string | null }
type FarmRow = { id: string; entity_id: string | null; county_id: string | null }
type EntityRow = { id: string; name: string }
type CountyRow = { id: string; name: string; state_code: string }
type BinRow = { id: string; name_or_number: string; crop_id: string | null }

export const dynamic = 'force-dynamic'

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

function fmtDate(iso: string) {
  // "2026-01-15" -> "1/15/2026"
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${m}/${d}/${y}`
}

function fmtBu(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: { entity?: string; crop_year?: string; county?: string }
}) {
  const supabase = createClient()
  const entityId = searchParams.entity ?? ''
  const countyId = searchParams.county ?? ''
  const cropYear = searchParams.crop_year ? Number(searchParams.crop_year) : null
  const today = todayISO()

  const [binsRes, cropsRes, loadsRes, fieldsRes, farmsRes, entitiesRes, countiesRes, adjsRes, plantingsRes] = await Promise.all([
    supabase.from('bins').select('id, name_or_number, crop_id').order('name_or_number'),
    supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').order('name'),
    supabase.from('loads').select('net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, from_bin_id, to_type, to_bin_id'),
    supabase.from('fields').select('id, farm_id, county_id'),
    supabase.from('farms').select('id, entity_id, county_id'),
    supabase.from('entities').select('id, name').order('name'),
    supabase.from('counties').select('id, name, state_code').order('state_code').order('name'),
    supabase.from('bin_inventory_adjustments')
      .select('id, bin_id, crop_id, adjustment_type, bushels, moisture, as_of_date, notes, created_at')
      .lte('as_of_date', today)
      .order('as_of_date', { ascending: true }),
    supabase.from('field_plantings').select('season_year'),
  ])

  const bins = (binsRes.data ?? []) as BinRow[]
  const crops = (cropsRes.data ?? []) as Crop[]
  const loads = (loadsRes.data ?? []) as LoadRow[]
  const fields = (fieldsRes.data ?? []) as FieldRow[]
  const farms = (farmsRes.data ?? []) as FarmRow[]
  const entities = (entitiesRes.data ?? []) as EntityRow[]
  const counties = (countiesRes.data ?? []) as CountyRow[]
  const adjustments = (adjsRes.data ?? []) as BinInventoryAdjustment[]

  const cropById = new Map(crops.map((c) => [c.id, c]))
  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const farmCounty = new Map(farms.map((f) => [f.id, f.county_id]))
  const fieldEntity = new Map(
    fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null])
  )
  const fieldCounty = new Map(
    fields.map((f) => [f.id, f.county_id ?? (f.farm_id ? farmCounty.get(f.farm_id) ?? null : null)])
  )

  // Per bin → per crop totals split by source.
  type Cell = { loadBacked: number; beginning: number; emptyAdj: number }
  const cellFor = (bag: Map<string, Map<string, Cell>>, binId: string, cropId: string): Cell => {
    let inner = bag.get(binId)
    if (!inner) { inner = new Map(); bag.set(binId, inner) }
    let cell = inner.get(cropId)
    if (!cell) { cell = { loadBacked: 0, beginning: 0, emptyAdj: 0 }; inner.set(cropId, cell) }
    return cell
  }
  const onHand = new Map<string, Map<string, Cell>>()
  for (const b of bins) onHand.set(b.id, new Map())

  const plantingYears = ((plantingsRes.data ?? []) as Array<{ season_year: number | null }>).map((p) => p.season_year)
  const cropYearOptions = cropYearOptionsFromPlantings(plantingYears, cropYear)

  for (const l of loads) {
    if (!l.crop_id) continue
    if (cropYear != null && l.crop_year !== cropYear) continue
    if (entityId) {
      // With entity filter: only include loads sourced from a field belonging to that entity.
      // (Bin-source loads have no field, so they're excluded.)
      if (l.from_type !== 'field' || !l.from_field_id) continue
      if (fieldEntity.get(l.from_field_id) !== entityId) continue
    }
    if (countyId) {
      if (l.from_type !== 'field' || !l.from_field_id) continue
      if (fieldCounty.get(l.from_field_id) !== countyId) continue
    }
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (!dryBushels) continue
    if (l.to_type === 'bin' && l.to_bin_id && onHand.has(l.to_bin_id)) {
      cellFor(onHand, l.to_bin_id, l.crop_id).loadBacked += dryBushels
    }
    if (l.from_type === 'bin' && l.from_bin_id && onHand.has(l.from_bin_id)) {
      cellFor(onHand, l.from_bin_id, l.crop_id).loadBacked -= dryBushels
    }
  }

  // Adjustments don't carry a crop_year, entity, or county attribution, so when any
  // of those filters is active we leave them out (a note on the page explains this).
  const includeAdjustments = !entityId && !countyId && cropYear == null
  const adjustmentsForBin = new Map<string, BinInventoryAdjustment[]>()
  if (includeAdjustments) {
    for (const a of adjustments) {
      if (!onHand.has(a.bin_id)) continue
      const cell = cellFor(onHand, a.bin_id, a.crop_id)
      if (a.adjustment_type === 'beginning_inventory') cell.beginning += Number(a.bushels)
      else cell.emptyAdj += Number(a.bushels)
      const list = adjustmentsForBin.get(a.bin_id) ?? []
      list.push(a)
      adjustmentsForBin.set(a.bin_id, list)
    }
  }

  const cropName = (id: string) => cropById.get(id)?.name ?? '—'

  // Build the export rows once for the whole page.
  const csvRows: InventoryCsvRow[] = []
  for (const b of bins) {
    const inner = onHand.get(b.id) ?? new Map<string, Cell>()
    for (const [cid, cell] of inner.entries()) {
      const total = cell.loadBacked + cell.beginning - cell.emptyAdj
      if (Math.abs(total) < 0.005 && cell.beginning === 0) continue
      const beginningNotes = (adjustmentsForBin.get(b.id) ?? [])
        .filter((a) => a.crop_id === cid && a.adjustment_type === 'beginning_inventory')
        .map((a) => `${fmtBu(Number(a.bushels))} bu as of ${fmtDate(a.as_of_date)}${a.notes ? ` — ${a.notes}` : ''}`)
        .join('; ')
      csvRows.push({
        binName: b.name_or_number,
        cropName: cropName(cid),
        loadBackedBu: cell.loadBacked,
        beginningBu: cell.beginning,
        emptyAdjBu: cell.emptyAdj,
        totalBu: total,
        beginningNotes,
      })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Bin Inventory</h1>
        <form className="flex items-center gap-2 flex-wrap">
          <select
            name="entity"
            defaultValue={entityId}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All entities</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <select
            name="county"
            defaultValue={countyId}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All counties</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
          </select>
          <select
            name="crop_year"
            defaultValue={cropYear ?? ''}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
          <button className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm">Apply</button>
        </form>
        <ExportInventoryCsv rows={csvRows} />
      </div>
      <p className="text-sm text-slate-500">
        Dry bushels on hand = beginning inventory + bushels delivered to bin − bushels pulled from bin − empty-bin adjustments (shrunk to base moisture).
        {entityId && (
          <> Showing only loads sourced from this entity&rsquo;s fields; bin-to-bin and bin-to-buyer outflows are excluded.</>
        )}
        {countyId && (
          <> Showing only loads sourced from fields in the selected county; bin-to-bin and bin-to-buyer outflows are excluded.</>
        )}
        {!includeAdjustments && (
          <> Beginning-inventory and empty-bin adjustments are hidden because they aren&rsquo;t attributable to the selected filters.</>
        )}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {bins.map((b) => {
          const inner = onHand.get(b.id) ?? new Map<string, Cell>()
          const entries = [...inner.entries()]
            .map(([cid, cell]) => {
              const total = cell.loadBacked + cell.beginning - cell.emptyAdj
              return { cid, cell, total }
            })
            .filter((r) => Math.abs(r.total) >= 0.005)
            .sort((a, b) => cropName(a.cid).localeCompare(cropName(b.cid)))
          const total = entries.reduce((s, r) => s + r.total, 0)
          const beginningRows = (adjustmentsForBin.get(b.id) ?? [])
            .filter((a) => a.adjustment_type === 'beginning_inventory')
          return (
            <div key={b.id} className="bg-white rounded-xl shadow p-4">
              <div className="flex justify-between items-baseline gap-2 flex-wrap">
                <h2 className="text-lg font-semibold">Bin {b.name_or_number}</h2>
                <span className="text-sm text-slate-500">{fmtBu(total)} bu total</span>
              </div>
              {entries.length === 0 ? (
                <p className="text-sm text-slate-400 mt-2">Empty.</p>
              ) : (
                <table className="w-full text-sm mt-2">
                  <thead>
                    <tr className="text-xs text-slate-500">
                      <th className="text-left py-1">Crop</th>
                      <th className="text-right py-1">Load-backed</th>
                      <th className="text-right py-1">Beginning</th>
                      <th className="text-right py-1">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((r) => (
                      <tr key={r.cid} className="border-t border-slate-100">
                        <td className="py-1">{cropName(r.cid)}</td>
                        <td className="py-1 text-right font-mono">{fmtBu(r.cell.loadBacked - r.cell.emptyAdj)}</td>
                        <td className="py-1 text-right font-mono text-slate-500">
                          {r.cell.beginning > 0 ? fmtBu(r.cell.beginning) : '—'}
                        </td>
                        <td className="py-1 text-right font-mono font-semibold">{fmtBu(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {beginningRows.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                  {beginningRows.map((a) => (
                    <li key={a.id}>
                      Includes beginning inventory: {fmtBu(Number(a.bushels))} bu {cropName(a.crop_id)} (added {fmtDate(a.as_of_date)})
                      {a.notes ? ` — ${a.notes}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-start gap-2">
                <EmptyBinButton binId={b.id} binName={b.name_or_number} />
                <BeginningInventoryButton
                  binId={b.id}
                  binName={b.name_or_number}
                  crops={crops}
                  defaultCropId={b.crop_id}
                />
              </div>
            </div>
          )
        })}
        {bins.length === 0 && <p className="text-slate-500">No bins configured. Add them under Settings → Bins.</p>}
      </div>
    </div>
  )
}
