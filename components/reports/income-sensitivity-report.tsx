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
import { fieldCropAggregates, type CombineEntryLike } from '@/lib/yields'
import { segmentAcresByCrop, expectedProductionFromBreakout, isCottonCrop } from '@/lib/marketing'
import { fetchCottonPhysical, type CottonPhysicalData } from '@/lib/cotton-physical-fetch'
import type { CottonPhysicalSummary } from '@/lib/cotton-sales'
import { buildEntityScope } from '@/lib/entity-scope'
import EntityFilter from '@/components/entity-filter'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { useViewerAssumptions } from '@/lib/use-viewer-assumptions'
import { marketingReferenceContract, referenceMonthOptions, fallForwardOnMissingQuote, type ReferenceContract } from '@/lib/reference-contract'
import { resolveCropAssumptions, resolveCountyAssumptions } from '@/lib/viewer-assumptions'
import { SupersededNotice } from '@/components/viewer-scenario'
import { harvestContractSymbol, countyAssumptionFor, isAreaPlan } from '@/lib/crop-insurance'
import { cropToHedgeCommodity } from '@/lib/contracts'
import { quantityFor, formatCottonPrice, parseCottonPriceInput } from '@/lib/hedging'
import { projectPayments, applyMyaResolution, programYearFor, otherPaymentsInRevenueYear } from '@/lib/government-payments'
import { resolveProgramYearConfig, programConfigNotice } from '@/lib/program-config'
import {
  axisValues, defaultPriceStep, defaultYieldStep, closestIndex, insurancePriceToAxisUnits,
  splitHarvestByCrop, buildScenarioGrid, flatGovPerAcre,
  type CropScenarioInputs, type HarvestSplit, type ScenarioCell,
} from '@/lib/income-sensitivity'
import { EmptyState, theadCls, toneText, signedTone } from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload, type ExportCell } from '@/lib/exports'
import type {
  CropInsuranceStax, CropInsuranceMco, CountyYieldAssumption,
  Crop, Contract, CropAssumption, Entity, FieldPlanting, FuturesPosition, OptionPosition,
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
// cm: county yield scenario mode — 'ind' (independent, default) | 'move'
// ("county moves with me", widespread-loss scenario). Persisted per crop.
type AxisCfg = { pc?: string; ps?: string; pn?: string; yc?: string; ys?: string; yn?: string; cm?: 'ind' | 'move' }

type ViewMode = 'revenue' | 'profit'

const bu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
const price2 = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// ¢/lb-stored cotton prices display as $/lb.
const cents2 = (n: number) => formatCottonPrice(n)
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
  /** County yield scenario (045). */
  countyPinned: boolean
  hasCountyLegs: boolean
  countyMode: 'independent' | 'with_farm'
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
  const [combineEntries, setCombineEntries] = useState<CombineEntryLike[]>([])
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
  // Physical cotton marketing (044): sold/pool/loan facts that lock lbs and
  // floor in-loan cells at the banked CCC loan value. Raw fetch; the
  // entity-scoped summary is derived below.
  const [cottonPhysicalRaw, setCottonPhysicalRaw] = useState<CottonPhysicalData | null>(null)
  // Viewer role (052): grants cap the entity scope; the viewer's private
  // overrides layer over the shared crop/county assumptions.
  const viewer = useViewerScope(supabase)
  const viewerA = useViewerAssumptions(supabase, viewer)
  // Entity filter (shared scoping — see lib/entity-scope.ts). Operation-wide
  // assumptions and axis defaults flow down; acres/positions/policies narrow.
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Array<{ id: string; entity_id: string | null }>>([])
  const [fields, setFields] = useState<Array<{ id: string; farm_id: string | null }>>([])
  // 045: STAX/MCO endorsements + the shared county-yield assumptions.
  const [staxes, setStaxes] = useState<CropInsuranceStax[]>([])
  const [mcos, setMcos] = useState<CropInsuranceMco[]>([])
  const [countyAssumptions, setCountyAssumptions] = useState<CountyYieldAssumption[]>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [sx, mc, ca] = await Promise.all([
        supabase.from('crop_insurance_stax').select('*'),
        supabase.from('crop_insurance_mco').select('*'),
        supabase.from('county_yield_assumptions').select('*'),
      ])
      if (cancelled) return
      setStaxes((sx.data as CropInsuranceStax[]) || [])
      setMcos((mc.data as CropInsuranceMco[]) || [])
      setCountyAssumptions((ca.data as CountyYieldAssumption[]) || [])
    })()
    return () => { cancelled = true }
  }, [supabase])

  const [cropYear, setCropYear] = usePersistentState<number | ''>('income-sens:cropYear', '')

  // Fetch the year's physical cotton marketing (tolerates 044 absent → null).
  useEffect(() => {
    if (cropYear === '') { setCottonPhysicalRaw(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const physical = await fetchCottonPhysical(supabase, cropYear)
        if (!cancelled) setCottonPhysicalRaw(physical)
      } catch { if (!cancelled) setCottonPhysicalRaw(null) }
    })()
    return () => { cancelled = true }
  }, [cropYear, supabase])

  const [view, setView] = usePersistentState<ViewMode>('income-sens:view', 'revenue')
  const [includeGov, setIncludeGov] = usePersistentState<boolean>('income-sens:gov', false)
  const [axes, setAxes] = usePersistentState<Record<string, AxisCfg>>('income-sens:axes', {})
  const [entityId, setEntityId] = usePersistentState('income-sens:entity', '')

  useEffect(() => {
    ;(async () => {
      const [cr, pl, ct, fp, op, ca, ld, sp, po, sc, ec, hpe, pgc, cc, ba, el, apd, apay, ogp, en, fa, fi, ce] = await Promise.all([
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
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('id, entity_id'),
        supabase.from('fields').select('id, farm_id'),
        // May not exist yet (migration 062): an error leaves data null → [].
        supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date'),
      ])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as Array<{ id: string; entity_id: string | null }>) || [])
      setFields((fi.data as Array<{ id: string; farm_id: string | null }>) || [])
      setCrops((cr.data as Crop[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setContracts((ct.data as Contract[]) || [])
      setFutures((fp.data as FuturesPosition[]) || [])
      setOptions((op.data as OptionPosition[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setLoads((ld.data as LoadRow[]) || [])
      setSplits((sp.data as SplitRow[]) || [])
      setCombineEntries((ce.data as CombineEntryLike[]) || [])
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

  // The viewer's effective assumptions: shared rows + their private overrides
  // (identity for owners). Stale overrides (admin changed the base) drop out
  // and are lazily deleted.
  const cropRes = useMemo(() => resolveCropAssumptions(assumptions, viewerA.overrides), [assumptions, viewerA.overrides])
  const countyRes = useMemo(() => resolveCountyAssumptions(countyAssumptions, viewerA.overrides), [countyAssumptions, viewerA.overrides])
  const effAssumptions = cropRes.rows
  const effCountyAssumptions = countyRes.rows
  useEffect(() => {
    const stale = [...cropRes.staleIds, ...countyRes.staleIds]
    if (stale.length > 0) viewerA.cleanupStale(stale)
  }, [cropRes, countyRes, viewerA])

  // Shared entity scoping — the same layer Marketing / Revenue Projections
  // apply, so the pages agree on what "entity selected" means. Assumptions and
  // axis defaults are operation-wide and flow down unchanged.
  const scope = useMemo(
    () => buildEntityScope({ entityId, farms, fields, entities, grantedEntityIds: viewer.grantedIds }),
    [entityId, farms, fields, entities, viewer.grantedIds],
  )
  const entityName = entityId
    ? entities.find((e) => e.id === entityId)?.name ?? null
    : viewerAllEntitiesLabel(viewer, entities)
  const scopedPlantings = useMemo(() => scope.plantings(plantings), [scope, plantings])
  // Contracts/hedges attribute (entity-keyed → whole; operation-level → the
  // entity's acre share of the crop), so filtered sales don't vanish.
  const attribution = useMemo(() => scope.attribution({ plantings, crops }), [scope, plantings, crops])
  const scopedContracts = useMemo(() => attribution.contracts(contracts), [attribution, contracts])
  const scopedFutures = useMemo(() => attribution.futures(futures), [attribution, futures])
  const scopedOptions = useMemo(() => attribution.options(options), [attribution, options])
  const scopedPolicies = useMemo(() => scope.byEntity(policies), [scope, policies])
  // Own-name rows whole; marketing-agent/null rows flow down at the entity's
  // cotton acre share — same attribution as grain.
  const cottonPhysicalSummary = useMemo(
    () => (cottonPhysicalRaw ? attribution.cottonSummary(cottonPhysicalRaw.inputs) : null),
    [cottonPhysicalRaw, attribution],
  )

  const yearPlantings = useMemo(
    () => scopedPlantings.filter((p) => p.season_year === cropYear),
    [scopedPlantings, cropYear],
  )
  const plantedCropIds = useMemo(() => Array.from(new Set(yearPlantings.map((p) => p.crop_id))), [yearPlantings])

  // Live reference-contract quotes for every planted crop — the SAME expiry-
  // aware resolver (+ any pinned month) the Marketing dashboard uses, so the
  // price-axis center and header name the same contract everywhere. The
  // insurance math beneath the axis (projected price, RMA final pinning)
  // keeps its own harvest-price seams untouched. Reset up front so a failed
  // refetch never leaves another year's prices centering the axes.
  const refAsOf = useMemo(() => new Date(), [])
  const refByCrop = useMemo(() => {
    const m = new Map<string, ReferenceContract>()
    if (cropYear === '') return m
    for (const id of plantedCropIds) {
      const c = cropById.get(id)
      if (!c) continue
      const pinned = effAssumptions.find((a) => a.crop_id === id && a.crop_year === cropYear)?.reference_contract_month ?? null
      const ref = marketingReferenceContract(c.name, cropYear, refAsOf, pinned)
      if (ref) m.set(id, ref)
    }
    return m
  }, [cropYear, plantedCropIds, cropById, effAssumptions, refAsOf])
  // Effective (quote-backed) reference symbol per crop, for the axis header.
  const [refSymbols, setRefSymbols] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    setLiveEstimates(new Map())
    setRefSymbols(new Map())
    if (cropYear === '' || refByCrop.size === 0) return
    const optsByCrop = new Map<string, ReturnType<typeof referenceMonthOptions>>()
    for (const [id] of refByCrop) {
      const c = cropById.get(id)
      if (c) optsByCrop.set(id, referenceMonthOptions(c.name, cropYear, refAsOf))
    }
    const symbols = Array.from(new Set([
      ...[...refByCrop.values()].map((r) => r.symbol),
      ...[...optsByCrop.values()].flat().map((o) => o.symbol),
    ]))
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/market-prices', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const bySymbol = new Map<string, number>()
        for (const p of (json.prices ?? []) as Array<{ symbol: string; price: number | null }>) {
          if (p.price != null) bySymbol.set(p.symbol.toUpperCase(), Number(p.price))
        }
        const prices = new Map<string, number>()
        const syms = new Map<string, string>()
        for (const [id, ref] of refByCrop) {
          const eff = fallForwardOnMissingQuote(ref, optsByCrop.get(id) ?? [], (s) => bySymbol.has(s), bySymbol.size > 0)
          syms.set(id, eff.symbol)
          const price = bySymbol.get(eff.symbol)
          if (price != null) prices.set(id, price)
        }
        setLiveEstimates(prices)
        setRefSymbols(syms)
      } catch { /* fall back to stored/assumed prices */ }
    })()
    return () => { cancelled = true }
  }, [cropYear, refByCrop, cropById, refAsOf])

  // Field-level dry bushels + last load date, splits-aware — narrowed to the
  // entity's fields.
  const aggByKey = useMemo(
    () => scope.fieldAgg(fieldCropAggregates(loads, splits, cropById, { cropYear: cropYear === '' ? null : cropYear, combineEntries })),
    [loads, splits, combineEntries, cropById, cropYear, scope],
  )
  const cropCompleteKeys = useMemo(() => {
    const s = new Set<string>()
    for (const a of effAssumptions) if (a.harvest_complete) s.add(`${a.crop_id}|${a.crop_year}`)
    return s
  }, [effAssumptions])

  // Harvested-fact vs still-in-the-field, per crop and per planting.
  const harvestSplit = useMemo(() => {
    if (cropYear === '') return { byCrop: new Map<string, HarvestSplit>(), statusByPlanting: new Map<string, 'complete' | 'in_progress' | 'unharvested'>() }
    return splitHarvestByCrop({ plantings: scopedPlantings, aggByKey, cropYear, cropCompleteKeys })
  }, [scopedPlantings, aggByKey, cropYear, cropCompleteKeys])

  // Expected yield on the REMAINING (not-yet-complete) acres, per crop — the
  // yield-axis center once harvest is underway, from the assumption breakouts.
  const doubleCropIds = useMemo(() => buildDoubleCropSet(plantings, cropById), [plantings, cropById])
  const remainingExpectedYield = useMemo(() => {
    const m = new Map<string, number>()
    if (cropYear === '') return m
    const remaining = yearPlantings.filter((p) => harvestSplit.statusByPlanting.get(p.id) !== 'complete')
    const prod = expectedProductionFromBreakout(segmentAcresByCrop(remaining, cropYear, doubleCropIds), effAssumptions, cropYear)
    const acres = new Map<string, number>()
    for (const p of remaining) acres.set(p.crop_id, (acres.get(p.crop_id) ?? 0) + Number(p.planted_acres ?? 0))
    for (const [cropId, production] of prod) {
      const ac = acres.get(cropId) ?? 0
      if (ac > 0) m.set(cropId, production / ac)
    }
    return m
  }, [yearPlantings, harvestSplit, cropYear, doubleCropIds, effAssumptions])

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
    // Entity filter: only the entity's farms' ARC/PLC and its other payments,
    // re-spread over just the entity's planted acres.
    const projected = projectPayments({ cropYear: programYear, baseAcres, commodities, elections, priceData: effPrice, payments: arcPayments, sequestrationPct: payCfg.sequestrationPct })
      .filter((p) => scope.farmInEntity(p.farmId))
    const totalArcPlc = projected.reduce((s, p) => s + p.result.net, 0)
    const totalOther = otherPaymentsInRevenueYear(scope.otherPayments(otherPayments), cropYear).reduce((s, o) => s + Number(o.amount), 0)
    const totalAcres = yearPlantings.reduce((s, p) => s + Number(p.planted_acres ?? 0), 0)
    return flatGovPerAcre(totalArcPlc + totalOther, totalAcres)
  }, [cropYear, commodities, arcPriceData, baseAcres, elections, arcPayments, otherPayments, yearPlantings, programConfigs, scope])

  // ---- Per-crop views: inputs, axes, and the computed grid ----
  const cropViews: CropView[] = useMemo(() => {
    if (cropYear === '' || viewer.loading || !viewerA.ready) return []
    const yearContracts = scopedContracts.filter((c) => c.crop_year === cropYear)
    const yearFutures = scopedFutures.filter((f) => f.crop_year === cropYear)
    const yearOptions = scopedOptions.filter((o) => o.crop_year === cropYear)
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
      const assumption = effAssumptions.find((a) => a.crop_id === cropId && a.crop_year === cropYear)
      const cropPolicies = scopedPolicies.filter((p) => p.crop_id === cropId && p.crop_year === cropYear)
      // Once the RMA FINAL harvest price is on file (policy or stored final),
      // insurance in every cell uses it — the same basis as the Claims Monitor.
      const policyFinal = cropPolicies.find((p) => p.harvest_price != null)?.harvest_price
      const storedFinal = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_final')
      const finalHarvestPrice = policyFinal != null ? Number(policyFinal) : storedFinal ? Number(storedFinal.price) : null
      // County yield scenario (045): the shared assumption row for this crop
      // (first policy's county), the per-crop persisted mode, and the RMA-final
      // pin that disables both modes.
      const countyAssumption = countyAssumptionFor(effCountyAssumptions, cropId, cropPolicies[0]?.county_id ?? null, cropYear)
      const cfgForCrop = axes[`${cropYear}:${cropId}`] ?? {}
      const countyPinned = countyAssumption?.rma_final_county_yield != null
      const countyMode: 'independent' | 'with_farm' = !countyPinned && cfgForCrop.cm === 'move' ? 'with_farm' : 'independent'
      const hasCountyLegs = cropPolicies.some((p) =>
        isAreaPlan(p.plan_type) || scos.some((s) => s.policy_id === p.id) || ecos.some((e) => e.policy_id === p.id) ||
        staxes.some((s) => s.policy_id === p.id) || mcos.some((m) => m.policy_id === p.id))

      const inputs: CropScenarioInputs = {
        crop, cropYear, plantedAcres, irrigatedAcres, drylandAcres,
        fixedHarvestedBu: split.fixedBu, remainingAcres: split.remainingAcres,
        contracts: yearContracts.filter((c) => c.crop_id === cropId),
        futures: yearFutures, options: yearOptions,
        assumption, policies: cropPolicies, scos, ecos, staxes, mcos,
        countyAssumption, countyMode,
        scoTrigger: programCfg.scoTrigger,
        finalHarvestPrice,
        // Cotton: sold/pool lbs stay locked; in-loan lbs floor at the banked
        // CCC loan value (cells below the floor flatten there).
        cottonPhysical: isCottonCrop(crop.name) ? cottonPhysicalSummary : null,
      }

      const contractedBu = isCottonCrop(crop.name)
        ? (cottonPhysicalSummary?.soldLbs ?? 0)
        : inputs.contracts.reduce((s, c) => s + Number(c.contracted_bushels ?? 0), 0)
      const commodity = cropToHedgeCommodity(crop.name)
      // Bushels for grains, lbs for cotton (quantityFor knows each contract size).
      const openHedgeBu = commodity
        ? yearFutures.filter((f) => f.commodity === commodity && f.side === 'short' && f.status === 'open')
            .reduce((s, f) => s + quantityFor(commodity, Number(f.num_contracts)), 0)
        : 0

      // Axis defaults. Price centers on the CURRENT ASSUMPTIONS midpoint: the
      // standing What-If assumed futures first, then today's live benchmark
      // quote, then the avg projected price on file. The projected-price
      // fallback is insurance-native ($/lb for cotton) while the cotton axis
      // is ¢/lb — insurancePriceToAxisUnits converts at the boundary so the
      // fallback never centers a cotton axis ~100× low. The "you are here"
      // row still marks the live quote wherever it lands on the axis.
      const live = liveEstimates.get(cropId) ?? null
      const assumedFutures = assumption?.assumed_futures != null ? Number(assumption.assumed_futures) : null
      const avgProjected = cropPolicies.length > 0
        ? insurancePriceToAxisUnits(
            crop.name,
            cropPolicies.reduce((s, p) => s + Number(p.projected_price), 0) / cropPolicies.length,
          )
        : null
      const autoPriceCenter = assumedFutures ?? live ?? avgProjected
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
        countyPinned, hasCountyLegs, countyMode,
        // Axis header names the marketing reference contract (rolled/pinned);
        // the RMA discovery symbol is only the last-resort label.
        symbol: refSymbols.get(cropId) ?? refByCrop.get(cropId)?.symbol ?? harvestContractSymbol(crop.name, cropYear),
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
  }, [cropYear, viewer.loading, viewerA.ready, plantedCropIds, cropById, yearPlantings, scopedContracts, scopedFutures, scopedOptions, effAssumptions, scopedPolicies, scos, ecos, staxes, mcos, effCountyAssumptions, priceEstimates, harvestSplit, remainingExpectedYield, liveEstimates, refSymbols, refByCrop, axes, programCfg, includeGov, govPerAcre, cottonPhysicalSummary])

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
        // Cotton axes display $/lb × lbs/ac (¢ stored); grains $/bu × bu/ac.
        const isCotton = isCottonCrop(v.crop.name)
        const qty = isCotton ? 'lbs' : 'bu'
        const columns = [
          { label: `${v.symbol ? `${v.symbol} futures` : 'Futures'} ${isCotton ? '$/lb' : '$/bu'}`, align: 'right' as const, format: (isCotton ? 'cents' : 'price') as 'cents' | 'price' },
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
    // County scenario mode per crop, carried into the export filter line.
    const countyLabels = cropViews
      .filter((v) => v.hasCountyLegs)
      .map((v) => `${v.crop.name}: ${v.countyPinned ? 'final county yield on file' : v.countyMode === 'with_farm' ? 'moves with farm yield' : 'independent'}`)
    const countyLabel = countyLabels.length > 0 ? `County: ${countyLabels.join(', ')}` : null
    return {
      title: 'Income Sensitivity',
      filters: [`Crop year: ${cropYear || '—'}`, entityName ? `Entity: ${entityName}` : null, `View: ${viewLabel}`, govLabel, countyLabel].filter(Boolean).join(' · '),
      // Never export zero sections (exceljs needs at least one sheet).
      sections: sections.length > 0 ? sections : [{ columns: [{ label: 'No sensitivity tables' }], rows: [] }],
      orientation: 'landscape',
    }
  }
  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropViews, view, includeGov, govPerAcre, cropYear, entityName, onPayloadChange])

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
        <EntityFilter entities={entityOptionsFor(viewer, entities)} value={entityId} onChange={setEntityId} />
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

      <SupersededNotice show={viewerA.superseded} onDismiss={viewerA.dismissSuperseded} />

      {cropYear === '' && <p className="text-amber-700 text-sm">Pick a crop year to build the sensitivity tables.</p>}

      {entityName && cropYear !== '' && (
        <p className="text-sm text-slate-600">Entity: <span className="font-semibold">{entityName}</span></p>
      )}

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
                scenario yield × remaining acres). Before harvest that is yield × planted acres; once a crop is
                fully harvested the yield axis collapses to the single actual yield and only price risk remains.</p>
              <p><strong className="text-slate-700">Crop insurance</strong> — every policy (RP / RP-HPE / YP + SCO/ECO,
                per practice) re-runs in each cell with the scenario price as the harvest price and the cell&apos;s blended
                yield allocated to the policy&apos;s practice. Once the RMA <em>final</em> harvest price is on file it is
                used in every cell instead (the price axis then moves crop sales only), matching the Claims Monitor.
                Cells show <em>net</em> insurance P&amp;L (indemnity − premium), the same engine as the Claims Monitor.</p>
              <p><strong className="text-slate-700">County yield scenario</strong> (per-crop toggle) — the county
                estimate comes from your <em>my-yield-vs-county differential</em> (&quot;I typically run 15 bu/ac better
                than the county&quot;): estimated county yield = farm yield − differential.
                <em> County independent</em> (default): the county is CONSTANT across the farm-yield axis (your
                EXPECTED yield − differential) — the yield axis is YOUR farm&apos;s yield and the county doesn&apos;t
                necessarily follow it, so county-triggered legs (SCO/ECO/STAX/ARP/AYP/MCO) vary only down the price
                axis. This honest baseline shows the &quot;county policy may not pay when I have a loss&quot; gap.
                <em> County moves with me</em> (widespread-loss scenario): the county = the cell&apos;s scenario blended
                farm yield − differential — the stable relationship is preserved as the farm yield moves, so a farm
                35 bu below expected implies a county 35 bu below its estimate and the area policies kick in alongside
                the individual RP floor. Mid-harvest the blend (fixed + scenario ÷ total acres) is the basis. Once the
                RMA <em>final</em> county yield is on file, both modes pin to it and the toggle is disabled.</p>
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

// Cotton axis cfg strings persist in ¢ (unchanged from older sessions); the
// inputs read/write $/lb. Legacy ¢ typed directly (70, or a 2-¢ step) still
// lands right via the magnitude guard.
function centsCfgToDollars(cfg: string | undefined): string {
  if (cfg == null || cfg.trim() === '') return ''
  const v = Number(cfg)
  return Number.isFinite(v) ? String(v / 100) : ''
}
function dollarsToCentsCfg(entered: string, centsThreshold: number): string {
  if (entered.trim() === '') return ''
  const cents = parseCottonPriceInput(entered, { centsThreshold })
  return cents == null ? '' : String(cents)
}

// Module-scope so the input keeps its identity (and focus) across re-renders.
// Commits on blur/Enter (app convention), not per keystroke — every commit
// recomputes the scenario grids, so typing must stay local.
function AxisField({ label, value, placeholder, onCommit }: {
  label: string; value: string; placeholder: string; onCommit: (s: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  // Plain typing, no native spinner arrows. An entry that isn't a number
  // reverts to the last committed value instead of poisoning the axis.
  const commit = () => {
    if (draft === value) return
    if (draft.trim() !== '' && !Number.isFinite(Number(draft))) { setDraft(value); return }
    onCommit(draft)
  }
  return (
    <label className="flex items-center gap-1 text-xs text-slate-500">
      {label}
      <input
        type="text" inputMode="decimal" value={draft} placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
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
  // Cotton displays $/lb (¢ stored internally) and lbs of lint; grains $/bu and bushels.
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
          {isCotton && v.inputs.cottonPhysical != null && v.inputs.cottonPhysical.loanFloorCents != null && v.inputs.cottonPhysical.inLoanLbs > 0 && (
            <span className="text-xs rounded-full bg-indigo-100 text-indigo-800 px-2.5 py-1" title="In-loan lbs are valued at max(banked CCC loan value, scenario price) — cells below the floor flatten there, like the RP floor.">
              CCC loan floor {cents2(v.inputs.cottonPhysical.loanFloorCents)} on {bu(v.inputs.cottonPhysical.inLoanLbs)} lbs
            </span>
          )}
        </div>

        {/* Axis controls. Cotton price fields read and accept $/lb (0.70 /
            0.02 — legacy ¢ entries like 70 still work via the magnitude
            guard); the persisted cfg strings stay in ¢ so existing saved axes
            keep working unchanged. */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 no-print">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Price axis{isCotton ? ' ($/lb)' : ' ($/bu)'}</span>
            <AxisField
              label="center"
              value={isCotton ? centsCfgToDollars(v.cfg.pc) : v.cfg.pc ?? ''}
              placeholder={v.autoPriceCenter != null ? (isCotton ? (v.autoPriceCenter / 100).toFixed(2) : v.autoPriceCenter.toFixed(2)) : '—'}
              onCommit={(s) => onAxisChange({ pc: isCotton ? dollarsToCentsCfg(s, 5) : s })}
            />
            <AxisField
              label="step"
              value={isCotton ? centsCfgToDollars(v.cfg.ps) : v.cfg.ps ?? ''}
              placeholder={isCotton ? (v.priceStep / 100).toFixed(2) : v.priceStep.toFixed(2)}
              onCommit={(s) => onAxisChange({ ps: isCotton ? dollarsToCentsCfg(s, 0.25) : s })}
            />
            <AxisField label="± steps" value={v.cfg.pn ?? ''} placeholder="5" onCommit={(s) => onAxisChange({ pn: s })} />
          </div>
          {v.split.state !== 'complete' && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Yield axis</span>
              <AxisField label="center" value={v.cfg.yc ?? ''} placeholder={v.autoYieldCenter != null ? v.autoYieldCenter.toFixed(1) : '—'} onCommit={(s) => onAxisChange({ yc: s })} />
              <AxisField label="step" value={v.cfg.ys ?? ''} placeholder={v.yieldStep.toFixed(0)} onCommit={(s) => onAxisChange({ ys: s })} />
              <AxisField label="± steps" value={v.cfg.yn ?? ''} placeholder="5" onCommit={(s) => onAxisChange({ yn: s })} />
            </div>
          )}
          {v.hasCountyLegs && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">County yield scenario</span>
              {v.countyPinned ? (
                <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5" title="The RMA final county yield is on file — the county estimate is a fact in every cell; scenario modes are disabled.">
                  final county yield on file — modes disabled
                </span>
              ) : (
                <>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="radio" name={`cm-${v.crop.id}`} checked={v.countyMode === 'independent'} onChange={() => onAxisChange({ cm: 'ind' })} />
                    County independent
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="radio" name={`cm-${v.crop.id}`} checked={v.countyMode === 'with_farm'} onChange={() => onAxisChange({ cm: 'move' })} />
                    County moves with me
                  </label>
                </>
              )}
              <span className="text-[11px] text-slate-500">Independent = your loss may be local; Moves with me = county-wide loss scenario.</span>
            </div>
          )}
        </div>

        {missingCost && (
          <p className="text-xs text-amber-700">
            No cost/acre set for {v.crop.name} — cells show “—” in Net profit view. Set it in the Marketing Dashboard assumptions.
          </p>
        )}

        {(() => {
          const w = v.grid.flat().find((c) => c.insuranceWarning)?.insuranceWarning
          return w ? (
            <p className="text-xs font-semibold text-red-700">
              ⚠ {w} Insurance dollars in this table are unreliable until the policy&apos;s price is corrected
              (cotton insurance prices are $/lb, e.g. 0.68 — not ¢/lb).
            </p>
          ) : null
        })()}

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
                    {v.symbol ? `${v.symbol} futures` : 'Futures'} {isCotton ? '$/lb' : '$/bu'} ↓
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
