'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { fieldCropAggregates, type CombineEntryLike } from '@/lib/yields'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import {
  EmptyState, SummaryCards, numCell, textCell, theadCls,
  subtotalRowCls, grandTotalRowCls, toneText,
  type SummaryCardData,
} from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload } from '@/lib/exports'
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

type FieldRow = {
  fieldName: string
  acres: number
  dryBu: number
  landlordBu: number
  yieldBuPerAc: number | null
}

type CropOnFarm = {
  cropId: string
  cropName: string
  fields: FieldRow[]
  totals: { acres: number; dryBu: number; landlordBu: number }
}

type FarmShare = {
  farmName: string
  fsaNumber: string | null
  sharePercentage: number
  crops: CropOnFarm[]
}

type LandownerShareGroup = {
  key: string
  landownerName: string
  farms: FarmShare[]
  byCrop: Map<string, { cropName: string; acres: number; dryBu: number; landlordBu: number }>
}

type Props = {
  onPayloadChange?: (build: () => ExportPayload) => void
}

const NO_LANDOWNER_KEY = '__none__'

export default function ShareRentReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [combineEntries, setCombineEntries] = useState<CombineEntryLike[]>([])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [loading, setLoading] = useState(true)

  // Filters persist across visits (see usePersistentState).
  const [cropYear, setCropYear] = usePersistentState<number | ''>('share-rent:cropYear', '')
  const [cropId, setCropId] = usePersistentState('share-rent:cropId', '')
  const [entityId, setEntityId] = usePersistentState('share-rent:entityId', '')
  const [landownerId, setLandownerId] = usePersistentState('share-rent:landownerId', '')

  useEffect(() => {
    ;(async () => {
      const [cr, en, fa, fi, pl, lo, sp, lan, ce] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('field_plantings').select('*'),
        fetchAllRows((f, t) => supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
        supabase.from('landowners').select('*').order('name'),
        // May not exist yet (migration 062): an error leaves data null → [].
        fetchAllRows((f, t) => supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date').order('id').range(f, t)),
      ])
      setCrops((cr.data as Crop[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as Farm[]) || [])
      setFields((fi.data as Field[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoads((lo.data as LoadRow[]) || [])
      setSplits((sp.data as LoadSplit[]) || [])
      setLandowners((lan.data as Landowner[]) || [])
      setCombineEntries((ce.data as CombineEntryLike[]) || [])
      // Default to the latest year that has plantings.
      const years = (pl.data as FieldPlanting[] | null)?.map((p) => p.season_year) ?? []
      if (years.length > 0) setCropYear(Math.max(...years))
      else setCropYear(new Date().getFullYear())
      setLoading(false)
    })()
  }, [supabase])

  // Viewer role (052): RLS already row-filters the data; here the grants only
  // limit the entity dropdown and name the granted entities on the export.
  const viewer = useViewerScope(supabase)
  const entityOptions = entityOptionsFor(viewer, entities)

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const landownerById = useMemo(() => new Map(landowners.map((l) => [l.id, l])), [landowners])

  // (fieldId, cropId, year) → dryBu via the shared yield engine — the same
  // allocation rules (and keys) as the Yields pages, combine entries included.
  const dryBuByKey = useMemo(() => {
    const agg = fieldCropAggregates(loads, splits, cropById, {
      cropYear: cropYear === '' ? null : cropYear,
      combineEntries,
    })
    const map = new Map<string, number>()
    for (const [k, v] of agg) map.set(k, v.dryBu)
    return map
  }, [loads, splits, cropById, cropYear, combineEntries])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  // Compute per-landowner / per-farm / per-crop / per-field structure.
  const { groups, summaryByCrop } = useMemo(() => {
    const shareRentFarms = farms.filter((f) => f.is_share_rent && (f.landlord_share_percentage ?? 0) > 0)
    const filtered = shareRentFarms.filter((f) => {
      if (entityId && f.entity_id !== entityId) return false
      if (landownerId && (f.landowner_id ?? NO_LANDOWNER_KEY) !== landownerId) return false
      return true
    })

    const byOwner = new Map<string, LandownerShareGroup>()
    const summary = new Map<string, { cropName: string; landlordBu: number }>()

    for (const farm of filtered) {
      const farmPct = farm.landlord_share_percentage ?? 0
      const fpct = farmPct / 100

      // Plantings on this farm matching the filters.
      const farmFieldIds = new Set(
        fields.filter((fi) => fi.farm_id === farm.id).map((fi) => fi.id),
      )
      const farmPlantings = plantings.filter((p) => {
        if (!farmFieldIds.has(p.field_id)) return false
        if (cropYear !== '' && p.season_year !== cropYear) return false
        if (cropId && p.crop_id !== cropId) return false
        return true
      })
      if (farmPlantings.length === 0) continue

      // Group plantings by crop.
      const byCrop = new Map<string, CropOnFarm>()
      for (const p of farmPlantings) {
        const fld = fieldById.get(p.field_id)
        if (!fld) continue
        const cropName = cropById.get(p.crop_id)?.name ?? '—'
        let cropAgg = byCrop.get(p.crop_id)
        if (!cropAgg) {
          cropAgg = {
            cropId: p.crop_id,
            cropName,
            fields: [],
            totals: { acres: 0, dryBu: 0, landlordBu: 0 },
          }
          byCrop.set(p.crop_id, cropAgg)
        }
        const acres = Number(p.planted_acres)
        const dryBu = dryBuByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`) ?? 0
        const landlordBu = dryBu * fpct
        cropAgg.fields.push({
          fieldName: fld.name_or_number,
          acres,
          dryBu,
          landlordBu,
          yieldBuPerAc: acres > 0 ? dryBu / acres : null,
        })
        cropAgg.totals.acres += acres
        cropAgg.totals.dryBu += dryBu
        cropAgg.totals.landlordBu += landlordBu
      }

      const ownerKey = farm.landowner_id ?? NO_LANDOWNER_KEY
      let group = byOwner.get(ownerKey)
      if (!group) {
        const l = farm.landowner_id ? landownerById.get(farm.landowner_id) : null
        group = {
          key: ownerKey,
          landownerName: l?.name ?? 'Owned / No Landowner',
          farms: [],
          byCrop: new Map(),
        }
        byOwner.set(ownerKey, group)
      }
      group.farms.push({
        farmName: farm.name,
        fsaNumber: farm.fsa_number,
        sharePercentage: farmPct,
        crops: [...byCrop.values()].sort((a, b) => a.cropName.localeCompare(b.cropName)),
      })

      // Roll into landowner totals and global summary.
      for (const c of byCrop.values()) {
        const ownerCropTotal = group.byCrop.get(c.cropId) ?? {
          cropName: c.cropName, acres: 0, dryBu: 0, landlordBu: 0,
        }
        ownerCropTotal.acres += c.totals.acres
        ownerCropTotal.dryBu += c.totals.dryBu
        ownerCropTotal.landlordBu += c.totals.landlordBu
        group.byCrop.set(c.cropId, ownerCropTotal)

        const sum = summary.get(c.cropId) ?? { cropName: c.cropName, landlordBu: 0 }
        sum.landlordBu += c.totals.landlordBu
        summary.set(c.cropId, sum)
      }
    }

    const sortedGroups = [...byOwner.values()].sort((a, b) => {
      if (a.key === NO_LANDOWNER_KEY) return 1
      if (b.key === NO_LANDOWNER_KEY) return -1
      return a.landownerName.localeCompare(b.landownerName)
    })
    return { groups: sortedGroups, summaryByCrop: [...summary.values()].sort((a, b) => a.cropName.localeCompare(b.cropName)) }
  }, [farms, fields, plantings, fieldById, cropById, landownerById, dryBuByKey, cropYear, cropId, entityId, landownerId])

  function filtersLabel(): string {
    const parts: string[] = [`Crop year: ${cropYear === '' ? '(none)' : cropYear}`]
    if (cropId) parts.push(`Crop: ${cropById.get(cropId)?.name ?? '?'}`)
    // For a viewer, "no entity selected" means their granted entities — name
    // them. Null for owners (keep existing wording).
    const entityName = entityId
      ? entities.find((e) => e.id === entityId)?.name ?? '?'
      : viewerAllEntitiesLabel(viewer, entities)
    if (entityName) parts.push(`Entity: ${entityName}`)
    if (landownerId) parts.push(`Landowner: ${landownerById.get(landownerId)?.name ?? '?'}`)
    return parts.join(' · ')
  }

  function buildExportPayload(): ExportPayload {
    const sections: ExportPayload['sections'] = []

    if (summaryByCrop.length > 0) {
      sections.push({
        title: 'Summary',
        columns: [
          { label: 'Crop' },
          { label: 'Bushels Owed (total)', align: 'right', format: 'bu' },
        ],
        rows: summaryByCrop.map((s) => [s.cropName, s.landlordBu]),
      })
    }

    // Real numbers (not toFixed strings) so Excel cells stay numeric; subtotal /
    // landowner-total rows are tagged so they render distinctly, like the screen.
    const detailRows: Array<Array<string | number>> = []
    const detailMeta: Array<'data' | 'subtotal' | 'total'> = []
    const yieldOf = (bu: number, ac: number): number | string => (ac > 0 ? bu / ac : '')
    for (const g of groups) {
      for (const f of g.farms) {
        for (const c of f.crops) {
          for (const r of c.fields) {
            detailRows.push([
              g.landownerName, f.farmName, f.fsaNumber ?? '', f.sharePercentage,
              c.cropName, r.fieldName,
              r.acres, r.dryBu, r.yieldBuPerAc ?? '', r.landlordBu,
            ])
            detailMeta.push('data')
          }
          detailRows.push([
            g.landownerName, f.farmName, f.fsaNumber ?? '', f.sharePercentage,
            c.cropName, `${c.cropName} subtotal`,
            c.totals.acres, c.totals.dryBu, yieldOf(c.totals.dryBu, c.totals.acres), c.totals.landlordBu,
          ])
          detailMeta.push('subtotal')
        }
      }
      for (const t of g.byCrop.values()) {
        detailRows.push([
          `${g.landownerName} — ${t.cropName} TOTAL`, '', '', '',
          t.cropName, '',
          t.acres, t.dryBu, yieldOf(t.dryBu, t.acres), t.landlordBu,
        ])
        detailMeta.push('total')
      }
    }

    sections.push({
      title: 'Detail',
      columns: [
        { label: 'Landowner' }, { label: 'Farm' }, { label: 'FSA #' }, { label: 'Share %', align: 'right', format: 'pct0' },
        { label: 'Crop' }, { label: 'Field' },
        { label: 'Acres', align: 'right', format: 'acres' }, { label: 'Dry bu', align: 'right', format: 'bu' },
        { label: 'Yield (bu/ac)', align: 'right', format: 'yield' }, { label: 'Landlord bu', align: 'right', format: 'bu' },
      ],
      rows: detailRows,
      rowMeta: detailMeta,
    })

    return {
      title: 'Share Rent Report',
      filters: filtersLabel(),
      summary: summaryByCrop.map((s) => ({ label: `${s.cropName} owed`, value: formatNumber(s.landlordBu, 'bu') })),
      sections,
    }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, summaryByCrop, cropYear, cropId, entityId, landownerId, viewer, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d })

  if (loading) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 no-print">
        <select
          value={cropYear}
          onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}
          className={inputCls}
        >
          <option value="">— pick a crop year —</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
        </select>
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">All crops</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {!(viewer.isViewer && entityOptions.length <= 1) && (
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
            <option value="">All entities</option>
            {entityOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        <select value={landownerId} onChange={(e) => setLandownerId(e.target.value)} className={inputCls}>
          <option value="">All landowners</option>
          {landowners.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {cropYear === '' ? (
        <EmptyState
          message="Pick a crop year to run the share rent report."
          hint="Choose a crop year above to see bushels owed by landowner."
          linkHref="/settings/farms"
          linkLabel="Set up share-rent farms"
        />
      ) : groups.length === 0 ? (
        <EmptyState
          message={`No share-rent farms have production in ${cropYear}.`}
          hint="Mark farms as share-rent with a landlord share percentage, or widen the filters above."
          linkHref="/settings/farms"
          linkLabel="Set up share-rent farms"
        />
      ) : (
        <div className="space-y-6">
          {/* Headline totals — bushels owed per crop across all landowners. */}
          {summaryByCrop.length > 0 && (
            <SummaryCards
              cards={summaryByCrop.map((s): SummaryCardData => ({
                label: `${s.cropName} owed`,
                value: `${fmt(s.landlordBu)} bu`,
                sub: `${cropYear} · all landowners`,
              }))}
            />
          )}

          {/* Summary card */}
          {summaryByCrop.length > 0 && (
            <section className="bg-white rounded-xl shadow p-4 avoid-break">
              <h2 className="font-bold text-lg mb-2">Total Bushels Owed — {cropYear}</h2>
              <table className="min-w-full text-sm border-collapse">
                <thead className={theadCls}>
                  <tr>
                    <th className={`${textCell} font-semibold`}>Crop</th>
                    <th className={`${numCell} font-semibold`}>Bushels owed across all landowners</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryByCrop.map((s) => (
                    <tr key={s.cropName} className="border-t border-slate-100">
                      <td className={`${textCell} font-semibold`}>{s.cropName}</td>
                      <td className={`${numCell} tabular-nums`}>{fmt(s.landlordBu)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Per-landowner sections */}
          {groups.map((g) => (
            <section key={g.key} className="bg-white rounded-xl shadow overflow-hidden avoid-break">
              <header className="bg-slate-100 px-4 py-2 flex items-baseline gap-2 flex-wrap">
                <h2 className="font-bold text-lg">{g.landownerName}</h2>
                <span className="text-xs text-slate-500">{g.farms.length} share-rent farm{g.farms.length === 1 ? '' : 's'}</span>
              </header>

              {g.farms.map((f, fi) => (
                <div key={fi} className="px-4 py-3 border-t border-slate-100">
                  <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                    <h3 className="font-semibold">{f.farmName}</h3>
                    {f.fsaNumber && <span className="text-xs text-slate-500">FSA #{f.fsaNumber}</span>}
                    <span className="ml-auto text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">
                      Landlord share: {f.sharePercentage}%
                    </span>
                  </div>
                  {f.crops.map((c) => (
                    <div key={c.cropId} className="mb-3">
                      <div className="text-sm font-semibold text-slate-700 mb-1">{c.cropName}</div>
                      <table className="min-w-full text-sm border-collapse">
                        <thead className={theadCls}>
                          <tr>
                            <th className={`${textCell} font-semibold`}>Field</th>
                            <th className={`${numCell} font-semibold`}>Acres</th>
                            <th className={`${numCell} font-semibold`}>Dry bu</th>
                            <th className={`${numCell} font-semibold`}>Yield (bu/ac)</th>
                            <th className={`${numCell} font-semibold`}>Landlord bu</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.fields.map((r, ri) => (
                            <tr key={ri} className="border-t border-slate-100">
                              <td className={textCell}>{r.fieldName}</td>
                              <td className={`${numCell} tabular-nums`}>{fmt(r.acres)}</td>
                              <td className={`${numCell} tabular-nums`}>{fmt(r.dryBu)}</td>
                              <td className={`${numCell} tabular-nums`}>{r.yieldBuPerAc != null ? r.yieldBuPerAc.toFixed(1) : '—'}</td>
                              <td className={`${numCell} tabular-nums`}>{fmt(r.landlordBu)}</td>
                            </tr>
                          ))}
                          <tr className={`border-t border-slate-200 ${subtotalRowCls}`}>
                            <td className={`${textCell} italic`}>{c.cropName} subtotal</td>
                            <td className={`${numCell} tabular-nums`}>{fmt(c.totals.acres)}</td>
                            <td className={`${numCell} tabular-nums`}>{fmt(c.totals.dryBu)}</td>
                            <td className={`${numCell} tabular-nums`}>{c.totals.acres > 0 ? (c.totals.dryBu / c.totals.acres).toFixed(1) : '—'}</td>
                            <td className={`${numCell} tabular-nums`}>{fmt(c.totals.landlordBu)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              ))}

              {g.byCrop.size > 0 && (
                <div className={`px-4 py-3 ${grandTotalRowCls}`}>
                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{g.landownerName} — Total Owed</div>
                  <table className="min-w-full text-sm">
                    <tbody>
                      {[...g.byCrop.values()].map((t) => (
                        <tr key={t.cropName}>
                          <td className="pr-4 py-1 font-semibold">{t.cropName}</td>
                          <td className="pr-4 py-1 text-right tabular-nums">{fmt(t.acres)} ac</td>
                          <td className="pr-4 py-1 text-right tabular-nums">{fmt(t.dryBu)} bu produced</td>
                          <td className={`pr-4 py-1 text-right tabular-nums font-bold ${toneText('warning')}`}>{fmt(t.landlordBu)} bu owed</td>
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
