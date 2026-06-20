'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fieldCropAggregates, analyzeYields } from '@/lib/yields'
import AvgYieldHeader from '@/components/reports/avg-yield-header'
import { EmptyState, theadCls, subtotalRowCls } from '@/components/reports/report-kit'
import type { ExportPayload } from '@/lib/exports'
import type {
  Crop, Entity, Farm, Field, FieldPlanting, Landowner, LoadSplit,
} from '@/lib/types'

type LoadRow = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
}

type FarmAgg = {
  farmName: string
  fsaNumber: string | null
  byCrop: Map<string, { acres: number; dryBu: number; cropName: string }>
}

type LandownerGroup = {
  key: string
  landownerName: string
  farms: FarmAgg[]
  byCrop: Map<string, { acres: number; dryBu: number; cropName: string }>
}

const NO_LANDOWNER_KEY = '__none__'
const NO_LANDOWNER_LABEL = 'Owned / No Landowner'

type Props = {
  /** When provided, callback is invoked any time the export payload changes,
   *  giving the parent a fresh builder it can pass to <ExportBar />. */
  onPayloadChange?: (build: () => ExportPayload) => void
}

export default function YieldsByLandowner({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [loading, setLoading] = useState(true)

  // Filters persist across visits; default the crop year to the current year.
  const [cropYear, setCropYear] = usePersistentState<number | ''>('yields-by-landowner:cropYear', new Date().getFullYear())
  const [cropId, setCropId] = usePersistentState('yields-by-landowner:cropId', '')
  const [entityId, setEntityId] = usePersistentState('yields-by-landowner:entityId', '')
  const [landownerId, setLandownerId] = usePersistentState('yields-by-landowner:landownerId', '')

  useEffect(() => {
    ;(async () => {
      const [cr, en, fa, fi, pl, lo, sp, lan] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('field_plantings').select('*'),
        supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id'),
        supabase.from('load_splits').select('*'),
        supabase.from('landowners').select('*').order('name'),
      ])
      setCrops((cr.data as Crop[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as Farm[]) || [])
      setFields((fi.data as Field[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoads((lo.data as LoadRow[]) || [])
      setSplits((sp.data as LoadSplit[]) || [])
      setLandowners((lan.data as Landowner[]) || [])
      setLoading(false)
    })()
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const landownerById = useMemo(() => new Map(landowners.map((l) => [l.id, l])), [landowners])

  // Dry bushels + most-recent load date per field+crop+year (shared rules).
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { cropYear: cropYear === '' ? null : cropYear }),
    [loads, splits, cropById, cropYear],
  )
  const dryBuFor = (fieldId: string, cropId2: string, year: number) =>
    aggByKey.get(`${fieldId}|${cropId2}|${year}`)?.dryBu ?? 0

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  // Plantings matching the active filters (before the harvest exclusion).
  const filteredPlantings = useMemo(() => plantings.filter((p) => {
    if (cropYear !== '' && p.season_year !== cropYear) return false
    if (cropId && p.crop_id !== cropId) return false
    const fld = fieldById.get(p.field_id)
    if (!fld) return false
    const farm = fld.farm_id ? farmById.get(fld.farm_id) ?? null : null
    if (entityId && farm?.entity_id !== entityId) return false
    const ownerKey = farm?.landowner_id ?? NO_LANDOWNER_KEY
    if (landownerId && ownerKey !== landownerId) return false
    return true
  }), [plantings, fieldById, farmById, cropYear, cropId, entityId, landownerId])

  // Drop unharvested / in-progress fields from the rolled-up numbers and the
  // average-yield header (per crop, over the filtered plantings).
  const yieldAnalysis = useMemo(() => analyzeYields(
    filteredPlantings.map((p) => {
      const agg = aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
      return {
        id: p.id,
        cropId: p.crop_id,
        acres: Number(p.planted_acres),
        dryBu: agg?.dryBu ?? 0,
        lastLoadDate: agg?.lastLoadDate ?? null,
        override: p.yield_include_override,
      }
    }),
  ), [filteredPlantings, aggByKey])

  // Build per-landowner aggregation.
  const groups = useMemo<LandownerGroup[]>(() => {
    const excluded = yieldAnalysis.excluded
    const byOwner = new Map<string, LandownerGroup>()

    // Pre-create the groups for landowners that exist so an empty owner still
    // shows up if the user is filtering specifically on them.
    if (landownerId) {
      const l = landownerById.get(landownerId)
      byOwner.set(landownerId, {
        key: landownerId,
        landownerName: l?.name ?? '(missing)',
        farms: [],
        byCrop: new Map(),
      })
    }

    for (const p of filteredPlantings) {
      if (excluded.has(p.id)) continue
      const fld = fieldById.get(p.field_id)
      if (!fld) continue
      const farm = fld.farm_id ? farmById.get(fld.farm_id) ?? null : null
      const ownerKey = farm?.landowner_id ?? NO_LANDOWNER_KEY
      if (!byOwner.has(ownerKey)) {
        const l = farm?.landowner_id ? landownerById.get(farm.landowner_id) : null
        byOwner.set(ownerKey, {
          key: ownerKey,
          landownerName: l?.name ?? NO_LANDOWNER_LABEL,
          farms: [],
          byCrop: new Map(),
        })
      }
      const group = byOwner.get(ownerKey)!

      const acres = Number(p.planted_acres)
      const dryBu = dryBuFor(p.field_id, p.crop_id, p.season_year)
      const cropName = cropById.get(p.crop_id)?.name ?? '—'

      let farmAgg = group.farms.find((f) => f.farmName === (farm?.name ?? '— no farm —'))
      if (!farmAgg) {
        farmAgg = {
          farmName: farm?.name ?? '— no farm —',
          fsaNumber: farm?.fsa_number ?? null,
          byCrop: new Map(),
        }
        group.farms.push(farmAgg)
      }
      const farmCropTotal = farmAgg.byCrop.get(p.crop_id) ?? { acres: 0, dryBu: 0, cropName }
      farmCropTotal.acres += acres
      farmCropTotal.dryBu += dryBu
      farmAgg.byCrop.set(p.crop_id, farmCropTotal)

      const ownerCropTotal = group.byCrop.get(p.crop_id) ?? { acres: 0, dryBu: 0, cropName }
      ownerCropTotal.acres += acres
      ownerCropTotal.dryBu += dryBu
      group.byCrop.set(p.crop_id, ownerCropTotal)
    }

    return [...byOwner.values()].sort((a, b) => {
      // Push "Owned / No Landowner" to the bottom; otherwise alphabetical.
      if (a.key === NO_LANDOWNER_KEY) return 1
      if (b.key === NO_LANDOWNER_KEY) return -1
      return a.landownerName.localeCompare(b.landownerName)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredPlantings, yieldAnalysis, fieldById, farmById, landownerById, cropById, aggByKey, landownerId])

  function filtersLabel(): string {
    const parts: string[] = []
    parts.push(`Crop year: ${cropYear === '' ? 'all' : cropYear}`)
    if (cropId) parts.push(`Crop: ${cropById.get(cropId)?.name ?? '?'}`)
    if (entityId) parts.push(`Entity: ${entities.find((e) => e.id === entityId)?.name ?? '?'}`)
    if (landownerId) parts.push(`Landowner: ${landownerById.get(landownerId)?.name ?? '?'}`)
    return parts.join(' · ')
  }

  // Export payload mirrors the on-screen layout: one section per landowner,
  // with a sub-header row per farm followed by its crop rows, then a tinted
  // totals block. Per-field detail is intentionally omitted — the report rolls
  // up to the farm level for readability.
  function buildExportPayload(): ExportPayload {
    const columns: ExportPayload['sections'][number]['columns'] = [
      { label: 'Crop' },
      { label: 'Acres', align: 'right', format: 'acres' },
      { label: 'Dry bu', align: 'right', format: 'bu' },
      { label: 'Yield (bu/ac)', align: 'right', format: 'yield' },
    ]
    // Real number (formatted to 1 dec by the column), or '—' when there are no acres.
    const yld = (acres: number, dryBu: number): number | string => (acres > 0 ? dryBu / acres : '—')

    const sections = groups.map((g) => {
      const rows: Array<Array<string | number | null>> = []
      const rowMeta: NonNullable<ExportPayload['sections'][number]['rowMeta']> = []

      for (const f of g.farms) {
        rows.push([f.fsaNumber ? `${f.farmName}  ·  FSA #${f.fsaNumber}` : f.farmName])
        rowMeta.push('subhead')
        for (const t of f.byCrop.values()) {
          rows.push([t.cropName, t.acres, t.dryBu, yld(t.acres, t.dryBu)])
          rowMeta.push('data')
        }
      }

      if (g.byCrop.size > 0) {
        rows.push([`${g.landownerName} totals`])
        rowMeta.push('subhead')
        for (const t of g.byCrop.values()) {
          rows.push([t.cropName, t.acres, t.dryBu, yld(t.acres, t.dryBu)])
          rowMeta.push('total')
        }
      }

      const farmCount = `${g.farms.length} farm${g.farms.length === 1 ? '' : 's'}`
      return {
        title: `${g.landownerName}  —  ${farmCount}`,
        columns,
        rows,
        rowMeta,
      }
    })

    return {
      title: 'Yields by Landowner',
      filters: filtersLabel(),
      singleSheet: true,
      sections,
    }
  }

  // Hand a fresh builder up to the parent any time the data or filters change.
  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, cropYear, cropId, entityId, landownerId, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 no-print">
        <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
          <option value="">All crop years</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
        </select>
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">All crops</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
          <option value="">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select value={landownerId} onChange={(e) => setLandownerId(e.target.value)} className={inputCls}>
          <option value="">All landowners</option>
          {landowners.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {!loading && (
        <AvgYieldHeader averages={yieldAnalysis.averages} cropName={(id) => cropById.get(id)?.name ?? '—'} />
      )}

      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : groups.length === 0 ? (
        <EmptyState
          message="No plantings match these filters."
          hint="Try widening the crop year, crop, entity, or landowner filters — or record yields for these fields."
          linkHref="/yields"
          linkLabel="Go to Yields"
        />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key} className="bg-white rounded-xl shadow overflow-hidden avoid-break">
              <header className="bg-slate-100 px-4 py-2 flex items-baseline gap-2 flex-wrap">
                <h2 className="font-bold text-lg">{g.landownerName}</h2>
                <span className="text-xs text-slate-500">{g.farms.length} farm{g.farms.length === 1 ? '' : 's'}</span>
              </header>

              {g.farms.map((f, fi) => (
                <div key={fi} className="px-4 py-3 border-t border-slate-100">
                  <div className="flex items-baseline gap-2 mb-1">
                    <h3 className="font-semibold">{f.farmName}</h3>
                    {f.fsaNumber && <span className="text-xs text-slate-500">FSA #{f.fsaNumber}</span>}
                  </div>
                  <table className="min-w-full text-sm">
                    <thead className={theadCls}>
                      <tr>
                        <th className="text-left pr-4 font-medium">Crop</th>
                        <th className="text-right pr-4 font-medium">Acres</th>
                        <th className="text-right pr-4 font-medium">Dry bu</th>
                        <th className="text-right pr-4 font-medium">Yield (bu/ac)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...f.byCrop.values()].map((t) => (
                        <tr key={t.cropName} className="border-t border-slate-100">
                          <td className="pr-4 py-1 font-medium">{t.cropName}</td>
                          <td className="pr-4 py-1 text-right font-mono tabular-nums">{fmt(t.acres)}</td>
                          <td className="pr-4 py-1 text-right font-mono tabular-nums">{fmt(t.dryBu)}</td>
                          <td className="pr-4 py-1 text-right font-mono tabular-nums">{t.acres > 0 ? (t.dryBu / t.acres).toFixed(1) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

              {g.byCrop.size > 0 && (
                <div className={`px-4 py-3 border-t-2 border-slate-200 ${subtotalRowCls}`}>
                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{g.landownerName} totals</div>
                  <table className="min-w-full text-sm">
                    <tbody>
                      {[...g.byCrop.values()].map((t) => (
                        <tr key={`grand-${t.cropName}`}>
                          <td className="pr-4 py-1 font-semibold">{t.cropName}</td>
                          <td className="pr-4 py-1 text-right font-mono tabular-nums">{fmt(t.acres)} ac</td>
                          <td className="pr-4 py-1 text-right font-mono tabular-nums">{fmt(t.dryBu)} bu</td>
                          <td className="pr-4 py-1 text-right font-mono tabular-nums font-semibold">{t.acres > 0 ? (t.dryBu / t.acres).toFixed(1) : '—'} bu/ac</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
