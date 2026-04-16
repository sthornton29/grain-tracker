import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import EmptyBinButton from '@/components/empty-bin-button'

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

type CropRow = {
  id: string
  name: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}

type FieldRow = { id: string; farm_id: string | null }
type FarmRow = { id: string; entity_id: string | null }
type EntityRow = { id: string; name: string }

export const dynamic = 'force-dynamic'

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: { entity?: string; crop_year?: string }
}) {
  const supabase = createClient()
  const entityId = searchParams.entity ?? ''
  const cropYear = searchParams.crop_year ? Number(searchParams.crop_year) : null

  const [binsRes, cropsRes, loadsRes, fieldsRes, farmsRes, entitiesRes] = await Promise.all([
    supabase.from('bins').select('id, name_or_number').order('name_or_number'),
    supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').order('name'),
    supabase.from('loads').select('net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, from_bin_id, to_type, to_bin_id'),
    supabase.from('fields').select('id, farm_id'),
    supabase.from('farms').select('id, entity_id'),
    supabase.from('entities').select('id, name').order('name'),
  ])

  const bins = binsRes.data ?? []
  const crops = (cropsRes.data ?? []) as CropRow[]
  const loads = (loadsRes.data ?? []) as LoadRow[]
  const fields = (fieldsRes.data ?? []) as FieldRow[]
  const farms = (farmsRes.data ?? []) as FarmRow[]
  const entities = (entitiesRes.data ?? []) as EntityRow[]

  const cropById = new Map(crops.map((c) => [c.id, c]))
  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const fieldEntity = new Map(
    fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null])
  )

  // Map: binId -> cropId -> dry bushels
  const onHand = new Map<string, Map<string, number>>()
  for (const b of bins) onHand.set(b.id, new Map())

  const cropYearOptions = Array.from(new Set(loads.map((l) => l.crop_year).filter((y): y is number => y != null))).sort((a, b) => b - a)

  for (const l of loads) {
    if (!l.crop_id) continue
    if (cropYear != null && l.crop_year !== cropYear) continue
    if (entityId) {
      // With entity filter: only include loads sourced from a field belonging to that entity.
      // (Bin-source loads have no field, so they're excluded.)
      if (l.from_type !== 'field' || !l.from_field_id) continue
      if (fieldEntity.get(l.from_field_id) !== entityId) continue
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
      const m = onHand.get(l.to_bin_id)!
      m.set(l.crop_id, (m.get(l.crop_id) ?? 0) + dryBushels)
    }
    if (l.from_type === 'bin' && l.from_bin_id && onHand.has(l.from_bin_id)) {
      const m = onHand.get(l.from_bin_id)!
      m.set(l.crop_id, (m.get(l.crop_id) ?? 0) - dryBushels)
    }
  }

  const cropName = new Map(crops.map((c) => [c.id, c.name]))

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
            name="crop_year"
            defaultValue={cropYear ?? ''}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
          <button className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm">Apply</button>
        </form>
      </div>
      <p className="text-sm text-slate-500">
        Dry bushels on hand = bushels delivered to bin − bushels pulled from bin (shrunk to base moisture).
        {entityId && (
          <> Showing only loads sourced from this entity&rsquo;s fields; bin-to-bin and bin-to-buyer outflows are excluded.</>
        )}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {bins.map((b) => {
          const entries = [...(onHand.get(b.id) ?? new Map()).entries()]
            .filter(([, v]) => v !== 0)
            .sort((a, b) => (cropName.get(a[0]) || '').localeCompare(cropName.get(b[0]) || ''))
          const total = entries.reduce((s, [, v]) => s + v, 0)
          return (
            <div key={b.id} className="bg-white rounded-xl shadow p-4">
              <div className="flex justify-between items-baseline gap-2 flex-wrap">
                <h2 className="text-lg font-semibold">Bin {b.name_or_number}</h2>
                <span className="text-sm text-slate-500">{total.toLocaleString(undefined, { maximumFractionDigits: 2 })} bu total</span>
                <EmptyBinButton binId={b.id} binName={b.name_or_number} />
              </div>
              {entries.length === 0 ? (
                <p className="text-sm text-slate-400 mt-2">Empty.</p>
              ) : (
                <table className="w-full text-sm mt-2">
                  <tbody>
                    {entries.map(([cropId, bu]) => (
                      <tr key={cropId} className="border-t border-slate-100">
                        <td className="py-1">{cropName.get(cropId) ?? '—'}</td>
                        <td className="py-1 text-right font-mono">{bu.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
        {bins.length === 0 && <p className="text-slate-500">No bins configured. Add them under Settings → Bins.</p>}
      </div>
    </div>
  )
}
