'use client'

// Income Sensitivity Report — one two-variable data table per crop: futures
// price levels down the side × yield levels across the top, each cell the
// revenue/acre or net profit/acre in that scenario. All cell math lives in
// lib/income-sensitivity.ts (which composes the marketing + crop-insurance
// engines); this component owns data fetching, the editable axes (persisted
// per crop), the display toggles, and the export payload.
//
// Key semantics (see the in-page methodology panel):
//   * contracted bushels stay at their locked prices — the scenario price
//     applies only to unpriced bushels (a zero-contract crop is fully
//     price-sensitive);
//   * once harvest starts, bushels from completed fields are fixed and the
//     yield axis applies only to the remaining acres; a fully-harvested crop
//     collapses to a single actual-yield column (price-only sensitivity);
//   * insurance is net of premium, at the scenario price as harvest price;
//   * government payments (toggle) add one flat $/acre to every crop's cells.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings, buildDoubleCropSet } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fieldCropAggregates } from '@/lib/yields'
import { segmentAcresByCrop, expectedProductionFromBreakout, isCottonCrop } from '@/lib/marketing'
import { harvestContractSymbol } from '@/lib/crop-insurance'
import { cropToHedgeCommodity } from '@/lib/contracts'
import { quantityFor } from '@/lib/hedging'
import { projectPayments, applyMyaResolution, programYearFor, otherPaymentsInRevenueYear } from '@/lib/government-payments'
import { resolveProgramYearConfig, programConfigNotice } from '@/lib/program-config'
import {
  axisValues, defaultPriceStep, defaultYieldStep, closestIndex,
  splitHarvestByCrop, buildScenarioGrid, flatGovPerAcre,
  type CropScenarioInputs, type HarvestSplit, type ScenarioCell,
} from '@/lib/income-sensitivity'
import { EmptyState, theadCls, toneText, signedTone } from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload, type ExportCell } from '@/lib/exports'
import type {
  Crop, Contract, CropAssumption, FieldPlanting, FuturesPosition, OptionPosition,
  CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco, HarvestPriceEstimate, ProgramYearConfig,
  CoveredCommodity, FarmBaseAcres, ArcPlcElection, ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment,
} from '@/lib/types'

type LoadRow = {
  id: string
  date: string
  crop_id: string | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
}
type SplitRow = { load_id: string; field_id: string; crop_id: string; dry_bushels: number | null }

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

// Per-crop axis overrides, persisted as strings ('' / missing = automatic).
// Keyed `${cropYear}:${cropId}` inside one localStorage record.
type AxisCfg = { pc?: string; ps?: string; pn?: string; yc?: string; ys?: string; yn?: string }

type ViewMode = 'revenue' | 'profit'

const bu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
const price2 = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const cents2 = (n: number) => `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}¢`
const parseNum = (s: string | undefined | null): number | null => {
  if (s == null || s.trim() === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

type CropView = {
  crop: Crop
  inputs: CropScenarioInputs
  split: HarvestSplit
  symbol: string | null
  /** Today's live discovery-month price — the "you are here" price. */
  currentPrice: number | null
  /** Expected yield on the acres the yield axis sensitizes. */
  expectedYield: number | null
  actualYield: number | null
  /** RMA final harvest price on file — insurance is pinned to it in every cell. */
  finalHarvestPrice: number | null
  contractedBu: number
  openHedgeBu: number
  priceValues: number[]
  yieldValues: number[]
  grid: ScenarioCell[][]
  hereRow: number
  hereCol: number
  autoPriceCenter: number | null
  autoYieldCenter: number | null
  priceStep: number
  yieldStep: number
  cfg: AxisCfg
}

export default function IncomeSensitivityReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [futures, setFutures] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<SplitRow[]>([])
  const [policies, setPolicies] = useState<CropInsurancePolicy[]>([])
  const [scos, setScos] = useState<CropInsuranceSco[]>([])
  const [ecos, setEcos] = useState<CropInsuranceEco[]>([])
  const [priceEstimates, setPriceEstimates] = useState<HarvestPriceEstimate[]>([])
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])
  // Government payments (for the flat $/acre toggle).
  const [commodities, setCommodities] = useState<CoveredCommodity[]>([])
  const [baseAcres, setBaseAcres] = useState<FarmBaseAcres[]>([])
  const [elections, setElections] = useState<ArcPlcElection[]>([])
  const [arcPriceData, setArcPriceData] = useState<ArcPlcPriceData[]>([])
  const [arcPayments, setArcPayments] = useState<ArcPlcPayment[]>([])
  const [otherPayments, setOtherPayments] = useState<OtherGovernmentPayment[]>([])
  // Live discovery-month futures per crop_id.
  const [liveEstimates, setLiveEstimates] = useState<Map<string, number>>(new Map())

  const [cropYear, setCropYear] = usePersistentState<number | ''>('income-sens:cropYear', '')
  const [view, setView] = usePersistentState<ViewMode>('income-sens:view', 'revenue')
  const [includeGov, setIncludeGov] = usePersistentState<boolean>('income-sens:gov', false)
  const [axes, setAxes] = usePersistentState<Record<string, AxisCfg>>('income-sens:axes', {})

  useEffect(() => {
    ;(async () => {
      const [cr, pl, ct, fp, op, ca, ld, sp, po, sc, ec, hpe, pgc, cc, ba, el, apd, apay, ogp] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('field_plantings').select('*'),
        supabase.from('contracts').select('*'),
        supabase.from('futures_positions').select('*'),
        supabase.from('options_positions').select('*'),
        supabase.from('crop_assumptions').select('*'),
        supabase.from('loads').select('id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override'),
        supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels'),
        supabase.from('crop_insurance_policies').select('*'),
        supabase.from('crop_insurance_sco').select('*'),
        supabase.from('crop_insurance_eco').select('*'),
        supabase.from('harvest_price_estimates').select('*').order('price_date', { ascending: false }),
        supabase.from('program_year_config').select('*'),
        supabase.from('covered_commodities').select('*'),
        supabase.from('farm_base_acres').select('*'),
        supabase.from('arc_plc_elections').select('*'),
        supabase.from('arc_plc_price_data').select('*'),
        supabase.from('arc_plc_payments').select('*'),
        supabase.from('other_government_payments').select('*'),
      ])
      setCrops((cr.data as Crop[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setContracts((ct.data as Contract[]) || [])
      setFutures((fp.data as FuturesPosition[]) || [])
      setOptions((op.data as OptionPosition[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setLoads((ld.data as LoadRow[]) || [])
      setSplits((sp.data as SplitRow[]) || [])
      setPolicies((po.data as CropInsurancePolicy[]) || [])
      setScos((sc.data as CropInsuranceSco[]) || [])
      setEcos((ec.data as CropInsuranceEco[]) || [])
      setPriceEstimates((hpe.data as HarvestPriceEstimate[]) || [])
      setProgramConfigs((pgc.data as ProgramYearConfig[]) || [])
      setCommodities((cc.data as CoveredCommodity[]) || [])
      setBaseAcres((ba.data as FarmBaseAcres[]) || [])
      setElections((el.data as ArcPlcElection[]) || [])
      setArcPriceData((apd.data as ArcPlcPriceData[]) || [])
      setArcPayments((apay.data as ArcPlcPayment[]) || [])
      setOtherPayments((ogp.data as OtherGovernmentPayment[]) || [])
      const yrs = (pl.data as FieldPlanting[] | null)?.map((p) => p.season_year) ?? []
      if (yrs.length > 0) setCropYear((cy) => (cy === '' ? Math.max(...yrs) : cy))
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year), cropYear === '' ? null : cropYear),
    [plantings, cropYear],
  )
  const yearPlantings = useMemo(
    () => plantings.filter((p) => p.season_year === cropYear),
    [plantings, cropYear],
  )
  const plantedCropIds = useMemo(() => Array.from(new Set(yearPlantings.map((p) => p.crop_id))), [yearPlantings])

  // Live harvest-month futures for every planted crop — the same request the
  // Marketing dashboard / Revenue Projections make. Reset up front so a failed
  // refetch never leaves another year's prices centering the axes.
  useEffect(() => {
    setLiveEstimates(new Map())
    if (cropYear === '' || plantedCropIds.length === 0) return
    const payload = plantedCropIds.map((id) => ({ crop_id: id, crop_name: cropById.get(id)?.name ?? '' })).filter((c) => c.crop_name)
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/harvest-price-estimate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: cropYear, crops: payload }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const m = new Map<string, number>()
        for (const e of (json.estimates ?? []) as Array<{ crop_id: string; price: number | null }>) {
          if (e.price != null) m.set(e.crop_id, Number(e.price))
        }
        setLiveEstimates(m)
      } catch { /* fall back to stored/assumed prices */ }
    })()
    return () => { cancelled = true }
  }, [cropYear, plantedCropIds, cropById])

  // Field-level dry bushels + last load date, splits-aware.
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { cropYear: cropYear === '' ? null : cropYear }),
    [loads, splits, cropById, cropYear],
  )
  const cropCompleteKeys = useMemo(() => {
    const s = new Set<string>()
    for (const a of assumptions) if (a.harvest_complete) s.add(`${a.crop_id}|${a.crop_year}`)
    return s
  }, [assumptions])

  // Harvested-fact vs still-in-the-field, per crop and per planting.
  const harvestSplit = useMemo(() => {
    if (cropYear === '') return { byCrop: new Map<string, HarvestSplit>(), statusByPlanting: new Map<string, 'complete' | 'in_progress' | 'unharvested'>() }
    return splitHarvestByCrop({ plantings, aggByKey, cropYear, cropCompleteKeys })
  }, [plantings, aggByKey, cropYear, cropCompleteKeys])

  // Expected yield on the REMAINING (not-yet-complete) acres, per crop — the
  // yield-axis center once harvest is underway, from the assumption breakouts.
  const doubleCropIds = useMemo(() => buildDoubleCropSet(plantings, cropById), [plantings, cropById])
  const remainingExpectedYield = useMemo(() => {
    const m = new Map<string, number>()
    if (cropYear === '') return m
    const remaining = yearPlantings.filter((p) => harvestSplit.statusByPlanting.get(p.id) !== 'complete')
    const prod = expectedProductionFromBreakout(segmentAcresByCrop(remaining, cropYear, doubleCropIds), assumptions, cropYear)
    const acres = new Map<string, number>()
    for (const p of remaining) acres.set(p.crop_id, (acres.get(p.crop_id) ?? 0) + Number(p.planted_acres ?? 0))
    for (const [cropId, production] of prod) {
      const ac = acres.get(cropId) ?? 0
      if (ac > 0) m.set(cropId, production / ac)
    }
    return m
  }, [yearPlantings, harvestSplit, cropYear, doubleCropIds, assumptions])

  // Per-year program parameters (SCO trigger, sequestration).
  const programCfg = useMemo(
    () => resolveProgramYearConfig(cropYear === '' ? new Date().getFullYear() : cropYear, programConfigs),
    [cropYear, programConfigs],
  )
  const programNotice = cropYear === '' ? null : programConfigNotice(programCfg)

  // Flat government $/acre: the payments RECEIVED during crop year Y ÷ total
  // planted acres across ALL crops — net ARC/PLC for program year Y−1 (paid
  // October of Y, projected from that program year's own stored/final prices
  // and parameters) plus other USDA payments landing in Y. Held constant
  // across cells (current projections — never re-derived from the scenario
  // price).
  const govPerAcre = useMemo(() => {
    if (cropYear === '') return 0
    const programYear = programYearFor(cropYear)
    const payCfg = resolveProgramYearConfig(programYear, programConfigs)
    const effPrice = applyMyaResolution({ cropYear: programYear, commodities, priceData: arcPriceData, liveEstimates: new Map() })
    const projected = projectPayments({ cropYear: programYear, baseAcres, commodities, elections, priceData: effPrice, payments: arcPayments, sequestrationPct: payCfg.sequestrationPct })
    const totalArcPlc = projected.reduce((s, p) => s + p.result.net, 0)
    const totalOther = otherPaymentsInRevenueYear(otherPayments, cropYear).reduce((s, o) => s + Number(o.amount), 0)
    const totalAcres = yearPlantings.reduce((s, p) => s + Number(p.planted_acres ?? 0), 0)
    return flatGovPerAcre(totalArcPlc + totalOther, totalAcres)
  }, [cropYear, commodities, arcPriceData, baseAcres, elections, arcPayments, otherPayments, yearPlantings, programConfigs])

  // ---- Per-crop views: inputs, axes, and the computed grid ----
  const cropViews: CropView[] = useMemo(() => {
    if (cropYear === '') return []
    const yearContracts = contracts.filter((c) => c.crop_year === cropYear)
    const yearFutures = futures.filter((f) => f.crop_year === cropYear)
    const yearOptions = options.filter((o) => o.crop_year === cropYear)
    const views: CropView[] = []
    for (const cropId of plantedCropIds) {
      const crop = cropById.get(cropId)
      if (!crop) continue
      const cps = yearPlantings.filter((p) => p.crop_id === cropId)
      const plantedAcres = cps.reduce((s, p) => s + Number(p.planted_acres ?? 0), 0)
      if (plantedAcres <= 0) continue
      const irrigatedAcres = cps.reduce((s, p) => s + (Number(p.irrigated_acres) || 0), 0)
      const drylandAcres = cps.reduce((s, p) => s + (Number(p.dryland_acres) || 0), 0)
      const split = harvestSplit.byCrop.get(cropId) ?? { fixedBu: 0, completedAcres: 0, remainingAcres: plantedAcres, state: 'pre' as const }
      const assumption = assumptions.find((a) => a.crop_id === cropId && a.crop_year === cropYear)
      const cropPolicies = policies.filter((p) => p.crop_id === cropId && p.crop_year === cropYear)
      // Once the RMA FINAL harvest price is on file (policy or stored final),
      // insurance in every cell uses it — the same basis as the Claims Monitor.
      const policyFinal = cropPolicies.find((p) => p.harvest_price != null)?.harvest_price
      const storedFinal = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_final')
      const finalHarvestPrice = policyFinal != null ? Number(policyFinal) : storedFinal ? Number(storedFinal.price) : null
      const inputs: CropScenarioInputs = {
        crop, cropYear, plantedAcres, irrigatedAcres, drylandAcres,
        fixedHarvestedBu: split.fixedBu, remainingAcres: split.remainingAcres,
        contracts: yearContracts.filter((c) => c.crop_id === cropId),
        futures: yearFutures, options: yearOptions,
        assumption, policies: cropPolicies, scos, ecos,
        scoTrigger: programCfg.scoTrigger,
        finalHarvestPrice,
      }

      const contractedBu = inputs.contracts.reduce((s, c) => s + Number(c.contracted_bushels ?? 0), 0)
      const commodity = cropToHedgeCommodity(crop.name)
      // Bushels for grains, lbs for cotton (quantityFor knows each contract size).
      const openHedgeBu = commodity
        ? yearFutures.filter((f) => f.commodity === commodity && f.side === 'short' && f.status === 'open')
            .reduce((s, f) => s + quantityFor(commodity, Number(f.num_contracts)), 0)
        : 0

      // Axis defaults. Price centers on today's live benchmark quote (fallbacks:
      // the standing assumed futures, then the avg projected price on file).
      const live = liveEstimates.get(cropId) ?? null
      const assumedFutures = assumption?.assumed_futures != null ? Number(assumption.assumed_futures) : null
      const avgProjected = cropPolicies.length > 0
        ? cropPolicies.reduce((s, p) => s + Number(p.projected_price), 0) / cropPolicies.length
        : null
      const autoPriceCenter = live ?? assumedFutures ?? avgProjected
      const actualYield = split.fixedBu > 0 && plantedAcres > 0 && split.state === 'complete' ? split.fixedBu / plantedAcres : null
      const expectedRemaining = remainingExpectedYield.get(cropId)
        ?? (assumption?.expected_yield != null ? Number(assumption.expected_yield) : null)
      const autoYieldCenter = split.state === 'complete' ? actualYield : expectedRemaining

      const cfg = axes[`${cropYear}:${cropId}`] ?? {}
      const priceStep = parseNum(cfg.ps) ?? defaultPriceStep(crop.name)
      const yieldStep = parseNum(cfg.ys) ?? defaultYieldStep(crop.name)
      const priceSteps = Math.min(10, Math.max(1, Math.round(parseNum(cfg.pn) ?? 5)))
      const yieldSteps = Math.min(10, Math.max(1, Math.round(parseNum(cfg.yn) ?? 5)))
      const priceCenter = parseNum(cfg.pc) ?? autoPriceCenter
      const yieldCenter = parseNum(cfg.yc) ?? autoYieldCenter

      const priceValues = priceCenter != null && priceCenter > 0 && priceStep > 0
        ? axisValues({ center: priceCenter, step: priceStep, steps: priceSteps })
        : []
      // Fully harvested → yield is a fact: one column at the actual yield.
      const yieldValues = split.state === 'complete'
        ? (actualYield != null ? [actualYield] : [])
        : yieldCenter != null && yieldCenter > 0 && yieldStep > 0
          ? axisValues({ center: yieldCenter, step: yieldStep, steps: yieldSteps })
          : []

      const grid = priceValues.length > 0 && yieldValues.length > 0
        ? buildScenarioGrid(inputs, priceValues, yieldValues, { govPerAcre: includeGov ? govPerAcre : 0 })
        : []
      views.push({
        crop, inputs, split,
        symbol: harvestContractSymbol(crop.name, cropYear),
        currentPrice: live,
        expectedYield: split.state === 'complete' ? actualYield : expectedRemaining,
        actualYield,
        finalHarvestPrice,
        contractedBu, openHedgeBu,
        priceValues, yieldValues, grid,
        hereRow: closestIndex(priceValues, live),
        hereCol: yieldValues.length === 1 ? 0 : closestIndex(yieldValues, split.state === 'complete' ? actualYield : expectedRemaining),
        autoPriceCenter, autoYieldCenter, priceStep, yieldStep, cfg,
      })
    }
    return views.sort((a, b) => a.crop.name.localeCompare(b.crop.name))
  }, [cropYear, plantedCropIds, cropById, yearPlantings, contracts, futures, options, assumptions, policies, scos, ecos, priceEstimates, harvestSplit, remainingExpectedYield, liveEstimates, axes, programCfg, includeGov, govPerAcre])

  function setAxis(cropId: string, patch: Partial<AxisCfg>) {
    const key = `${cropYear}:${cropId}`
    setAxes((m) => ({ ...m, [key]: { ...(m[key] ?? {}), ...patch } }))
  }

  const cellValue = (cell: ScenarioCell): number | null =>
    view === 'profit' ? cell.profitPerAcre : cell.revenuePerAcre

  // ----- Export payload (shared lib/exports.ts layer) -----
  function buildExportPayload(): ExportPayload {
    const viewLabel = view === 'profit' ? 'Net profit/acre' : 'Revenue/acre'
    const govLabel = includeGov
      ? `Government payments: included (flat ${formatNumber(govPerAcre, 'usd2')}/ac across all crops)`
      : 'Government payments: excluded'
    const sections: ExportPayload['sections'] = cropViews
      .filter((v) => v.grid.length > 0)
      .map((v) => {
        // Cotton axes are ¢/lb × lbs/ac; grains $/bu × bu/ac.
        const isCotton = isCottonCrop(v.crop.name)
        const qty = isCotton ? 'lbs' : 'bu'
        const columns = [
          { label: `${v.symbol ? `${v.symbol} futures` : 'Futures'} ${isCotton ? '¢/lb' : '$/bu'}`, align: 'right' as const, format: (isCotton ? 'cents' : 'price') as 'cents' | 'price' },
          ...v.yieldValues.map((y) => ({
            label: `${formatNumber(y, 'yield')} ${isCotton ? 'lbs/ac' : 'bu/ac'}${v.split.state === 'complete' ? ' (actual)' : ''}`,
            align: 'right' as const, format: 'usd2' as const,
          })),
        ]
        const regime = v.contractedBu + v.openHedgeBu > 0
          ? `${formatNumber(v.contractedBu, 'bu')} ${qty} contracted${v.openHedgeBu > 0 ? ` + ${formatNumber(v.openHedgeBu, 'bu')} ${qty} hedged` : ''} at locked prices — scenario price applies to remaining ${isCotton ? 'lbs' : 'bushels'}`
          : 'No contracts — fully price-sensitive'
        const harvestNote = v.split.state === 'partial'
          ? ` · Harvested so far: ${formatNumber(v.split.fixedBu, 'bu')} bu on ${formatNumber(v.split.completedAcres, 'acres')} ac (actual); yield axis applies to the remaining ${formatNumber(v.split.remainingAcres, 'acres')} ac`
          : v.split.state === 'complete'
            ? ' · Harvest complete — yield is actual; table is price-only'
            : ''
        const rows: ExportCell[][] = [
          [`${regime}${harvestNote}`, ...v.yieldValues.map(() => '')],
          ...v.grid.map((row, ri) => [
            v.priceValues[ri],
            ...row.map((cell): ExportCell => {
              const val = cellValue(cell)
              if (val == null) return ''
              return view === 'profit' ? { v: val, tone: signedTone(val) } : val
            }),
          ]),
        ]
        return {
          title: v.crop.name,
          columns,
          rows,
          rowMeta: ['subhead' as const, ...v.grid.map(() => 'data' as const)],
        }
      })
    return {
      title: 'Income Sensitivity',
      filters: [`Crop year: ${cropYear || '—'}`, `View: ${viewLabel}`, govLabel].join(' · '),
      // Never export zero sections (exceljs needs at least one sheet).
      sections: sections.length > 0 ? sections : [{ columns: [{ label: 'No sensitivity tables' }], rows: [] }],
      orientation: 'landscape',
    }
  }
  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropViews, view, includeGov, govPerAcre, cropYear, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  if (loading) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4 print-area">
      {/* Filters + display toggles */}
      <div className="flex flex-wrap gap-3 items-end no-print">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year *</span>
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
        <div className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Cell value</span>
          <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
            {(['revenue', 'profit'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setView(m)}
                className={`px-3 py-2 text-sm font-semibold ${view === m ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'} ${m === 'profit' ? 'border-l border-slate-300' : ''}`}
              >
                {m === 'revenue' ? 'Revenue/acre' : 'Net profit/acre'}
              </button>
            ))}
          </span>
        </div>
        <label className="text-sm flex items-center gap-2 self-end pb-2.5">
          <input type="checkbox" checked={includeGov} onChange={(e) => setIncludeGov(e.target.checked)} className="h-4 w-4" />
          <span className="text-slate-600">
            Include government payments <span className="text-slate-400">(flat {formatNumber(govPerAcre, 'usd2')}/ac across all crops)</span>
          </span>
        </label>
      </div>

      {cropYear === '' && <p className="text-amber-700 text-sm">Pick a crop year to build the sensitivity tables.</p>}

      {programNotice && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-300 px-3 py-2 text-sm text-yellow-900">{programNotice}</div>
      )}

      {cropYear !== '' && cropViews.length === 0 && (
        <EmptyState
          message={`No planted crops for ${cropYear}.`}
          hint="Add plantings for this crop year to run scenarios."
          linkHref="/settings/plantings"
          linkLabel="Add plantings"
        />
      )}

      {cropYear !== '' && cropViews.length > 0 && (
        <>
          {/* How this is calculated */}
          <details className="bg-white rounded-xl shadow text-sm no-print">
            <summary className="cursor-pointer select-none px-4 py-3 font-semibold text-slate-700">How this is calculated</summary>
            <div className="border-t border-slate-100 px-4 py-3 space-y-2 text-slate-600">
              <p><strong className="text-slate-700">Contracted bushels stay locked</strong> — flat-cash contracts at their
                cash price, futures-priced contracts at their locked futures + basis (assumed basis where basis isn&apos;t
                set), open short hedges at their trade price, realized hedge P&amp;L counted once. The scenario price
                applies only to the <em>unpriced</em> bushels (plus the assumed basis), exactly like the Marketing
                Dashboard values them. If scenario production falls below contracted bushels, revenue is capped at
                production (the over-contracting rule).</p>
              <p><strong className="text-slate-700">Yield axis</strong> — bushels from harvest-complete fields are fixed
                facts; the scenario yield applies only to the remaining acres (scenario production = harvested bushels +
                scenario yield × remaining acres). Before harvest that is simply yield × planted acres; once a crop is
                fully harvested the yield axis collapses to the single actual yield and only price risk remains.</p>
              <p><strong className="text-slate-700">Crop insurance</strong> — every policy (RP / RP-HPE / YP + SCO/ECO,
                per practice) re-runs in each cell with the scenario price as the harvest price and the cell&apos;s blended
                yield allocated to the policy&apos;s practice. Once the RMA <em>final</em> harvest price is on file it is
                used in every cell instead (the price axis then moves crop sales only), matching the Claims Monitor.
                Cells show <em>net</em> insurance P&amp;L (indemnity − premium), the same engine as the Claims Monitor.</p>
              <p><strong className="text-slate-700">Government payments</strong> (toggle) — government payments shown
                are those expected to be <strong>received during the {cropYear} crop year</strong> (i.e.,
                the {programYearFor(cropYear)} program-year ARC/PLC paid in
                fall {cropYear}, plus other USDA payments landing in {cropYear}). Total ÷
                total planted acres = one flat $/acre added identically to every crop&apos;s cells (payments are
                decoupled from planted acres). Held constant across cells — they are current projections, not
                re-derived from the scenario price.</p>
              <p><strong className="text-slate-700">Cell value</strong> — Revenue/acre = (crop sales + net insurance
                [+ government]) ÷ planted acres. Net profit/acre subtracts the crop&apos;s cost/acre from the Marketing
                assumptions.</p>
            </div>
          </details>

          {cropViews.map((v) => (
            <CropSensitivitySection
              key={`${v.crop.id}-${cropYear}`}
              view={v}
              mode={view}
              onAxisChange={(patch) => setAxis(v.crop.id, patch)}
            />
          ))}
        </>
      )}
    </div>
  )
}

// Module-scope so the input keeps its identity (and focus) across re-renders.
// Commits on blur/Enter (app convention), not per keystroke — every commit
// recomputes the scenario grids, so typing must stay local.
function AxisField({ label, value, placeholder, onCommit, step }: {
  label: string; value: string; placeholder: string; onCommit: (s: string) => void; step?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <label className="flex items-center gap-1 text-xs text-slate-500">
      {label}
      <input
        type="number" step={step ?? 'any'} value={draft} placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onCommit(draft) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="w-20 rounded border border-slate-300 px-2 py-1 text-right tabular-nums text-sm"
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// One full-width section per crop (same stacked layout language as the
// Marketing Dashboard): identity + regime badge + harvest note, compact axis
// controls, then the two-variable table with the "you are here" cell marked.
// ---------------------------------------------------------------------------
function CropSensitivitySection({
  view: v, mode, onAxisChange,
}: {
  view: CropView
  mode: ViewMode
  onAxisChange: (patch: Partial<AxisCfg>) => void
}) {
  const locked = v.contractedBu + v.openHedgeBu > 0
  const missingCost = mode === 'profit' && v.inputs.assumption?.cost_per_acre == null
  // Cotton reads in ¢/lb and lbs of lint; grains in $/bu and bushels.
  const isCotton = isCottonCrop(v.crop.name)
  const qty = isCotton ? 'lbs' : 'bu'
  const yUnit = isCotton ? 'lbs/ac' : 'bu/ac'
  const fmtP = isCotton ? cents2 : price2
  const yieldAxisLabel = v.split.state === 'partial'
    ? `Yield on remaining ${bu(v.split.remainingAcres)} acres (${yUnit})`
    : `Yield (${yUnit})`

  return (
    <section className="bg-white rounded-xl shadow avoid-break">
      <div className="p-4 md:p-5 space-y-3">
        {/* Identity + regime */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="font-bold text-xl leading-tight">{v.crop.name}</div>
            <div className="text-sm text-slate-500 tabular-nums mt-0.5">{bu(v.inputs.plantedAcres)} acres planted</div>
          </div>
          <span className={`text-xs rounded-full px-2.5 py-1 font-semibold ${locked ? 'bg-slate-200 text-slate-700' : 'bg-sky-100 text-sky-800'}`}>
            {locked
              ? `${bu(v.contractedBu)} ${qty} contracted${v.openHedgeBu > 0 ? ` + ${bu(v.openHedgeBu)} ${qty} hedged` : ''} at locked prices — scenario price applies to remaining ${isCotton ? 'lbs' : 'bushels'}`
              : 'No contracts — fully price-sensitive'}
          </span>
          {v.split.state === 'partial' && (
            <span className="text-xs text-slate-500">
              Harvested so far: <strong className="text-slate-700 tabular-nums">{bu(v.split.fixedBu)} {qty}</strong> on{' '}
              <strong className="text-slate-700 tabular-nums">{bu(v.split.completedAcres)} acres</strong> (actual)
            </span>
          )}
          {v.split.state === 'complete' && (
            <span className="text-xs rounded-full bg-green-100 text-green-800 px-2.5 py-1">
              Harvest complete — yield is actual; table is price-only
            </span>
          )}
          {v.finalHarvestPrice != null && (
            <span className="text-xs rounded-full bg-green-100 text-green-800 px-2.5 py-1" title="Insurance in every cell uses the RMA final; the price axis moves crop sales only.">
              RMA final harvest price {price2(v.finalHarvestPrice)} on file — insurance pinned to it
            </span>
          )}
        </div>

        {/* Axis controls */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 no-print">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Price axis</span>
            <AxisField label="center" step="0.01" value={v.cfg.pc ?? ''} placeholder={v.autoPriceCenter != null ? v.autoPriceCenter.toFixed(2) : '—'} onCommit={(s) => onAxisChange({ pc: s })} />
            <AxisField label="step" step="0.05" value={v.cfg.ps ?? ''} placeholder={v.priceStep.toFixed(2)} onCommit={(s) => onAxisChange({ ps: s })} />
            <AxisField label="± steps" step="1" value={v.cfg.pn ?? ''} placeholder="5" onCommit={(s) => onAxisChange({ pn: s })} />
          </div>
          {v.split.state !== 'complete' && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Yield axis</span>
              <AxisField label="center" step="1" value={v.cfg.yc ?? ''} placeholder={v.autoYieldCenter != null ? v.autoYieldCenter.toFixed(1) : '—'} onCommit={(s) => onAxisChange({ yc: s })} />
              <AxisField label="step" step="1" value={v.cfg.ys ?? ''} placeholder={v.yieldStep.toFixed(0)} onCommit={(s) => onAxisChange({ ys: s })} />
              <AxisField label="± steps" step="1" value={v.cfg.yn ?? ''} placeholder="5" onCommit={(s) => onAxisChange({ yn: s })} />
            </div>
          )}
        </div>

        {missingCost && (
          <p className="text-xs text-amber-700">
            No cost/acre set for {v.crop.name} — cells show “—” in Net profit view. Set it in the Marketing Dashboard assumptions.
          </p>
        )}

        {v.grid.length === 0 ? (
          <p className="text-sm text-amber-700">
            {v.priceValues.length === 0
              ? 'No futures price available to center the price axis — enter a center price above.'
              : 'No expected yield available to center the yield axis — enter a center yield above.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  <th className="text-right px-2 py-1 whitespace-nowrap">
                    {v.symbol ? `${v.symbol} futures` : 'Futures'} {isCotton ? '¢/lb' : '$/bu'} ↓
                  </th>
                  {v.yieldValues.map((y, ci) => (
                    <th
                      key={ci}
                      className={`text-right px-2 py-1 whitespace-nowrap tabular-nums ${ci === v.hereCol ? 'bg-sky-100 text-sky-900' : ''}`}
                      title={ci === v.hereCol ? 'Closest to the expected yield' : undefined}
                    >
                      {v.split.state === 'complete' ? `${y.toFixed(1)} (actual)` : y.toFixed(1)}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th className="text-right px-2 py-0.5 text-[10px] font-normal text-slate-400" colSpan={1 + v.yieldValues.length}>
                    {yieldAxisLabel} →
                  </th>
                </tr>
              </thead>
              <tbody>
                {v.grid.map((row, ri) => (
                  <tr key={ri} className={`border-t border-slate-100 ${ri === v.hereRow ? 'bg-sky-50/60' : ''}`}>
                    <td
                      className={`px-2 py-1 text-right tabular-nums font-semibold whitespace-nowrap ${ri === v.hereRow ? 'bg-sky-100 text-sky-900' : 'text-slate-600'}`}
                      title={ri === v.hereRow ? 'Closest to the current futures price' : undefined}
                    >
                      {fmtP(v.priceValues[ri])}
                    </td>
                    {row.map((cell, ci) => {
                      const val = mode === 'profit' ? cell.profitPerAcre : cell.revenuePerAcre
                      const here = ri === v.hereRow && ci === v.hereCol
                      const tone = mode === 'profit' && val != null ? toneText(signedTone(val)) : ''
                      return (
                        <td
                          key={ci}
                          className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${tone} ${here ? 'ring-2 ring-inset ring-sky-500 rounded font-bold' : ci === v.hereCol ? 'bg-sky-50/60' : ''}`}
                          title={`${fmtP(cell.price)} × ${cell.scenarioYield.toFixed(1)} ${yUnit} → ${bu(cell.production)} ${qty} · sales ${formatNumber(cell.cropRevenue, 'usd0')} · ins. net ${formatNumber(cell.insuranceNet, 'usd0')}`}
                        >
                          {val != null ? formatNumber(val, 'usd2') : '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {v.grid.length > 0 && (
          <p className="text-[11px] text-slate-400">
            {mode === 'profit' ? 'Net profit/acre' : 'Revenue/acre'} per scenario.
            {v.currentPrice != null && ` Highlighted row/column mark today's ${v.symbol ?? ''} price (${fmtP(v.currentPrice)})${v.expectedYield != null ? ` and the ${v.split.state === 'complete' ? 'actual' : 'expected'} yield (${v.expectedYield.toFixed(1)} ${yUnit})` : ''}.`}
            {' '}Hover a cell for production, sales, and insurance detail.
          </p>
        )}
      </div>
    </section>
  )
}
