'use client'

// Bale Quality (2026-10-20, layout 2026-10-21) — the HVI quality package a
// merchant would envy, laid out so the data leads:
//
//   header        title, the active filters in plain English, exports
//   control strip crop year + contract always in reach; every other filter
//                 and the display choices (weighting, factors) wait in a
//                 drawer behind "Filters & display"
//   KPI strip     classed bales, lint lbs, avg loan value, base-or-better,
//                 % meets contract
//   contract      the headline, cap tracker, projection, why bales fail
//   factor tiles  one slim tile per grade factor; tap one to open its detail
//                 (histogram at the factor's own precision, contract line,
//                 averages, spread, fails) — the Color detail carries the
//                 USDA color grid
//   comparison    one row per group (Group by lives on the table)
//   bale list     the drill-down target for every tap above
//
// Every number comes from lib/bale-quality-report.ts (pure); the exports
// from lib/bale-quality-export.ts through lib/exports.ts.

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useReportCropYear, cropYearChoices } from '@/lib/report-filters'
import { useViewerScope, entityOptionsFor } from '@/lib/use-viewer-scope'
import { exportToExcel, type ExportPayload } from '@/lib/exports'
import ExportBar from '@/components/export-bar'
import { fmtDate } from '@/lib/format-date'
import {
  EmptyState, ReportHeader, ReportFilterBar, FilterField, SummaryCards, InfoTip, selectCls, inputCls, theadCls, grandTotalRowCls,
  stickyColCls, stickyColHeadCls, fmtInt, filterSummaryOf, cropYearLabel, toneText, type Tone,
} from '@/components/reports/report-kit'
import { ChipMultiSelect, SegmentedChips, type ChipOption } from '@/components/reports/chip-select'
import { FactorPicker } from '@/components/reports/factor-picker'
import { FactorTiles, FactorDetailPanel, SectionTitle, avgText, bandBg, pct1 } from '@/components/reports/factor-detail'
import { FACTORS, FACTOR_PRESETS, bandsFor, factorText, factorValue, type Band, type FactorKey } from '@/lib/cotton-quality'
import { EVALUATION_LABEL, specFromRow, specHasFiberTerms, specSummaryLine, type BaleEvaluation, type ContractQualitySpec } from '@/lib/cotton-contract-spec'
import {
  activeFilterCount, applyFilters, bandTone, buildBaleRows, cellBand, colorGrid, comparisonRows, contractView, estimatedBalesFromAssumptions, factorDetail,
  EMPTY_FILTERS, GROUP_BY_LABEL, groupRows, kpis, rowsInBin, NO_VARIETY,
  type BaleQualityFilters, type BaleQualityInputs, type BaleRow, type ComparisonRow, type ContractView, type FactorBin, type FactorDetail, type GroupBy, type Weighting,
} from '@/lib/bale-quality-report'
import { buildBaleQualityPdfPayload, buildBaleQualityWorkbook, buildQualifyingBalesWorkbook, DISPOSITION_TEXT, kpiCards, type BaleQualityExportInput } from '@/lib/bale-quality-export'
import type { CottonContractSpec, CottonDisposition, CottonSalesContract, CropAssumption } from '@/lib/types'

type Drill =
  | { kind: 'bin'; factor: FactorKey; min: number | null; max: number | null; code: string | null; label: string }
  | { kind: 'color'; code: string; label: string }
  | { kind: 'pareto'; factor: FactorKey; label: string }
  | { kind: 'result'; status: BaleEvaluation['status']; label: string }
  | null

type ContractChoice = { contract: CottonSalesContract; spec: ContractQualitySpec; label: string }

const PRACTICE_OPTIONS: ChipOption[] = [
  { id: 'dryland', label: 'Dryland' }, { id: 'irrigated', label: 'Irrigated' }, { id: 'mixed', label: 'Mixed' }, { id: 'unknown', label: 'No planting' },
]
const DISPOSITION_OPTIONS: ChipOption[] = (Object.keys(DISPOSITION_TEXT) as CottonDisposition[]).map((d) => ({ id: d, label: DISPOSITION_TEXT[d] }))
const GROUP_OPTIONS = (Object.keys(GROUP_BY_LABEL) as GroupBy[]).map((k) => ({ key: k, label: GROUP_BY_LABEL[k] }))

export default function BaleQualityReport() {
  const supabase = useMemo(() => createClient(), [])
  const viewer = useViewerScope(supabase)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [inputs, setInputs] = useState<BaleQualityInputs | null>(null)
  const [contracts, setContracts] = useState<CottonSalesContract[]>([])
  const [specRows, setSpecRows] = useState<CottonContractSpec[]>([])
  const [buyers, setBuyers] = useState<Array<{ id: string; name: string }>>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [allYears, setAllYears] = useState<number[]>([])

  const [cropYearValue, setCropYear] = useReportCropYear('cotton:cropYear', { options: allYears, loaded })
  const cropYear = typeof cropYearValue === 'number' ? cropYearValue : new Date().getFullYear()
  const [filters, setFilters] = usePersistentState<BaleQualityFilters>('bale-quality:filters', EMPTY_FILTERS)
  const [groupBy, setGroupBy] = usePersistentState<GroupBy>('bale-quality:groupBy', 'field')
  const [factors, setFactors] = usePersistentState<FactorKey[]>('bale-quality:factors', FACTOR_PRESETS.loan.factors)
  const [weighting, setWeighting] = usePersistentState<Weighting>('bale-quality:weighting', 'bales')
  const [selectedFactorRaw, setSelectedFactor] = usePersistentState<FactorKey | null>('bale-quality:factor', null)
  const selectedFactor = selectedFactorRaw && factors.includes(selectedFactorRaw) ? selectedFactorRaw : null
  const [drill, setDrill] = useState<Drill>(null)
  const setFilter = useCallback(<K extends keyof BaleQualityFilters>(k: K, v: BaleQualityFilters[K]) => setFilters((f) => ({ ...EMPTY_FILTERS, ...f, [k]: v })), [setFilters])

  // ?contract=<id> pre-selects a contract (the contract page's link).
  useEffect(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('contract')
      if (id) setFilters((f) => ({ ...EMPTY_FILTERS, ...f, contractId: id }))
    } catch { /* no window */ }
  }, [setFilters])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoaded(false); setLoadError(null)
      try {
        const [bales, grades, receipts, gins, farms, fields, entities, plantings, varieties, crops, disp, loanBales, cts, specs, by, asm, years] = await Promise.all([
          fetchAllRows((f, t) => supabase.from('cotton_bales').select('id, gin_receipt_id, crop_year, pbi_number, net_weight_lbs').eq('crop_year', cropYear).order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('cotton_bale_grades').select('*').order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('gin_receipts').select('id, gin_id, receipt_number, receipt_date, statement_number, gin_code, entity_id, farm_id, field_id, crop_year').eq('crop_year', cropYear).order('id').range(f, t)),
          supabase.from('gins').select('id, name'),
          supabase.from('farms').select('id, name, entity_id, fsa_number, archived_at'),
          supabase.from('fields').select('id, farm_id, name_or_number'),
          supabase.from('entities').select('id, name'),
          fetchAllRows((f, t) => supabase.from('field_plantings').select('id, field_id, crop_id, season_year, irrigated_acres, dryland_acres, planted_acres, archived_at').eq('season_year', cropYear).order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('field_planting_varieties').select('planting_id, variety').order('id').range(f, t)),
          supabase.from('crops').select('id, name'),
          fetchAllRows((f, t) => supabase.from('cotton_bale_dispositions').select('bale_id, disposition, contract_id, loan_id').order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('ccc_loan_bales').select('bale_id, loan_id').order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('cotton_sales_contracts').select('*').eq('crop_year', cropYear).order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('cotton_contract_specs').select('*').order('id').range(f, t)),
          supabase.from('buyers').select('id, name'),
          supabase.from('crop_assumptions').select('*').eq('crop_year', cropYear),
          supabase.from('cotton_bales').select('crop_year').order('crop_year', { ascending: false }).limit(1000),
        ])
        if (cancelled) return
        const err = [bales, grades, receipts, cts].find((q) => q.error)?.error
        if (err) { setLoadError('Could not load the bale data — reload the page, or contact support.'); console.error(err) }
        setInputs({
          cropYear,
          bales: (bales.data as BaleQualityInputs['bales']) ?? [],
          grades: (grades.data as BaleQualityInputs['grades']) ?? [],
          receipts: (receipts.data as BaleQualityInputs['receipts']) ?? [],
          gins: (gins.data as BaleQualityInputs['gins']) ?? [],
          farms: (farms.data as BaleQualityInputs['farms']) ?? [],
          fields: (fields.data as BaleQualityInputs['fields']) ?? [],
          entities: (entities.data as BaleQualityInputs['entities']) ?? [],
          plantings: (plantings.data as BaleQualityInputs['plantings']) ?? [],
          crops: (crops.data as BaleQualityInputs['crops']) ?? [],
          varieties: (varieties.data as BaleQualityInputs['varieties']) ?? [],
          dispositions: (disp.data as BaleQualityInputs['dispositions']) ?? [],
          loanBales: (loanBales.data as BaleQualityInputs['loanBales']) ?? [],
        })
        setContracts((cts.data as CottonSalesContract[]) ?? [])
        setSpecRows(((specs.data as CottonContractSpec[]) ?? []).filter(Boolean))
        setBuyers((by.data as Array<{ id: string; name: string }>) ?? [])
        setAssumptions((asm.data as CropAssumption[]) ?? [])
        setAllYears(Array.from(new Set((((years.data as Array<{ crop_year: number }>) ?? []).map((r) => r.crop_year)))))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [supabase, cropYear])

  const yearChoices = useMemo(() => cropYearChoices(allYears, cropYear), [allYears, cropYear])
  const rows = useMemo(() => (inputs ? buildBaleRows(inputs) : []), [inputs])
  const buyerName = useCallback((id: string | null) => buyers.find((b) => b.id === id)?.name ?? null, [buyers])

  // Contracts that carry a quality spec (the only ones the Contract filter offers).
  const contractChoices = useMemo<ContractChoice[]>(() => {
    const out: ContractChoice[] = []
    for (const c of contracts) {
      const row = specRows.find((s) => s.contract_id === c.id)
      const spec = specFromRow(row as unknown as Record<string, unknown>)
      if (!spec || !specHasFiberTerms(spec)) continue
      const label = [buyerName(c.buyer_id), c.contract_number ? `#${c.contract_number}` : null].filter(Boolean).join(' ') || 'Contract'
      out.push({ contract: c, spec, label })
    }
    return out
  }, [contracts, specRows, buyerName])
  const contractChoice = contractChoices.find((c) => c.contract.id === filters.contractId) ?? null

  // The app's own production estimate, in bales, for the projection fallback.
  const appEstimatedBales = useMemo(() => (inputs ? estimatedBalesFromAssumptions(inputs, assumptions) : null), [inputs, assumptions])

  const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters])
  const view: ContractView | null = useMemo(() => (contractChoice ? contractView(filtered, contractChoice.spec, appEstimatedBales) : null), [filtered, contractChoice, appEstimatedBales])
  const details = useMemo(() => {
    const out: Partial<Record<FactorKey, FactorDetail>> = {}
    for (const f of factors) out[f] = factorDetail(filtered, f, cropYear, weighting, contractChoice?.spec ?? null, view?.evaluationOf)
    return out
  }, [filtered, factors, cropYear, weighting, contractChoice, view])
  const grid = useMemo(() => colorGrid(filtered, weighting), [filtered, weighting])
  const groups = useMemo(() => groupRows(filtered, groupBy), [filtered, groupBy])
  const comparison = useMemo(() => comparisonRows(groups, factors, cropYear, weighting, contractChoice?.spec ?? null), [groups, factors, cropYear, weighting, contractChoice])
  const k = useMemo(() => kpis(filtered, cropYear), [filtered, cropYear])

  // Filter option lists come from the year's bales, so a chip never offers an empty choice.
  const entityOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) if (r.entityId) seen.set(r.entityId, r.entityName)
    const list: ChipOption[] = Array.from(seen, ([id, label]) => ({ id, label })).sort((a, z) => a.label.localeCompare(z.label))
    return entityOptionsFor(viewer, list)
  }, [rows, viewer])
  const farmOptions = useMemo(() => uniq(rows.filter((r) => r.farmId).map((r) => ({ id: r.farmId!, label: r.farmName, hint: r.fsa ? `FSA ${r.fsa}` : undefined }))), [rows])
  const fieldOptions = useMemo(() => uniq(rows.filter((r) => r.fieldId && (filters.farmIds.length === 0 || filters.farmIds.includes(r.farmId ?? ''))).map((r) => ({ id: r.fieldId!, label: r.fieldName, hint: r.farmName }))), [rows, filters.farmIds])
  const varietyOptions = useMemo(() => uniq(rows.map((r) => ({ id: r.variety ?? NO_VARIETY, label: r.variety ?? NO_VARIETY }))), [rows])
  const ginOptions = useMemo(() => uniq(rows.filter((r) => r.ginId).map((r) => ({ id: r.ginId!, label: r.ginName }))), [rows])
  const receiptOptions = useMemo(() => uniq(rows.map((r) => ({ id: r.receiptId, label: r.receiptLabel, hint: r.farmName }))), [rows])

  const filterSummary = useMemo(() => filterSummaryOf(
    cropYearLabel(cropYear),
    filters.entityIds.length ? `${filters.entityIds.length === 1 ? entityOptions.find((e) => e.id === filters.entityIds[0])?.label : `${filters.entityIds.length} entities`}` : 'All entities',
    filters.farmIds.length ? `${filters.farmIds.length} farm${filters.farmIds.length === 1 ? '' : 's'}` : null,
    filters.fieldIds.length ? `${filters.fieldIds.length} field${filters.fieldIds.length === 1 ? '' : 's'}` : null,
    filters.varieties.length ? filters.varieties.join(', ') : null,
    filters.ginIds.length ? `${filters.ginIds.length} gin${filters.ginIds.length === 1 ? '' : 's'}` : null,
    filters.receiptIds.length ? `${filters.receiptIds.length} receipt${filters.receiptIds.length === 1 ? '' : 's'}` : null,
    filters.practices.length ? filters.practices.join(' / ') : null,
    filters.classFrom || filters.classTo ? `classed ${filters.classFrom ? fmtDate(filters.classFrom) : '…'} – ${filters.classTo ? fmtDate(filters.classTo) : '…'}` : null,
    filters.dispositions.length ? filters.dispositions.map((d) => DISPOSITION_TEXT[d]).join(' / ') : null,
    contractChoice ? `Contract ${contractChoice.label}${filters.excludeCommitted ? ' (committed elsewhere excluded)' : ''}` : null,
    `${weighting === 'lbs' ? 'lbs' : 'bale'}-weighted`,
  ), [cropYear, filters, entityOptions, contractChoice, weighting])

  const exportInput = useCallback((): BaleQualityExportInput => ({
    cropYear, rows: filtered, factors, groupBy, weighting, filterSummary,
    contract: contractChoice && view ? { id: contractChoice.contract.id, label: contractChoice.label, spec: contractChoice.spec, view } : null,
  }), [cropYear, filtered, factors, groupBy, weighting, filterSummary, contractChoice, view])
  const buildPayload = useCallback((): ExportPayload => buildBaleQualityPdfPayload(exportInput()), [exportInput])
  const buildExcel = useCallback((): ExportPayload => buildBaleQualityWorkbook(exportInput()), [exportInput])
  const [qualifyingBusy, setQualifyingBusy] = useState(false)
  const exportQualifying = useCallback(async () => {
    setQualifyingBusy(true)
    try { await exportToExcel(buildQualifyingBalesWorkbook(exportInput())) } finally { setQualifyingBusy(false) }
  }, [exportInput])

  // Drill-down rows for the bale list.
  const drillRows = useMemo(() => {
    if (!drill) return filtered
    switch (drill.kind) {
      case 'bin': return rowsInBin(filtered, drill.factor, drill)
      case 'color': return filtered.filter((r) => r.grade != null && factorValue(r.grade, 'color') === drill.code)
      case 'pareto': return filtered.filter((r) => { const ev = view?.evaluationOf(r.id); return ev?.status === 'fails' && ev.failures.some((f) => f.factor === drill.factor) })
      case 'result': return filtered.filter((r) => view?.evaluationOf(r.id)?.status === drill.status)
    }
  }, [filtered, drill, view])

  const cards = useMemo(() => kpiCards(exportInput()), [exportInput])
  const cottonIsOn = loaded && inputs != null
  const bands = bandsFor(cropYear)
  // The counted filters leave out the contract itself — it has its own control in the strip.
  const drawerCount = activeFilterCount({ ...filters, contractId: '', excludeCommitted: false })
  const drillBin = (f: FactorKey) => (bin: FactorBin) => setDrill({ kind: 'bin', factor: f, min: bin.min, max: bin.max, code: bin.code, label: `${FACTORS[f].short} ${bin.label}` })

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Bale Quality"
        filterSummary={filterSummary}
        actions={(
          <div className="flex flex-wrap gap-2 items-center">
            <ExportBar buildPayload={buildPayload} buildExcelPayload={buildExcel} />
            {contractChoice && view && (
              <button type="button" onClick={() => void exportQualifying()} disabled={qualifyingBusy || view.summary.meets === 0} className="rounded-lg bg-white border border-brand text-brand-deep font-semibold px-3 min-h-11 text-sm disabled:opacity-50">
                {qualifyingBusy ? 'Exporting…' : `Export qualifying bales (${view.summary.meets.toLocaleString()})`}
              </button>
            )}
          </div>
        )}
      />

      <ReportFilterBar
        collapsible
        label="Filters & display"
        activeCount={drawerCount}
        alwaysVisible={(
          <>
            <FilterField label="Crop year">
              <select value={cropYear} onChange={(e) => setCropYear(Number(e.target.value))} className={selectCls}>
                {yearChoices.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </FilterField>
            <FilterField label="Contract">
              <select value={contractChoice ? contractChoice.contract.id : ''} onChange={(e) => { setFilter('contractId', e.target.value); setDrill(null) }} className={selectCls}>
                <option value="">— none —</option>
                {contractChoices.map((c) => <option key={c.contract.id} value={c.contract.id}>{c.label}</option>)}
              </select>
            </FilterField>
            {drawerCount > 0 && (
              <button type="button" onClick={() => { setFilters({ ...EMPTY_FILTERS, contractId: filters.contractId }); setDrill(null) }} className="text-xs text-slate-500 underline px-2 min-h-11 self-end">Clear filters</button>
            )}
          </>
        )}
      >
        <div className="w-full space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Narrow the bales</div>
          <div className="flex flex-wrap gap-3 items-end">
            {entityOptions.length > 1 && <ChipMultiSelect label="Entity" options={entityOptions} value={filters.entityIds} onChange={(v) => setFilter('entityIds', v)} inlineUpTo={4} />}
            <ChipMultiSelect label="Farm" options={farmOptions} value={filters.farmIds} onChange={(v) => setFilter('farmIds', v)} searchable />
            <ChipMultiSelect label="Field" options={fieldOptions} value={filters.fieldIds} onChange={(v) => setFilter('fieldIds', v)} searchable />
            <ChipMultiSelect label="Variety" options={varietyOptions} value={filters.varieties} onChange={(v) => setFilter('varieties', v)} inlineUpTo={5} />
            {ginOptions.length > 1 && <ChipMultiSelect label="Gin" options={ginOptions} value={filters.ginIds} onChange={(v) => setFilter('ginIds', v)} inlineUpTo={4} />}
            <ChipMultiSelect label="Gin receipt" options={receiptOptions} value={filters.receiptIds} onChange={(v) => setFilter('receiptIds', v)} searchable />
            <ChipMultiSelect label="Practice" options={PRACTICE_OPTIONS} value={filters.practices} onChange={(v) => setFilter('practices', v as BaleQualityFilters['practices'])} />
            <FilterField label="Classed from">
              <input type="date" value={filters.classFrom} onChange={(e) => setFilter('classFrom', e.target.value)} className={inputCls} />
            </FilterField>
            <FilterField label="to">
              <input type="date" value={filters.classTo} onChange={(e) => setFilter('classTo', e.target.value)} className={inputCls} />
            </FilterField>
            <ChipMultiSelect label="Disposition" options={DISPOSITION_OPTIONS} value={filters.dispositions} onChange={(v) => setFilter('dispositions', v as CottonDisposition[])} inlineUpTo={5} />
          </div>
        </div>
        <div className="w-full space-y-2 pt-2 border-t border-slate-100">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Display</div>
          <div className="flex flex-wrap gap-4 items-end">
            <SegmentedChips label="Weighting" options={[{ key: 'bales', label: 'Per bale' }, { key: 'lbs', label: 'Per lb' }]} value={weighting} onChange={setWeighting} />
            <div className="text-xs text-slate-500 max-w-md self-center">
              Loan value ¢/lb is always lbs-weighted. Price bands: {bands.source}
              {bands.cropYear !== cropYear && <span className="text-amber-700"> (no {cropYear} schedule entered yet — using {bands.cropYear})</span>}.
            </div>
          </div>
          <FactorPicker value={factors} onChange={setFactors} />
        </div>
      </ReportFilterBar>

      {loadError && <p className="text-sm text-red-700">{loadError}</p>}
      {!loaded && <p className="text-sm text-slate-400">Loading bales…</p>}

      {cottonIsOn && rows.length === 0 && (
        <EmptyState message={`No ${cropYear} bales yet.`} hint="Bales come from gin receipts; classing data from the Bales & Grades import." linkHref="/cotton/receipts" linkLabel="Add gin receipts" role={viewer.role} />
      )}
      {cottonIsOn && rows.length > 0 && filtered.length === 0 && (
        <EmptyState message="No bales match these filters." hint="Open Filters & display and clear a chip or two." />
      )}

      {cottonIsOn && filtered.length > 0 && (
        <>
          <SummaryCards cards={cards.map((c) => ({ ...c, onClick: c.label.startsWith('Meets') && view ? () => setDrill({ kind: 'result', status: 'meets', label: `Meets ${contractChoice?.label}` }) : undefined }))} />
          {k.classed === 0 && (
            <p className="text-sm text-amber-700">None of these {filtered.length.toLocaleString()} bales has classing data yet — import the classing file on <Link href="/cotton/bales" className="underline">Bales &amp; Grades</Link>.</p>
          )}

          {contractChoice && view && (
            <ContractPanel
              choice={contractChoice} view={view} onDrill={setDrill}
              excludeCommitted={filters.excludeCommitted} onExcludeCommitted={(v) => setFilter('excludeCommitted', v)}
            />
          )}

          <section className="space-y-3">
            <SectionTitle right={<span className="text-xs text-slate-500 no-print">Tap a factor for its distribution{contractChoice ? ' and the contract line' : ''}</span>}>
              Grade factors <span className="text-sm font-normal text-slate-500">· {weighting === 'lbs' ? 'lbs-weighted' : 'per bale'}</span>
            </SectionTitle>
            <FactorTiles factors={factors} details={details} selected={selectedFactor} onSelect={setSelectedFactor} hasContract={!!contractChoice} />
            {selectedFactor && details[selectedFactor] && (
              <FactorDetailPanel
                detail={details[selectedFactor]!}
                weighting={weighting}
                contractLabel={contractChoice?.label ?? null}
                onDrillBin={drillBin(selectedFactor)}
                onDrillFails={() => setDrill({ kind: 'pareto', factor: selectedFactor, label: `Fails ${FACTORS[selectedFactor].short}` })}
                onClose={() => setSelectedFactor(null)}
                grid={selectedFactor === 'color' ? grid : undefined}
                spec={contractChoice?.spec ?? null}
                onDrillColor={(code, label) => setDrill({ kind: 'color', code, label })}
              />
            )}
          </section>

          <ComparisonTable rows={comparison.rows} total={comparison.total} factors={factors} groupBy={groupBy} onGroupBy={setGroupBy} cropYear={cropYear} contractLabel={contractChoice?.label ?? null} weighting={weighting} />

          <BaleList
            rows={drillRows} allCount={filtered.length} factors={factors} cropYear={cropYear} drill={drill} onClearDrill={() => setDrill(null)}
            view={view} contractLabel={contractChoice?.label ?? null}
          />
        </>
      )}
    </div>
  )
}

function uniq(list: ChipOption[]): ChipOption[] {
  const seen = new Map<string, ChipOption>()
  for (const o of list) if (!seen.has(o.id)) seen.set(o.id, o)
  return Array.from(seen.values()).sort((a, z) => a.label.localeCompare(z.label))
}

// ---------------------------------------------------------------------------
// Contract panel
// ---------------------------------------------------------------------------

function ContractPanel({ choice, view, onDrill, excludeCommitted, onExcludeCommitted }: {
  choice: ContractChoice; view: ContractView; onDrill: (d: Drill) => void; excludeCommitted: boolean; onExcludeCommitted: (v: boolean) => void
}) {
  const s = view.summary
  const capPct = s.cap && s.cap > 0 ? Math.min(1, s.meets / s.cap) : null
  const projPct = s.cap && s.cap > 0 && s.projection ? Math.min(1, s.projection.projected / s.cap) : null
  const maxPareto = Math.max(1, ...s.pareto.map((p) => p.bales))
  const schedule = choice.spec.schedule ?? []
  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3 border-l-4 border-sky-600">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="font-semibold text-lg">
          {s.eligibleClassed > 0
            ? <>{s.meets.toLocaleString()} of {s.eligibleClassed.toLocaleString()} classed bales from eligible farms meet {choice.label}&rsquo;s spec <span className={toneText(s.passRate != null && s.passRate >= 0.5 ? 'favorable' : 'warning')}>({pct1(s.passRate)})</span> · {fmtInt(s.meetsLbs)} lbs</>
            : <>No classed bales from eligible farms yet for {choice.label}</>}
        </div>
        <div className="text-sm text-slate-600 flex flex-wrap gap-2">
          {s.passRateLbs != null && <span>{pct1(s.passRateLbs)} by lbs</span>}
          <button type="button" onClick={() => onDrill({ kind: 'result', status: 'not_eligible', label: 'Not eligible' })} className="underline decoration-dotted min-h-7">{s.notEligible.toLocaleString()} not eligible (farm not on the contract{schedule.length ? '’s schedule' : ''})</button>
          <button type="button" onClick={() => onDrill({ kind: 'result', status: 'not_classed', label: 'Not classed' })} className="underline decoration-dotted min-h-7">{s.notClassed.toLocaleString()} not yet classed</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="text-xs text-slate-500">{specSummaryLine(choice.spec)}{choice.spec.eligible_fsa_farms?.length ? ` · ${choice.spec.eligible_fsa_farms.length} eligible FSA farms` : ''}{choice.spec.base_price_cents != null ? ` · ${(choice.spec.base_price_cents / 100).toFixed(2)} $/lb on ${choice.spec.base_grade ?? 'base'}` : ''}</div>
        <label className="flex items-center gap-2 text-xs min-h-8 no-print">
          <input type="checkbox" checked={excludeCommitted} onChange={(e) => onExcludeCommitted(e.target.checked)} className="h-4 w-4 accent-[#36B449]" />
          Exclude bales committed elsewhere
          <InfoTip label="?">Leaves out bales already in a CCC loan, sold, pooled, or assigned to another contract. Off by default.</InfoTip>
        </label>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="text-sm font-semibold">Cap tracker</div>
          {s.cap != null ? (
            <>
              <div className="relative h-5 rounded bg-slate-100 overflow-hidden" role="img" aria-label={`${s.meets} qualifying bales of a ${s.cap} cap`}>
                <div className="absolute inset-y-0 left-0 bg-green-600 rounded-r" style={{ width: `${(capPct ?? 0) * 100}%` }} />
                {projPct != null && <div className="absolute inset-y-0 w-0.5 bg-sky-700" style={{ left: `${projPct * 100}%` }} />}
              </div>
              <div className="text-sm tabular-nums"><span className="font-semibold">{s.meets.toLocaleString()}</span> qualifying bales of the <span className="font-semibold">{s.cap.toLocaleString()}</span> cap ({pct1(capPct)})</div>
            </>
          ) : <div className="text-sm text-slate-500">The contract carries no bale cap.</div>}
          {s.projection ? (
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{s.projection.projected.toLocaleString()}</span> projected qualifying bales <span className="text-slate-500">— estimate: {pct1(s.passRate)} pass rate × {s.projection.estimatedBales.toLocaleString()} {s.projection.estimateSource === 'contract' ? 'estimated bales on the contract' : 'bales expected by Turnrow (expected lint ÷ 500)'}{s.cap != null ? `, vs the ${s.cap.toLocaleString()} cap` : ''}</span>
            </div>
          ) : (
            <div className="text-xs text-slate-500">No production estimate yet — set a cotton expected yield under Marketing, or enter the estimate on the contract.</div>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-sm font-semibold flex items-center gap-2">Why bales fail <InfoTip label="?">Bales failing each factor (a bale can fail several). &ldquo;Only this&rdquo; counts the near misses — bales that would meet the spec but for that one factor, the ones worth asking the buyer to take at a discount.</InfoTip></div>
          {s.pareto.length === 0 ? <div className="text-sm text-slate-500">{s.fails === 0 ? 'Every eligible classed bale meets the spec.' : 'No failures recorded.'}</div> : (
            <ul className="space-y-1">
              {s.pareto.map((p) => (
                <li key={p.factor}>
                  <button type="button" onClick={() => onDrill({ kind: 'pareto', factor: p.factor, label: `Fails ${FACTORS[p.factor].short}` })} className="w-full text-left min-h-8 hover:bg-slate-50 rounded px-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-24 truncate">{FACTORS[p.factor].label}</span>
                      <span className="flex-1 h-3 bg-slate-100 rounded overflow-hidden"><span className="block h-full bg-red-500 rounded-r" style={{ width: `${(p.bales / maxPareto) * 100}%` }} /></span>
                      <span className="tabular-nums w-16 text-right"><span className="font-semibold">{p.bales}</span> fail</span>
                      <span className="tabular-nums w-24 text-right text-slate-500">{p.onlyThis} only this</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {s.singleFactorFails > 0 && <div className="text-xs text-slate-500">{s.singleFactorFails.toLocaleString()} bale{s.singleFactorFails === 1 ? '' : 's'} fail on exactly one factor.</div>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

type SortKey = string
function ComparisonTable({ rows, total, factors, groupBy, onGroupBy, cropYear, contractLabel, weighting }: {
  rows: ComparisonRow[]; total: ComparisonRow; factors: FactorKey[]; groupBy: GroupBy; onGroupBy: (g: GroupBy) => void; cropYear: number; contractLabel: string | null; weighting: Weighting
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'label', dir: 1 })
  const columns = useMemo(() => {
    const cols: Array<{ key: SortKey; label: string; get: (r: ComparisonRow) => number | string | null; tone?: (r: ComparisonRow) => Tone; band?: (r: ComparisonRow) => Band | null; fmt: (v: number | string | null) => string; numeric: boolean }> = [
      { key: 'label', label: GROUP_BY_LABEL[groupBy], get: (r) => r.label, fmt: (v) => String(v ?? ''), numeric: false },
      { key: 'bales', label: 'Bales', get: (r) => r.bales, fmt: (v) => fmtInt(v as number), numeric: true },
      { key: 'classed', label: 'Classed', get: (r) => r.classed, fmt: (v) => fmtInt(v as number), numeric: true },
      { key: 'lbs', label: 'Lbs', get: (r) => r.lbs, fmt: (v) => fmtInt(v as number), numeric: true },
    ]
    for (const f of factors) {
      const def = FACTORS[f]
      if (def.kind === 'number') cols.push({ key: `avg:${f}`, label: `${def.short} avg`, get: (r) => r.cells[f]?.average ?? null, band: (r) => cellBand(f, r.cells[f]?.average ?? null, cropYear), fmt: (v) => avgText(f, v as number | null), numeric: true })
      if (def.banded) {
        cols.push({ key: `prem:${f}`, label: `${def.short} prem`, get: (r) => (r.cells[f]?.classed ? r.cells[f].premium : null), tone: () => 'favorable', fmt: (v) => pct1(v as number | null), numeric: true })
        cols.push({ key: `base:${f}`, label: `${def.short} base`, get: (r) => (r.cells[f]?.classed ? r.cells[f].base : null), fmt: (v) => pct1(v as number | null), numeric: true })
        cols.push({ key: `disc:${f}`, label: `${def.short} disc`, get: (r) => (r.cells[f]?.classed ? r.cells[f].discount : null), tone: (r) => ((r.cells[f]?.discount ?? 0) > 0 ? 'unfavorable' : 'muted'), fmt: (v) => pct1(v as number | null), numeric: true })
      }
    }
    if (contractLabel) cols.push({ key: 'meets', label: '% meets contract', get: (r) => r.meetsPct, tone: (r) => (r.meetsPct == null ? 'muted' : r.meetsPct >= 0.5 ? 'favorable' : 'warning'), fmt: (v) => pct1(v as number | null), numeric: true })
    return cols
  }, [factors, groupBy, cropYear, contractLabel])
  const sorted = useMemo(() => {
    const c = columns.find((x) => x.key === sort.key) ?? columns[0]
    return rows.slice().sort((a, z) => {
      const va = c.get(a), vz = c.get(z)
      if (va == null && vz == null) return 0
      if (va == null) return 1
      if (vz == null) return -1
      const cmp = typeof va === 'number' && typeof vz === 'number' ? va - vz : String(va).localeCompare(String(vz))
      return cmp * sort.dir
    })
  }, [rows, columns, sort])
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'label' ? 1 : -1 }))
  return (
    <div className="bg-white rounded-xl shadow">
      <div className="px-4 pt-3 pb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="font-semibold">By {GROUP_BY_LABEL[groupBy].toLowerCase()} <span className="text-sm font-normal text-slate-500">· {weighting === 'lbs' ? 'lbs-weighted' : 'per bale'} · tap a heading to sort · cells shaded by price band</span></div>
        <div className="no-print sm:ml-auto"><SegmentedChips options={GROUP_OPTIONS} value={groupBy} onChange={onGroupBy} /></div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className={theadCls}>
            <tr>
              {columns.map((c, i) => (
                <th key={c.key} className={`${i === 0 ? stickyColHeadCls + ' text-left' : 'text-right'} px-2 py-1.5 whitespace-nowrap`}>
                  <button type="button" onClick={() => onSort(c.key)} className="min-h-8 font-semibold hover:underline">
                    {c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key} className="border-t border-slate-100">
                {columns.map((c, i) => {
                  const v = c.get(r)
                  const band = c.band ? c.band(r) : null
                  const tone = c.tone && v != null ? c.tone(r) : 'neutral'
                  return (
                    <td key={c.key} className={`${i === 0 ? stickyColCls + ' font-semibold' : 'text-right tabular-nums'} px-2 py-1.5 whitespace-nowrap ${bandBg(band)} ${v == null ? 'text-slate-300' : toneText(tone)}`}>{c.fmt(v)}</td>
                  )
                })}
              </tr>
            ))}
            <tr className={grandTotalRowCls}>
              {columns.map((c, i) => {
                const v = c.get(total)
                const band = c.band ? c.band(total) : null
                return <td key={c.key} className={`${i === 0 ? stickyColCls + ' bg-slate-100' : 'text-right tabular-nums'} px-2 py-1.5 whitespace-nowrap ${bandBg(band)}`}>{c.fmt(v)}</td>
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bale list
// ---------------------------------------------------------------------------

function BaleList({ rows, allCount, factors, cropYear, drill, onClearDrill, view, contractLabel }: {
  rows: BaleRow[]; allCount: number; factors: FactorKey[]; cropYear: number; drill: Drill; onClearDrill: () => void; view: ContractView | null; contractLabel: string | null
}) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'pbi', dir: 1 })
  const [showAll, setShowAll] = useState(false)
  const columns = useMemo(() => {
    const cols: Array<{ key: string; label: string; get: (r: BaleRow) => number | string | null; render?: (r: BaleRow) => ReactNode; numeric: boolean }> = [
      { key: 'pbi', label: 'PBI', get: (r) => r.pbi, numeric: false },
      { key: 'receipt', label: 'Receipt', get: (r) => r.receiptLabel, numeric: false },
      { key: 'farm', label: 'Farm', get: (r) => r.farmName, numeric: false },
      { key: 'field', label: 'Field', get: (r) => r.fieldName, numeric: false },
      { key: 'variety', label: 'Variety', get: (r) => r.variety ?? '', numeric: false },
      { key: 'classDate', label: 'Class date', get: (r) => r.classDate ?? '', render: (r) => (r.classDate ? fmtDate(r.classDate) : <span className="text-slate-300">—</span>), numeric: false },
    ]
    for (const f of factors) {
      cols.push({
        key: `f:${f}`, label: FACTORS[f].short, numeric: FACTORS[f].kind === 'number',
        get: (r) => (r.grade ? factorValue(r.grade, f) : null),
        render: (r) => {
          if (!r.grade) return <span className="text-slate-300">—</span>
          const v = factorValue(r.grade, f)
          const band = cellBand(f, v, cropYear)
          return <span className={`${toneText(bandTone(band) === 'muted' ? 'neutral' : bandTone(band))}`}>{f === 'staple' ? (v == null ? '—' : String(v)) : f === 'loan' ? (typeof v === 'number' ? `${v.toFixed(2)}¢` : '—') : factorText(f, v)}</span>
        },
      })
    }
    cols.push({ key: 'lbs', label: 'Lbs', get: (r) => r.lbs, render: (r) => fmtInt(r.lbs), numeric: true })
    cols.push({ key: 'disposition', label: 'Disposition', get: (r) => DISPOSITION_TEXT[r.disposition], numeric: false })
    if (view) {
      cols.push({
        key: 'result', label: contractLabel ?? 'Contract', numeric: false,
        get: (r) => { const ev = view.evaluationOf(r.id); return ev ? EVALUATION_LABEL[ev.status] + (ev.status === 'fails' ? ' ' + ev.failures.map((x) => x.factor).join(',') : '') : '' },
        render: (r) => <ResultChip ev={view.evaluationOf(r.id)} />,
      })
    }
    return cols
  }, [factors, cropYear, view, contractLabel])
  const searched = useMemo(() => {
    const t = q.trim().toLowerCase()
    const base = t ? rows.filter((r) => [r.pbi, r.receiptLabel, r.farmName, r.fieldName, r.variety ?? '', r.entityName].some((s) => s.toLowerCase().includes(t))) : rows
    const c = columns.find((x) => x.key === sort.key) ?? columns[0]
    return base.slice().sort((a, z) => {
      const va = c.get(a), vz = c.get(z)
      if (va == null || va === '') return 1
      if (vz == null || vz === '') return -1
      const cmp = typeof va === 'number' && typeof vz === 'number' ? va - vz : String(va).localeCompare(String(vz), undefined, { numeric: true })
      return cmp * sort.dir
    })
  }, [rows, q, columns, sort])
  const visible = showAll ? searched : searched.slice(0, 100)
  const onSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  return (
    <div className="bg-white rounded-xl shadow">
      <div className="px-4 pt-3 pb-2 flex flex-wrap items-center gap-2">
        <div className="font-semibold">Bales <span className="text-sm font-normal text-slate-500">· {searched.length.toLocaleString()}{drill ? ` of ${allCount.toLocaleString()}` : ''}</span></div>
        {drill && (
          <button type="button" onClick={onClearDrill} className="rounded-full bg-sky-100 text-sky-900 px-3 min-h-9 text-xs font-semibold">Showing: {drill.label} ✕</button>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PBI, receipt, farm, field, variety…" className={`${inputCls} ml-auto w-72 max-w-full no-print`} aria-label="Search bales" />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className={theadCls}>
            <tr>
              {columns.map((c, i) => (
                <th key={c.key} className={`${i === 0 ? stickyColHeadCls + ' text-left' : c.numeric ? 'text-right' : 'text-left'} px-2 py-1.5 whitespace-nowrap`}>
                  <button type="button" onClick={() => onSort(c.key)} className="min-h-8 font-semibold hover:underline">{c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                {columns.map((c, i) => (
                  <td key={c.key} className={`${i === 0 ? stickyColCls + ' font-mono' : c.numeric ? 'text-right tabular-nums' : ''} px-2 py-1.5 whitespace-nowrap`}>
                    {c.render ? c.render(r) : (c.get(r) == null || c.get(r) === '' ? <span className="text-slate-300">—</span> : String(c.get(r)))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {searched.length > visible.length && (
        <div className="px-4 py-2 no-print">
          <button type="button" onClick={() => setShowAll(true)} className="text-sm text-brand-deep font-semibold underline min-h-10">Show all {searched.length.toLocaleString()} bales</button>
        </div>
      )}
    </div>
  )
}

export function ResultChip({ ev }: { ev: BaleEvaluation | undefined }) {
  if (!ev) return <span className="text-slate-300">—</span>
  const cls = ev.status === 'meets' ? 'bg-green-100 text-green-800' : ev.status === 'fails' ? 'bg-red-100 text-red-800' : ev.status === 'not_eligible' ? 'bg-slate-100 text-slate-700' : 'bg-amber-100 text-amber-800'
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{EVALUATION_LABEL[ev.status]}</span>
      {ev.status === 'fails' && <span className="text-xs text-slate-600">{ev.failures.map((f) => f.text).join(' · ')}</span>}
      {ev.status === 'not_eligible' && <span className="text-xs text-slate-500">{ev.reason}</span>}
    </span>
  )
}
