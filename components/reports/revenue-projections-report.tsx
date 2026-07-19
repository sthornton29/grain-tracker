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
import { fetchCottonPhysical } from '@/lib/cotton-physical-fetch'
import type { CottonPhysicalSummary } from '@/lib/cotton-sales'
import { fieldCropAggregates, cropsWithCompleteHarvest } from '@/lib/yields'
import { cropToCommodity } from '@/lib/contracts'
import { cropYearOptionsFromPlantings, buildDoubleCropSet } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import {
  computePolicy, harvestContractLabel, policyPremium,
  type PolicyInputs, type ScoConfig, type EcoConfig,
} from '@/lib/crop-insurance'
import { projectPayments, applyMyaResolution, programYearFor, otherPaymentsInRevenueYear } from '@/lib/government-payments'
import { computeRevenueProjections, type InsuranceProceeds, type GovtProceeds } from '@/lib/revenue-projections'
import {
  SummaryCards, EmptyState, fmtUsd, signedTone, toneText,
  theadCls, grandTotalRowCls, type SummaryCardData,
} from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import type {
  Crop, Contract, CropAssumption, FieldPlanting, FuturesPosition, OptionPosition,
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
type GinReceiptLite = { id: string; crop_year: number; bales_count: number | null; total_bale_weight: number | null }
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

  useEffect(() => {
    ;(async () => {
      const [cr, pl, ct, fp, op, ca, ld, po, sc, ec, hpe, cc, ba, el, apd, apay, ogp, sp, gr, cb] = await Promise.all([
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
        supabase.from('gin_receipts').select('id, crop_year, bales_count, total_bale_weight'),
        supabase.from('cotton_bales').select('gin_receipt_id, crop_year, net_weight_lbs'),
      ])
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

  // Broken-out expected production (irr/dry × full/double-crop), computed exactly
  // like the Marketing dashboard so computeMarketing yields identical per-crop
  // production — and therefore identical blended revenue — on both pages.
  const doubleCropIds = useMemo(() => buildDoubleCropSet(plantings, cropById), [plantings, cropById])
  const expProdByCrop = useMemo(() => {
    if (cropYear === '') return new Map<string, number>()
    return expectedProductionFromBreakout(segmentAcresByCrop(plantings, cropYear, doubleCropIds), assumptions, cropYear)
  }, [plantings, cropYear, doubleCropIds, assumptions])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...plantings.map((p) => p.season_year), ...policies.map((p) => p.crop_year)], cropYear === '' ? null : cropYear),
    [plantings, policies, cropYear],
  )

  // Live harvest-month futures estimate for EVERY planted crop — the exact same
  // request the Marketing dashboard makes, so the price used to value unpriced
  // bushels is identical on both pages (not just for crops that carry a policy).
  const livePriceCropIds = useMemo(
    () => Array.from(new Set(plantings.filter((p) => p.season_year === cropYear).map((p) => p.crop_id))),
    [plantings, cropYear],
  )
  useEffect(() => {
    if (cropYear === '' || livePriceCropIds.length === 0) { setLiveEstimates(new Map()); return }
    const payload = livePriceCropIds.map((id) => ({ crop_id: id, crop_name: cropById.get(id)?.name ?? '' })).filter((c) => c.crop_name)
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
      } catch { /* keep cached/projected */ }
    })()
    return () => { cancelled = true }
  }, [cropYear, livePriceCropIds, cropById])

  // (field|crop|year) → dry bushels + last load date, splits-aware. Drives actual
  // production (by crop) and the field-level harvest-completion check.
  const aggByKey = useMemo(
    () => fieldCropAggregates(loads, splits, cropById, { cropYear: cropYear === '' ? null : cropYear }),
    [loads, splits, cropById, cropYear],
  )

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
    for (const a of assumptions) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)
    return cropsWithCompleteHarvest({ plantings, aggByKey, cropYear, cropCompleteKeys })
  }, [plantings, aggByKey, cropYear, assumptions])

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
    for (const r of ginReceipts) {
      if (r.crop_year !== cropYear) continue
      const fromBales = balesByReceipt.get(r.id)
      lintLbs += fromBales && fromBales.lbs > 0 ? fromBales.lbs : Number(r.total_bale_weight) || 0
      baleCount += fromBales && fromBales.count > 0 ? fromBales.count : Number(r.bales_count) || 0
    }
    for (const c of crops) if (isCottonCrop(c.name)) m.set(c.id, { lintLbs, bales: baleCount })
    return m
  }, [cropYear, ginReceipts, cottonBales, crops])

  // Physical cotton marketing summary (044) — same input the dashboard passes,
  // so blended revenue stays structurally identical across the two pages.
  const [cottonPhysical, setCottonPhysical] = useState<Map<string, CottonPhysicalSummary>>(new Map())
  useEffect(() => {
    if (cropYear === '' || crops.length === 0) { setCottonPhysical(new Map()); return }
    let cancelled = false
    ;(async () => {
      try {
        const physical = await fetchCottonPhysical(supabase, cropYear)
        if (cancelled) return
        const m = new Map<string, CottonPhysicalSummary>()
        if (physical.hasData) for (const c of crops) if (isCottonCrop(c.name)) m.set(c.id, physical.summary)
        setCottonPhysical(m)
      } catch { if (!cancelled) setCottonPhysical(new Map()) }
    })()
    return () => { cancelled = true }
  }, [cropYear, crops, supabase])

  const marketingRows = useMemo(() => {
    if (cropYear === '') return []
    return computeMarketing({
      cropYear,
      crops,
      plantings: plantings.filter((p) => p.season_year === cropYear).map((p): Planting => ({ crop_id: p.crop_id, season_year: p.season_year, planted_acres: p.planted_acres })),
      contracts: contracts.filter((c) => c.crop_year === cropYear),
      futures: futures.filter((f) => f.crop_year === cropYear),
      options: options.filter((o) => o.crop_year === cropYear),
      assumptions: assumptions.filter((a) => a.crop_year === cropYear),
      actualProductionByCrop: productionByCrop,
      expectedProductionByCrop: expProdByCrop,
      currentFuturesByCrop,
      harvestCompleteCropIds: harvestCompleteIds,
      cottonProductionByCrop,
      cottonPhysicalByCrop: cottonPhysical,
    })
  }, [cropYear, crops, plantings, contracts, futures, options, assumptions, productionByCrop, expProdByCrop, currentFuturesByCrop, harvestCompleteIds, cottonProductionByCrop, cottonPhysical])

  // Resolve a harvest price per crop: final → estimate → projected.
  function harvestPriceFor(cropId: string): { price: number; isFinal: boolean } {
    const pols = policies.filter((p) => p.crop_id === cropId && p.crop_year === cropYear)
    const policyFinal = pols.find((p) => p.harvest_price != null)?.harvest_price
    const storedFinal = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_final')
    if (policyFinal != null || storedFinal) return { price: Number(policyFinal ?? storedFinal!.price), isFinal: true }
    const live = liveEstimates.get(cropId)
    if (live != null) return { price: live, isFinal: false }
    const storedEst = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_estimate')
    if (storedEst) return { price: Number(storedEst.price), isFinal: false }
    const avgProjected = pols.length > 0 ? pols.reduce((s, p) => s + Number(p.projected_price), 0) / pols.length : 0
    return { price: avgProjected, isFinal: false }
  }

  // Net insurance proceeds by crop, using each crop's marketing yield as the
  // assumed yield (ties the two reports together).
  const insuranceByCrop = useMemo(() => {
    const m = new Map<string, InsuranceProceeds>()
    if (cropYear === '') return m
    const scoBy = new Map(scos.map((s) => [s.policy_id, s]))
    const ecoBy = new Map(ecos.map((e) => [e.policy_id, e]))
    const yieldByCrop = new Map(marketingRows.map((r) => [r.cropId, r.yield]))
    for (const p of policies.filter((x) => x.crop_year === cropYear)) {
      const harvest = harvestPriceFor(p.crop_id).price
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
        countyYieldAssumptionPct: scoRow.county_yield_assumption_pct == null ? 0 : Number(scoRow.county_yield_assumption_pct),
        premiumPerAcre: scoRow.premium_per_acre == null ? null : Number(scoRow.premium_per_acre),
        totalPremium: scoRow.total_premium == null ? null : Number(scoRow.total_premium),
      } : null
      const eco: EcoConfig | null = ecoRow ? {
        ecoTriggerLevel: Number(ecoRow.eco_trigger_level),
        expectedCountyYield: Number(ecoRow.expected_county_yield),
        countyYieldAssumptionPct: ecoRow.county_yield_assumption_pct == null ? 0 : Number(ecoRow.county_yield_assumption_pct),
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
  }, [policies, scos, ecos, cropYear, marketingRows, liveEstimates, priceEstimates])

  // Current market cash price by crop: harvest price + average basis.
  const marketPriceByCrop = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of marketingRows) {
      const h = harvestPriceFor(r.cropId)
      if (h.price > 0) m.set(r.cropId, h.price + (r.avgBasis ?? 0))
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
    const projected = projectPayments({ cropYear: programYear, baseAcres, commodities, elections, priceData: effPrice, payments: arcPayments })
    const totalArcPlc = projected.reduce((s, p) => s + p.result.net, 0)
    const yearOther = otherPaymentsInRevenueYear(otherPayments, cropYear)
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
  }, [cropYear, arcPriceData, baseAcres, commodities, elections, arcPayments, otherPayments, marketingRows])

  const { rows, totals } = useMemo(
    () => computeRevenueProjections({
      marketingRows, contracts: contracts.filter((c) => c.crop_year === cropYear),
      cropYear: cropYear === '' ? 0 : cropYear, marketPriceByCrop, insuranceByCrop, govtByCrop,
    }),
    [marketingRows, contracts, cropYear, marketPriceByCrop, insuranceByCrop, govtByCrop],
  )

  const harvestLabelFor = (cropId: string) => {
    const c = cropById.get(cropId)
    return cropToCommodity(c?.name) ? harvestContractLabel(c?.name, cropYear === '' ? 0 : cropYear) : null
  }

  function buildExportPayload(): ExportPayload {
    const filters = `Crop year: ${cropYear || '—'}`
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
      // Cotton prices export in ¢/lb (per-cell 'cents' format) — never $/bu.
      rows: rows.map((r) => [
        r.unit === 'lbs' ? `${r.cropName} (¢/lb · lbs)` : r.cropName, r.costPerAcre != null ? Math.round(r.costPerAcre) : '', Math.round(r.totalCost),
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
  }, [rows, totals, cropYear, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  if (loading) return <p className="text-slate-500">Loading…</p>

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
      </div>

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
                buckets its lbs the same way: sold/priced contract lbs (and equity-sold loan lbs) at their locked ¢/lb,
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
            <h2 className="font-bold text-lg mb-2">Revenue by Crop — {cropYear}</h2>
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
                    <td className="px-2 py-1 text-right font-mono tabular-nums" title={r.avgSalesPrice != null ? `Effective ${r.unit === 'lbs' ? `${r.avgSalesPrice.toFixed(2)}¢/lb` : `${price2(r.avgSalesPrice)}/bu`} over ${bu(r.totalProduction)} ${r.unit}` : 'No production'}>{usd(r.cropSalesRevenue)}</td>
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
                    <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold" title="The Marketing dashboard's Total Avg Price — breakeven yield = cost/acre ÷ this">{r.unit === 'lbs' ? (r.totalAvgPrice != null ? `${r.totalAvgPrice.toFixed(2)}¢` : '—') : price2(r.totalAvgPrice)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{r.unit === 'lbs' ? (r.breakevenPrice != null ? `${r.breakevenPrice.toFixed(2)}¢` : '—') : price2(r.breakevenPrice)}</td>
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
              if (r.unit === 'lbs') return `${r.cropName} ${mp.toFixed(2)}¢/lb${lbl ? ` (${lbl})` : ''}`
              return `${r.cropName} ${price2(mp)}${lbl ? ` (${lbl} + basis)` : ''}`
            }).filter(Boolean).join(' · ') || '—'}
          </p>
        </>
      )}
    </div>
  )
}
