'use client'

// Crop Insurance Claims Monitor.
//
// For a crop year, estimates the indemnity each MPCI policy (RP / RP-HPE / YP,
// plus SCO/ECO endorsements) would pay at the producer's per-practice yields and
// the current harvest-price basis (live Barchart discovery-month price until an
// RMA final is on file), and nets it against premium paid. Every number is an
// ESTIMATE until RMA sets the final harvest price and county yields after
// harvest. Scenario analysis (price × yield what-ifs) lives in the Income
// Sensitivity Report (/reports/income-sensitivity), linked below.

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { fmtPrice } from '@/lib/hedging'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import {
  sensitivityTable, harvestContractLabel,
  projectInsuranceIndemnities, resolveHarvestPriceByCrop, actualYieldByCropFromLoads,
  PLAN_TYPE_SHORT, PRACTICE_LABEL, isAreaPlan, stackingWarnings, staxArcPlcWarning,
  type PolicyInputs, type ScoConfig, type EcoConfig, type PolicyComputation,
  type LiveHarvest,
} from '@/lib/crop-insurance'
import { CountyAssumptionControl } from '@/components/crop-insurance/county-assumption-editor'
import { resolveProgramYearConfig, programConfigNotice } from '@/lib/program-config'
import {
  SummaryCards, EmptyState, fmtUsd, signedTone, toneText,
  theadCls, grandTotalRowCls, type SummaryCardData,
} from '@/components/reports/report-kit'
import type {
  Crop, County, Entity, CropAssumption, FieldPlanting,
  CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco,
  CropInsuranceStax, CropInsuranceMco, CountyYieldAssumption,
  HarvestPriceEstimate, ProgramYearConfig,
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
  const [staxes, setStaxes] = useState<CropInsuranceStax[]>([])
  const [mcos, setMcos] = useState<CropInsuranceMco[]>([])
  const [countyAssumptions, setCountyAssumptions] = useState<CountyYieldAssumption[]>([])
  const [priceEstimates, setPriceEstimates] = useState<HarvestPriceEstimate[]>([])
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])
  // Live Barchart estimate keyed by crop_id (from /api/harvest-price-estimate).
  const [liveEstimates, setLiveEstimates] = useState<Map<string, { price: number; label: string | null; stale: boolean; priceDate: string | null }>>(new Map())
  const [priceNote, setPriceNote] = useState<string | null>(null)

  const [cropYear, setCropYear] = usePersistentState<number | ''>('ci-claims:cropYear', '')
  const [entityId, setEntityId] = usePersistentState('ci-claims:entityId', '')

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    ;(async () => {
      const [cr, co, en, ca, pl, ld, po, sc, ec, hpe, pgc, sx, mc, cya] = await Promise.all([
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
        supabase.from('crop_insurance_stax').select('*'),
        supabase.from('crop_insurance_mco').select('*'),
        supabase.from('county_yield_assumptions').select('*'),
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
      setStaxes((sx.data as CropInsuranceStax[]) || [])
      setMcos((mc.data as CropInsuranceMco[]) || [])
      setCountyAssumptions((cya.data as CountyYieldAssumption[]) || [])
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

  // Crop-level actual yield (Σ dry bu / Σ planted ac) — shared resolver so this
  // matches the Cash Flow's safety-net exactly.
  const actualYieldByCrop = useMemo(
    () => (cropYear === '' ? new Map<string, number>() : actualYieldByCropFromLoads({ loads, plantings, crops, cropYear })),
    [loads, plantings, crops, cropYear],
  )

  // Today's live Barchart estimate per crop_id, for the shared resolver.
  const liveHarvestByCrop = useMemo(() => {
    const m = new Map<string, LiveHarvest>()
    for (const [id, e] of liveEstimates) m.set(id, { price: e.price, stale: e.stale, priceDate: e.priceDate })
    return m
  }, [liveEstimates])

  // Per-crop harvest resolution for DISPLAY (the table's Harvest $ column). The
  // actual indemnity math goes through projectInsuranceIndemnities below, which
  // resolves the same way — this just adds the futures-contract label.
  const harvestByCrop = useMemo(() => {
    if (cropYear === '') return new Map<string, HarvestInfo>()
    const resolved = resolveHarvestPriceByCrop({ cropIds: reportCropIds, cropYear, policies: yearPolicies, estimates: priceEstimates, liveByCrop: liveHarvestByCrop, crops })
    const m = new Map<string, HarvestInfo>()
    for (const [cropId, h] of resolved) {
      m.set(cropId, { price: h.price, isFinal: h.source === 'final', label: harvestContractLabel(cropById.get(cropId)?.name, cropYear), source: h.source, stale: h.stale, priceDate: h.priceDate })
    }
    return m
  }, [reportCropIds, cropYear, yearPolicies, priceEstimates, liveHarvestByCrop, cropById, crops])

  // Per-year program parameters (SCO trigger), with most-recent-year fallback.
  const programCfg = useMemo(
    () => resolveProgramYearConfig(cropYear === '' ? new Date().getFullYear() : cropYear, programConfigs),
    [cropYear, programConfigs],
  )
  const programNotice = cropYear === '' ? null : programConfigNotice(programCfg)

  type Computed = { policy: CropInsurancePolicy; comp: PolicyComputation; harvest: HarvestInfo | undefined; assumedYield: number; base: PolicyInputs; sco: ScoConfig | null; eco: EcoConfig | null; basePremium: number }
  const computed: Computed[] = useMemo(() => {
    if (cropYear === '') return []
    // Single source of truth shared with the Cash Flow safety-net so the two
    // pages' projected indemnity reconciles.
    const projected = projectInsuranceIndemnities({
      cropYear, policies: yearPolicies, scos, ecos, staxes, mcos, countyAssumptions, assumptions, plantings,
      actualYieldByCrop, harvestEstimates: priceEstimates, liveHarvestByCrop, crops,
      scoTrigger: programCfg.scoTrigger,
    })
    return projected.map((r) => ({
      policy: r.policy, comp: r.comp, harvest: harvestByCrop.get(r.policy.crop_id),
      assumedYield: r.assumedYield, base: r.base, sco: r.sco, eco: r.eco, basePremium: r.basePremium,
    }))
  }, [cropYear, yearPolicies, scos, ecos, staxes, mcos, countyAssumptions, assumptions, plantings, actualYieldByCrop, priceEstimates, liveHarvestByCrop, crops, programCfg, harvestByCrop])

  const totals = useMemo(() => {
    return computed.reduce(
      (a, c) => ({
        acres: a.acres + Number(c.policy.insured_acres),
        revenueGuarantee: a.revenueGuarantee + c.comp.base.revenueGuarantee,
        expectedRevenue: a.expectedRevenue + c.comp.base.expectedRevenue,
        baseIndemnity: a.baseIndemnity + c.comp.base.indemnity,
        scoIndemnity: a.scoIndemnity + (c.comp.sco?.indemnity ?? 0),
        ecoIndemnity: a.ecoIndemnity + (c.comp.eco?.indemnity ?? 0),
        staxMcoIndemnity: a.staxMcoIndemnity + (c.comp.stax?.indemnity ?? 0) + (c.comp.mco?.indemnity ?? 0),
        totalIndemnity: a.totalIndemnity + c.comp.totalIndemnity,
        premium: a.premium + c.comp.premiumPaid,
        netPnl: a.netPnl + c.comp.netPnl,
      }),
      { acres: 0, revenueGuarantee: 0, expectedRevenue: 0, baseIndemnity: 0, scoIndemnity: 0, ecoIndemnity: 0, staxMcoIndemnity: 0, totalIndemnity: 0, premium: 0, netPnl: 0 },
    )
  }, [computed])

  // Group the (crop-sorted) policies by crop so a crop with both an irrigated and
  // a dryland policy shows a per-crop subtotal under its rows.
  type CropSub = { acres: number; revenueGuarantee: number; expectedRevenue: number; baseIndemnity: number; scoIndemnity: number; ecoIndemnity: number; staxMcoIndemnity: number; totalIndemnity: number; premium: number; netPnl: number }
  const subOf = (rows: Computed[]): CropSub => rows.reduce((a, c) => ({
    acres: a.acres + Number(c.policy.insured_acres),
    revenueGuarantee: a.revenueGuarantee + c.comp.base.revenueGuarantee,
    expectedRevenue: a.expectedRevenue + c.comp.base.expectedRevenue,
    baseIndemnity: a.baseIndemnity + c.comp.base.indemnity,
    scoIndemnity: a.scoIndemnity + (c.comp.sco?.indemnity ?? 0),
    ecoIndemnity: a.ecoIndemnity + (c.comp.eco?.indemnity ?? 0),
    staxMcoIndemnity: a.staxMcoIndemnity + (c.comp.stax?.indemnity ?? 0) + (c.comp.mco?.indemnity ?? 0),
    totalIndemnity: a.totalIndemnity + c.comp.totalIndemnity,
    premium: a.premium + c.comp.premiumPaid,
    netPnl: a.netPnl + c.comp.netPnl,
  }), { acres: 0, revenueGuarantee: 0, expectedRevenue: 0, baseIndemnity: 0, scoIndemnity: 0, ecoIndemnity: 0, staxMcoIndemnity: 0, totalIndemnity: 0, premium: 0, netPnl: 0 })
  const cropGroups = useMemo(() => {
    const groups: { cropId: string; rows: Computed[] }[] = []
    for (const c of computed) {
      const last = groups[groups.length - 1]
      if (last && last.cropId === c.policy.crop_id) last.rows.push(c)
      else groups.push({ cropId: c.policy.crop_id, rows: [c] })
    }
    return groups
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
    const filters = [`Crop year: ${cropYear || '—'}`, entityName ? `Entity: ${entityName}` : 'All entities'].join(' · ')
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: 'Estimated Indemnity by Policy',
      columns: [
        { label: 'Crop' }, { label: 'County' }, { label: 'Plan' }, { label: 'Practice' }, { label: 'Coverage', align: 'right', format: 'pct0' },
        { label: 'APH', align: 'right', format: 'yield' }, { label: 'Proj $', align: 'right', format: 'price' }, { label: 'Harvest $', align: 'right', format: 'price' },
        { label: 'Assumed Yld', align: 'right', format: 'yield' }, { label: 'Acres', align: 'right', format: 'acres' },
        { label: 'Revenue Guarantee', align: 'right', format: 'usd0' }, { label: 'Expected Revenue', align: 'right', format: 'usd0' },
        { label: 'Base Indemnity', align: 'right', format: 'usd0' }, { label: 'SCO', align: 'right', format: 'usd0' }, { label: 'ECO', align: 'right', format: 'usd0' },
        { label: 'STAX/MCO', align: 'right', format: 'usd0' },
        { label: 'Total Indemnity', align: 'right', format: 'usd0' }, { label: 'Premium Paid', align: 'right', format: 'usd0' }, { label: 'Net Ins. P&L', align: 'right', format: 'usd0' },
      ],
      rows: computed.map((c) => [
        cropName(c.policy.crop_id), countyName(c.policy.county_id),
        isAreaPlan(c.policy.plan_type) ? `${PLAN_TYPE_SHORT[c.policy.plan_type]} (county-triggered)` : PLAN_TYPE_SHORT[c.policy.plan_type],
        PRACTICE_LABEL[c.policy.practice ?? 'non_irrigated'],
        Math.round(Number(c.policy.coverage_level) * 100), isAreaPlan(c.policy.plan_type) ? '' : Number(c.policy.aph_yield), Number(c.policy.projected_price),
        Number((c.harvest?.price ?? 0).toFixed(4)), isAreaPlan(c.policy.plan_type) ? '' : Number(c.assumedYield.toFixed(1)), Number(c.policy.insured_acres),
        Math.round(c.comp.base.revenueGuarantee), Math.round(c.comp.base.expectedRevenue), Math.round(c.comp.base.indemnity),
        Math.round(c.comp.sco?.indemnity ?? 0), Math.round(c.comp.eco?.indemnity ?? 0),
        Math.round((c.comp.stax?.indemnity ?? 0) + (c.comp.mco?.indemnity ?? 0)),
        Math.round(c.comp.totalIndemnity), Math.round(c.comp.premiumPaid), Math.round(c.comp.netPnl),
      ]),
      rowMeta: computed.map(() => 'data' as const),
    })
    // Totals as a final 'total' row appended to the same section.
    sections[0].rows.push([
      'Total', '', '', '', '', '', '', '', '', Math.round(totals.acres),
      Math.round(totals.revenueGuarantee), Math.round(totals.expectedRevenue), Math.round(totals.baseIndemnity),
      Math.round(totals.scoIndemnity), Math.round(totals.ecoIndemnity), Math.round(totals.staxMcoIndemnity), Math.round(totals.totalIndemnity),
      Math.round(totals.premium), Math.round(totals.netPnl),
    ])
    sections[0].rowMeta!.push('total')
    return {
      title: 'Crop Insurance Claims Monitor',
      filters,
      summary: [
        { label: 'Total Indemnity', value: formatNumber(totals.totalIndemnity, 'usd0'), tone: totals.totalIndemnity > 0 ? 'favorable' : 'muted' },
        { label: 'Premium Paid', value: formatNumber(totals.premium, 'usd0') },
        { label: 'Net Ins. P&L', value: formatNumber(totals.netPnl, 'usd0'), tone: signedTone(totals.netPnl) },
        { label: 'Insured Acres', value: formatNumber(totals.acres, 'acres') },
      ],
      sections,
    }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, totals, cropYear, entityId, onPayloadChange])

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
        <div className="ml-auto self-end flex flex-wrap gap-2">
          <Link
            href="/reports/income-sensitivity"
            className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Scenario analysis: Income Sensitivity →
          </Link>
          <Link
            href="/settings/crop-insurance#coverage-check"
            className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Coverage Check: insured vs planted acres →
          </Link>
        </div>
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
            determined by RMA after harvest.{priceNote ? ` ${priceNote}` : ''} For price and yield scenarios, use the{' '}
            <Link href="/reports/income-sensitivity" className="underline font-semibold">Income Sensitivity Report</Link>.
          </div>

          <SummaryCards cards={summaryCards} />

          {computed.some((c) => c.comp.warnings.length > 0) && (
            <div className="rounded-lg bg-red-50 border border-red-300 px-3 py-2 text-sm text-red-900">
              <strong>Check price units:</strong> the computed indemnity on{' '}
              {computed.filter((c) => c.comp.warnings.length > 0).map((c) => `${cropName(c.policy.crop_id)} (${countyName(c.policy.county_id)})`).join(', ')}{' '}
              is implausibly large — this usually means a ¢/lb price is stored where the policy expects $/lb
              (cotton insurance prices are dollars, e.g. 0.68). Review the policy&apos;s projected/harvest price
              under Settings → Crop Insurance.
            </div>
          )}

          {(() => {
            const warnings = stackingWarnings({
              policies: yearPolicies,
              ecoPolicyIds: new Set(ecos.map((e) => e.policy_id)),
              staxPolicyIds: new Set(staxes.map((s) => s.policy_id)),
              mcoPolicyIds: new Set(mcos.map((m) => m.policy_id)),
              cropName: (id) => cropById.get(id)?.name ?? 'crop',
            })
            const hasStax = yearPolicies.some((p) => staxes.some((s) => s.policy_id === p.id))
            return warnings.length > 0 || hasStax ? (
              <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-900 space-y-0.5 no-print">
                <div className="font-semibold">Stacking review (warnings only — your agent is the authority):</div>
                {warnings.map((w) => <div key={w.key}>· {w.message}</div>)}
                {yearPolicies.some((p) => staxes.some((s) => s.policy_id === p.id)) && (
                  <div>· {staxArcPlcWarning({ staxCount: 1, seedCottonEnrolled: true })}</div>
                )}
              </div>
            ) : null
          })()}

          {/* Unified county-yield assumptions (045): drives every county-
              triggered leg (SCO/ECO/STAX/ARP/AYP/MCO). Separate from ARC-CO. */}
          <div className="bg-white rounded-xl shadow px-4 py-3 no-print space-y-1">
            <div className="text-sm font-semibold">County yield assumptions (insurance — separate from the ARC-CO expectation)</div>
            {Array.from(new Map(yearPolicies.map((p) => [`${p.crop_id}|${p.county_id ?? ''}`, p])).values()).map((p) => (
              <div key={`${p.crop_id}|${p.county_id ?? ''}`} className="flex items-center gap-2 flex-wrap text-sm">
                <span className="font-medium w-56 truncate">{cropName(p.crop_id)} · {countyName(p.county_id)}</span>
                <CountyAssumptionControl
                  cropId={p.crop_id}
                  countyId={p.county_id}
                  cropYear={cropYear as number}
                  assumption={countyAssumptions.find((a) => a.crop_id === p.crop_id && a.crop_year === cropYear && (a.county_id ?? '') === (p.county_id ?? '')) ?? null}
                  compact
                  onChanged={async () => {
                    const { data } = await supabase.from('county_yield_assumptions').select('*')
                    setCountyAssumptions((data as CountyYieldAssumption[]) || [])
                  }}
                />
              </div>
            ))}
          </div>

          {/* Summary table */}
          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">Estimated Indemnity by Policy — {cropYear}</h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  {['Crop', 'County', 'Plan', 'Practice', 'Cov', 'APH', 'Proj $', 'Harvest $', 'Assumed Yld', 'Acres',
                    'Rev. Guarantee', 'Exp. Revenue', 'Base Indemnity', 'SCO', 'ECO', 'STAX/MCO', 'Total Indemnity', 'Premium', 'Net Ins. P&L', ''].map((h) => (
                    <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cropGroups.map((g) => {
                  const sub = subOf(g.rows)
                  return (
                  <Fragment key={g.cropId}>
                  {g.rows.map((c) => {
                  const p = c.policy
                  return (
                    <tr key={p.id} className="border-t border-slate-100 align-middle">
                      <td className="px-2 py-1 font-semibold whitespace-nowrap">{cropName(p.crop_id)}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{countyName(p.county_id)}</td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {PLAN_TYPE_SHORT[p.plan_type]}
                        {isAreaPlan(p.plan_type) && (
                          <span className="block text-[10px] text-indigo-700 leading-tight" title="Indemnity comes entirely from the estimated county yield/revenue vs the trigger.">
                            county-triggered — farm yield not used
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">{PRACTICE_LABEL[p.practice ?? 'non_irrigated']}</td>
                      <td className="px-2 py-1 text-right">{Math.round(Number(p.coverage_level) * 100)}%</td>
                      <td className="px-2 py-1 text-right tabular-nums">{isAreaPlan(p.plan_type) ? '—' : Number(p.aph_yield).toFixed(1)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtPrice(p.projected_price)}</td>
                      <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{harvestLabel(c.harvest)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{isAreaPlan(p.plan_type) ? '—' : c.assumedYield.toFixed(1)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{bu(Number(p.insured_acres))}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(c.comp.base.revenueGuarantee)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(c.comp.base.expectedRevenue)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(c.comp.base.indemnity))}`}>{usd(c.comp.base.indemnity)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${c.comp.sco ? toneText(signedTone(c.comp.sco.indemnity)) : toneText('muted')}`}>{c.comp.sco ? usd(c.comp.sco.indemnity) : 'N/A'}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${c.comp.eco ? toneText(signedTone(c.comp.eco.indemnity)) : toneText('muted')}`}>{c.comp.eco ? usd(c.comp.eco.indemnity) : 'N/A'}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${(c.comp.stax || c.comp.mco) ? toneText(signedTone((c.comp.stax?.indemnity ?? 0) + (c.comp.mco?.indemnity ?? 0))) : toneText('muted')}`}>
                        {(c.comp.stax || c.comp.mco) ? usd((c.comp.stax?.indemnity ?? 0) + (c.comp.mco?.indemnity ?? 0)) : 'N/A'}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums font-semibold ${c.comp.warnings.length > 0 ? 'text-red-700' : toneText(signedTone(c.comp.totalIndemnity))}`}>
                        {c.comp.warnings.length > 0 && (
                          <span title={c.comp.warnings.join(' ')} className="mr-1 cursor-help">⚠</span>
                        )}
                        {usd(c.comp.totalIndemnity)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(c.comp.premiumPaid)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums font-bold ${pnlClass(c.comp.netPnl, c.comp.premiumPaid)}`}>{usd(c.comp.netPnl)}</td>
                      <td className="px-2 py-1 no-print">
                        <button onClick={() => toggle(p.id)} className="text-sky-700 text-xs whitespace-nowrap">{expanded.has(p.id) ? 'Hide' : 'Detail'}</button>
                      </td>
                    </tr>
                  )
                  })}
                  {g.rows.length > 1 && (
                    <tr className="bg-slate-50 font-semibold border-t border-slate-200">
                      <td className="px-2 py-1" colSpan={9}>{cropName(g.cropId)} subtotal</td>
                      <td className="px-2 py-1 text-right tabular-nums">{bu(sub.acres)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(sub.revenueGuarantee)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(sub.expectedRevenue)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(sub.baseIndemnity))}`}>{usd(sub.baseIndemnity)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(sub.scoIndemnity))}`}>{usd(sub.scoIndemnity)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(sub.ecoIndemnity))}`}>{usd(sub.ecoIndemnity)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(sub.staxMcoIndemnity))}`}>{usd(sub.staxMcoIndemnity)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(sub.totalIndemnity))}`}>{usd(sub.totalIndemnity)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd(sub.premium)}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${pnlClass(sub.netPnl, sub.premium)}`}>{usd(sub.netPnl)}</td>
                      <td className="no-print" />
                    </tr>
                  )}
                  </Fragment>
                  )
                })}
                <tr className={grandTotalRowCls}>
                  <td className="px-2 py-1" colSpan={9}>Total</td>
                  <td className="px-2 py-1 text-right tabular-nums">{bu(totals.acres)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{usd(totals.revenueGuarantee)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{usd(totals.expectedRevenue)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.baseIndemnity))}`}>{usd(totals.baseIndemnity)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.scoIndemnity))}`}>{usd(totals.scoIndemnity)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.ecoIndemnity))}`}>{usd(totals.ecoIndemnity)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${toneText(signedTone(totals.staxMcoIndemnity))}`}>{usd(totals.staxMcoIndemnity)}</td>
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
              sensitivity={sensitivityTable({ base: c.base, basePremium: c.basePremium, sco: c.sco, eco: c.eco })}
            />
          ))}
        </>
      )}
    </div>
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
      <h3 className="font-bold">{cropName} · {countyName} · {PRACTICE_LABEL[p.practice ?? 'non_irrigated']} · {PLAN_TYPE_SHORT[p.plan_type]} {Math.round(cov * 100)}% — calculation</h3>

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
