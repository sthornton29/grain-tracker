'use client'

import { useEffect, useMemo, useState } from 'react'
import CottonYieldsSection, { cottonSectionExport, type CottonSectionRow } from '@/components/reports/cotton-yields-section'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { buildDoubleCropSet } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fieldCropAggregates, analyzeYields, buildYieldInputs, harvestStatusOf, type CombineEntryLike, type CropAverage } from '@/lib/yields'
import { useCottonYields } from '@/lib/use-cotton-yields'
import { roleAllowsPath } from '@/lib/route-guard'
import { isCottonCrop } from '@/lib/marketing'
import { buildEntityScope } from '@/lib/entity-scope'
import { checkoffByCrop } from '@/lib/checkoff'
import { normalizeTicket } from '@/lib/ticket-matching'
import EntityFilter from '@/components/entity-filter'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import AvgYieldHeader from '@/components/reports/avg-yield-header'
import ExportBar from '@/components/export-bar'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import {
  SummaryCards,
  EmptyState,
  ReportHeader,
  ReportFilterBar,
  FilterField,
  numCell,
  textCell,
  theadCls,
  grandTotalRowCls,
  selectCls,
  fmtNum,
  fmtInt,
  fmtUsd,
  fmtPct,
  filterSummaryOf,
  cropYearLabel,
  type SummaryCardData,
} from '@/components/reports/report-kit'
import { useReportCropYear } from '@/lib/report-filters'
import type { Crop, CropAssumption, Entity, FieldPlanting, LoadSplit } from '@/lib/types'

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
  ticket_number: string | null
  to_buyer_id: string | null
}

// Settlements + their itemized checkoff lines (086) — the "Checkoff paid"
// block keys each settlement to a crop / crop year through its matched loads.
type SettlementLite = {
  id: string; buyer_id: string; settlement_date: string
  settlement_lines: Array<{ load_id: string | null; ticket_number: string | null; net_bushels: number | null }> | null
}

const currentYear = () => new Date().getFullYear()

export default function SeasonSummaryPage() {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [combineEntries, setCombineEntries] = useState<CombineEntryLike[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Array<{ id: string; name: string; entity_id: string | null }>>([])
  const [fields, setFields] = useState<Array<{ id: string; name_or_number: string; farm_id: string | null }>>([])
  const [loading, setLoading] = useState(true)
  // Filters persist across visits. The crop year follows the one report rule
  // (lib/report-filters): current year by default, never overwritten on load.
  const [yearValue, setYear] = useReportCropYear('season:year')
  const year = typeof yearValue === 'number' ? yearValue : currentYear()
  const [entityId, setEntityId] = usePersistentState('season:entity', '')

  async function refresh() {
    setLoading(true)
    const [cr, pl, lo, sp, en, fa, fi, ce, ca] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      fetchAllRows((f, t) => supabase.from('loads').select('id, date, time, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, ticket_number, to_buyer_id').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
      supabase.from('entities').select('*').order('name'),
      supabase.from('farms').select('id, name, entity_id'),
      supabase.from('fields').select('id, name_or_number, farm_id'),
      // May not exist yet (migration 062): an error leaves data null → [].
      fetchAllRows((f, t) => supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date').order('id').range(f, t)),
      // Expected yields (the thin-peers comparison tier), the crop-level
      // harvest-complete flag, and the cotton turnout (092).
      supabase.from('crop_assumptions').select('*'),
    ])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
    setSplits((sp.data as LoadSplit[]) || [])
    setEntities((en.data as Entity[]) || [])
    setFarms((fa.data as Array<{ id: string; name: string; entity_id: string | null }>) || [])
    setFields((fi.data as Array<{ id: string; name_or_number: string; farm_id: string | null }>) || [])
    setCombineEntries((ce.data as CombineEntryLike[]) || [])
    setAssumptions((ca.data as CropAssumption[]) || [])
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  // Cotton module (092): the seed-cotton classifier adapter + lint estimates;
  // inert (no reads) when the module is off.
  const cottonYields = useCottonYields(supabase, { crops, assumptions })
  const cottonModel = cottonYields.model
  const cottonOn = cottonYields.on === true

  // Checkoff paid (086) — settlements + itemized checkoff lines, keyed to the
  // crop / crop year of each settlement's matched loads (load_id, else a
  // unique buyer ticket match on the shared seam).
  const [settlements, setSettlements] = useState<SettlementLite[]>([])
  const [discountItems, setDiscountItems] = useState<Array<{ settlement_id: string; category: string; amount: number | null; deduction_kind: string | null }>>([])
  useEffect(() => {
    ;(async () => {
      const [s, items] = await Promise.all([
        fetchAllRows<SettlementLite>((f, t) => supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_lines(load_id, ticket_number, net_bushels)').order('id').range(f, t)),
        fetchAllRows<{ settlement_id: string; category: string; amount: number | null; deduction_kind: string | null }>((f, t) =>
          supabase.from('settlement_discount_items').select('settlement_id, category, amount, deduction_kind').order('id').range(f, t)),
      ])
      setSettlements(s.data ?? [])
      setDiscountItems(items.data ?? [])
    })()
  }, [supabase])
  const checkoffInputs = useMemo(() => {
    const itemsBy = new Map<string, typeof discountItems>()
    for (const it of discountItems) { const a = itemsBy.get(it.settlement_id) ?? []; a.push(it); itemsBy.set(it.settlement_id, a) }
    const loadById = new Map(loads.map((l) => [l.id, l]))
    const byBuyerTicket = new Map<string, LoadRow[]>()
    for (const l of loads) {
      const t = normalizeTicket(l.ticket_number)
      if (!t || !l.to_buyer_id) continue
      const key = `${l.to_buyer_id}|${t}`
      const a = byBuyerTicket.get(key) ?? []; a.push(l); byBuyerTicket.set(key, a)
    }
    const mode = <T,>(xs: T[]): T | null => { const m = new Map<T, number>(); for (const x of xs) if (x != null) m.set(x, (m.get(x) ?? 0) + 1); let best: T | null = null, n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v }; return best }
    return settlements.map((s) => {
      const matched: LoadRow[] = []
      for (const ln of s.settlement_lines ?? []) {
        if (ln.load_id) { const ld = loadById.get(ln.load_id); if (ld) matched.push(ld); continue }
        const cands = byBuyerTicket.get(`${s.buyer_id}|${normalizeTicket(ln.ticket_number)}`) ?? []
        if (cands.length === 1) matched.push(cands[0])
      }
      return {
        settlementId: s.id, buyerId: s.buyer_id, settlementDate: s.settlement_date,
        cropId: mode(matched.map((l) => l.crop_id)), cropYear: mode(matched.map((l) => l.crop_year)),
        settledBu: (s.settlement_lines ?? []).reduce((t, l) => t + (Number(l.net_bushels) || 0), 0),
        items: itemsBy.get(s.id) ?? [],
        fieldIds: matched.filter((l) => l.from_type === 'field' && l.from_field_id).map((l) => l.from_field_id as string),
      }
    })
  }, [settlements, discountItems, loads])

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

  // Checkoff paid for this season, narrowed to the entity's fields (a
  // settlement counts when any matched load came off an in-scope field).
  const checkoffRows = useMemo(
    () => checkoffByCrop(
      checkoffInputs.map((s) => (!scope.active || s.fieldIds.some((id) => scope.fieldIds?.has(id)) ? s : { ...s, items: [] })),
    ).filter((r) => r.cropYear === year),
    [checkoffInputs, scope, year],
  )

  const distinctYears = useMemo(() => {
    const s = new Set<number>([currentYear()])
    plantings.forEach((p) => s.add(p.season_year))
    return [...s].sort((a, b) => b - a)
  }, [plantings])

  const yearPlantings = scope.plantings(plantings.filter((p) => p.season_year === year))

  // Dry bushels + most-recent load date per field+crop+year (shared rules),
  // scoped to the selected season year.
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { loadYear: year, combineEntries }),
    [loads, splits, cropById, year, combineEntries],
  )
  const dryBuFor = (fieldId: string, cropId: string, yr: number) =>
    aggByKey.get(`${fieldId}|${cropId}|${yr}`)?.dryBu ?? 0

  // Unharvested / in-progress fields are excluded from the season's production
  // and yield (per crop). Acreage columns still count every planted field.
  // Cotton plantings (module on) classify off their seed cotton loads through
  // the same engine via the cotton adapter.
  const yieldAnalysis = useMemo(() => {
    return analyzeYields(buildYieldInputs({ plantings: yearPlantings, aggByKey, assumptions, cotton: cottonModel.adapter }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantings, assumptions, aggByKey, year, scope, cottonModel])
  const cropCompleteKeys = useMemo(() => {
    const s = new Set<string>()
    for (const a of assumptions) if (a.harvest_complete) s.add(`${a.crop_id}|${a.crop_year}`)
    return s
  }, [assumptions])

  // ---- Cotton table rows (092): one per cotton planting of the season ----
  const cottonRows = useMemo<CottonSectionRow[]>(() => {
    if (!cottonOn) return []
    const farmById = new Map(farms.map((f) => [f.id, f]))
    const fieldById = new Map(fields.map((f) => [f.id, f]))
    return yearPlantings
      .filter((p) => cottonModel.cottonCropIds.has(p.crop_id))
      .map((p) => {
        const fld = fieldById.get(p.field_id)
        const farm = fld?.farm_id ? farmById.get(fld.farm_id) : null
        const autoFlag = yieldAnalysis.autoExcluded.get(p.id)
        return {
          key: p.id, plantingId: p.id, fieldId: p.field_id, cropId: p.crop_id,
          cropName: cropById.get(p.crop_id)?.name ?? '\u2014', year: p.season_year,
          farmName: farm?.name ?? '\u2014 no farm \u2014', fieldName: fld?.name_or_number ?? '\u2014',
          acres: Number(p.planted_acres) || 0,
          y: cottonModel.yieldFor(p)!,
          status: harvestStatusOf(p, yieldAnalysis.excluded, cropCompleteKeys),
          autoFlag,
          overridden: p.yield_include_override === true && autoFlag === 'in_progress',
          noBaseline: yieldAnalysis.noBaseline.has(p.id),
        }
      })
      .sort((a, b) => a.farmName.localeCompare(b.farmName) || a.fieldName.localeCompare(b.fieldName))
  }, [cottonOn, yearPlantings, cottonModel, farms, fields, cropById, yieldAnalysis, cropCompleteKeys])
  const cottonTurnouts = useMemo(() => {
    if (!cottonOn) return []
    const ids = [...new Set(cottonRows.map((r) => r.cropId))]
    return ids.map((id) => {
      const a = assumptions.find((x) => x.crop_id === id && x.crop_year === year)
      return {
        cropId: id, cropName: cropById.get(id)?.name ?? 'Cotton', year,
        turnout: cottonModel.turnoutFor(id, year),
        manualPct: a?.assumed_turnout_pct != null ? Number(a.assumed_turnout_pct) : null,
      }
    })
  }, [cottonOn, cottonRows, cropById, year, cottonModel, assumptions])
  // The averages header: cotton crops speak in LINT lbs/ac (the classifier's
  // own figure for them is seed cotton).
  const displayAverages = useMemo(() => {
    const m = new Map<string, CropAverage>(yieldAnalysis.averages)
    const byCrop = new Map<string, { acres: number; lint: number }>()
    for (const r of cottonRows) {
      if (r.status !== 'complete') continue
      const cur = byCrop.get(r.cropId) ?? { acres: 0, lint: 0 }
      cur.acres += r.acres; cur.lint += r.y.lintLbs
      byCrop.set(r.cropId, cur)
    }
    for (const id of cottonModel.cottonCropIds) {
      const c = byCrop.get(id)
      if (c && c.acres > 0) m.set(id, { cropId: id, acres: c.acres, dryBu: c.lint, yield: c.lint / c.acres })
      else m.delete(id)
    }
    return m
  }, [yieldAnalysis, cottonRows, cottonModel])

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

  // Headline tiles from the values already computed above (same numbers as the
  // table totals — no new calculations). Weighted yield is grain bushels over
  // the harvested grain acres; % harvested counts every crop's harvested acres.
  const grainHarvestedAcres = byCrop.reduce((s, r) => s + (r.isCotton ? 0 : r.harvestedAcres), 0)
  const harvestedAcres = byCrop.reduce((s, r) => s + r.harvestedAcres, 0)
  const weightedYield = grainHarvestedAcres > 0 ? totals.dryBu / grainHarvestedAcres : null
  const pctHarvested = totals.acres > 0 ? (harvestedAcres / totals.acres) * 100 : null
  const summaryCards: SummaryCardData[] = [
    { label: 'Total acres', value: fmtNum(totals.acres, 1), sub: `${fmtNum(totals.irrigated, 1)} irrigated · ${fmtNum(totals.dryland, 1)} dryland` },
    { label: 'Dry bushels', value: fmtInt(totals.dryBu), sub: 'Harvested fields only' },
    { label: 'Weighted yield', value: weightedYield != null ? `${fmtNum(weightedYield, 1)} bu/ac` : '—' },
    { label: '% harvested', value: pctHarvested != null ? fmtPct(pctHarvested, 0) : '—', sub: `${fmtNum(harvestedAcres, 1)} of ${fmtNum(totals.acres, 1)} acres`, tone: pctHarvested != null && pctHarvested >= 100 ? 'favorable' : 'neutral' },
  ]
  const filterSummary = filterSummaryOf(cropYearLabel(year), entityName ?? 'All Entities')

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
      filters: filterSummary,
      summary: [
        { label: 'Total acres', value: formatNumber(totals.acres, 'acres') },
        { label: 'Dry bushels', value: formatNumber(totals.dryBu, 'bu') },
        { label: 'Weighted yield', value: weightedYield != null ? formatNumber(weightedYield, 'yield') : '—' },
        { label: '% harvested', value: pctHarvested != null ? formatNumber(pctHarvested, 'pct0') : '—' },
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
      },
      ...(cottonOn && cottonRows.length > 0 ? [cottonSectionExport(cottonRows, `Cotton — ${year}`)] : []),
      ...(checkoffRows.length > 0 ? [{
        title: 'Checkoff paid',
        columns: [
          { label: 'Crop' }, { label: 'Crop year', format: 'text' as const },
          { label: 'Checkoff $', align: 'right' as const, format: 'usd2' as const }, { label: '¢/bu', align: 'right' as const, format: 'dec2' as const },
          { label: 'Settled bu', align: 'right' as const, format: 'bu' as const }, { label: 'Settlements', align: 'right' as const, format: 'int' as const },
        ],
        rows: checkoffRows.map((r) => [cropById.get(r.cropId ?? '')?.name ?? 'Unassigned crop', r.cropYear ?? '', r.dollars, r.centsPerBu != null ? Number(r.centsPerBu.toFixed(2)) : '', Math.round(r.settledBu), r.settlements]),
      }] : []),
      ],
    }
  }

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Season Summary"
        filterSummary={filterSummary}
        actions={!loading && !viewer.loading && byCrop.length > 0 ? <ExportBar buildPayload={buildPayload} /> : undefined}
      />
      <ReportFilterBar activeCount={entityId ? 1 : 0}>
        <FilterField label="Crop year">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
            {distinctYears.map((y) => <option key={y} value={y}>{y}</option>)}
            {!distinctYears.includes(year) && <option value={year}>{year}</option>}
          </select>
        </FilterField>
        <EntityFilter entities={entityOptionsFor(viewer, entities)} value={entityId} onChange={setEntityId} />
      </ReportFilterBar>

      {loading || viewer.loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <AvgYieldHeader averages={displayAverages} cropName={(id) => cropById.get(id)?.name ?? '—'} unitOf={cottonOn ? (id) => (cottonModel.cottonCropIds.has(id) ? 'lbs' : 'bu') : undefined} />

          <SummaryCards cards={summaryCards} />

          {byCrop.length === 0 ? (
            <EmptyState
              message={`No plantings recorded for ${year}.`}
              hint="Record plantings and enter loads to build the season summary."
              linkHref="/loads"
              linkLabel="Enter loads"
              role={viewer.role}
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
                        <td className={numCell}>{fmtNum(r.fullSeasonAcres, 1)}</td>
                        <td className={numCell}>{fmtNum(r.doubleCropAcres, 1)}</td>
                        <td className={numCell}>{fmtNum(r.totalAcres, 1)}</td>
                        <td className={numCell}>{r.irrigatedAcres > 0 ? fmtNum(r.irrigatedAcres, 1) : '—'}</td>
                        <td className={numCell}>{r.drylandAcres > 0 ? fmtNum(r.drylandAcres, 1) : '—'}</td>
                        {r.isCotton ? (
                          <td colSpan={2} className={`${numCell} text-xs text-slate-400 font-normal`}>lbs of lint — see Cotton Yields below</td>
                        ) : (
                          <>
                            <td className={numCell}>{fmtInt(r.dryBu)}</td>
                            <td className={`${numCell} font-semibold`}>{yld != null ? fmtNum(yld, 1) : '—'}</td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                  <tr className={grandTotalRowCls}>
                    <td className={textCell}>Total</td>
                    <td className={numCell}>{fmtNum(totals.fullSeason, 1)}</td>
                    <td className={numCell}>{fmtNum(totals.doubleCrop, 1)}</td>
                    <td className={numCell}>{fmtNum(totals.acres, 1)}</td>
                    <td className={numCell}>{fmtNum(totals.irrigated, 1)}</td>
                    <td className={numCell}>{fmtNum(totals.dryland, 1)}</td>
                    <td className={numCell}>{fmtInt(totals.dryBu)}</td>
                    <td className={numCell}></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {/* Checkoff paid (086) — the itemized checkoff on this season's
          settlements by crop; some states refund it on request. */}
      {!loading && checkoffRows.length > 0 && (
        <section className="bg-white rounded-xl shadow p-4 avoid-break">
          <h2 className="font-bold text-lg mb-1">Checkoff paid</h2>
          <p className="text-xs text-slate-500 mb-2">From the itemized checkoff lines on the season&rsquo;s settlements — not a quality discount. Some states refund checkoff on request; this is the number to claim.</p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className={theadCls}>
                <tr>{['Crop', 'Crop year', 'Checkoff $', '¢/bu', 'Settled bu', 'Settlements'].map((h, i) => <th key={h} className={`${i >= 2 ? 'text-right' : 'text-left'} pr-4 py-1 font-medium whitespace-nowrap`}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {checkoffRows.map((r) => (
                  <tr key={`${r.cropId}|${r.cropYear}`} className="border-t border-slate-100">
                    <td className="pr-4 py-1">{cropById.get(r.cropId ?? '')?.name ?? 'Unassigned crop'}</td>
                    <td className="pr-4 py-1">{r.cropYear ?? '—'}</td>
                    <td className="pr-4 py-1 text-right tabular-nums font-semibold">{fmtUsd(r.dollars, 2)}</td>
                    <td className="pr-4 py-1 text-right tabular-nums">{r.centsPerBu != null ? `${fmtNum(r.centsPerBu, 2)}¢` : '—'}</td>
                    <td className="pr-4 py-1 text-right tabular-nums">{fmtInt(r.settledBu)}</td>
                    <td className="pr-4 py-1 text-right tabular-nums">{r.settlements}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {/* Cotton module (092): the same cotton table as the Yields page —
          seed cotton from loads, lint from receipts + the turnout estimate,
          harvest and ginning status per field. */}
      {cottonOn && !loading && cottonRows.length > 0 && (
        <CottonYieldsSection
          rows={cottonRows}
          turnouts={cottonTurnouts}
          model={cottonModel}
          title={`Cotton — ${year}`}
          subtitle="lint lbs/acre · seed cotton from loads · lint from gin receipts, estimated at the turnout until ginned"
          canEdit={false}
          allowLoadLinks={roleAllowsPath(viewer.role, '/cotton')}
          loading={cottonYields.loading}
        />
      )}
    </div>
  )
}
