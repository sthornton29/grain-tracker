'use client'

import { useEffect, useMemo, useState } from 'react'
import CottonYieldsSection from '@/components/reports/cotton-yields-section'
import { createClient } from '@/lib/supabase/client'
import { buildDoubleCropSet } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fieldCropAggregates, analyzeYields } from '@/lib/yields'
import { isCottonCrop } from '@/lib/marketing'
import { buildEntityScope } from '@/lib/entity-scope'
import EntityFilter from '@/components/entity-filter'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import AvgYieldHeader from '@/components/reports/avg-yield-header'
import ExportBar from '@/components/export-bar'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import {
  SummaryCards,
  EmptyState,
  numCell,
  textCell,
  theadCls,
  grandTotalRowCls,
  type SummaryCardData,
} from '@/components/reports/report-kit'
import type { Crop, Entity, FieldPlanting, LoadSplit } from '@/lib/types'

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

const currentYear = () => new Date().getFullYear()

export default function SeasonSummaryPage() {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Array<{ id: string; entity_id: string | null }>>([])
  const [fields, setFields] = useState<Array<{ id: string; farm_id: string | null }>>([])
  const [loading, setLoading] = useState(true)
  // Filters persist across visits (see usePersistentState).
  const [year, setYear] = usePersistentState<number>('season:year', currentYear())
  const [entityId, setEntityId] = usePersistentState('season:entity', '')

  async function refresh() {
    setLoading(true)
    const [cr, pl, lo, sp, en, fa, fi] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id'),
      supabase.from('load_splits').select('*'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('id, entity_id'),
      supabase.from('fields').select('id, farm_id'),
    ])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
    setSplits((sp.data as LoadSplit[]) || [])
    setEntities((en.data as Entity[]) || [])
    setFarms((fa.data as Array<{ id: string; entity_id: string | null }>) || [])
    setFields((fi.data as Array<{ id: string; farm_id: string | null }>) || [])
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])

  // Viewer role (052): the grant universe caps the entity scope and prunes the
  // entity dropdown; '' then means "all MY entities".
  const viewer = useViewerScope(supabase)

  // Shared entity scoping — acreage/production narrow to the entity's fields;
  // the season's assumptions and shared rules are untouched.
  const scope = useMemo(
    () => buildEntityScope({ entityId, farms, fields, entities, grantedEntityIds: viewer.grantedIds }),
    [entityId, farms, fields, entities, viewer.grantedIds],
  )
  const entityName = entityId
    ? entities.find((e) => e.id === entityId)?.name ?? null
    : viewerAllEntitiesLabel(viewer, entities)

  const distinctYears = useMemo(() => {
    const s = new Set<number>([currentYear()])
    plantings.forEach((p) => s.add(p.season_year))
    return [...s].sort((a, b) => b - a)
  }, [plantings])

  const yearPlantings = scope.plantings(plantings.filter((p) => p.season_year === year))

  // Dry bushels + most-recent load date per field+crop+year (shared rules),
  // scoped to the selected season year.
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { loadYear: year }),
    [loads, splits, cropById, year],
  )
  const dryBuFor = (fieldId: string, cropId: string, yr: number) =>
    aggByKey.get(`${fieldId}|${cropId}|${yr}`)?.dryBu ?? 0

  // Unharvested / in-progress fields are excluded from the season's production
  // and yield (per crop). Acreage columns still count every planted field.
  const yieldAnalysis = useMemo(() => analyzeYields(
    yearPlantings.map((p) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [plantings, aggByKey, year, scope])

  type Agg = {
    cropName: string
    // Cotton is lbs-native — its production/yield live in the Cotton Yields
    // section below, never in this table's bushel columns.
    isCotton: boolean
    fullSeasonAcres: number
    doubleCropAcres: number
    totalAcres: number
    irrigatedAcres: number
    drylandAcres: number
    dryBu: number
    // Acres of the harvested, included fields only — the denominator for yield
    // so partial/unharvested fields don't drag bu/ac down.
    harvestedAcres: number
  }

  const doubleCropIds = useMemo(
    () => buildDoubleCropSet(plantings, cropById),
    [plantings, cropById],
  )

  const byCrop = useMemo(() => {
    const excluded = yieldAnalysis.excluded
    const m = new Map<string, Agg>()
    for (const p of yearPlantings) {
      const cropName = cropById.get(p.crop_id)?.name ?? '—'
      const key = p.crop_id
      if (!m.has(key)) m.set(key, {
        cropName,
        isCotton: isCottonCrop(cropName),
        fullSeasonAcres: 0, doubleCropAcres: 0, totalAcres: 0,
        irrigatedAcres: 0, drylandAcres: 0, dryBu: 0, harvestedAcres: 0,
      })
      const agg = m.get(key)!
      const acres = Number(p.planted_acres)
      agg.totalAcres += acres
      agg.irrigatedAcres += Number(p.irrigated_acres) || 0
      agg.drylandAcres   += Number(p.dryland_acres)   || 0
      if (doubleCropIds.has(p.id)) agg.doubleCropAcres += acres
      else agg.fullSeasonAcres += acres
      // Production + yield count only harvested, non-in-progress fields.
      if (!excluded.has(p.id)) {
        agg.dryBu += dryBuFor(p.field_id, p.crop_id, p.season_year)
        agg.harvestedAcres += acres
      }
    }
    return [...m.values()].sort((a, b) => a.cropName.localeCompare(b.cropName))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearPlantings, cropById, aggByKey, yieldAnalysis, doubleCropIds, scope])

  const totals = byCrop.reduce(
    (acc, r) => {
      acc.acres += r.totalAcres
      acc.dryBu += r.dryBu
      acc.fullSeason += r.fullSeasonAcres
      acc.doubleCrop += r.doubleCropAcres
      acc.irrigated += r.irrigatedAcres
      acc.dryland += r.drylandAcres
      return acc
    },
    { acres: 0, dryBu: 0, fullSeason: 0, doubleCrop: 0, irrigated: 0, dryland: 0 }
  )

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const fmt = (n: number, d = 1) => n.toLocaleString(undefined, { maximumFractionDigits: d })

  // Headline tiles from the values already computed above (same numbers as the
  // table totals / crop count — no new calculations).
  const summaryCards: SummaryCardData[] = [
    { label: 'Crops planted', value: String(byCrop.length) },
    { label: 'Total acres', value: fmt(totals.acres, 2) },
    { label: 'Irrigated acres', value: fmt(totals.irrigated, 2) },
    { label: 'Dryland acres', value: fmt(totals.dryland, 2) },
  ]

  // Export mirrors the on-screen table (real numbers + shared formatting).
  function buildPayload(): ExportPayload {
    const rows = byCrop.map((r) => {
      const yld = !r.isCotton && r.harvestedAcres > 0 ? r.dryBu / r.harvestedAcres : ''
      return [
        r.isCotton ? `${r.cropName} (lbs — see Cotton Yields)` : r.cropName, r.fullSeasonAcres, r.doubleCropAcres, r.totalAcres,
        r.irrigatedAcres > 0 ? r.irrigatedAcres : '', r.drylandAcres > 0 ? r.drylandAcres : '',
        r.isCotton ? '' : r.dryBu, yld,
      ]
    })
    rows.push(['Total', totals.fullSeason, totals.doubleCrop, totals.acres, totals.irrigated, totals.dryland, totals.dryBu, ''])
    return {
      title: 'Season Summary',
      filters: `Season: ${year}${entityName ? ` · Entity: ${entityName}` : ''}`,
      summary: [
        { label: 'Crops planted', value: formatNumber(byCrop.length, 'int') },
        { label: 'Total acres', value: formatNumber(totals.acres, 'acres') },
        { label: 'Irrigated acres', value: formatNumber(totals.irrigated, 'acres') },
        { label: 'Dryland acres', value: formatNumber(totals.dryland, 'acres') },
      ],
      sections: [{
        columns: [
          { label: 'Crop' },
          { label: 'Full-season ac', align: 'right', format: 'acres' }, { label: 'Double-crop ac', align: 'right', format: 'acres' },
          { label: 'Total ac', align: 'right', format: 'acres' }, { label: 'Irrigated ac', align: 'right', format: 'acres' },
          { label: 'Dryland ac', align: 'right', format: 'acres' }, { label: 'Dry bu', align: 'right', format: 'bu' },
          { label: 'Yield (bu/ac)', align: 'right', format: 'yield' },
        ],
        rows,
        rowMeta: [...byCrop.map(() => 'data' as const), 'total'],
      }],
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">
          Season Summary
          {entityName && <span className="ml-2 text-base font-semibold text-slate-500">— {entityName}</span>}
        </h1>
        <label className="text-sm flex items-center gap-2">
          Season
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={inputCls}>
            {distinctYears.map((y) => <option key={y} value={y}>{y}</option>)}
            {!distinctYears.includes(year) && <option value={year}>{year}</option>}
          </select>
        </label>
        <EntityFilter entities={entityOptionsFor(viewer, entities)} value={entityId} onChange={setEntityId} className="no-print" />
        {!loading && !viewer.loading && byCrop.length > 0 && <ExportBar buildPayload={buildPayload} />}
      </div>

      {loading || viewer.loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <AvgYieldHeader averages={yieldAnalysis.averages} cropName={(id) => cropById.get(id)?.name ?? '—'} />

          <SummaryCards cards={summaryCards} />

          {byCrop.length === 0 ? (
            <EmptyState
              message={`No plantings recorded for ${year}.`}
              hint="Record plantings and enter loads to build the season summary."
              linkHref="/loads"
              linkLabel="Enter loads"
            />
          ) : (
            <div className="overflow-x-auto bg-white rounded-xl shadow">
              <table className="min-w-full text-sm">
                <thead className={theadCls}>
                  <tr>
                    {['Crop','Full-season ac','Double-crop ac','Total ac','Irrigated ac','Dryland ac','Dry bu','Yield (bu/ac)']
                      .map((h, i) => <th key={i} className={`${i === 0 ? 'text-left' : 'text-right'} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {byCrop.map((r) => {
                    const yld = !r.isCotton && r.harvestedAcres > 0 ? r.dryBu / r.harvestedAcres : null
                    return (
                      <tr key={r.cropName} className="border-t border-slate-100">
                        <td className={`${textCell} font-semibold`}>{r.cropName}</td>
                        <td className={numCell}>{fmt(r.fullSeasonAcres, 2)}</td>
                        <td className={numCell}>{fmt(r.doubleCropAcres, 2)}</td>
                        <td className={numCell}>{fmt(r.totalAcres, 2)}</td>
                        <td className={numCell}>{r.irrigatedAcres > 0 ? fmt(r.irrigatedAcres, 2) : '—'}</td>
                        <td className={numCell}>{r.drylandAcres > 0 ? fmt(r.drylandAcres, 2) : '—'}</td>
                        {r.isCotton ? (
                          <td colSpan={2} className={`${numCell} text-xs text-slate-400 font-normal`}>lbs of lint — see Cotton Yields below</td>
                        ) : (
                          <>
                            <td className={numCell}>{fmt(r.dryBu, 2)}</td>
                            <td className={`${numCell} font-semibold`}>{yld != null ? yld.toFixed(1) : '—'}</td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                  <tr className={grandTotalRowCls}>
                    <td className={textCell}>Total</td>
                    <td className={numCell}>{fmt(totals.fullSeason, 2)}</td>
                    <td className={numCell}>{fmt(totals.doubleCrop, 2)}</td>
                    <td className={numCell}>{fmt(totals.acres, 2)}</td>
                    <td className={numCell}>{fmt(totals.irrigated, 2)}</td>
                    <td className={numCell}>{fmt(totals.dryland, 2)}</td>
                    <td className={numCell}>{fmt(totals.dryBu, 2)}</td>
                    <td className={numCell}></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {/* Cotton module (feature-flagged): lint lbs/acre from gin receipts. */}
      <CottonYieldsSection year={year} entityId={entityId} />
    </div>
  )
}
