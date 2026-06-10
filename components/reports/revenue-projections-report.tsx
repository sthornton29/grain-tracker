'use client'

// Revenue Projections — one financial picture per crop for a crop year,
// combining crop sales revenue (from the Marketing dashboard logic), net crop
// insurance proceeds (from the Claims Monitor engine), and government payments
// (ARC/PLC + other USDA payments, allocated by planted acres), then layering
// cost, profit, and breakeven. Updates live as loads, contracts, insurance
// assumptions, government payments, or futures prices change.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { computeMarketing, type Planting } from '@/lib/marketing'
import { cropToCommodity } from '@/lib/contracts'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fmtPrice } from '@/lib/hedging'
import {
  computePolicy, harvestContractLabel, policyPremium,
  type PolicyInputs, type ScoConfig, type EcoConfig,
} from '@/lib/crop-insurance'
import { projectPayments } from '@/lib/government-payments'
import { computeRevenueProjections, type InsuranceProceeds, type GovtProceeds } from '@/lib/revenue-projections'
import {
  SummaryCards, EmptyState, fmtUsd, signedTone, toneText,
  theadCls, grandTotalRowCls, type SummaryCardData,
} from '@/components/reports/report-kit'
import type { ExportPayload } from '@/lib/exports'
import type {
  Crop, Contract, CropAssumption, FieldPlanting, FuturesPosition, OptionPosition,
  CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco, HarvestPriceEstimate,
  CoveredCommodity, FarmBaseAcres, ArcPlcElection, ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment,
} from '@/lib/types'

type LoadRow = {
  crop_id: string | null
  crop_year: number | null
  from_type: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
}

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const usd = (n: number | null | undefined, d = 0) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
const bu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })

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
  const [liveMya, setLiveMya] = useState<Map<string, number>>(new Map())

  const [cropYear, setCropYear] = usePersistentState<number | ''>('rev-proj:cropYear', '')

  useEffect(() => {
    ;(async () => {
      const [cr, pl, ct, fp, op, ca, ld, po, sc, ec, hpe, cc, ba, el, apd, apay, ogp] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('field_plantings').select('*'),
        supabase.from('contracts').select('*'),
        supabase.from('futures_positions').select('*'),
        supabase.from('options_positions').select('*'),
        supabase.from('crop_assumptions').select('*'),
        supabase.from('loads').select('crop_id, crop_year, from_type, net_weight, moisture, dry_bushels_override'),
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
      ])
      setCrops((cr.data as Crop[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setContracts((ct.data as Contract[]) || [])
      setFutures((fp.data as FuturesPosition[]) || [])
      setOptions((op.data as OptionPosition[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setLoads((ld.data as LoadRow[]) || [])
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

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...plantings.map((p) => p.season_year), ...policies.map((p) => p.crop_year)], cropYear === '' ? null : cropYear),
    [plantings, policies, cropYear],
  )

  // Crops with a policy this year — refresh their harvest-price estimates.
  const policyCropIds = useMemo(
    () => Array.from(new Set(policies.filter((p) => p.crop_year === cropYear).map((p) => p.crop_id))),
    [policies, cropYear],
  )
  useEffect(() => {
    if (cropYear === '' || policyCropIds.length === 0) { setLiveEstimates(new Map()); return }
    const payload = policyCropIds.map((id) => ({ crop_id: id, crop_name: cropById.get(id)?.name ?? '' })).filter((c) => c.crop_name)
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
  }, [cropYear, policyCropIds, cropById])

  // Actual production (dry bushels) by crop for the year.
  const productionByCrop = useMemo(() => {
    const prod = new Map<string, number>()
    if (cropYear === '') return prod
    for (const l of loads) {
      if (l.from_type !== 'field' || !l.crop_id || l.crop_year !== cropYear) continue
      const crop = cropById.get(l.crop_id)
      const { dryBushels } = computeBushels({
        netWeightLb: l.net_weight, moisturePct: l.moisture,
        baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
        dryBushelsOverride: l.dry_bushels_override,
      })
      if (dryBushels) prod.set(l.crop_id, (prod.get(l.crop_id) ?? 0) + dryBushels)
    }
    return prod
  }, [loads, cropYear, cropById])

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
    })
  }, [cropYear, crops, plantings, contracts, futures, options, assumptions, productionByCrop])

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

  // Refresh live MYA for the tradeable commodities (feeds PLC projections).
  useEffect(() => {
    if (cropYear === '' || commodities.length === 0) return
    const tradeable = commodities.filter((c) => ['Corn', 'Soybeans', 'Wheat'].includes(c.name))
    if (tradeable.length === 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/mya-estimate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: cropYear, commodities: tradeable.map((c) => ({ commodity_id: c.id, name: c.name })) }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const m = new Map<string, number>()
        for (const e of (json.estimates ?? []) as Array<{ commodity_id: string; price: number | null }>) if (e.price != null) m.set(e.commodity_id, Number(e.price))
        setLiveMya(m)
      } catch { /* fall back to stored */ }
    })()
    return () => { cancelled = true }
  }, [cropYear, commodities])

  // Government payments allocated per crop: total ARC/PLC (across all farms) and
  // non-crop-specific other payments are split by planted acres; crop-specific
  // other payments go straight to their crop.
  const govtByCrop = useMemo(() => {
    const m = new Map<string, GovtProceeds>()
    if (cropYear === '') return m
    const effPrice = arcPriceData.map((p) => (p.crop_year === cropYear && liveMya.has(p.commodity_id) ? { ...p, mya_price_estimate: liveMya.get(p.commodity_id)! } : p))
    for (const [cid, price] of liveMya) {
      if (!effPrice.some((p) => p.commodity_id === cid && p.crop_year === cropYear)) {
        effPrice.push({ id: `live-${cid}`, commodity_id: cid, crop_year: cropYear, effective_reference_price: null, mya_price_estimate: price, mya_price_final: null, source: 'barchart', updated_at: '' })
      }
    }
    const projected = projectPayments({ cropYear, baseAcres, commodities, elections, priceData: effPrice, payments: arcPayments })
    const totalArcPlc = projected.reduce((s, p) => s + p.result.net, 0)
    const yearOther = otherPayments.filter((o) => o.crop_year === cropYear)
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
  }, [cropYear, arcPriceData, liveMya, baseAcres, commodities, elections, arcPayments, otherPayments, marketingRows])

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
        { label: 'Crop' }, { label: 'Acres', align: 'right' }, { label: 'Yield', align: 'right' },
        { label: 'Total Production', align: 'right' }, { label: 'Crop Sales Revenue', align: 'right' },
        { label: 'Insurance Proceeds', align: 'right' }, { label: 'Govt Payments', align: 'right' },
        { label: 'Total Revenue', align: 'right' }, { label: 'Revenue/Acre', align: 'right' },
      ],
      rows: rows.map((r) => [
        r.cropName, Math.round(r.acres), r.yield != null ? Number(r.yield.toFixed(1)) : '',
        Math.round(r.totalProduction), Math.round(r.cropSalesRevenue), Math.round(r.insuranceProceeds),
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
        { label: 'Crop' }, { label: 'Cost/Acre', align: 'right' }, { label: 'Total Cost', align: 'right' },
        { label: 'Total Revenue', align: 'right' }, { label: 'Profit', align: 'right' }, { label: 'Profit/Acre', align: 'right' },
        { label: 'Breakeven Price', align: 'right' }, { label: 'Breakeven Yield', align: 'right' },
      ],
      rows: rows.map((r) => [
        r.cropName, r.costPerAcre != null ? Math.round(r.costPerAcre) : '', Math.round(r.totalCost),
        Math.round(r.totalRevenue), r.profit != null ? Math.round(r.profit) : '', r.profitPerAcre != null ? Math.round(r.profitPerAcre) : '',
        r.breakevenPrice != null ? Number(r.breakevenPrice.toFixed(2)) : '', r.breakevenYield != null ? Number(r.breakevenYield.toFixed(1)) : '',
      ]),
      rowMeta: rows.map(() => 'data' as const),
    }
    profitSection.rows.push([
      'Total', totals.costPerAcre != null ? Math.round(totals.costPerAcre) : '', Math.round(totals.totalCost),
      Math.round(totals.totalRevenue), Math.round(totals.profit), totals.profitPerAcre != null ? Math.round(totals.profitPerAcre) : '', '', '',
    ])
    profitSection.rowMeta!.push('total')

    return { title: 'Revenue Projections', filters, sections: [revenueSection, profitSection] }
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
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 no-print">
            <strong>Projection</strong> — crop sales use each crop&apos;s average marketed price (futures + basis, net of
            realized futures/options P&amp;L) applied to total production; insurance proceeds and harvest prices are
            estimates until RMA finalizes them after harvest.
          </div>

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
                  {['Crop', 'Acres', 'Yield', 'Total Production', 'Crop Sales Revenue *', 'Insurance Proceeds', 'Govt Payments', 'Total Revenue', 'Revenue/Acre'].map((h) => (
                    <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cropId} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-semibold">{r.cropName}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{bu(r.acres)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{r.yield != null ? `${r.yield.toFixed(1)}` : '—'} <span className="text-xs text-slate-400">{r.yield != null ? r.yieldLabel : ''}</span></td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{bu(r.totalProduction)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums" title={r.avgSalesPrice != null ? `Avg marketed price ${fmtPrice(r.avgSalesPrice)} (${r.salesPriceSource}) × ${bu(r.totalProduction)} bu — net of realized futures/options P&L` : 'No marketed price available'}>{usd(r.cropSalesRevenue)}</td>
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
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{bu(totals.totalProduction)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.cropSalesRevenue)}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${toneText(signedTone(totals.insuranceProceeds))}`}>{usd(totals.insuranceProceeds)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.govtPayments)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.totalRevenue)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.revenuePerAcre)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-slate-500 mt-2">
              <strong>*</strong> Crop Sales Revenue = each crop&apos;s average marketed price (futures + basis) × total
              production — and is <strong>net of realized futures &amp; options P&amp;L</strong>, since that P&amp;L is
              folded into the average futures price. Falls back to average cash, then current market price. Government
              Payments = ARC/PLC and other USDA payments allocated by planted acres (hover a cell for the breakdown).
              Insurance Proceeds = total indemnity − premium.
            </p>
          </section>

          {/* Cost / profit / breakeven */}
          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">Cost, Profit &amp; Breakeven</h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  {['Crop', 'Cost/Acre', 'Total Cost', 'Total Revenue', 'Profit', 'Profit/Acre', 'Breakeven Price', 'Breakeven Yield'].map((h) => (
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
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{r.breakevenPrice != null ? fmtPrice(r.breakevenPrice) : '—'}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{r.breakevenYield != null ? `${r.breakevenYield.toFixed(1)} bu/ac` : '—'}</td>
                  </tr>
                ))}
                <tr className={`border-t-2 ${grandTotalRowCls}`}>
                  <td className="px-2 py-1">Total</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.costPerAcre)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.totalCost)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.totalRevenue)}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${toneText(signedTone(totals.profit))}`}>{usd(totals.profit)}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${toneText(signedTone(totals.profitPerAcre))}`}>{usd(totals.profitPerAcre)}</td>
                  <td /><td />
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-slate-500 mt-2">
              Breakeven price = sales $ needed to cover cost after insurance ÷ total production. Breakeven yield = that
              same figure ÷ (market price × acres). Both hold the other variable fixed.
            </p>
          </section>

          {/* Harvest price reference */}
          <p className="text-xs text-slate-500 no-print">
            Uncontracted bushels valued at: {rows.map((r) => {
              const lbl = harvestLabelFor(r.cropId)
              const mp = r.marketPrice
              return mp != null ? `${r.cropName} ${fmtPrice(mp)}${lbl ? ` (${lbl} + basis)` : ''}` : null
            }).filter(Boolean).join(' · ') || '—'}
          </p>
        </>
      )}
    </div>
  )
}
