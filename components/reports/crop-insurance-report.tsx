'use client'

// Crop Insurance Production Report.
//
// Mirrors the spreadsheet format crop insurance agents accept: one Summary
// sheet plus one detail sheet per (county, practice) combination. Acres come
// from field_plantings.irrigated_acres / dryland_acres; production comes from
// loads + load_splits with optional per-planting irrigated/dryland breakouts.
// ALL of the rules live in lib/production-report.ts (buildProductionReport) —
// this file renders them and builds the exports.
//
// Mixed-practice plantings (both irrigated and dryland acres) without a
// production breakout are gated, but only once their harvest is complete —
// an unharvested or still-in-progress field has no final production to split,
// so it never blocks the report. Completion uses the same analyzeYields logic
// as the Yields page. For a gated planting the user either fills in the
// breakout on the Yields page or chooses to roll the production into dryland.
// Fields still being harvested are left out of the report (acres and
// production), listed below the filters with a Count anyway button.
//
// Exports: PDF / Print mirror the screen through the shared ExportPayload.
// Excel is the AUDIT WORKBOOK (lib/production-audit-workbook.ts): every
// summary number a live formula tracing back to the loads.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { type CombineEntryLike } from '@/lib/yields'
import { useCottonYields } from '@/lib/use-cotton-yields'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { roleCanEditYields } from '@/lib/app-role'
import { useViewerAssumptions } from '@/lib/use-viewer-assumptions'
import { resolveCropAssumptions } from '@/lib/viewer-assumptions'
import { SupersededNotice } from '@/components/viewer-scenario'
import { EmptyState, ReportHeader, ReportFilterBar, FilterField, theadCls, grandTotalRowCls, stickyColCls, stickyColHeadCls, selectCls, fmtNum, fmtInt, filterSummaryOf, cropYearLabel } from '@/components/reports/report-kit'
import ExportBar from '@/components/export-bar'
import { ConfirmDialog } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'
import { useReportCropYear } from '@/lib/report-filters'
import { fetchLoadSales, type LoadSale } from '@/lib/load-sales'
import { fetchOrgBranding } from '@/lib/branding'
import { type ExportPayload } from '@/lib/exports'
import {
  buildProductionReport, loadIdsOfPlantings, practiceLabel, unitOf, EXCLUDED_LOAD_REASON,
  type DetailSheet, type ExcludedLoad, type FarmCropCell, type SummaryRow,
} from '@/lib/production-report'
import { buildProductionBalance, balanceFactors, factorLabel, BINS_NOTE, type BalanceSettlement, type BalanceSettlementLine } from '@/lib/production-balance'
import { buildProductionAuditPayload, type AuditCottonReceipt, type AuditLoadRow, type ProductionBasis } from '@/lib/production-audit-workbook'
import type {
  County, Crop, CropAssumption, Entity, Farm, Field, FieldPlanting, LoadSplit,
} from '@/lib/types'

// Every load column the audit workbook lists (the engine reads a subset).
const LOAD_SELECT = 'id, date, time, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, from_bin_id, practice, gross_weight, tare_weight, test_weight, ticket_number, buyer_ticket_number, truck_id, truck_label, hauler_truck, to_type, to_bin_id, to_buyer_id'

const BASIS_LABEL: Record<ProductionBasis, string> = { measured: 'Measured (scale tickets)', balanced: 'Balanced to settlements' }

export default function CropInsuranceReport() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<AuditLoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [combineEntries, setCombineEntries] = useState<Array<CombineEntryLike & { notes?: string | null }>>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  // "Balance to settlements" sources (lib/production-balance): every saved
  // settlement line and its settlement, plus buyer / bin names for the panel.
  const [settlementLines, setSettlementLines] = useState<BalanceSettlementLine[]>([])
  const [settlements, setSettlements] = useState<BalanceSettlement[]>([])
  const [buyers, setBuyers] = useState<Array<{ id: string; name: string }>>([])
  const [bins, setBins] = useState<Array<{ id: string; name_or_number: string }>>([])

  // Filters persist across visits. The crop year follows the one report rule
  // (lib/report-filters): current year by default, a saved pick is never
  // overwritten on load; only an untouched default falls back to the newest
  // year with plantings.
  const [plantingYears, setPlantingYears] = useState<number[]>([])
  const [cropYear, setCropYear] = useReportCropYear('crop-insurance:cropYear', { options: plantingYears, loaded: !loading })
  const [entityId, setEntityId] = usePersistentState('crop-insurance:entityId', '')
  // Optional crop filter — empty means all crops. Multi-select via toggle chips.
  const [cropIds, setCropIds] = usePersistentState<string[]>('crop-insurance:cropIds', [])
  // Production basis: measured scale tickets (default) or balanced so the
  // bushels the buyers paid for match the production records. A report
  // option only — Yields, Marketing, Claims and the partner API stay measured.
  const [basis, setBasis] = usePersistentState<ProductionBasis>('crop-insurance:basis', 'measured')
  // Gate state for mixed-without-breakout plantings. The user must explicitly
  // resolve this before we generate the report — either fill in the breakout
  // upstream or accept that production rolls into dryland.
  const [acceptedAsDryland, setAcceptedAsDryland] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('summary')
  useEffect(() => {
    ;(async () => {
      const [cr, en, fa, fi, co, pl, lo, sp, ca, ce, sl, st, bu, bi] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('counties').select('*').order('state_code').order('name'),
        supabase.from('field_plantings').select('*'),
        fetchAllRows((f, t) => supabase.from('loads').select(LOAD_SELECT).order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
        supabase.from('crop_assumptions').select('*'),
        // May not exist yet (migration 062): an error leaves data null → [].
        fetchAllRows((f, t) => supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date, notes').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('settlement_lines').select('id, settlement_id, load_id, net_bushels, ticket_number').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_number').order('id').range(f, t)),
        supabase.from('buyers').select('id, name'),
        supabase.from('bins').select('id, name_or_number'),
      ])
      setCrops((cr.data as Crop[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as Farm[]) || [])
      setFields((fi.data as Field[]) || [])
      setCounties((co.data as County[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoads((lo.data as AuditLoadRow[]) || [])
      setSplits((sp.data as LoadSplit[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setCombineEntries((ce.data as Array<CombineEntryLike & { notes?: string | null }>) || [])
      setSettlementLines((sl.data as BalanceSettlementLine[]) || [])
      setSettlements((st.data as BalanceSettlement[]) || [])
      setBuyers((bu.data as Array<{ id: string; name: string }>) || [])
      setBins((bi.data as Array<{ id: string; name_or_number: string }>) || [])
      setPlantingYears(Array.from(new Set(((pl.data as FieldPlanting[] | null) ?? []).map((p) => p.season_year))))
      setLoading(false)
    })()
  }, [supabase])

  // Reset the dryland-rollover choice whenever filters change — the set of
  // affected plantings depends on the year, so the user should re-confirm.
  useEffect(() => {
    setAcceptedAsDryland(false)
  }, [cropYear, entityId, cropIds])

  // "Count anyway" on a still-harvesting field — the same persisted override
  // the Yields page sets (field_plantings.yield_include_override), so the
  // field counts as finished everywhere. Only the plantings are refetched.
  const [overrideSavingId, setOverrideSavingId] = useState<string | null>(null)
  const [overrideErr, setOverrideErr] = useState<string | null>(null)
  // The "count anyway" confirmation (an app dialog, not window.confirm).
  const [countAsk, setCountAsk] = useState<{ p: FieldPlanting; name: string } | null>(null)
  async function countAnyway(p: FieldPlanting) {
    setCountAsk(null)
    setOverrideErr(null)
    setOverrideSavingId(p.id)
    const { error } = await supabase
      .from('field_plantings')
      .update({ yield_include_override: true })
      .eq('id', p.id)
    if (!error) {
      const pl = await fetchAllRows((f, t) => supabase.from('field_plantings').select('*').order('id').range(f, t))
      setPlantings((pl.data as FieldPlanting[]) || [])
    }
    setOverrideSavingId(null)
    if (error) setOverrideErr(reportError(error, { action: 'count this field as finished' }))
  }

  // Viewer role (052): grants prune the entity dropdown and name the export's
  // entity label; the viewer's private overrides layer over crop_assumptions.
  // The row data itself (farms/fields/loads) is already RLS-scoped server-side,
  // so the hand-rolled entity filtering below stays as-is.
  const viewer = useViewerScope(supabase)
  const viewerA = useViewerAssumptions(supabase, viewer)
  const assumptionRes = useMemo(() => resolveCropAssumptions(assumptions, viewerA.overrides), [assumptions, viewerA.overrides])
  const effAssumptions = assumptionRes.rows
  useEffect(() => { if (assumptionRes.staleIds.length > 0) viewerA.cleanupStale(assumptionRes.staleIds) }, [assumptionRes, viewerA])
  // Cotton module (092): cotton plantings classify off their seed cotton loads
  // and report lint lbs (receipts + the turnout estimate on unginned seed
  // cotton) as their production. Inert when the module is off.
  const cottonYields = useCottonYields(supabase, { crops, assumptions: effAssumptions })
  const cottonModel = cottonYields.model

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])

  // THE engine (lib/production-report.ts): filters → harvest status → gate →
  // resolved plantings → county × practice sheets → summary. The balance is
  // crop-wide across every entity, so it reads an all-entities MEASURED run.
  const engineInput = useMemo(() => ({
    cropYear, entityId, cropIds, plantings, fields, farms, counties, crops, loads, splits, combineEntries,
    assumptions: effAssumptions, cotton: cottonModel, acceptedAsDryland,
  }), [cropYear, entityId, cropIds, plantings, fields, farms, counties, crops, loads, splits, combineEntries, effAssumptions, cottonModel, acceptedAsDryland])
  const measuredAll = useMemo(() => buildProductionReport({ ...engineInput, entityId: '' }), [engineInput])
  const balance = useMemo(() => {
    if (basis !== 'balanced' || cropYear === '') return null
    return buildProductionBalance({
      cropYear, crops, cottonCropIds: cottonModel.cottonCropIds, loads, lines: settlementLines, settlements,
      measuredByCrop: new Map([...measuredAll.summaryTotals].map(([id, c]) => [id, c.bu])),
      // aggByKey is keyed `${fieldId}|${cropId}|${year}`; a combine block is the netted remainder posted to its bin.
      combineRemainders: [...measuredAll.aggByKey.entries()].filter(([, a]) => a.combine).map(([k, a]) => ({ crop_id: k.split('|')[1], crop_year: cropYear, destinationBinId: a.combine!.destinationBinId, remainderBu: a.combine!.remainderBu })),
      excludeLoadIds: loadIdsOfPlantings(loads, splits, measuredAll.inProgress),
    })
  }, [basis, cropYear, crops, cottonModel, loads, splits, settlementLines, settlements, measuredAll])
  const report = useMemo(
    () => buildProductionReport({ ...engineInput, balanceFactorByCrop: balanceFactors(balance) }),
    [engineInput, balance],
  )
  const { cropFilterOptions, mixedWithoutBreakout, inProgress, isBlocked, reportCrops, detailSheets, summaryRows, summaryTotals, excludedLoads } = report
  const grainBalances = useMemo(() => (balance ? reportCrops.filter((c) => balance.byCrop.has(c.id)).map((c) => balance.byCrop.get(c.id)!) : []), [balance, reportCrops])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  // Switch back to summary tab when the available sheet list changes, so we
  // never linger on a tab that no longer exists.
  useEffect(() => {
    if (activeTab !== 'summary' && !detailSheets.some((s) => s.sheetName === activeTab)) {
      setActiveTab('summary')
    }
  }, [detailSheets, activeTab])

  // A viewer with no entity selected reports over their granted entities, and
  // the title/filter line must say so by name.
  const entityName = entityId
    ? (entities.find((e) => e.id === entityId)?.name ?? '')
    : (viewerAllEntitiesLabel(viewer, entities) ?? '')
  const entityOptions = entityOptionsFor(viewer, entities)
  const reportTitle = `${entityName ? entityName + ' ' : ''}${cropYear === '' ? '' : cropYear + ' '}Production Report${balance ? ' — balanced to settlements' : ''}`
  const cropFilterLabel = cropIds.length === 0 ? 'All crops' : cropIds.map((id) => cropById.get(id)?.name ?? '').filter(Boolean).join(', ')

  // Build the shared ExportPayload (PDF / Print): a Summary section (one sheet)
  // listing each county × practice with per-crop acres/bu, then one section
  // (sheet) per county × practice detailing farms. Dynamic crop columns come
  // from reportCrops.
  function buildPayload(): ExportPayload {
    // Mirror the on-screen grouped layout: three per-crop metric groups —
    // Certified Acres, Production, Yield/Acre — each spanning every crop, with
    // the crop name as the column header. (The screen shows all three; earlier
    // exports dropped Yield/Acre entirely.)
    const metricCols = (fmt: 'acres' | 'bu' | 'yield') =>
      reportCrops.map((c) => ({ label: c.name, align: 'right' as const, format: fmt }))
    const cropCols = (): ExportPayload['sections'][number]['columns'] =>
      [...metricCols('acres'), ...metricCols('bu'), ...metricCols('yield')]
    // Values for all three metrics across every crop. Blank where the screen is
    // blank — 0 acres / 0 bu render empty, and yield needs both to be positive.
    const metricCells = (byCrop: Map<string, FarmCropCell>): Array<string | number> => {
      const acres = reportCrops.map((c) => { const v = byCrop.get(c.id); return v && v.acres > 0 ? v.acres : '' })
      const bu = reportCrops.map((c) => { const v = byCrop.get(c.id); return v && v.bu > 0 ? v.bu : '' })
      const yld = reportCrops.map((c) => { const v = byCrop.get(c.id); return v && v.acres > 0 && v.bu > 0 ? v.bu / v.acres : '' })
      return [...acres, ...bu, ...yld]
    }
    const metricGroups = (acresLabel: string, prodLabel: string): ExportPayload['sections'][number]['groups'] =>
      reportCrops.length > 0
        ? [
            { label: '', span: 2 },
            { label: acresLabel, span: reportCrops.length },
            { label: prodLabel, span: reportCrops.length },
            { label: 'Yield/Acre (Bu. Or Lbs.)', span: reportCrops.length },
          ]
        : undefined

    const sections: ExportPayload['sections'] = []

    // Summary section.
    const summarySection: ExportPayload['sections'][number] = {
      title: 'Summary',
      columns: [{ label: 'County' }, { label: 'Practice' }, ...cropCols()],
      groups: metricGroups('Certified Acres', 'Production (Bu. Or Lbs.)'),
      rows: summaryRows.map((r) => [r.countyLabel, practiceLabel(r.practice), ...metricCells(r.byCrop)]),
      rowMeta: summaryRows.map(() => 'data' as const),
    }
    summarySection.rows.push(['Total', '', ...metricCells(summaryTotals)])
    summarySection.rowMeta!.push('total')
    sections.push(summarySection)

    // Balanced: the reconciliation panel, printed.
    if (balance && grainBalances.length > 0) {
      sections.push({
        title: 'Settlement balance',
        columns: [
          { label: 'Crop' }, { label: 'Measured (bu)', format: 'bu3', align: 'right' }, { label: 'Settled, paid (bu)', format: 'bu3', align: 'right' }, { label: 'Settlements', format: 'int', align: 'right' },
          { label: 'Delivered, not settled (bu)', format: 'bu3', align: 'right' }, { label: 'Unsettled loads', format: 'int', align: 'right' }, { label: 'Still in bins (bu)', format: 'bu3', align: 'right' },
          { label: 'Balanced total (bu)', format: 'bu3', align: 'right' }, { label: 'Factor', format: 'factor', align: 'right' }, { label: 'Change', format: 'ratio', align: 'right' }, { label: 'Note' },
        ],
        rows: grainBalances.map((b) => [
          b.cropName, b.measured, b.settled, b.settlementCount, b.unsettled, b.unsettledLoads.length, b.bins, b.balancedTotal, b.factor, b.factor - 1,
          [b.allPaid ? 'production equals bushels paid' : 'balance will change as settlements arrive', b.warn ? 'check for a missing settlement or load' : '', b.unmatched.lines > 0 ? `${b.unmatched.lines} unmatched settlement line${b.unmatched.lines === 1 ? '' : 's'} (${fmtNum(b.unmatched.bu, 0)} bu) not counted` : ''].filter(Boolean).join('; '),
        ]),
      })
    }

    // One detail section (sheet) per county × practice.
    for (const s of detailSheets) {
      const practice = practiceLabel(s.practice)
      const farms = [...s.farms.values()]
      const rows: Array<Array<string | number>> = farms.map((f) => [f.farmName, f.fsaNumber ?? '', ...metricCells(f.byCrop)])
      const totalByCrop = summaryRows.find((r) => r.sheetName === s.sheetName)?.byCrop ?? new Map()
      rows.push(['Total', '', ...metricCells(totalByCrop)])
      sections.push({
        title: s.sheetName,
        columns: [{ label: 'Farm' }, { label: 'FSA #' }, ...cropCols()],
        groups: metricGroups(`Certified ${practice} Acres`, `${practice} Production (Bu. Or Lbs.)`),
        rows,
        rowMeta: [...farms.map(() => 'data' as const), 'total'],
      })
    }

    return {
      title: reportTitle,
      filters: [
        cropYear === '' ? 'All crop years' : `${cropYear} crop`,
        entityName || 'All entities',
        cropFilterLabel,
        `Production basis: ${BASIS_LABEL[balance ? 'balanced' : 'measured']}`,
      ].join(' · '),
      sections,
    }
  }

  // The Excel export: the audit workbook. Fetches the cross-check sources the
  // screen never needs (buyers, bins, trucks, settlement matches, the gin
  // receipts and bales behind a cotton crop, the org name) only when clicked.
  async function buildAuditPayload(): Promise<ExportPayload> {
    if (cropYear === '') throw new Error('Pick a crop year first.')
    const yearLoadIds = loads.filter((l) => l.from_type === 'field' && l.crop_year === cropYear).map((l) => l.id)
    const hasCotton = cottonModel.on === true && reportCrops.some((c) => cottonModel.cottonCropIds.has(c.id))
    const [tr, sales, org, gr, gb, gi] = await Promise.all([
      supabase.from('trucks').select('id, name_or_number'),
      fetchLoadSales(supabase, { loadIds: yearLoadIds }).catch(() => [] as LoadSale[]),
      fetchOrgBranding(supabase).catch(() => ({ displayName: 'Farm' })),
      hasCotton
        ? fetchAllRows((f, t) => supabase.from('gin_receipts').select('id, gin_id, receipt_number, statement_number, receipt_date, farm_id, field_id, crop_year, modules_count, total_seed_cotton_weight, bales_count, total_bale_weight').eq('crop_year', cropYear).order('id').range(f, t))
        : Promise.resolve({ data: [] as AuditCottonReceipt[] }),
      hasCotton
        ? fetchAllRows((f, t) => supabase.from('cotton_bales').select('id, gin_receipt_id, pbi_number, net_weight_lbs').eq('crop_year', cropYear).order('id').range(f, t))
        : Promise.resolve({ data: [] as Array<{ id: string; gin_receipt_id: string; pbi_number: string; net_weight_lbs: number }> }),
      hasCotton ? supabase.from('gins').select('id, name') : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    ])
    return buildProductionAuditPayload({
      report,
      cropYear,
      entityName,
      cropFilterLabel,
      orgName: org.displayName,
      generatedAt: new Date(),
      appOrigin: typeof window !== 'undefined' ? window.location.origin : null,
      crops, fields, farms, counties, loads, splits, combineEntries,
      buyers,
      bins,
      trucks: (tr.data as Array<{ id: string; name_or_number: string }>) ?? [],
      loadSales: sales,
      settlementLines,
      settlements,
      basis: balance ? 'balanced' : 'measured',
      balance,
      cotton: hasCotton
        ? {
            receipts: (gr.data as AuditCottonReceipt[] | null) ?? [],
            bales: (gb.data as Array<{ id: string; gin_receipt_id: string; pbi_number: string; net_weight_lbs: number }> | null) ?? [],
            gins: (gi.data as Array<{ id: string; name: string }> | null) ?? [],
            yieldFor: (p) => cottonModel.yieldFor(p),
          }
        : null,
      cropIds,
      entityId,
    })
  }

  // Hold the report until the viewer scope/overrides resolve too, so a viewer
  // never sees a flash of unresolved numbers. Inert timing for owners.
  if (loading || viewer.loading || !viewerA.ready) return <p className="text-slate-500">Loading…</p>

  // Exports go through the shared ExportBar; it appears only once the report
  // can be generated (a year picked, no breakout gate, at least one sheet) —
  // the same rule the old per-button disabled state enforced.
  const canExport = cropYear !== '' && !isBlocked && detailSheets.length > 0
  const filterSummary = filterSummaryOf(
    cropYear === '' ? null : cropYearLabel(cropYear),
    entityName || 'All Entities',
    cropIds.length === 0 ? 'All Crops' : cropIds.map((id) => cropById.get(id)?.name ?? '').filter(Boolean).join(', '),
    BASIS_LABEL[balance ? 'balanced' : 'measured'],
  )

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Crop Insurance Production Report"
        filterSummary={filterSummary}
        actions={canExport ? <ExportBar buildPayload={buildPayload} buildExcelPayload={buildAuditPayload} /> : undefined}
      />
      {/* Filter strip — hidden when printing. */}
      <ReportFilterBar activeCount={(entityId ? 1 : 0) + (cropIds.length > 0 ? 1 : 0) + (basis === 'balanced' ? 1 : 0)}>
        <FilterField label="Crop year">
          <select
            value={cropYear}
            onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}
            className={selectCls}
          >
            {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </FilterField>
        {/* A viewer with a single grant has nothing to switch between (the
            EntityFilter component's <=1 hide rule); owners keep the select. */}
        {(!viewer.isViewer || entityOptions.length > 1) && (
          <FilterField label="Entity">
            <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={selectCls}>
              <option value="">All entities</option>
              {entityOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </FilterField>
        )}
        <FilterField label="Production basis">
          <select value={basis} onChange={(e) => setBasis(e.target.value as ProductionBasis)} className={selectCls}>
            <option value="measured">Measured (scale tickets)</option>
            <option value="balanced">Balanced to settlements</option>
          </select>
        </FilterField>
        {cropFilterOptions.length > 0 && (
          <div className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Crops</span>
            <div className="flex flex-wrap gap-1.5 items-center">
              {cropFilterOptions.map((c) => {
                const on = cropIds.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCropIds((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                    className={
                      on
                        ? 'rounded-full bg-brand hover:bg-brand-deep text-white px-3 min-h-10 text-xs font-semibold'
                        : 'rounded-full bg-white border border-slate-300 text-slate-700 px-3 min-h-10 text-xs'
                    }
                  >
                    {c.name}
                  </button>
                )
              })}
              {cropIds.length > 0 && (
                <button type="button" onClick={() => setCropIds([])} className="text-xs text-slate-500 underline px-2 min-h-10">
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </ReportFilterBar>
      <SupersededNotice show={viewerA.superseded} onDismiss={viewerA.dismissSuperseded} />

      <ConfirmDialog
        open={countAsk != null}
        title={`Count ${countAsk?.name ?? 'this field'} as finished?`}
        body={<p>Its current bushels will be treated as the field&rsquo;s final yield. You can undo this from the field&rsquo;s detail on the Yields page.</p>}
        confirmLabel="Count it"
        onConfirm={() => { if (countAsk) countAnyway(countAsk.p) }}
        onCancel={() => setCountAsk(null)}
      />

      {/* Mixed-practice gate. */}
      {cropYear !== '' && mixedWithoutBreakout.length > 0 && !acceptedAsDryland && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-3 no-print">
          <div className="font-semibold text-amber-900">
            Production breakout needed for {mixedWithoutBreakout.length} mixed-practice planting
            {mixedWithoutBreakout.length === 1 ? '' : 's'}
          </div>
          <p className="text-sm text-amber-900">
            The following harvested fields have both irrigated and dryland acres but no
            production breakout. Either enter the breakout on the Yields page, or generate
            the report with all production rolled into the dryland sheet. Fields still
            being harvested won&apos;t appear here until their harvest is complete.
          </p>
          <ul className="text-sm text-amber-900 list-disc ml-6">
            {mixedWithoutBreakout.map((p) => {
              const fld = fieldById.get(p.field_id)
              const crop = cropById.get(p.crop_id)
              return (
                <li key={p.id}>
                  {fld?.name_or_number ?? '—'} — {crop?.name ?? '—'} (
                  {Number(p.irrigated_acres)} irr / {Number(p.dryland_acres)} dry ac)
                </li>
              )
            })}
          </ul>
          <div className="flex gap-2 flex-wrap">
            <Link
              href="/yields?breakout=1"
              className="inline-flex items-center rounded-lg bg-slate-700 text-white px-3 min-h-10 text-sm font-semibold"
            >
              Enter breakouts on Yields →
            </Link>
            <button
              type="button"
              onClick={() => setAcceptedAsDryland(true)}
              className="rounded-lg bg-amber-700 text-white px-3 min-h-10 text-sm font-semibold"
            >
              Generate as dryland
            </button>
          </div>
        </div>
      )}

      {/* Still-harvesting fields: left out of the report (acres and production),
          never blocking it. Count anyway treats a finished field's bushels as final. */}
      {cropYear !== '' && inProgress.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 no-print">
          <div className="font-semibold text-slate-700">
            {inProgress.length} field{inProgress.length === 1 ? '' : 's'} still harvesting — not included
          </div>
          <p className="text-sm text-slate-600">
            These fields look partway through harvest, so their acres and bushels are left out of the
            report until harvest finishes — a half-harvested field would certify a misleading yield.
            If a field here is actually done, use Count anyway to treat its bushels as final. A mixed
            irrigated/dryland field will then ask for its breakout on the Yields page.
          </p>
          {overrideErr && <p className="text-sm text-red-700">{overrideErr}</p>}
          <ul className="text-sm text-slate-600 list-disc ml-6">
            {inProgress.map((p) => {
              const fld = fieldById.get(p.field_id)
              const crop = cropById.get(p.crop_id)
              return (
                <li key={p.id}>
                  {fld?.name_or_number ?? '—'} — {crop?.name ?? '—'} (
                  {Number(p.irrigated_acres)} irr / {Number(p.dryland_acres)} dry ac)
                  {roleCanEditYields(viewer.role) && (
                    <button
                      type="button"
                      disabled={overrideSavingId === p.id}
                      onClick={() => setCountAsk({ p, name: fld?.name_or_number ?? 'this field' })}
                      className="ml-2 inline-flex items-center min-h-10 px-2 rounded-lg border border-slate-300 bg-white text-brand-deep text-xs font-semibold disabled:opacity-50"
                    >{overrideSavingId === p.id ? 'Saving…' : 'Count anyway'}</button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Balanced to settlements: the reconciliation per grain crop. */}
      {cropYear !== '' && balance && grainBalances.map((b) => (
        <div key={b.cropId} className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 no-print">
          <div className="font-semibold text-slate-800">{b.cropName} — balanced to settlements</div>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-sm">
            <dt className="text-slate-500">Measured (scale tickets)</dt><dd className="tabular-nums text-right md:text-left">{fmtNum(b.measured, 3)} bu</dd>
            <dt className="text-slate-500">Settled (paid)</dt><dd className="tabular-nums text-right md:text-left">{fmtNum(b.settled, 3)} bu across {b.settlementCount} settlement{b.settlementCount === 1 ? '' : 's'}</dd>
            <dt className="text-slate-500">Delivered, not settled</dt>
            <dd className="tabular-nums text-right md:text-left">
              {fmtNum(b.unsettled, 3)} bu
              {b.unsettledLoads.length > 0 && (
                <span className="text-slate-500"> ({b.unsettledLoads.length} load{b.unsettledLoads.length === 1 ? '' : 's'}: {b.unsettledLoads.slice(0, 8).map((x, i) => (
                  <span key={x.load.id}>{i > 0 ? ', ' : ''}<Link href={`/loads/${x.load.id}`} className="text-brand-deep underline">{x.load.ticket_number || x.load.date}</Link></span>
                ))}{b.unsettledLoads.length > 8 ? ', …' : ''})</span>
              )}
            </dd>
            <dt className="text-slate-500">Still in bins</dt><dd className="tabular-nums text-right md:text-left">{fmtNum(b.bins, 3)} bu <span className="text-slate-500">({BINS_NOTE})</span></dd>
            <dt className="text-slate-500">Balanced total</dt><dd className="tabular-nums text-right md:text-left font-semibold">{fmtNum(b.balancedTotal, 3)} bu</dd>
            <dt className="text-slate-500">Factor</dt><dd className={`tabular-nums text-right md:text-left font-semibold ${b.warn ? 'text-amber-700' : ''}`}>{factorLabel(b.factor)}</dd>
          </dl>
          {b.allPaid && <p className="text-sm text-green-800">Nothing is unsettled and the bins are empty: balanced production equals the bushels paid.</p>}
          {!b.allPaid && b.unsettled > 0 && <p className="text-sm text-slate-600">{fmtNum(b.unsettled, 0)} bu are delivered but not settled; the balance will change as settlements arrive.</p>}
          {b.warn && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">The factor is more than 5% from 1. Check for a missing settlement or load.</p>}
          {b.unmatched.lines > 0 && (
            <p className="text-sm text-amber-800">
              {b.unmatched.lines} settlement line{b.unmatched.lines === 1 ? '' : 's'} ({fmtNum(b.unmatched.bu, 0)} bu) {b.unmatched.lines === 1 ? "isn't" : "aren't"} matched to a load and can&apos;t count until matched.{' '}
              <Link href="/settlements" className="text-brand-deep underline">Open settlements</Link>
            </p>
          )}
        </div>
      ))}
      {cropYear !== '' && balance && balance.orphanUnmatched.lines > 0 && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 no-print">
          {balance.orphanUnmatched.lines} settlement line{balance.orphanUnmatched.lines === 1 ? '' : 's'} ({fmtNum(balance.orphanUnmatched.bu, 0)} bu) on settlements with no matched load at all can&apos;t count until matched.{' '}
          <Link href="/settlements" className="text-brand-deep underline">Open settlements</Link>
        </p>
      )}

      {/* Loads of the crop year the report leaves out, with the reason and a link — nothing is hidden. */}
      {cropYear !== '' && excludedLoads.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 no-print">
          <div className="font-semibold text-slate-700">
            {excludedLoads.length} load{excludedLoads.length === 1 ? '' : 's'} for {cropYear} not counted
          </div>
          <ul className="text-sm text-slate-600 list-disc ml-6">
            {(Object.keys(EXCLUDED_LOAD_REASON) as ExcludedLoad['reason'][]).map((reason) => {
              const group = excludedLoads.filter((x) => x.reason === reason)
              if (group.length === 0) return null
              return (
                <li key={reason}>
                  <span className="font-medium">{group.length} load{group.length === 1 ? '' : 's'}</span> — {EXCLUDED_LOAD_REASON[reason]}:{' '}
                  {group.slice(0, 12).map((x, i) => (
                    <span key={x.loadId}>{i > 0 ? ', ' : ''}<Link href={`/loads/${x.loadId}`} className="text-brand-deep underline">{x.ticket || x.date}</Link> ({x.fieldName}{x.cropName ? `, ${x.cropName}` : ''})</span>
                  ))}{group.length > 12 ? ', …' : ''}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {cropYear !== '' && !isBlocked && detailSheets.length === 0 && (
        <EmptyState
          message={
            cropIds.length > 0
              ? `No plantings with acres for the selected crop${cropIds.length === 1 ? '' : 's'} in ${cropYear}.`
              : `No plantings with acres for ${cropYear}.`
          }
          linkHref="/settings/plantings"
          linkLabel="Add field plantings"
          role={viewer.role}
        />
      )}

      {cropYear !== '' && !isBlocked && detailSheets.length > 0 && (
        <>
          {/* Tab bar. */}
          <div className="flex flex-wrap gap-1 border-b border-slate-200 no-print">
            <TabButton active={activeTab === 'summary'} onClick={() => setActiveTab('summary')}>Summary</TabButton>
            {detailSheets.map((s) => (
              <TabButton
                key={s.sheetName}
                active={activeTab === s.sheetName}
                onClick={() => setActiveTab(s.sheetName)}
              >
                {s.sheetName}
              </TabButton>
            ))}
          </div>

          {/* Tabbed body — only one visible at a time on screen, but all
              rendered when printing so every sheet ends up in the PDF.   */}
          <div className="print-area space-y-6">
            <SheetCard
              hidden={activeTab !== 'summary'}
              title="Summary"
              subtitle={reportTitle}
            >
              <SummaryTable
                reportCrops={reportCrops}
                summaryRows={summaryRows}
                summaryTotals={summaryTotals}
              />
            </SheetCard>
            {detailSheets.map((s) => (
              <SheetCard
                key={s.sheetName}
                hidden={activeTab !== s.sheetName}
                title={s.sheetName}
                subtitle={reportTitle}
              >
                <DetailTable sheet={s} reportCrops={reportCrops} />
              </SheetCard>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={
        active
          ? 'px-3 min-h-10 text-sm font-semibold border-b-2 border-brand text-brand-dark -mb-px'
          : 'px-3 min-h-10 text-sm text-slate-600 border-b-2 border-transparent hover:text-slate-900'
      }
    >
      {children}
    </button>
  )
}

function SheetCard({
  title, subtitle, hidden, children,
}: {
  title: string
  subtitle: string
  hidden: boolean
  children: React.ReactNode
}) {
  // Each sheet is its own page in print, even when hidden on screen.
  return (
    <section
      className={`bg-white rounded-xl shadow p-4 ${hidden ? 'hidden print:block' : ''} print:break-before-page first:print:break-before-auto avoid-break`}
    >
      <div className="mb-3">
        <h2 className="font-bold text-lg">{title}</h2>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function SummaryTable({
  reportCrops, summaryRows, summaryTotals,
}: {
  reportCrops: Crop[]
  summaryRows: SummaryRow[]
  summaryTotals: Map<string, FarmCropCell>
}) {
  return (
    <table className="min-w-full text-sm border-collapse">
      <thead className={theadCls}>
        <tr>
          <th rowSpan={2} className={`border border-slate-300 px-2 py-1 text-left align-bottom ${stickyColHeadCls}`}>
            County / Practice
          </th>
          <th colSpan={reportCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Certified Acres
          </th>
          <th colSpan={reportCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Production
          </th>
          <th colSpan={reportCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Yield per Acre
          </th>
        </tr>
        <tr>
          {reportCrops.map((c) => (
            <th key={`ha-${c.id}`} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name}</th>
          ))}
          {reportCrops.map((c) => (
            <th key={`hb-${c.id}`} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name} <span className="font-normal text-slate-500">({unitOf(c)})</span></th>
          ))}
          {reportCrops.map((c) => (
            <th key={`hy-${c.id}`} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name} <span className="font-normal text-slate-500">({unitOf(c)}/ac)</span></th>
          ))}
        </tr>
      </thead>
      <tbody>
        {summaryRows.map((row) => (
          <tr key={row.sheetName} className="border-t border-slate-100">
            <td className={`border border-slate-200 px-2 py-1 font-semibold whitespace-nowrap ${stickyColCls}`}>{row.sheetName}</td>
            {reportCrops.map((c) => {
              const v = row.byCrop.get(c.id)
              return <td key={`a-${c.id}`} className="border border-slate-200 px-2 py-1 text-right tabular-nums">
                {v && v.acres > 0 ? fmtNum(v.acres, 1) : ''}
              </td>
            })}
            {reportCrops.map((c) => {
              const v = row.byCrop.get(c.id)
              return <td key={`b-${c.id}`} className="border border-slate-200 px-2 py-1 text-right tabular-nums">
                {v && v.bu > 0 ? fmtInt(v.bu) : ''}
              </td>
            })}
            {reportCrops.map((c) => {
              const v = row.byCrop.get(c.id)
              const yld = v && v.acres > 0 && v.bu > 0 ? v.bu / v.acres : null
              return <td key={`y-${c.id}`} className="border border-slate-200 px-2 py-1 text-right tabular-nums">
                {yld != null ? fmtNum(yld, 1) : ''}
              </td>
            })}
          </tr>
        ))}
        <tr className={`border-t-2 border-slate-400 ${grandTotalRowCls}`}>
          <td className={`border border-slate-300 px-2 py-1 ${stickyColCls} bg-slate-100`}>Total</td>
          {reportCrops.map((c) => {
            const v = summaryTotals.get(c.id)
            return <td key={`ta-${c.id}`} className="border border-slate-300 px-2 py-1 text-right tabular-nums">
              {v && v.acres > 0 ? fmtNum(v.acres, 1) : ''}
            </td>
          })}
          {reportCrops.map((c) => {
            const v = summaryTotals.get(c.id)
            return <td key={`tb-${c.id}`} className="border border-slate-300 px-2 py-1 text-right tabular-nums">
              {v && v.bu > 0 ? fmtInt(v.bu) : ''}
            </td>
          })}
          {reportCrops.map((c) => {
            const v = summaryTotals.get(c.id)
            const yld = v && v.acres > 0 && v.bu > 0 ? v.bu / v.acres : null
            return <td key={`ty-${c.id}`} className="border border-slate-300 px-2 py-1 text-right tabular-nums">
              {yld != null ? fmtNum(yld, 1) : ''}
            </td>
          })}
        </tr>
      </tbody>
    </table>
  )
}

function DetailTable({ sheet, reportCrops }: { sheet: DetailSheet; reportCrops: Crop[] }) {
  const practice = practiceLabel(sheet.practice)
  // Only crops that have any acres in THIS sheet — keeps each county sheet
  // narrow. (A field's irrigated-only crop won't show on the dryland sheet.)
  const sheetCrops = useMemo(() => {
    const ids = new Set<string>()
    for (const farm of sheet.farms.values()) {
      for (const [cid, cell] of farm.byCrop) {
        if (cell.acres > 0) ids.add(cid)
      }
    }
    return reportCrops.filter((c) => ids.has(c.id))
  }, [sheet, reportCrops])

  const farmRows = useMemo(
    () => [...sheet.farms.values()].sort((a, b) => a.farmName.localeCompare(b.farmName)),
    [sheet],
  )

  // Per-sheet column totals (used for the total row).
  const totalsByCrop = useMemo(() => {
    const m = new Map<string, FarmCropCell>()
    for (const farm of sheet.farms.values()) {
      for (const [cid, cell] of farm.byCrop) {
        const agg = m.get(cid) ?? { acres: 0, bu: 0 }
        agg.acres += cell.acres
        agg.bu += cell.bu
        m.set(cid, agg)
      }
    }
    return m
  }, [sheet])

  return (
    <table className="min-w-full text-sm border-collapse">
      <thead className={theadCls}>
        <tr>
          <th rowSpan={2} className="border border-slate-300 bg-slate-100 px-2 py-1 text-left align-bottom">Farm Name</th>
          <th rowSpan={2} className="border border-slate-300 bg-slate-100 px-2 py-1 text-left align-bottom">Farm #</th>
          <th colSpan={sheetCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Certified {practice} Acres
          </th>
          <th colSpan={sheetCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            {practice} Production
          </th>
          <th colSpan={sheetCrops.length} className="border border-slate-300 bg-slate-100 px-2 py-1 text-center">
            Yield per Acre
          </th>
        </tr>
        <tr>
          {sheetCrops.map((c) => (
            <th key={`ha-${c.id}`} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name}</th>
          ))}
          {sheetCrops.map((c) => (
            <th key={`hb-${c.id}`} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name} <span className="font-normal text-slate-500">({unitOf(c)})</span></th>
          ))}
          {sheetCrops.map((c) => (
            <th key={`hy-${c.id}`} className="border border-slate-300 bg-slate-50 px-2 py-1 text-center">{c.name} <span className="font-normal text-slate-500">({unitOf(c)}/ac)</span></th>
          ))}
        </tr>
      </thead>
      <tbody>
        {farmRows.map((farm) => (
          <tr key={farm.farmName + (farm.fsaNumber ?? '')} className="border-t border-slate-100">
            <td className="border border-slate-200 px-2 py-1 font-semibold">{farm.farmName}</td>
            <td className="border border-slate-200 px-2 py-1 text-xs tabular-nums">{farm.fsaNumber ?? ''}</td>
            {sheetCrops.map((c) => {
              const cell = farm.byCrop.get(c.id)
              return <td key={`a-${c.id}`} className="border border-slate-200 px-2 py-1 text-right tabular-nums">
                {cell && cell.acres > 0 ? fmtNum(cell.acres, 1) : ''}
              </td>
            })}
            {sheetCrops.map((c) => {
              const cell = farm.byCrop.get(c.id)
              return <td key={`b-${c.id}`} className="border border-slate-200 px-2 py-1 text-right tabular-nums">
                {cell && cell.bu > 0 ? fmtInt(cell.bu) : ''}
              </td>
            })}
            {sheetCrops.map((c) => {
              const cell = farm.byCrop.get(c.id)
              const yld = cell && cell.acres > 0 && cell.bu > 0 ? cell.bu / cell.acres : null
              return <td key={`y-${c.id}`} className="border border-slate-200 px-2 py-1 text-right tabular-nums">
                {yld != null ? fmtNum(yld, 1) : ''}
              </td>
            })}
          </tr>
        ))}
        <tr className={`border-t-2 border-slate-400 ${grandTotalRowCls}`}>
          <td colSpan={2} className="border border-slate-300 px-2 py-1">Total</td>
          {sheetCrops.map((c) => {
            const t = totalsByCrop.get(c.id)
            return <td key={`ta-${c.id}`} className="border border-slate-300 px-2 py-1 text-right tabular-nums">
              {t && t.acres > 0 ? fmtNum(t.acres, 1) : ''}
            </td>
          })}
          {sheetCrops.map((c) => {
            const t = totalsByCrop.get(c.id)
            return <td key={`tb-${c.id}`} className="border border-slate-300 px-2 py-1 text-right tabular-nums">
              {t && t.bu > 0 ? fmtInt(t.bu) : ''}
            </td>
          })}
          {sheetCrops.map((c) => {
            const t = totalsByCrop.get(c.id)
            const yld = t && t.acres > 0 && t.bu > 0 ? t.bu / t.acres : null
            return <td key={`ty-${c.id}`} className="border border-slate-300 px-2 py-1 text-right tabular-nums">
              {yld != null ? fmtNum(yld, 1) : ''}
            </td>
          })}
        </tr>
      </tbody>
    </table>
  )
}

export type { DetailSheet, SummaryRow, FarmCropCell }
