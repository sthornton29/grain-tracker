'use client'

// Revenue Projections — one financial picture per crop for a crop year,
// combining crop sales revenue (from the Marketing dashboard logic), net crop
// insurance proceeds (from the Claims Monitor engine), and government payments
// (ARC/PLC + other USDA payments, allocated by planted acres), then layering
// cost, profit, and breakeven. Updates live as loads, contracts, insurance
// assumptions, government payments, or futures prices change.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeMarketing, segmentAcresByCrop, expectedProductionFromBreakout, isCottonCrop, type Planting } from '@/lib/marketing'
import { fetchCottonPhysical, type CottonPhysicalData } from '@/lib/cotton-physical-fetch'
import { fetchSeedContracts, type SeedContractData } from '@/lib/seed-contracts-fetch'
import { buildSeedCommitments } from '@/lib/seed-contracts'
import type { CottonPhysicalSummary } from '@/lib/cotton-sales'
import { buildEntityScope } from '@/lib/entity-scope'
import EntityFilter from '@/components/entity-filter'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { useViewerAssumptions } from '@/lib/use-viewer-assumptions'
import { resolveCropAssumptions } from '@/lib/viewer-assumptions'
import { marketingReferenceContract, referenceMonthOptions, fallForwardOnMissingQuote, type ReferenceContract } from '@/lib/reference-contract'
import { SupersededNotice } from '@/components/viewer-scenario'
import { fieldCropAggregates, cropsWithCompleteHarvest, type CombineEntryLike } from '@/lib/yields'
import { cropToCommodity } from '@/lib/contracts'
import { cropYearOptionsFromPlantings, buildDoubleCropSet } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import {
  computePolicy, harvestContractLabel, policyPremium, resolveHarvestPriceByCrop,
  type PolicyInputs, type ScoConfig, type EcoConfig,
} from '@/lib/crop-insurance'
import { formatCottonPrice } from '@/lib/hedging'
import { projectPayments, applyMyaResolution, programYearFor, otherPaymentsInRevenueYear } from '@/lib/government-payments'
import { computeRevenueProjections, type InsuranceProceeds, type GovtProceeds } from '@/lib/revenue-projections'
import {
  SummaryCards, EmptyState, fmtUsd, signedTone, toneText,
  theadCls, grandTotalRowCls, type SummaryCardData,
} from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import type {
  Crop, Contract, CropAssumption, Entity, FieldPlanting, FuturesPosition, OptionPosition,
  CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco, HarvestPriceEstimate,
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
type GinReceiptLite = {
  id: string; crop_year: number; bales_count: number | null; total_bale_weight: number | null
  entity_id: string | null; farm_id: string | null; field_id: string | null
}
type CottonBaleLite = { gin_receipt_id: string; crop_year: number; net_weight_lbs: number }

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const usd = (n: number | null | undefined, d = 0) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
const bu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
// $/bu prices on this page show exactly two decimals (not the app-wide fmtPrice's
// up-to-four), so all price columns read consistently.
const price2 = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function RevenueProjectionsReport({ onPayloadChange }: Props) {
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
  const [liveEstimates, setLiveEstimates] = useState<Map<string, number>>(new Map())
  // Government payments data.
  const [commodities, setCommodities] = useState<CoveredCommodity[]>([])
  const [baseAcres, setBaseAcres] = useState<FarmBaseAcres[]>([])
  const [elections, setElections] = useState<ArcPlcElection[]>([])
  const [arcPriceData, setArcPriceData] = useState<ArcPlcPriceData[]>([])
  const [arcPayments, setArcPayments] = useState<ArcPlcPayment[]>([])
  const [otherPayments, setOtherPayments] = useState<OtherGovernmentPayment[]>([])

  // Cotton actuals (lbs of lint from gin receipts) — same inputs the Marketing
  // dashboard feeds computeMarketing, so the cotton row matches on both pages.
  const [ginReceipts, setGinReceipts] = useState<GinReceiptLite[]>([])
  const [cottonBales, setCottonBales] = useState<CottonBaleLite[]>([])

  const [cropYear, setCropYear] = usePersistentState<number | ''>('rev-proj:cropYear', '')
  // Entity filter (shared scoping — see lib/entity-scope.ts). The operation-wide
  // assumptions flow down unchanged; only acres/production/policies/payments narrow.
  const [entityId, setEntityId] = usePersistentState('rev-proj:entity', '')
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Array<{ id: string; entity_id: string | null }>>([])
  const [fields, setFields] = useState<Array<{ id: string; farm_id: string | null }>>([])

  useEffect(() => {
    ;(async () => {
      const [cr, pl, ct, fp, op, ca, ld, po, sc, ec, hpe, cc, ba, el, apd, apay, ogp, sp, gr, cb, en, fa, fi, ce] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('field_plantings').select('*'),
        supabase.from('contracts').select('*'),
        supabase.from('futures_positions').select('*'),
        supabase.from('options_positions').select('*'),
        supabase.from('crop_assumptions').select('*'),
        supabase.from('loads').select('id, date, crop_id, crop_year, from_type, from_field_id, net_weight, moisture, dry_bushels_override'),
        supabase.from('crop_insurance_policies').select('*'),
        supabase.from('crop_insurance_sco').select('*'),
        supabase.from('crop_insurance_eco').select('*'),
        supabase.from('harvest_price_estimates').select('*').order('price_date', { ascending: false }),
        supabase.from('covered_commodities').select('*'),
        supabase.from('farm_base_acres').select('*'),
        supabase.from('arc_plc_elections').select('*'),
        supabase.from('arc_plc_price_data').select('*'),
        supabase.from('arc_plc_payments').select('*'),
        supabase.from('other_government_payments').select('*'),
        supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels'),
        supabase.from('gin_receipts').select('id, crop_year, bales_count, total_bale_weight, entity_id, farm_id, field_id'),
        supabase.from('cotton_bales').select('gin_receipt_id, crop_year, net_weight_lbs'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('id, entity_id'),
        supabase.from('fields').select('id, farm_id'),
        // May not exist yet (migration 062): an error leaves data null → [].
        supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date'),
      ])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as Array<{ id: string; entity_id: string | null }>) || [])
      setFields((fi.data as Array<{ id: string; farm_id: string | null }>) || [])
      setGinReceipts(((gr.data as unknown) as GinReceiptLite[]) || [])
      setCottonBales(((cb.data as unknown) as CottonBaleLite[]) || [])
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
      setCommodities((cc.data as CoveredCommodity[]) || [])
      setBaseAcres((ba.data as FarmBaseAcres[]) || [])
      setElections((el.data as ArcPlcElection[]) || [])
      setArcPriceData((apd.data as ArcPlcPriceData[]) || [])
      setArcPayments((apay.data as ArcPlcPayment[]) || [])
      setOtherPayments((ogp.data as OtherGovernmentPayment[]) || [])
      const yrs = (pl.data as FieldPlanting[] | null)?.map((p) => p.season_year) ?? []
      const pyrs = (po.data as CropInsurancePolicy[] | null)?.map((p) => p.crop_year) ?? []
      const all = [...yrs, ...pyrs]
      if (all.length > 0) setCropYear((cy) => (cy === '' ? Math.max(...all) : cy))
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])

  // Viewer role (052): the grant universe caps the entity scope, and the
  // viewer's private assumption overrides layer over the shared rows.
  const viewer = useViewerScope(supabase)
  const viewerA = useViewerAssumptions(supabase, viewer)
  const assumptionRes = useMemo(() => resolveCropAssumptions(assumptions, viewerA.overrides), [assumptions, viewerA.overrides])
  const effAssumptions = assumptionRes.rows
  useEffect(() => { if (assumptionRes.staleIds.length > 0) viewerA.cleanupStale(assumptionRes.staleIds) }, [assumptionRes, viewerA])

  // Shared entity scoping — the SAME layer the Marketing dashboard applies, so
  // the reconciliation identity (RevProj profit − Marketing profit = insurance
  // + government) survives an entity filter.
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

  // Broken-out expected production (irr/dry × full/double-crop), computed exactly
  // like the Marketing dashboard so computeMarketing yields identical per-crop
  // production — and therefore identical blended revenue — on both pages. The
  // operation-wide assumptions apply to the (scoped) acres unchanged.
  const doubleCropIds = useMemo(() => buildDoubleCropSet(plantings, cropById), [plantings, cropById])
  const expProdByCrop = useMemo(() => {
    if (cropYear === '') return new Map<string, number>()
    return expectedProductionFromBreakout(segmentAcresByCrop(scopedPlantings, cropYear, doubleCropIds), effAssumptions, cropYear)
  }, [scopedPlantings, cropYear, doubleCropIds, effAssumptions])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...plantings.map((p) => p.season_year), ...policies.map((p) => p.crop_year)], cropYear === '' ? null : cropYear),
    [plantings, policies, cropYear],
  )

  // Live reference-contract quote for EVERY planted crop — the SAME expiry-
  // aware resolver (+ any pinned month) the Marketing dashboard uses, so the
  // price valuing unpriced bushels is identical on both pages and the
  // RevProj − Marketing reconciliation identity keeps holding.
  const livePriceCropIds = useMemo(
    () => Array.from(new Set(plantings.filter((p) => p.season_year === cropYear).map((p) => p.crop_id))),
    [plantings, cropYear],
  )
  const refAsOf = useMemo(() => new Date(), [])
  const refByCrop = useMemo(() => {
    const m = new Map<string, ReferenceContract>()
    if (cropYear === '') return m
    for (const id of livePriceCropIds) {
      const c = cropById.get(id)
      if (!c) continue
      const pinned = effAssumptions.find((a) => a.crop_id === id && a.crop_year === cropYear)?.reference_contract_month ?? null
      const ref = marketingReferenceContract(c.name, cropYear, refAsOf, pinned)
      if (ref) m.set(id, ref)
    }
    return m
  }, [cropYear, livePriceCropIds, cropById, effAssumptions, refAsOf])
  useEffect(() => {
    if (cropYear === '' || refByCrop.size === 0) { setLiveEstimates(new Map()); return }
    // Fetch the resolved symbols plus each crop's later listed months so a
    // quoteless contract falls forward identically to the dashboard.
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
        const m = new Map<string, number>()
        for (const [id, ref] of refByCrop) {
          const eff = fallForwardOnMissingQuote(ref, optsByCrop.get(id) ?? [], (s) => bySymbol.has(s), bySymbol.size > 0)
          const price = bySymbol.get(eff.symbol)
          if (price != null) m.set(id, price)
        }
        setLiveEstimates(m)
      } catch { /* keep cached/projected */ }
    })()
    return () => { cancelled = true }
  }, [cropYear, refByCrop, cropById, refAsOf])

  // (field|crop|year) → dry bushels + last load date, splits-aware — narrowed
  // to the entity's fields. Drives actual production (by crop) and the
  // field-level harvest-completion check.
  const rawAggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { cropYear: cropYear === '' ? null : cropYear, combineEntries }),
    [loads, splits, combineEntries, cropById, cropYear],
  )
  const aggByKey = useMemo(() => scope.fieldAgg(rawAggByKey), [scope, rawAggByKey])

  // Actual production (dry bushels) by crop for the year.
  const productionByCrop = useMemo(() => {
    const prod = new Map<string, number>()
    if (cropYear === '') return prod
    for (const [key, agg] of aggByKey) {
      const cropId = key.split('|')[1]
      if (cropId) prod.set(cropId, (prod.get(cropId) ?? 0) + agg.dryBu)
    }
    return prod
  }, [aggByKey, cropYear])

  // Crops whose harvest is complete (field-level) → value production at ACTUAL,
  // not the yield estimate, so a poor harvest stops showing estimate-based profit.
  const harvestCompleteIds = useMemo(() => {
    if (cropYear === '') return new Set<string>()
    const cropCompleteKeys = new Set<string>()
    for (const a of effAssumptions) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)
    return cropsWithCompleteHarvest({ plantings: scopedPlantings, aggByKey, cropYear, cropCompleteKeys, assumptions: effAssumptions })
  }, [scopedPlantings, aggByKey, cropYear, effAssumptions])

  // Current futures per crop to value unpriced bushels in blended revenue — the
  // live harvest-month estimate, the EXACT source the Marketing dashboard uses
  // (the dashboard's `currentFutures` is this same map), so the two pages value
  // unpriced bushels identically. The richer harvestPriceFor (final → live →
  // stored → projected) still backs the market-price and insurance figures below,
  // where the final/stored fallback belongs.
  const currentFuturesByCrop = useMemo(() => {
    const m = new Map<string, number>()
    if (cropYear === '') return m
    const ids = new Set(plantings.filter((p) => p.season_year === cropYear).map((p) => p.crop_id))
    for (const id of ids) { const p = liveEstimates.get(id); if (p != null && p > 0) m.set(id, p) }
    return m
  }, [plantings, cropYear, liveEstimates])

  // Cotton lbs of lint per cotton crop id (per-bale weights, falling back to the
  // receipt's total bale weight) — identical derivation to the dashboard's.
  const cottonProductionByCrop = useMemo(() => {
    const m = new Map<string, { lintLbs: number; bales: number }>()
    if (cropYear === '') return m
    const balesByReceipt = new Map<string, { lbs: number; count: number }>()
    for (const b of cottonBales) {
      if (b.crop_year !== cropYear) continue
      const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
      g.lbs += Number(b.net_weight_lbs) || 0
      g.count += 1
      balesByReceipt.set(b.gin_receipt_id, g)
    }
    let lintLbs = 0, baleCount = 0
    for (const r of scope.ginReceipts(ginReceipts)) {
      if (r.crop_year !== cropYear) continue
      const fromBales = balesByReceipt.get(r.id)
      lintLbs += fromBales && fromBales.lbs > 0 ? fromBales.lbs : Number(r.total_bale_weight) || 0
      baleCount += fromBales && fromBales.count > 0 ? fromBales.count : Number(r.bales_count) || 0
    }
    for (const c of crops) if (isCottonCrop(c.name)) m.set(c.id, { lintLbs, bales: baleCount })
    return m
  }, [cropYear, ginReceipts, cottonBales, crops, scope])

  // Physical cotton marketing (044) — same input the dashboard passes, so
  // blended revenue stays structurally identical across the two pages. Raw
  // fetch + an entity-scoped summary derived below.
  const [cottonPhysicalRaw, setCottonPhysicalRaw] = useState<CottonPhysicalData | null>(null)
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
  const cottonPhysical = useMemo(() => {
    const m = new Map<string, CottonPhysicalSummary>()
    if (!cottonPhysicalRaw) return m
    // Own-name rows whole; marketing-agent/null rows flow down at the
    // entity's cotton acre share — same attribution as grain.
    const summary = attribution.cottonSummary(cottonPhysicalRaw.inputs)
    if (!summary) return m
    for (const c of crops) if (isCottonCrop(c.name)) m.set(c.id, summary)
    return m
  }, [cottonPhysicalRaw, attribution, crops])

  // Seed production contracts (077) — same input the dashboard passes, so
  // blended revenue stays structurally identical across the two pages.
  const [seedRaw, setSeedRaw] = useState<SeedContractData | null>(null)
  const [buyerNames, setBuyerNames] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (cropYear === '') { setSeedRaw(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const [seed, buyersQ] = await Promise.all([
          fetchSeedContracts(supabase, cropYear, { contracts }),
          supabase.from('buyers').select('id, name'),
        ])
        if (cancelled) return
        setSeedRaw(seed)
        setBuyerNames(new Map((((buyersQ.data ?? []) as Array<{ id: string; name: string }>)).map((b) => [b.id, b.name])))
      } catch { if (!cancelled) setSeedRaw(null) }
    })()
    return () => { cancelled = true }
  }, [cropYear, supabase, contracts])
  const seedCommitments = useMemo(() => {
    if (cropYear === '' || !seedRaw || seedRaw.bundles.length === 0) return undefined
    return buildSeedCommitments({
      bundles: seedRaw.bundles,
      cropYear,
      plantings,
      // Unscoped production — attribution.shareForContract is the only scaling.
      aggByKey: rawAggByKey,
      assumptions: effAssumptions,
      harvestCompleteCropIds: harvestCompleteIds,
      buyerNameById: buyerNames,
      shareForContract: (c) => attribution.shareForContract(c),
    })
  }, [cropYear, seedRaw, plantings, rawAggByKey, effAssumptions, harvestCompleteIds, buyerNames, attribution])

  const marketingRows = useMemo(() => {
    if (cropYear === '' || viewer.loading || !viewerA.ready) return []
    return computeMarketing({
      cropYear,
      crops,
      plantings: scopedPlantings.filter((p) => p.season_year === cropYear).map((p): Planting => ({ crop_id: p.crop_id, season_year: p.season_year, planted_acres: p.planted_acres })),
      contracts: scopedContracts.filter((c) => c.crop_year === cropYear),
      futures: scopedFutures.filter((f) => f.crop_year === cropYear),
      options: scopedOptions.filter((o) => o.crop_year === cropYear),
      assumptions: effAssumptions.filter((a) => a.crop_year === cropYear),
      actualProductionByCrop: productionByCrop,
      expectedProductionByCrop: expProdByCrop,
      currentFuturesByCrop,
      harvestCompleteCropIds: harvestCompleteIds,
      cottonProductionByCrop,
      cottonPhysicalByCrop: cottonPhysical,
      seedCommitmentsByCrop: seedCommitments,
    })
  }, [cropYear, viewer.loading, viewerA.ready, crops, scopedPlantings, scopedContracts, scopedFutures, scopedOptions, effAssumptions, productionByCrop, expProdByCrop, currentFuturesByCrop, harvestCompleteIds, cottonProductionByCrop, cottonPhysical, seedCommitments])

  // Resolve a harvest price per crop for the MARKET path: final → RMA
  // in-discovery running average → estimate → projected. `source`
  // distinguishes RMA-native prices ($/lb for cotton: 'final'/
  // 'rma_discovery'/'projected') from futures-derived ones (¢/lb:
  // 'estimate') so the caller can keep the cotton market price in ¢/lb.
  function harvestPriceFor(cropId: string): { price: number; isFinal: boolean; source: 'final' | 'rma_discovery' | 'estimate' | 'projected' } {
    const pols = policies.filter((p) => p.crop_id === cropId && p.crop_year === cropYear)
    const policyFinal = pols.find((p) => p.harvest_price != null)?.harvest_price
    const storedFinal = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_final')
    if (policyFinal != null || storedFinal) return { price: Number(policyFinal ?? storedFinal!.price), isFinal: true, source: 'final' }
    // The RMA route rewrites this row daily while the window is open; stale
    // rows (window closed / fetch broken) fall through to the estimate tier.
    const discovery = priceEstimates.find((e) =>
      e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_estimate' &&
      e.source === 'rma_discovery' && e.price_date != null && Date.now() - Date.parse(e.price_date) <= 3 * 86_400_000)
    if (discovery) return { price: Number(discovery.price), isFinal: false, source: 'rma_discovery' }
    const live = liveEstimates.get(cropId)
    if (live != null) return { price: live, isFinal: false, source: 'estimate' }
    const storedEst = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_estimate' && e.source !== 'rma_discovery')
    if (storedEst) return { price: Number(storedEst.price), isFinal: false, source: 'estimate' }
    const avgProjected = pols.length > 0 ? pols.reduce((s, p) => s + Number(p.projected_price), 0) / pols.length : 0
    return { price: avgProjected, isFinal: false, source: 'projected' }
  }

  // Net insurance proceeds by crop, using each crop's marketing yield as the
  // assumed yield (ties the two reports together).
  const insuranceByCrop = useMemo(() => {
    const m = new Map<string, InsuranceProceeds>()
    if (cropYear === '') return m
    const scoBy = new Map(scos.map((s) => [s.policy_id, s]))
    const ecoBy = new Map(ecos.map((e) => [e.policy_id, e]))
    const yieldByCrop = new Map(marketingRows.map((r) => [r.cropId, r.yield]))
    // Price resolution reads ALL of the year's policies (harvest prices are
    // operation-level market facts that flow down); the P&L computation below
    // runs only the selected entity's policies.
    const yearPolsAll = policies.filter((x) => x.crop_year === cropYear)
    const yearPols = scope.byEntity(yearPolsAll)
    // Insurance math runs in the policy's native $ unit ($/lb cotton) — the
    // shared resolver converts futures-derived ¢/lb sources at the boundary.
    const insuranceHarvest = resolveHarvestPriceByCrop({
      cropIds: Array.from(new Set(yearPolsAll.map((x) => x.crop_id))),
      cropYear,
      policies: yearPolsAll,
      estimates: priceEstimates,
      liveByCrop: new Map(Array.from(liveEstimates, ([id, price]) => [id, { price, stale: false, priceDate: null }])),
      crops,
    })
    for (const p of yearPols) {
      const harvest = insuranceHarvest.get(p.crop_id)?.price ?? Number(p.projected_price)
      const assumedYield = yieldByCrop.get(p.crop_id) ?? Number(p.aph_yield)
      const base: PolicyInputs = {
        planType: p.plan_type,
        coverageLevel: Number(p.coverage_level),
        aphYield: Number(p.aph_yield),
        projectedPrice: Number(p.projected_price),
        harvestPrice: harvest,
        insuredAcres: Number(p.insured_acres),
        actualYield: assumedYield ?? Number(p.aph_yield),
      }
      const scoRow = scoBy.get(p.id)
      const ecoRow = ecoBy.get(p.id)
      const sco: ScoConfig | null = scoRow ? {
        coverageTrigger: Number(scoRow.coverage_trigger),
        expectedCountyYield: Number(scoRow.expected_county_yield),
        premiumPerAcre: scoRow.premium_per_acre == null ? null : Number(scoRow.premium_per_acre),
        totalPremium: scoRow.total_premium == null ? null : Number(scoRow.total_premium),
      } : null
      const eco: EcoConfig | null = ecoRow ? {
        ecoTriggerLevel: Number(ecoRow.eco_trigger_level),
        expectedCountyYield: Number(ecoRow.expected_county_yield),
        premiumPerAcre: ecoRow.premium_per_acre == null ? null : Number(ecoRow.premium_per_acre),
        totalPremium: ecoRow.total_premium == null ? null : Number(ecoRow.total_premium),
      } : null
      const comp = computePolicy({ base, basePremium: policyPremium(p), sco, eco })
      const cur = m.get(p.crop_id) ?? { netPnl: 0, totalIndemnity: 0, premium: 0 }
      cur.netPnl += comp.netPnl
      cur.totalIndemnity += comp.totalIndemnity
      cur.premium += comp.premiumPaid
      m.set(p.crop_id, cur)
    }
    return m
  }, [policies, scos, ecos, cropYear, marketingRows, liveEstimates, priceEstimates, crops, scope])

  // Current market cash price by crop: harvest price + average basis. Cotton
  // marketing prices are ¢/lb — RMA-native sources (final/projected, $/lb)
  // scale ×100 so the cotton market price never mixes units with the ¢ basis.
  const marketPriceByCrop = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of marketingRows) {
      const h = harvestPriceFor(r.cropId)
      const hp = r.unit === 'lbs' && h.source !== 'estimate' ? h.price * 100 : h.price
      if (hp > 0) m.set(r.cropId, hp + (r.avgBasis ?? 0))
      else if (r.avgCashPrice != null) m.set(r.cropId, r.avgCashPrice)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketingRows, liveEstimates, priceEstimates, policies, cropYear])

  // Government payments allocated per crop: total ARC/PLC (across all farms) and
  // non-crop-specific other payments are split by planted acres; crop-specific
  // other payments go straight to their crop.
  //
  // ATTRIBUTION: payments belong to the crop year they're PAID in. ARC/PLC for
  // program year Y−1 arrives in October of Y, so crop year Y's Govt Payments
  // column projects program year Y−1 (its own stored/final prices — the live
  // estimate applies to the current marketing year, not the prior program
  // year); other payments count by the year they land in (payment-date year,
  // else crop_year).
  const govtByCrop = useMemo(() => {
    const m = new Map<string, GovtProceeds>()
    if (cropYear === '') return m
    const programYear = programYearFor(cropYear)
    // Shared MYA resolution for the PROGRAM year (manual override > final >
    // stored estimate) — the same effective prices the Payment Tracker
    // projects that program year from.
    const effPrice = applyMyaResolution({ cropYear: programYear, commodities, priceData: arcPriceData, liveEstimates: new Map() })
    // Entity filter: only the entity's farms' ARC/PLC and its other payments;
    // the flat allocation below then recomputes over the entity's acres.
    const projected = projectPayments({ cropYear: programYear, baseAcres, commodities, elections, priceData: effPrice, payments: arcPayments })
      .filter((p) => scope.farmInEntity(p.farmId))
    const totalArcPlc = projected.reduce((s, p) => s + p.result.net, 0)
    const yearOther = otherPaymentsInRevenueYear(scope.otherPayments(otherPayments), cropYear)
    const nonSpecificOther = yearOther.filter((o) => !o.crop_id).reduce((s, o) => s + Number(o.amount), 0)
    const cropSpecific = new Map<string, number>()
    for (const o of yearOther) if (o.crop_id) cropSpecific.set(o.crop_id, (cropSpecific.get(o.crop_id) ?? 0) + Number(o.amount))
    const totalAcres = marketingRows.reduce((s, r) => s + r.acres, 0)
    for (const r of marketingRows) {
      const share = totalAcres > 0 ? r.acres / totalAcres : 0
      m.set(r.cropId, {
        arcPlc: totalArcPlc * share,
        allocatedOther: nonSpecificOther * share,
        cropSpecificOther: cropSpecific.get(r.cropId) ?? 0,
      })
    }
    return m
  }, [cropYear, arcPriceData, baseAcres, commodities, elections, arcPayments, otherPayments, marketingRows, scope])

  const { rows, totals } = useMemo(
    () => computeRevenueProjections({
      marketingRows, contracts: scopedContracts.filter((c) => c.crop_year === cropYear),
      cropYear: cropYear === '' ? 0 : cropYear, marketPriceByCrop, insuranceByCrop, govtByCrop,
    }),
    [marketingRows, scopedContracts, cropYear, marketPriceByCrop, insuranceByCrop, govtByCrop],
  )

  const harvestLabelFor = (cropId: string) => {
    const c = cropById.get(cropId)
    return cropToCommodity(c?.name) ? harvestContractLabel(c?.name, cropYear === '' ? 0 : cropYear) : null
  }

  function buildExportPayload(): ExportPayload {
    const filters = `Crop year: ${cropYear || '—'}${entityName ? ` · Entity: ${entityName}` : ''}`
    const revenueSection: ExportPayload['sections'][number] = {
      title: 'Revenue by Crop',
      columns: [
        { label: 'Crop' }, { label: 'Acres', align: 'right', format: 'acres' }, { label: 'Yield', align: 'right', format: 'yield' },
        { label: 'Total Production', align: 'right', format: 'bu' }, { label: 'Crop Sales Revenue', align: 'right', format: 'usd0' },
        { label: 'Insurance Proceeds', align: 'right', format: 'usd0' }, { label: 'Govt Payments', align: 'right', format: 'usd0' },
        { label: 'Total Revenue', align: 'right', format: 'usd0' }, { label: 'Revenue/Acre', align: 'right', format: 'usd0' },
      ],
      // Cotton rows override the bushel-shaped columns per cell: production in
      // lbs and the crop name carries the unit so mixed tables stay readable.
      rows: rows.map((r) => [
        r.unit === 'lbs' ? `${r.cropName} (lbs lint)` : r.cropName, Math.round(r.acres), r.yield != null ? Number(r.yield.toFixed(1)) : '',
        r.unit === 'lbs' ? { v: Math.round(r.totalProduction), format: 'lbs' as const } : Math.round(r.totalProduction),
        Math.round(r.cropSalesRevenue), Math.round(r.insuranceProceeds),
        r.govtPayments, Math.round(r.totalRevenue), r.revenuePerAcre != null ? Math.round(r.revenuePerAcre) : '',
      ]),
      rowMeta: rows.map(() => 'data' as const),
    }
    revenueSection.rows.push([
      'Total', Math.round(totals.acres), '', Math.round(totals.totalProduction), Math.round(totals.cropSalesRevenue),
      Math.round(totals.insuranceProceeds), Math.round(totals.govtPayments), Math.round(totals.totalRevenue),
      totals.revenuePerAcre != null ? Math.round(totals.revenuePerAcre) : '',
    ])
    revenueSection.rowMeta!.push('total')

    const profitSection: ExportPayload['sections'][number] = {
      title: 'Cost, Profit & Breakeven',
      columns: [
        { label: 'Crop' }, { label: 'Cost/Acre', align: 'right', format: 'usd0' }, { label: 'Total Cost', align: 'right', format: 'usd0' },
        { label: 'Total Revenue', align: 'right', format: 'usd0' }, { label: 'Profit', align: 'right', format: 'usd0' }, { label: 'Profit/Acre', align: 'right', format: 'usd0' },
        { label: 'Total Avg Price', align: 'right', format: 'price' }, { label: 'Breakeven Price', align: 'right', format: 'price' }, { label: 'Breakeven Yield', align: 'right', format: 'yield' },
      ],
      // Cotton prices export as $/lb (per-cell 'cents' format ÷100) — never $/bu.
      rows: rows.map((r) => [
        r.unit === 'lbs' ? `${r.cropName} ($/lb · lbs)` : r.cropName, r.costPerAcre != null ? Math.round(r.costPerAcre) : '', Math.round(r.totalCost),
        Math.round(r.totalRevenue), r.profit != null ? Math.round(r.profit) : '', r.profitPerAcre != null ? Math.round(r.profitPerAcre) : '',
        r.totalAvgPrice != null ? (r.unit === 'lbs' ? { v: Number(r.totalAvgPrice.toFixed(2)), format: 'cents' as const } : Number(r.totalAvgPrice.toFixed(2))) : '',
        r.breakevenPrice != null ? (r.unit === 'lbs' ? { v: Number(r.breakevenPrice.toFixed(2)), format: 'cents' as const } : Number(r.breakevenPrice.toFixed(2))) : '',
        r.breakevenYield != null ? Number(r.breakevenYield.toFixed(1)) : '',
      ]),
      rowMeta: rows.map(() => 'data' as const),
    }
    profitSection.rows.push([
      'Total', totals.costPerAcre != null ? Math.round(totals.costPerAcre) : '', Math.round(totals.totalCost),
      Math.round(totals.totalRevenue), Math.round(totals.profit), totals.profitPerAcre != null ? Math.round(totals.profitPerAcre) : '', '', '', '',
    ])
    profitSection.rowMeta!.push('total')

    return {
      title: 'Revenue Projections',
      filters,
      summary: [
        { label: 'Total Revenue', value: formatNumber(totals.totalRevenue, 'usd0') },
        { label: 'Total Cost', value: formatNumber(totals.totalCost, 'usd0') },
        { label: 'Total Profit', value: formatNumber(totals.profit, 'usd0'), tone: signedTone(totals.profit) },
        { label: 'Profit / Acre', value: totals.profitPerAcre != null ? formatNumber(totals.profitPerAcre, 'usd0') : '—', tone: signedTone(totals.profitPerAcre) },
      ],
      sections: [revenueSection, profitSection],
    }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, totals, cropYear, entityName, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  // Hold the report until the viewer scope/overrides resolve too, so a viewer
  // never sees a flash of unscoped numbers. Inert timing for owners.
  if (loading || viewer.loading || !viewerA.ready) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4 print-area">
      <div className="flex flex-wrap gap-3 items-end no-print">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year *</span>
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
        <EntityFilter entities={entityOptionsFor(viewer, entities)} value={entityId} onChange={setEntityId} />
      </div>

      <SupersededNotice show={viewerA.superseded} onDismiss={viewerA.dismissSuperseded} />

      {cropYear === '' && <p className="text-amber-700 text-sm">Pick a crop year to run the projection.</p>}

      {cropYear !== '' && rows.length === 0 && (
        <EmptyState
          message={`No planted crops for ${cropYear}.`}
          hint="Add plantings for this crop year, or set marketing assumptions to project revenue."
          linkHref="/reports/marketing"
          linkLabel="Set marketing assumptions"
        />
      )}

      {cropYear !== '' && rows.length > 0 && (
        <>
          {/* How this is calculated — every methodology note consolidated in one
              place, collapsed by default so it never clutters the numbers. */}
          <details className="bg-white rounded-xl shadow text-sm no-print">
            <summary className="cursor-pointer select-none px-4 py-3 font-semibold text-slate-700">How this is calculated</summary>
            <div className="border-t border-slate-100 px-4 py-3 space-y-2 text-slate-600">
              <p><strong className="text-slate-700">Crop sales revenue</strong> — the same blended expected revenue as the
                Marketing Dashboard: every bushel valued at its own price (flat-cash at cash, futures-priced at futures +
                basis, open hedges &amp; unpriced bushels at the relevant futures + assumed basis), with realized
                futures/options P&amp;L counted once. The per-crop and total figures match the dashboard.</p>
              <p><strong className="text-slate-700">Cotton physical marketing</strong> — a cotton crop&apos;s sales revenue
                buckets its lbs the same way: sold/priced contract lbs (and equity-sold loan lbs) at their locked $/lb,
                pool lbs at dollars received plus the pool estimate for the rest, in-loan lbs
                at <strong>max(banked CCC loan value, market)</strong> — the loan is the revenue floor — and held lbs at
                the market/assumed price, net of cotton fees. <strong>LDP payments and marketing-loan gains are
                sale-linked program dollars counted once inside cotton sales revenue</strong>, NOT in the government
                pool below, so nothing is double-counted.</p>
              <p><strong className="text-slate-700">Insurance + government payments</strong> — added here on top of crop
                sales (insurance = indemnity − premium; government = ARC/PLC + other USDA, allocated by planted acres).
                Government payments are attributed to the crop year they&apos;re <strong>received</strong> in: for crop
                year {cropYear}, that&apos;s the {programYearFor(cropYear)} program
                year&apos;s ARC/PLC (paid October {cropYear}) plus other USDA payments landing
                in {cropYear}. These are the <strong>only</strong> reason this page&apos;s profit differs from
                the Marketing Dashboard — with no insurance or government payments for a crop, the two profits match to
                the cent.</p>
              <p><strong className="text-slate-700">Assumptions</strong> — the Marketing Dashboard&apos;s What-If pricing
                (assumed basis &amp; assumed futures) is a <strong>standing assumption saved to the crop</strong>, so it
                flows straight through here and values the unpriced bushels exactly the same way the dashboard does.</p>
              <p><strong className="text-slate-700">Breakeven</strong> — sales-only: price = cost/acre ÷ yield, yield =
                cost/acre ÷ average price. The insurance/government safety net is in Total Revenue, not folded into
                breakeven.</p>
              <p className="text-slate-400">Insurance proceeds and harvest prices are estimates until RMA finalizes them
                after harvest.</p>
            </div>
          </details>

          <SummaryCards cards={(() => {
            const cards: SummaryCardData[] = [
              { label: 'Total Revenue', value: fmtUsd(totals.totalRevenue) },
              { label: 'Total Cost', value: fmtUsd(totals.totalCost) },
              { label: 'Total Profit', value: fmtUsd(totals.profit), tone: signedTone(totals.profit) },
              { label: 'Profit / Acre', value: fmtUsd(totals.profitPerAcre), tone: signedTone(totals.profitPerAcre) },
            ]
            return cards
          })()} />

          {/* Revenue summary */}
          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">
              Revenue by Crop — {cropYear}
              {entityName && <span className="ml-2 text-sm font-normal text-slate-500">Entity: {entityName}</span>}
            </h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  {['Crop', 'Acres', 'Yield', 'Total Production', 'Crop Sales Revenue', 'Insurance Proceeds', 'Govt Payments', 'Total Revenue', 'Revenue/Acre'].map((h) => (
                    <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cropId} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-semibold">{r.cropName}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{bu(r.acres)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{r.yield != null ? `${r.yield.toFixed(1)}` : '—'} <span className="text-xs text-slate-400">{r.yield != null ? `${r.unit === 'lbs' ? 'lbs/ac ' : ''}${r.yieldLabel}` : ''}</span></td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{bu(r.totalProduction)}{r.unit === 'lbs' && <span className="text-xs text-slate-400"> lbs</span>}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums" title={r.avgSalesPrice != null ? `Effective ${r.unit === 'lbs' ? formatCottonPrice(r.avgSalesPrice, { perLb: true }) : `${price2(r.avgSalesPrice)}/bu`} over ${bu(r.totalProduction)} ${r.unit}` : 'No production'}>{usd(r.cropSalesRevenue)}</td>
                    <td className={`px-2 py-1 text-right font-mono tabular-nums ${toneText(signedTone(r.insuranceProceeds))}`}>{usd(r.insuranceProceeds)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums" title={`ARC/PLC: ${usd(r.govtArcPlc)} | Conservation/Other (allocated): ${usd(r.govtAllocatedOther)} | Crop-specific other: ${usd(r.govtCropSpecificOther)}`}>{usd(r.govtPayments)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold">{usd(r.totalRevenue)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(r.revenuePerAcre)}</td>
                  </tr>
                ))}
                <tr className={`border-t-2 ${grandTotalRowCls}`}>
                  <td className="px-2 py-1">Total</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{bu(totals.acres)}</td>
                  <td />
                  <td className="px-2 py-1 text-right font-mono tabular-nums">
                    {bu(totals.totalProduction)}
                    {totals.totalProductionLbs > 0 && <span className="text-xs text-slate-400"> bu + {bu(totals.totalProductionLbs)} lbs</span>}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.cropSalesRevenue)}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${toneText(signedTone(totals.insuranceProceeds))}`}>{usd(totals.insuranceProceeds)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.govtPayments)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.totalRevenue)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.revenuePerAcre)}</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* Cost / profit / breakeven */}
          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">Cost, Profit &amp; Breakeven</h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  {['Crop', 'Cost/Acre', 'Total Cost', 'Total Revenue', 'Profit', 'Profit/Acre', 'Total Avg Price', 'Breakeven Price', 'Breakeven Yield'].map((h) => (
                    <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cropId} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-semibold">{r.cropName}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(r.costPerAcre)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(r.totalCost)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(r.totalRevenue)}</td>
                    <td className={`px-2 py-1 text-right font-mono tabular-nums font-semibold ${r.profit == null ? toneText('muted') : toneText(signedTone(r.profit))}`}>{r.profit != null ? usd(r.profit) : 'no cost'}</td>
                    <td className={`px-2 py-1 text-right font-mono tabular-nums ${r.profitPerAcre == null ? toneText('muted') : toneText(signedTone(r.profitPerAcre))}`}>{usd(r.profitPerAcre)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold" title="The Marketing dashboard's Total Avg Price — breakeven yield = cost/acre ÷ this">{r.unit === 'lbs' ? (r.totalAvgPrice != null ? formatCottonPrice(r.totalAvgPrice) : '—') : price2(r.totalAvgPrice)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{r.unit === 'lbs' ? (r.breakevenPrice != null ? formatCottonPrice(r.breakevenPrice) : '—') : price2(r.breakevenPrice)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{r.breakevenYield != null ? `${r.breakevenYield.toFixed(1)} ${r.unit === 'lbs' ? 'lbs/ac' : 'bu/ac'}` : '—'}</td>
                  </tr>
                ))}
                <tr className={`border-t-2 ${grandTotalRowCls}`}>
                  <td className="px-2 py-1">Total</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.costPerAcre)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.totalCost)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.totalRevenue)}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${toneText(signedTone(totals.profit))}`}>{usd(totals.profit)}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${toneText(signedTone(totals.profitPerAcre))}`}>{usd(totals.profitPerAcre)}</td>
                  <td /><td /><td />
                </tr>
              </tbody>
            </table>
          </section>

          {/* Harvest price reference */}
          <p className="text-xs text-slate-500 no-print">
            Uncontracted bushels valued at: {rows.map((r) => {
              const lbl = harvestLabelFor(r.cropId)
              const mp = r.marketPrice
              if (mp == null) return null
              // Cotton quotes are ¢/lb on CTZ; no basis concept for cotton.
              if (r.unit === 'lbs') return `${r.cropName} ${formatCottonPrice(mp, { perLb: true })}${lbl ? ` (${lbl})` : ''}`
              return `${r.cropName} ${price2(mp)}${lbl ? ` (${lbl} + basis)` : ''}`
            }).filter(Boolean).join(' · ') || '—'}
          </p>
        </>
      )}
    </div>
  )
}
