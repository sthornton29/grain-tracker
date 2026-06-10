'use client'

// Crop Insurance Claims Monitor.
//
// For a crop year, estimates the indemnity each MPCI policy (RP / RP-HPE / YP,
// plus SCO/ECO endorsements) would pay at the producer's assumed yields and the
// current/estimated harvest price, and nets it against premium paid. Every
// number is an ESTIMATE until RMA sets the final harvest price and county yields
// after harvest. The What-If panel lets the user dial yields and harvest prices
// and watch indemnities move in real time — the most valuable mid-season lever.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fmtPrice } from '@/lib/hedging'
import type { ExportPayload } from '@/lib/exports'
import {
  computePolicy, sensitivityTable, harvestContractLabel,
  PLAN_TYPE_SHORT, type PolicyInputs, type ScoConfig, type EcoConfig, type PolicyComputation,
  policyPremium,
} from '@/lib/crop-insurance'
import { resolveProgramYearConfig, programConfigNotice } from '@/lib/program-config'
import {
  SummaryCards, EmptyState, fmtUsd, signedTone, toneText,
  theadCls, grandTotalRowCls, type SummaryCardData,
} from '@/components/reports/report-kit'
import type {
  Crop, County, Entity, CropAssumption, FieldPlanting,
  CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco, HarvestPriceEstimate, ProgramYearConfig,
} from '@/lib/types'

type LoadRow = {
  crop_id: string | null
  crop_year: number | null
  from_type: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
}

type HarvestInfo = {
  price: number
  isFinal: boolean
  label: string | null // futures contract label, e.g. "DEC 26 Corn"
  source: 'final' | 'estimate' | 'projected'
  stale: boolean
  priceDate: string | null
}

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const usd = (n: number | null | undefined, d = 0) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
const bu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function CropInsuranceClaimsReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [crops, setCrops] = useState<Crop[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [policies, setPolicies] = useState<CropInsurancePolicy[]>([])
  const [scos, setScos] = useState<CropInsuranceSco[]>([])
  const [ecos, setEcos] = useState<CropInsuranceEco[]>([])
  const [priceEstimates, setPriceEstimates] = useState<HarvestPriceEstimate[]>([])
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])
  // Live Barchart estimate keyed by crop_id (from /api/harvest-price-estimate).
  const [liveEstimates, setLiveEstimates] = useState<Map<string, { price: number; label: string | null; stale: boolean; priceDate: string | null }>>(new Map())
  const [priceNote, setPriceNote] = useState<string | null>(null)

  const [cropYear, setCropYear] = usePersistentState<number | ''>('ci-claims:cropYear', '')
  const [entityId, setEntityId] = usePersistentState('ci-claims:entityId', '')

  // What-if levers.
  const [globalYieldPct, setGlobalYieldPct] = useState(0)
  const [yieldOverride, setYieldOverride] = useState<Map<string, string>>(new Map()) // policyId -> bu/ac
  const [harvestOverride, setHarvestOverride] = useState<Map<string, string>>(new Map()) // cropId -> $/bu
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    ;(async () => {
      const [cr, co, en, ca, pl, ld, po, sc, ec, hpe, pgc] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('counties').select('*').order('state_code').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('crop_assumptions').select('*'),
        supabase.from('field_plantings').select('*'),
        supabase.from('loads').select('crop_id, crop_year, from_type, net_weight, moisture, dry_bushels_override'),
        supabase.from('crop_insurance_policies').select('*'),
        supabase.from('crop_insurance_sco').select('*'),
        supabase.from('crop_insurance_eco').select('*'),
        supabase.from('harvest_price_estimates').select('*').order('price_date', { ascending: false }),
        supabase.from('program_year_config').select('*'),
      ])
      setCrops((cr.data as Crop[]) || [])
      setCounties((co.data as County[]) || [])
      setEntities((en.data as Entity[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoads((ld.data as LoadRow[]) || [])
      setPolicies((po.data as CropInsurancePolicy[]) || [])
      setScos((sc.data as CropInsuranceSco[]) || [])
      setEcos((ec.data as CropInsuranceEco[]) || [])
      setPriceEstimates((hpe.data as HarvestPriceEstimate[]) || [])
      setProgramConfigs((pgc.data as ProgramYearConfig[]) || [])
      const yrs = (po.data as CropInsurancePolicy[] | null)?.map((p) => p.crop_year) ?? []
      if (yrs.length > 0) setCropYear((cy) => (cy === '' ? Math.max(...yrs) : cy))
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  const scoByPolicy = useMemo(() => new Map(scos.map((s) => [s.policy_id, s])), [scos])
  const ecoByPolicy = useMemo(() => new Map(ecos.map((e) => [e.policy_id, e])), [ecos])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...policies.map((p) => p.crop_year), ...plantings.map((p) => p.season_year)], cropYear === '' ? null : cropYear),
    [policies, plantings, cropYear],
  )

  // Policies for the selected year + optional entity.
  const yearPolicies = useMemo(() => {
    if (cropYear === '') return []
    return policies
      .filter((p) => p.crop_year === cropYear && (!entityId || p.entity_id === entityId))
      .sort((a, b) => {
        const ca = cropById.get(a.crop_id)?.name ?? ''
        const cb = cropById.get(b.crop_id)?.name ?? ''
        return ca.localeCompare(cb) || (countyById.get(a.county_id ?? '')?.name ?? '').localeCompare(countyById.get(b.county_id ?? '')?.name ?? '')
      })
  }, [policies, cropYear, entityId, cropById, countyById])

  // Crops actually carrying a policy this year — drives the harvest fetch and the What-If panel.
  const reportCropIds = useMemo(() => Array.from(new Set(yearPolicies.map((p) => p.crop_id))), [yearPolicies])

  // Fetch a running harvest-price estimate for each crop with a policy.
  useEffect(() => {
    if (cropYear === '' || reportCropIds.length === 0) { setLiveEstimates(new Map()); return }
    const cropsPayload = reportCropIds
      .map((id) => ({ crop_id: id, crop_name: cropById.get(id)?.name ?? '' }))
      .filter((c) => c.crop_name)
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/harvest-price-estimate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: cropYear, crops: cropsPayload }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const m = new Map<string, { price: number; label: string | null; stale: boolean; priceDate: string | null }>()
        for (const e of (json.estimates ?? []) as Array<{ crop_id: string; price: number | null; label: string | null; stale: boolean; price_date: string | null }>) {
          if (e.price != null) m.set(e.crop_id, { price: Number(e.price), label: e.label, stale: !!e.stale, priceDate: e.price_date })
        }
        setLiveEstimates(m)
        setPriceNote(typeof json.note === 'string' ? json.note : null)
      } catch {
        if (!cancelled) setPriceNote('Could not refresh the harvest-price estimate — using cached/projected prices.')
      }
    })()
    return () => { cancelled = true }
  }, [cropYear, reportCropIds, cropById])

  // Actual production (dry bushels) and planted acres by crop for the year — to
  // derive a default assumed yield when no expected yield is on file.
  const actualYieldByCrop = useMemo(() => {
    if (cropYear === '') return new Map<string, number>()
    const prod = new Map<string, number>()
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
    const acres = new Map<string, number>()
    for (const p of plantings) {
      if (p.season_year !== cropYear) continue
      acres.set(p.crop_id, (acres.get(p.crop_id) ?? 0) + Number(p.planted_acres ?? 0))
    }
    const out = new Map<string, number>()
    for (const [cropId, b] of prod) {
      const a = acres.get(cropId) ?? 0
      if (a > 0) out.set(cropId, b / a)
    }
    return out
  }, [loads, plantings, cropYear, cropById])

  // Default assumed yield for a crop: expected yield from assumptions, else
  // actual loads/acre, else the mean APH across that crop's policies.
  const defaultYieldByCrop = useMemo(() => {
    const m = new Map<string, number>()
    for (const cropId of reportCropIds) {
      const a = assumptions.find((x) => x.crop_id === cropId && x.crop_year === cropYear)
      if (a?.expected_yield != null && (!a.harvest_complete || !actualYieldByCrop.has(cropId))) {
        m.set(cropId, Number(a.expected_yield))
        continue
      }
      const actual = actualYieldByCrop.get(cropId)
      if (actual != null) { m.set(cropId, actual); continue }
      const pols = yearPolicies.filter((p) => p.crop_id === cropId)
      const meanAph = pols.length > 0 ? pols.reduce((s, p) => s + Number(p.aph_yield), 0) / pols.length : 0
      m.set(cropId, meanAph)
    }
    return m
  }, [reportCropIds, assumptions, cropYear, actualYieldByCrop, yearPolicies])

  // Resolve the harvest price for each crop: RMA-final (policy or stored final)
  // → running Barchart estimate → projected price fallback.
  const harvestByCrop = useMemo(() => {
    const m = new Map<string, HarvestInfo>()
    for (const cropId of reportCropIds) {
      const crop = cropById.get(cropId)
      const pols = yearPolicies.filter((p) => p.crop_id === cropId)
      const avgProjected = pols.length > 0 ? pols.reduce((s, p) => s + Number(p.projected_price), 0) / pols.length : 0

      // Final: a policy's entered harvest price, or a stored 'harvest_final' row.
      const policyFinal = pols.find((p) => p.harvest_price != null)?.harvest_price
      const storedFinal = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_final')
      if (policyFinal != null || storedFinal) {
        m.set(cropId, {
          price: Number(policyFinal ?? storedFinal!.price),
          isFinal: true, label: harvestContractLabel(crop?.name, cropYear === '' ? 0 : cropYear),
          source: 'final', stale: false, priceDate: storedFinal?.price_date ?? null,
        })
        continue
      }
      // Estimate: live Barchart, else most-recent stored 'harvest_estimate'.
      const live = liveEstimates.get(cropId)
      const storedEst = priceEstimates.find((e) => e.crop_id === cropId && e.crop_year === cropYear && e.price_type === 'harvest_estimate')
      if (live) {
        m.set(cropId, { price: live.price, isFinal: false, label: live.label, source: 'estimate', stale: live.stale, priceDate: live.priceDate })
        continue
      }
      if (storedEst) {
        m.set(cropId, { price: Number(storedEst.price), isFinal: false, label: harvestContractLabel(crop?.name, cropYear === '' ? 0 : cropYear), source: 'estimate', stale: true, priceDate: storedEst.price_date })
        continue
      }
      // Fallback: projected price.
      m.set(cropId, { price: avgProjected, isFinal: false, label: harvestContractLabel(crop?.name, cropYear === '' ? 0 : cropYear), source: 'projected', stale: false, priceDate: null })
    }
    return m
  }, [reportCropIds, cropById, yearPolicies, priceEstimates, liveEstimates, cropYear])

  // Effective (what-if-adjusted) harvest price for a crop.
  function effHarvest(cropId: string): number {
    const o = harvestOverride.get(cropId)
    if (o != null && o.trim() !== '' && Number.isFinite(Number(o))) return Number(o)
    return harvestByCrop.get(cropId)?.price ?? 0
  }
  // Effective assumed yield for a policy: per-policy override or crop default,
  // scaled by the global yield slider.
  function effYield(p: CropInsurancePolicy): number {
    const o = yieldOverride.get(p.id)
    const base = o != null && o.trim() !== '' && Number.isFinite(Number(o))
      ? Number(o)
      : (defaultYieldByCrop.get(p.crop_id) ?? Number(p.aph_yield))
    return base * (1 + globalYieldPct / 100)
  }

  function buildInputs(p: CropInsurancePolicy): { base: PolicyInputs; sco: ScoConfig | null; eco: EcoConfig | null; basePremium: number } {
    const harvest = effHarvest(p.crop_id)
    const base: PolicyInputs = {
      planType: p.plan_type,
      coverageLevel: Number(p.coverage_level),
      aphYield: Number(p.aph_yield),
      projectedPrice: Number(p.projected_price),
      harvestPrice: harvest,
      insuredAcres: Number(p.insured_acres),
      actualYield: effYield(p),
    }
    const scoRow = scoByPolicy.get(p.id)
    const ecoRow = ecoByPolicy.get(p.id)
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
    return { base, sco, eco, basePremium: policyPremium(p) }
  }

  // Per-year program parameters (SCO trigger), with most-recent-year fallback.
  const programCfg = useMemo(
    () => resolveProgramYearConfig(cropYear === '' ? new Date().getFullYear() : cropYear, programConfigs),
    [cropYear, programConfigs],
  )
  const programNotice = cropYear === '' ? null : programConfigNotice(programCfg)

  type Computed = { policy: CropInsurancePolicy; comp: PolicyComputation; harvest: HarvestInfo | undefined; assumedYield: number }
  const computed: Computed[] = useMemo(() => {
    return yearPolicies.map((p) => {
      const inp = buildInputs(p)
      return { policy: p, comp: computePolicy({ ...inp, scoTriggerDefault: programCfg.scoTrigger }), harvest: harvestByCrop.get(p.crop_id), assumedYield: inp.base.actualYield }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearPolicies, harvestByCrop, defaultYieldByCrop, yieldOverride, harvestOverride, globalYieldPct, scoByPolicy, ecoByPolicy, programCfg])

  const totals = useMemo(() => {
    return computed.reduce(
      (a, c) => ({
        acres: a.acres + Number(c.policy.insured_acres),
        revenueGuarantee: a.revenueGuarantee + c.comp.base.revenueGuarantee,
        expectedRevenue: a.expectedRevenue + c.comp.base.expectedRevenue,
        baseIndemnity: a.baseIndemnity + c.comp.base.indemnity,
        scoIndemnity: a.scoIndemnity + (c.comp.sco?.indemnity ?? 0),
        ecoIndemnity: a.ecoIndemnity + (c.comp.eco?.indemnity ?? 0),
        totalIndemnity: a.totalIndemnity + c.comp.totalIndemnity,
        premium: a.premium + c.comp.premiumPaid,
        netPnl: a.netPnl + c.comp.netPnl,
      }),
      { acres: 0, revenueGuarantee: 0, expectedRevenue: 0, baseIndemnity: 0, scoIndemnity: 0, ecoIndemnity: 0, totalIndemnity: 0, premium: 0, netPnl: 0 },
    )
  }, [computed])

  // Headline summary cards from the already-computed totals (no new math).
  const summaryCards: SummaryCardData[] = useMemo(() => [
    { label: 'Total Indemnity', value: fmtUsd(totals.totalIndemnity), tone: totals.totalIndemnity > 0 ? 'favorable' : 'muted' },
    { label: 'Premium Paid', value: fmtUsd(totals.premium) },
    { label: 'Net Ins. P&L', value: fmtUsd(totals.netPnl), tone: signedTone(totals.netPnl), sub: 'Total indemnity − premium paid' },
    { label: 'Insured Acres', value: bu(totals.acres) },
  ], [totals])

  // Net-P&L color: green well-positive, red well-negative, amber near breakeven.
  function pnlClass(net: number, premium: number): string {
    const tol = Math.max(50, premium * 0.05)
    if (net > tol) return 'text-green-700'
    if (net < -tol) return 'text-red-700'
    return 'text-amber-600'
  }

  const cropName = (id: string) => cropById.get(id)?.name ?? '—'
  const countyName = (id: string | null) => (id ? (countyById.get(id) ? `${countyById.get(id)!.name}, ${countyById.get(id)!.state_code}` : '—') : 'No county')

  function harvestLabel(info: HarvestInfo | undefined): string {
    if (!info) return '—'
    if (info.isFinal) return `${fmtPrice(info.price)} (final)`
    if (info.source === 'projected') return `${fmtPrice(info.price)} (proj.)`
    return `${fmtPrice(info.price)} (est.)`
  }

  function toggle(id: string) {
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  // ----- Export payload -----
  function buildExportPayload(): ExportPayload {
    const entityName = entityId ? entities.find((e) => e.id === entityId)?.name ?? '' : ''
    const filters = [`Crop year: ${cropYear || '—'}`, entityName ? `Entity: ${entityName}` : 'All entities',
      globalYieldPct !== 0 ? `Yield what-if: ${globalYieldPct > 0 ? '+' : ''}${globalYieldPct}%` : null].filter(Boolean).join(' · ')
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: 'Estimated Indemnity by Policy',
      columns: [
        { label: 'Crop' }, { label: 'County' }, { label: 'Plan' }, { label: 'Coverage', align: 'right' },
        { label: 'APH', align: 'right' }, { label: 'Proj $', align: 'right' }, { label: 'Harvest $', align: 'right' },
        { label: 'Assumed Yld', align: 'right' }, { label: 'Acres', align: 'right' },
        { label: 'Revenue Guarantee', align: 'right' }, { label: 'Expected Revenue', align: 'right' },
        { label: 'Base Indemnity', align: 'right' }, { label: 'SCO', align: 'right' }, { label: 'ECO', align: 'right' },
        { label: 'Total Indemnity', align: 'right' }, { label: 'Premium Paid', align: 'right' }, { label: 'Net Ins. P&L', align: 'right' },
      ],
      rows: computed.map((c) => [
        cropName(c.policy.crop_id), countyName(c.policy.county_id), PLAN_TYPE_SHORT[c.policy.plan_type],
        `${Math.round(Number(c.policy.coverage_level) * 100)}%`, Number(c.policy.aph_yield), Number(c.policy.projected_price),
        Number((c.harvest?.price ?? 0).toFixed(4)), Number(c.assumedYield.toFixed(1)), Number(c.policy.insured_acres),
        Math.round(c.comp.base.revenueGuarantee), Math.round(c.comp.base.expectedRevenue), Math.round(c.comp.base.indemnity),
        Math.round(c.comp.sco?.indemnity ?? 0), Math.round(c.comp.eco?.indemnity ?? 0),
        Math.round(c.comp.totalIndemnity), Math.round(c.comp.premiumPaid), Math.round(c.comp.netPnl),
      ]),
      rowMeta: computed.map(() => 'data' as const),
    })
    // Totals as a final 'total' row appended to the same section.
    sections[0].rows.push([
      'Total', '', '', '', '', '', '', '', Math.round(totals.acres),
      Math.round(totals.revenueGuarantee), Math.round(totals.expectedRevenue), Math.round(totals.baseIndemnity),
      Math.round(totals.scoIndemnity), Math.round(totals.ecoIndemnity), Math.round(totals.totalIndemnity),
      Math.round(totals.premium), Math.round(totals.netPnl),
    ])
    sections[0].rowMeta!.push('total')
    return { title: 'Crop Insurance Claims Monitor', filters, sections }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, totals, cropYear, entityId, globalYieldPct, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  if (loading) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4 print-area">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end no-print">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year *</span>
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Entity (optional)</span>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
            <option value="">All entities</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      </div>

      {cropYear === '' && <p className="text-amber-700 text-sm">Pick a crop year to run the claims monitor.</p>}

      {programNotice && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-300 px-3 py-2 text-sm text-yellow-900">
          {programNotice}
        </div>
      )}

      {cropYear !== '' && yearPolicies.length === 0 && (
        <EmptyState
          message={`No crop insurance policies for ${cropYear}.`}
          linkHref="/settings/crop-insurance"
          linkLabel="Add policies"
        />
      )}

      {cropYear !== '' && yearPolicies.length > 0 && (
        <>
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 no-print">
            <strong>Estimated</strong> — based on current yield assumptions and futures prices. Final amounts are
            determined by RMA after harvest.{priceNote ? ` ${priceNote}` : ''}
          </div>

          <SummaryCards cards={summaryCards} />

          {/* What-If panel */}
          <WhatIfPanel
            globalYieldPct={globalYieldPct}
            setGlobalYieldPct={setGlobalYieldPct}
            crops={reportCropIds.map((id) => ({ id, name: cropName(id), harvest: harvestByCrop.get(id) }))}
            harvestOverride={harvestOverride}
            setHarvestOverride={setHarvestOverride}
            onReset={() => { setGlobalYieldPct(0); setYieldOverride(new Map()); setHarvestOverride(new Map()) }}
          />

          {/* Summary table */}
          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">Estimated Indemnity by Policy — {cropYear}</h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  {['Crop', 'County', 'Plan', 'Cov', 'APH', 'Proj $', 'Harvest $', 'Assumed Yld', 'Acres',
                    'Rev. Guarantee', 'Exp. Revenue', 'Base Indemnity', 'SCO', 'ECO', 'Total Indemnity', 'Premium', 'Net Ins. P&L', ''].map((h) => (
                    <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {computed.map((c) => {
                  const p = c.policy
                  return (
                    <tr key={p.id} className="border-t border-slate-100 align-middle">
                      <td className="px-2 py-1 font-semibold whitespace-nowrap">{cropName(p.crop_id)}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{countyName(p.county_id)}</td>
                      <td className="px-2 py-1">{PLAN_TYPE_SHORT[p.plan_type]}</td>
                      <td className="px-2 py-1 text-right">{Math.round(Number(p.coverage_level) * 100)}%</td>
                      <td className="px-2 py-1 text-right tabular-nums">{Number(p.aph_yield).toFixed(1)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtPrice(p.projected_price)}</td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{harvestLabel(c.harvest)}</td>
                      <td className="px-2 py-1 text-right">
                        <input
                          type="number" step="0.1"
                          value={yieldOverride.get(p.id) ?? ''}
                          placeholder={c.assumedYield.toFixed(1)}
                          onChange={(e) => setYieldOverride((m) => { const n = new Map(m); if (e.target.value === '') n.delete(p.id); else n.set(p.id, e.target.value); return n })}
                          className="w-20 rounded border border-slate-300 px-1 py-0.5 text-right tabular-nums no-print"
                        />
                        <span className="hidden print:inline tabular-nums">{c.assumedYield.toFixed(1)}</span>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{bu(Number(p.insured_acres))}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(c.comp.base.revenueGuarantee)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(c.comp.base.expectedRevenue)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(c.comp.base.indemnity))}`}>{usd(c.comp.base.indemnity)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${c.comp.sco ? toneText(signedTone(c.comp.sco.indemnity)) : toneText('muted')}`}>{c.comp.sco ? usd(c.comp.sco.indemnity) : 'N/A'}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${c.comp.eco ? toneText(signedTone(c.comp.eco.indemnity)) : toneText('muted')}`}>{c.comp.eco ? usd(c.comp.eco.indemnity) : 'N/A'}</td>
                      <td className={`px-2 py-1 text-right tabular-nums font-semibold ${toneText(signedTone(c.comp.totalIndemnity))}`}>{usd(c.comp.totalIndemnity)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(c.comp.premiumPaid)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums font-bold ${pnlClass(c.comp.netPnl, c.comp.premiumPaid)}`}>{usd(c.comp.netPnl)}</td>
                      <td className="px-2 py-1 no-print">
                        <button onClick={() => toggle(p.id)} className="text-sky-700 text-xs whitespace-nowrap">{expanded.has(p.id) ? 'Hide' : 'Detail'}</button>
                      </td>
                    </tr>
                  )
                })}
                <tr className={grandTotalRowCls}>
                  <td className="px-2 py-1" colSpan={8}>Total</td>
                  <td className="px-2 py-1 text-right tabular-nums">{bu(totals.acres)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{usd(totals.revenueGuarantee)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{usd(totals.expectedRevenue)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.baseIndemnity))}`}>{usd(totals.baseIndemnity)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.scoIndemnity))}`}>{usd(totals.scoIndemnity)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.ecoIndemnity))}`}>{usd(totals.ecoIndemnity)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.totalIndemnity))}`}>{usd(totals.totalIndemnity)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{usd(totals.premium)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${pnlClass(totals.netPnl, totals.premium)}`}>{usd(totals.netPnl)}</td>
                  <td className="no-print" />
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-slate-500 mt-2">
              Net Insurance P&amp;L = Total Indemnity − Premium Paid. <span className="text-green-700">Green</span> = claim
              exceeds premium, <span className="text-red-700">red</span> = premium exceeds claim,
              <span className="text-amber-600"> amber</span> = near breakeven.
            </p>
          </section>

          {/* Per-policy detail */}
          {computed.filter((c) => expanded.has(c.policy.id)).map((c) => (
            <PolicyDetail
              key={c.policy.id}
              computed={c}
              cropName={cropName(c.policy.crop_id)}
              countyName={countyName(c.policy.county_id)}
              sco={scoByPolicy.get(c.policy.id) ?? null}
              eco={ecoByPolicy.get(c.policy.id) ?? null}
              sensitivity={sensitivityTable(buildInputs(c.policy))}
            />
          ))}
        </>
      )}
    </div>
  )
}

function WhatIfPanel({
  globalYieldPct, setGlobalYieldPct, crops, harvestOverride, setHarvestOverride, onReset,
}: {
  globalYieldPct: number
  setGlobalYieldPct: (n: number) => void
  crops: Array<{ id: string; name: string; harvest: HarvestInfo | undefined }>
  harvestOverride: Map<string, string>
  setHarvestOverride: (fn: (m: Map<string, string>) => Map<string, string>) => void
  onReset: () => void
}) {
  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-3 no-print">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="font-bold text-lg flex-1">What-If</h2>
        <button onClick={onReset} className="text-sm text-slate-500 underline">Reset assumptions</button>
      </div>
      <p className="text-xs text-slate-500">
        Move the yield slider or override a crop’s harvest price to see how indemnities change in real time. Per-policy
        assumed yield can also be edited directly in the table above.
      </p>
      <label className="flex items-center gap-3 flex-wrap text-sm">
        <span className="w-40 text-slate-600">Yield adjustment: <strong>{globalYieldPct > 0 ? '+' : ''}{globalYieldPct}%</strong></span>
        <input type="range" min={-40} max={40} step={5} value={globalYieldPct} onChange={(e) => setGlobalYieldPct(Number(e.target.value))} className="flex-1 min-w-[12rem]" />
        <button onClick={() => setGlobalYieldPct(0)} className="text-xs text-slate-500 underline">0%</button>
      </label>
      <div className="flex flex-wrap gap-3">
        {crops.map((c) => (
          <label key={c.id} className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">{c.name} harvest $ {c.harvest?.label ? `(${c.harvest.label})` : ''}</span>
            <input
              type="number" step="0.01"
              placeholder={(c.harvest?.price ?? 0).toFixed(2)}
              value={harvestOverride.get(c.id) ?? ''}
              onChange={(e) => setHarvestOverride((m) => { const n = new Map(m); if (e.target.value === '') n.delete(c.id); else n.set(c.id, e.target.value); return n })}
              className="rounded-lg border border-slate-300 px-3 py-2 w-40"
            />
          </label>
        ))}
      </div>
    </section>
  )
}

function PolicyDetail({
  computed, cropName, countyName, sco, eco, sensitivity,
}: {
  computed: { policy: CropInsurancePolicy; comp: PolicyComputation; harvest: HarvestInfo | undefined; assumedYield: number }
  cropName: string
  countyName: string
  sco: CropInsuranceSco | null
  eco: CropInsuranceEco | null
  sensitivity: ReturnType<typeof sensitivityTable>
}) {
  const { policy: p, comp, harvest, assumedYield } = computed
  const cov = Number(p.coverage_level)
  const usd2 = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const Line = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-0.5">
      <span className="text-slate-500">{label}</span><span className="font-mono">{value}</span>
    </div>
  )

  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-4 avoid-break">
      <h3 className="font-bold">{cropName} · {countyName} · {PLAN_TYPE_SHORT[p.plan_type]} {Math.round(cov * 100)}% — calculation</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <div className="font-semibold mb-1">Inputs</div>
          <Line label="APH yield" value={`${Number(p.aph_yield).toFixed(1)} bu/ac`} />
          <Line label="Coverage level" value={`${Math.round(cov * 100)}%`} />
          <Line label="Projected price" value={fmtPrice(p.projected_price)} />
          <Line label={`Harvest price${harvest?.isFinal ? ' (final)' : ' (est.)'}`} value={fmtPrice(harvest?.price ?? 0)} />
          <Line label="Guarantee price (used)" value={fmtPrice(comp.base.guaranteePrice)} />
          <Line label="Assumed yield" value={`${assumedYield.toFixed(1)} bu/ac`} />
          <Line label="Insured acres" value={Number(p.insured_acres).toLocaleString()} />
        </div>
        <div>
          <div className="font-semibold mb-1">Base policy ({PLAN_TYPE_SHORT[p.plan_type]})</div>
          {p.plan_type === 'YP' ? (
            <>
              <Line label="Production guarantee" value={`${(comp.base.productionGuaranteeBu ?? 0).toLocaleString()} bu`} />
              <Line label="= APH × coverage × acres" value={`${Number(p.aph_yield).toFixed(1)} × ${cov} × ${Number(p.insured_acres).toLocaleString()}`} />
              <Line label="Actual production" value={`${(comp.base.actualProductionBu ?? 0).toLocaleString()} bu`} />
              <Line label="Shortfall" value={`${(comp.base.indemnityBushels ?? 0).toLocaleString()} bu`} />
              <Line label="× MAX(proj, harvest)" value={fmtPrice(comp.base.guaranteePrice)} />
              <Line label="Base indemnity" value={usd2(comp.base.indemnity)} />
            </>
          ) : (
            <>
              <Line label="Revenue guarantee" value={usd2(comp.base.revenueGuarantee)} />
              <Line label="= APH × cov × g.price × acres" value={`${Number(p.aph_yield).toFixed(1)} × ${cov} × ${fmtPrice(comp.base.guaranteePrice)} × ${Number(p.insured_acres).toLocaleString()}`} />
              <Line label="Expected revenue" value={usd2(comp.base.expectedRevenue)} />
              <Line label="= assumed yld × harvest × acres" value={`${assumedYield.toFixed(1)} × ${fmtPrice(harvest?.price ?? 0)} × ${Number(p.insured_acres).toLocaleString()}`} />
              <Line label="Base indemnity = MAX(0, guar − exp)" value={usd2(comp.base.indemnity)} />
            </>
          )}
        </div>
      </div>

      {(comp.sco || comp.eco) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          {comp.sco && sco && (
            <div>
              <div className="font-semibold mb-1">SCO band ({Math.round(cov * 100)}% → {Math.round(Number(sco.coverage_trigger) * 100)}%)</div>
              <Line label="Expected county yield" value={`${Number(sco.expected_county_yield).toFixed(1)} bu/ac`} />
              <Line label="County vs your yield" value={`${Number(sco.county_yield_assumption_pct ?? 0)}%`} />
              <Line label="Est. county yield" value={`${(assumedYield * (1 + Number(sco.county_yield_assumption_pct ?? 0) / 100)).toFixed(1)} bu/ac`} />
              <Line label="County ratio" value={`${(comp.sco.ratio * 100).toFixed(1)}%`} />
              <Line label="Payment factor" value={comp.sco.paymentFactor.toFixed(4)} />
              <Line label="Band payment limit" value={usd2(comp.sco.paymentLimit)} />
              <Line label="SCO indemnity" value={usd2(comp.sco.indemnity)} />
            </div>
          )}
          {comp.eco && eco && (
            <div>
              <div className="font-semibold mb-1">ECO band (86% → {Math.round(Number(eco.eco_trigger_level) * 100)}%)</div>
              <Line label="Expected county yield" value={`${Number(eco.expected_county_yield).toFixed(1)} bu/ac`} />
              <Line label="County vs your yield" value={`${Number(eco.county_yield_assumption_pct ?? 0)}%`} />
              <Line label="Est. county yield" value={`${(assumedYield * (1 + Number(eco.county_yield_assumption_pct ?? 0) / 100)).toFixed(1)} bu/ac`} />
              <Line label="County ratio" value={`${(comp.eco.ratio * 100).toFixed(1)}%`} />
              <Line label="Payment factor" value={comp.eco.paymentFactor.toFixed(4)} />
              <Line label="Band payment limit" value={usd2(comp.eco.paymentLimit)} />
              <Line label="ECO indemnity" value={usd2(comp.eco.indemnity)} />
            </div>
          )}
        </div>
      )}

      {/* Sensitivity */}
      <div>
        <div className="font-semibold mb-1 text-sm">Yield sensitivity (±20%)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-2 py-1 text-left">Yield change</th>
                {sensitivity.map((s) => <th key={s.yieldPct} className="px-2 py-1 text-right">{s.yieldPct > 0 ? '+' : ''}{s.yieldPct}%</th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-100">
                <td className="px-2 py-1 text-slate-500">Yield (bu/ac)</td>
                {sensitivity.map((s) => <td key={s.yieldPct} className="px-2 py-1 text-right font-mono">{s.actualYield.toFixed(0)}</td>)}
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-2 py-1 text-slate-500">Total indemnity</td>
                {sensitivity.map((s) => <td key={s.yieldPct} className="px-2 py-1 text-right font-mono">{usd2(s.totalIndemnity)}</td>)}
              </tr>
              <tr className="border-t border-slate-100">
                <td className="px-2 py-1 text-slate-500">Net ins. P&L</td>
                {sensitivity.map((s) => (
                  <td key={s.yieldPct} className={`px-2 py-1 text-right font-mono ${s.netPnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>{usd2(s.netPnl)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
