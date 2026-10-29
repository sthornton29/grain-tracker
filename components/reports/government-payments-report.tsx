'use client'

// Government Payments tracker. For a crop year: one row per farm with a column
// per covered commodity (base acres + election + projected net payment), the
// farm's other USDA payments, and a grand total — plus per-entity payment-limit
// status and an expandable per-farm calculation breakdown. ARC-CO rows run the
// same county-revenue engine as the Decision Aid (shared projectPayments /
// computeCommodityPayment — the two pages agree to the cent), with a badge
// when the payment-rate cap binds.
//
// 0099: RECEIVED vs PROJECTED. The ARC/PLC payments read off FSA Payment
// Statements (fsa_payment_lines + crop amounts) lay over the projections
// through lib/fsa-actuals (one seam, no double counting): a KPI strip for the
// program year in view, Projected | Received | Both on the matrix and the
// per-farm table, a status per farm × commodity, and the variance explained
// (implied rate vs projected rate, attributed to RATE / ACRES-YIELD /
// SEQUESTER / PROGRAM). Entities resolve through lib/program-payee
// payeeEntityFor — the payee for THAT program year, not the farm's current
// entity. A Statements tab lists what was uploaded (with calendar-year totals
// per payee for 1099-G reconciliation) and an Upload tab reads a new one.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useReportCropYear } from '@/lib/report-filters'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { useLiveMyaDetailed } from '@/lib/use-live-mya'
import { fetchAllCounties } from '@/lib/counties'
import EntityFilter from '@/components/entity-filter'
import MyaPricePanel from '@/components/reports/mya-price-panel'
import CountyYieldExpectation from '@/components/government/county-yield-expectation'
import FsaPaymentStatementImport from '@/components/government/fsa-payment-statement-import'
import { SegmentedChips } from '@/components/reports/chip-select'
import {
  projectPayments, applyMyaResolution, ELECTION_LABEL, paymentLimitTotal, effectiveReferencePrice,
  programYearFor, revenueCropYearFor, otherPaymentsInRevenueYear, suspectProgramYearEntries,
  type ProjectedPayment,
} from '@/lib/government-payments'
import { resolveProgramYearConfig, programConfigNotice, paysHigherOf, type ResolvedProgramConfig } from '@/lib/program-config'
import { fetchGovernmentActuals, EMPTY_GOVERNMENT_ACTUALS, type GovernmentActuals } from '@/lib/fsa-actuals-fetch'
import {
  receivedArcPlc, mergeProjectedWithReceived, receivedKpis, calendarYearTotals,
  RECEIVED_STATUS_LABEL, VARIANCE_CAUSE_LABEL, type ReceivedVsProjected,
} from '@/lib/fsa-actuals'
import { indexPayees, farmsAsPayees, hasExplicitPayee } from '@/lib/program-payee'
import { PROGRAM_CODE_LABEL } from '@/lib/fsa-payment-statement'
import { fmtPrice } from '@/lib/hedging'
import { fmtDate } from '@/lib/format-date'
import {
  SummaryCards, EmptyState, ReportHeader, ReportFilterBar, FilterField, Disclosure, InfoTip, ViewTabs,
  theadCls, grandTotalRowCls, stickyColCls, stickyColHeadCls, selectCls, toneText, fmtUsd, fmtInt, fmtNum, fmtPct, filterSummaryOf,
  type SummaryCardData, type Tone,
} from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload, type ExportCell, type ExportColumn, type ExportSection, type NumFmt } from '@/lib/exports'
import { col, exactCriterion, self, sub, sumifs, type FormulaNode } from '@/lib/formula'
import type {
  Farm, Entity, County, Crop, FieldPlanting, CoveredCommodity, FarmBaseAcres, ArcPlcElection,
  ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment, ProgramYearConfig,
  ArcBenchmarkData, MyaMonthlyPrice,
} from '@/lib/types'

type Props = {
  onPayloadChange?: (build: () => ExportPayload) => void
  /** Rendered in the report header's action slot (the page passes <ExportBar/>). */
  headerActions?: ReactNode
}

type View = 'projected' | 'received' | 'both'
type Tab = 'tracker' | 'statements' | 'upload'

const input = (v: number | string | null, format?: NumFmt): ExportCell => ({ v, input: true, format })
const formula = (f: FormulaNode, format?: NumFmt): ExportCell => ({ v: null, f, format })
const SECTION = { statements: 'statements', lines: 'lines', crops: 'crops', rvp: 'rvp' } as const

/** The acres the implied rate ran on: the farm's base, × the producer's share on a share-rent farm. */
function acresText(v: ReceivedVsProjected): string {
  return v.producerShare !== 1 ? `${fmtInt(v.baseAcres)} ac × ${Math.round(v.producerShare * 100)}% share` : `${fmtInt(v.baseAcres)} ac`
}

function varianceTone(v: number | null | undefined): Tone {
  if (v == null) return 'muted'
  if (Math.abs(v) < 0.5) return 'neutral'
  return v > 0 ? 'favorable' : 'unfavorable'
}

export default function GovernmentPaymentsReport({ onPayloadChange, headerActions }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [farms, setFarms] = useState<Farm[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [commodities, setCommodities] = useState<CoveredCommodity[]>([])
  const [baseAcres, setBaseAcres] = useState<FarmBaseAcres[]>([])
  const [elections, setElections] = useState<ArcPlcElection[]>([])
  const [priceData, setPriceData] = useState<ArcPlcPriceData[]>([])
  const [payments, setPayments] = useState<ArcPlcPayment[]>([])
  const [otherPayments, setOtherPayments] = useState<OtherGovernmentPayment[]>([])
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [benchmarks, setBenchmarks] = useState<ArcBenchmarkData[]>([])
  const [monthlyPrices, setMonthlyPrices] = useState<MyaMonthlyPrice[]>([])
  const [actuals, setActuals] = useState<GovernmentActuals>(EMPTY_GOVERNMENT_ACTUALS)
  // Crop year: current year by default, persisted, never overwritten on load
  // (lib/report-filters). The option list always carries the current year.
  const [cropYear, setCropYear] = useReportCropYear('gov-pay:cropYear')
  const [entityId, setEntityId] = usePersistentState('gov-pay:entity', '')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Year framing: 'payment' (default) = the selected year is the crop year the
  // payments are RECEIVED in (program year = Y−1, paid Oct Y); 'program' = the
  // selected year is the FSA program year (paid Oct Y+1) — for reconciliation.
  const [yearBasis, setYearBasis] = usePersistentState<'payment' | 'program'>('gov-pay:yearBasis', 'payment')
  const [suspectNoteDismissed, setSuspectNoteDismissed] = usePersistentState('gov-pay:program-year-note-dismissed', false)
  const [view, setView] = usePersistentState<View>('gov-pay:view', 'both')
  const [tab, setTab] = usePersistentState<Tab>('gov-pay:tab', 'tracker')

  // The two derived years — the math is ALWAYS keyed to programYear, the
  // other-payment pool and labels to paymentYear (= programYear + 1).
  const programYear: number | '' = cropYear === '' ? '' : yearBasis === 'payment' ? programYearFor(cropYear) : cropYear
  const paymentYear: number | '' = cropYear === '' ? '' : yearBasis === 'payment' ? cropYear : revenueCropYearFor(cropYear)

  // Switching the basis keeps the year the user picked (the number never
  // shifts under them); only the label and the math's framing change.
  function switchBasis(b: 'payment' | 'program') {
    if (b === yearBasis) return
    setYearBasis(b)
  }

  const refreshActuals = useCallback(async () => {
    const [a, op, pc] = await Promise.all([
      fetchGovernmentActuals(supabase),
      fetchAllRows((f, t) => supabase.from('other_government_payments').select('*').order('id').range(f, t)),
      supabase.from('program_year_config').select('*'),
    ])
    setActuals(a)
    setOtherPayments((op.data as OtherGovernmentPayment[]) || [])
    setProgramConfigs((pc.data as ProgramYearConfig[]) || [])
  }, [supabase])

  useEffect(() => {
    ;(async () => {
      const [fa, en, cr, pl, cc, ba, el, pd, pay, op, pc, co, bm, mp, ac] = await Promise.all([
        supabase.from('farms').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('field_plantings').select('*').order('id').range(f, t)),
        supabase.from('covered_commodities').select('*').order('name'),
        supabase.from('farm_base_acres').select('*'),
        supabase.from('arc_plc_elections').select('*'),
        supabase.from('arc_plc_price_data').select('*'),
        fetchAllRows((f, t) => supabase.from('arc_plc_payments').select('*').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('other_government_payments').select('*').order('id').range(f, t)),
        supabase.from('program_year_config').select('*'),
        fetchAllCounties(supabase),
        supabase.from('arc_benchmark_data').select('*'),
        supabase.from('mya_monthly_prices').select('*'),
        fetchGovernmentActuals(supabase),
      ])
      setFarms((fa.data as Farm[]) || [])
      setEntities((en.data as Entity[]) || [])
      setCrops((cr.data as Crop[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setCommodities((cc.data as CoveredCommodity[]) || [])
      setBaseAcres((ba.data as FarmBaseAcres[]) || [])
      setElections((el.data as ArcPlcElection[]) || [])
      setPriceData((pd.data as ArcPlcPriceData[]) || [])
      setPayments((pay.data as ArcPlcPayment[]) || [])
      setOtherPayments((op.data as OtherGovernmentPayment[]) || [])
      setProgramConfigs((pc.data as ProgramYearConfig[]) || [])
      setCounties(co || [])
      setBenchmarks((bm.data as ArcBenchmarkData[]) || [])
      setMonthlyPrices((mp.data as MyaMonthlyPrice[]) || [])
      setActuals(ac)
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  // Viewer role (052): RLS already row-filters the data; here the grants only
  // limit the entity dropdown and name the granted entities on the export.
  const viewer = useViewerScope(supabase)

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const commodityById = useMemo(() => new Map(commodities.map((c) => [c.id, c])), [commodities])
  const cropYearOptions = useMemo(() => {
    const base = [...plantings.map((p) => p.season_year), ...elections.map((e) => e.crop_year), ...actuals.lines.map((l) => l.program_year ?? 0).filter(Boolean), new Date().getFullYear()]
    // Payment-year basis also needs each program year's payment year (+1) in
    // the list — e.g. 2025 elections mean 2026 payments.
    const years = yearBasis === 'payment' ? [...base, ...elections.map((e) => revenueCropYearFor(e.crop_year)), ...actuals.lines.map((l) => (l.program_year ? revenueCropYearFor(l.program_year) : 0)).filter(Boolean)] : base
    return cropYearOptionsFromPlantings(years, cropYear === '' ? null : cropYear)
  }, [plantings, elections, actuals.lines, cropYear, yearBasis])

  // Live MYA estimates for the PROGRAM year — the marketing-year blend (shared
  // hook — resets on year change so a failed refetch never leaves another
  // year's prices in play).
  const { prices: liveMya, details: liveDetails, refresh: refreshEstimates } = useLiveMyaDetailed(programYear, commodities)

  // Stored price data with the SHARED per-commodity MYA resolution applied
  // (manual override > published final > WASDE > live/stored estimate) — the
  // same function the Decision Aid reads, so both pages project the same
  // payments. Keyed to the PROGRAM year: that's what drives the math.
  const effectivePriceData = useMemo(() => {
    if (programYear === '') return priceData
    return applyMyaResolution({ cropYear: programYear, commodities, priceData, liveEstimates: liveMya })
  }, [priceData, liveMya, programYear, commodities])

  // Refetch price/benchmark/monthly data after an MYA toggle, monthly edit, or
  // county-yield change so every projection on the page updates live.
  async function refreshPriceData() {
    const [{ data }, { data: bm }, { data: mp }] = await Promise.all([
      supabase.from('arc_plc_price_data').select('*'),
      supabase.from('arc_benchmark_data').select('*'),
      supabase.from('mya_monthly_prices').select('*'),
    ])
    setPriceData((data as ArcPlcPriceData[]) || [])
    setBenchmarks((bm as ArcBenchmarkData[]) || [])
    setMonthlyPrices((mp as MyaMonthlyPrice[]) || [])
  }

  // Resolve per-year program parameters (sequestration %, per-person limit,
  // ARC guarantee/cap %, payment factors), falling back to the most recent
  // configured year when this one is missing.
  const programCfg = useMemo(
    () => resolveProgramYearConfig(programYear === '' ? new Date().getFullYear() : programYear, programConfigs),
    [programYear, programConfigs],
  )
  const programNotice = programYear === '' ? null : programConfigNotice(programCfg)

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  // county_id is what disambiguates same-named counties across states; the
  // name rides along as the fallback for legacy benchmark rows.
  const farmCountyList = useMemo(
    () => farms.map((f) => ({
      id: f.id,
      county: f.county_id ? (countyById.get(f.county_id)?.name ?? null) : null,
      county_id: f.county_id ?? null,
      is_share_rent: f.is_share_rent,
      landlord_share_percentage: f.landlord_share_percentage,
    })),
    [farms, countyById],
  )

  // 0099: the farms re-keyed to the PROGRAM year's payee (explicit row wins,
  // else farms.entity_id) — every entity read below goes through this list.
  const payeeIdx = useMemo(() => indexPayees(actuals.payees), [actuals.payees])
  const payeeFarms: Farm[] = useMemo(
    () => (programYear === '' ? farms : farmsAsPayees(farms, programYear, payeeIdx) as Farm[]),
    [farms, programYear, payeeIdx],
  )
  const payeeFarmById = useMemo(() => new Map(payeeFarms.map((f) => [f.id, f])), [payeeFarms])
  const payeeEntityName = (farmId: string) => {
    const f = payeeFarmById.get(farmId)
    return f?.entity_id ? entityById.get(f.entity_id)?.name ?? '—' : '—'
  }

  // Project all farm × commodity payments for the PROGRAM year — same engine
  // and same inputs as the Decision Aid. The payment lands in October of
  // programYear + 1 (the payment year shown in the header).
  const projected: ProjectedPayment[] = useMemo(() => {
    if (programYear === '') return []
    return projectPayments({
      cropYear: programYear, baseAcres, commodities, elections, priceData: effectivePriceData, payments,
      benchmarks, farms: farmCountyList,
      sequestrationPct: programCfg.sequestrationPct,
      paymentFactor: programCfg.paymentFactor,
      arcGuaranteePct: programCfg.arcGuaranteePct,
      arcPaymentCapPct: programCfg.arcPaymentCapPct,
      arcIcPaymentFactor: programCfg.arcIcPaymentFactor,
    })
  }, [programYear, baseAcres, commodities, elections, effectivePriceData, payments, benchmarks, farmCountyList, programCfg])

  // 0099: the actuals for the program year laid over the projections.
  const received = useMemo(() => receivedArcPlc({ lines: actuals.lines, cropAmounts: actuals.cropAmounts }), [actuals])
  const rvpRows: ReceivedVsProjected[] = useMemo(() => {
    if (programYear === '') return []
    const maxPlc = new Map<string, number>()
    for (const c of commodities) {
      const pd = effectivePriceData.find((p) => p.commodity_id === c.id && p.crop_year === programYear) ?? null
      maxPlc.set(c.id, Math.max(0, effectiveReferencePrice(c, pd) - Number(c.national_loan_rate)))
    }
    return mergeProjectedWithReceived({
      programYear, projected, received, sequesterPct: programCfg.sequestrationPct, paymentFactor: programCfg.paymentFactor,
      maxPlcRateByCommodity: maxPlc,
      countyByFarm: new Map(farms.map((f) => [f.id, f.county_id ?? null])),
      statementsExist: actuals.lines.some((l) => l.program_year === programYear && l.program_code !== 'OTHER'),
    })
  }, [programYear, projected, received, programCfg, commodities, effectivePriceData, actuals.lines, farms])
  const rvpByKey = useMemo(() => new Map(rvpRows.map((r) => [`${r.farmId}|${r.commodityId}`, r])), [rvpRows])
  const anyReceived = useMemo(() => rvpRows.some((r) => r.received != null), [rvpRows])
  // Statements that pay the program year in view, newest first.
  const yearStatements = useMemo(() => {
    if (programYear === '') return []
    const ids = new Set(actuals.lines.filter((l) => l.program_year === programYear).map((l) => l.statement_id))
    return actuals.statements.filter((s) => ids.has(s.id)).sort((a, b) => b.statement_date.localeCompare(a.statement_date))
  }, [actuals, programYear])

  // Only eligible (assigned) base drives the payment columns; unassigned base is
  // excluded from this report entirely.
  const eligibleBase = useMemo(() => baseAcres.filter((b) => !b.is_unassigned && b.commodity_id), [baseAcres])

  // Commodities with eligible base on any farm, plus any paid with no base row.
  const shownCommodities = useMemo(() => {
    const ids = new Set(eligibleBase.map((b) => b.commodity_id))
    for (const r of rvpRows) ids.add(r.commodityId)
    return commodities.filter((c) => ids.has(c.id))
  }, [eligibleBase, commodities, rvpRows])

  // Farms with eligible base acres or a received payment, scoped to the
  // selected entity THROUGH THE PROGRAM-YEAR PAYEE.
  const shownFarms = useMemo(() => {
    const ids = new Set(eligibleBase.map((b) => b.farm_id))
    for (const r of rvpRows) ids.add(r.farmId)
    return payeeFarms.filter((f) => ids.has(f.id) && (!entityId || f.entity_id === entityId)).sort((a, b) => a.name.localeCompare(b.name))
  }, [payeeFarms, eligibleBase, rvpRows, entityId])

  // (farmId|commodityId) -> projected payment.
  const projByKey = useMemo(() => new Map(projected.map((p) => [`${p.farmId}|${p.commodityId}`, p])), [projected])

  // Other USDA payments landing in the PAYMENT year (payment-date year, else
  // crop_year — which for manual entries means the year received).
  const yearOther = useMemo(
    () => (paymentYear === '' ? [] : otherPaymentsInRevenueYear(otherPayments, paymentYear)),
    [otherPayments, paymentYear],
  )
  // One-time review note: entries that look like OLD program-year semantics.
  const suspects = useMemo(() => suspectProgramYearEntries(otherPayments), [otherPayments])
  const otherByFarm = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of yearOther) if (o.farm_id) m.set(o.farm_id, (m.get(o.farm_id) ?? 0) + Number(o.amount))
    return m
  }, [yearOther])
  const nonFarmOther = useMemo(() => yearOther.filter((o) => !o.farm_id).reduce((s, o) => s + Number(o.amount), 0), [yearOther])

  type FarmRow = {
    farm: Farm
    arcPlcTotal: number
    receivedTotal: number | null
    effectiveTotal: number
    other: number
    total: number
    byCommodity: Map<string, ProjectedPayment>
    rvpByCommodity: Map<string, ReceivedVsProjected>
  }
  const farmRows: FarmRow[] = useMemo(() => {
    return shownFarms.map((farm) => {
      const byCommodity = new Map<string, ProjectedPayment>()
      const rvpByCommodity = new Map<string, ReceivedVsProjected>()
      let arcPlcTotal = 0, effectiveTotal = 0, receivedTotal = 0, anyPaid = false
      for (const c of shownCommodities) {
        const p = projByKey.get(`${farm.id}|${c.id}`)
        if (p) { byCommodity.set(c.id, p); arcPlcTotal += p.result.net }
        const r = rvpByKey.get(`${farm.id}|${c.id}`)
        if (r) {
          rvpByCommodity.set(c.id, r)
          effectiveTotal += r.effective
          if (r.received != null) { receivedTotal += r.received; anyPaid = true }
        } else if (p) effectiveTotal += p.result.net
      }
      const other = otherByFarm.get(farm.id) ?? 0
      return { farm, arcPlcTotal, receivedTotal: anyPaid ? receivedTotal : null, effectiveTotal, other, total: arcPlcTotal + other, byCommodity, rvpByCommodity }
    })
  }, [shownFarms, shownCommodities, projByKey, rvpByKey, otherByFarm])

  // The number a cell shows for the chosen view: projected, received (— until paid), or the effective figure.
  const amountFor = useCallback((p: ProjectedPayment | undefined, r: ReceivedVsProjected | undefined): number | null => {
    if (view === 'projected') return p ? p.result.net : r ? r.projected : null
    if (view === 'received') return r?.received ?? null
    return r ? r.effective : p ? p.result.net : null
  }, [view])

  const totals = useMemo(() => {
    const byCommodity = new Map<string, number>()
    const byCommodityReceived = new Map<string, number>()
    const byCommodityEffective = new Map<string, number>()
    let arcPlc = 0, other = 0, receivedSum = 0, effective = 0
    for (const r of farmRows) {
      for (const [cid, p] of r.byCommodity) byCommodity.set(cid, (byCommodity.get(cid) ?? 0) + p.result.net)
      for (const [cid, v] of r.rvpByCommodity) {
        if (v.received != null) byCommodityReceived.set(cid, (byCommodityReceived.get(cid) ?? 0) + v.received)
        byCommodityEffective.set(cid, (byCommodityEffective.get(cid) ?? 0) + v.effective)
      }
      for (const [cid, p] of r.byCommodity) if (!r.rvpByCommodity.has(cid)) byCommodityEffective.set(cid, (byCommodityEffective.get(cid) ?? 0) + p.result.net)
      arcPlc += r.arcPlcTotal
      receivedSum += r.receivedTotal ?? 0
      effective += r.effectiveTotal
      other += r.other
    }
    other += nonFarmOther
    return { byCommodity, byCommodityReceived, byCommodityEffective, arcPlc, received: receivedSum, effective, other, grand: arcPlc + other, grandEffective: effective + other }
  }, [farmRows, nonFarmOther])
  const totalByView = (cid: string): number => (view === 'projected' ? totals.byCommodity.get(cid) ?? 0 : view === 'received' ? totals.byCommodityReceived.get(cid) ?? 0 : totals.byCommodityEffective.get(cid) ?? 0)
  const arcPlcByView = view === 'projected' ? totals.arcPlc : view === 'received' ? totals.received : totals.effective
  const grandByView = arcPlcByView + totals.other

  // KPIs for the program year in view (the shown farms).
  const kpis = useMemo(() => receivedKpis(farmRows.flatMap((r) => [...r.rvpByCommodity.values()])), [farmRows])
  const lastStatement = yearStatements[0] ?? null

  // Headline summary straight from the already-computed totals (no new math).
  const summaryCards: SummaryCardData[] = useMemo(() => {
    const cards: SummaryCardData[] = [
      { label: 'Projected ARC/PLC', value: fmtUsd(kpis.projected), tone: 'neutral', sub: `${shownFarms.length} farm${shownFarms.length === 1 ? '' : 's'}` },
    ]
    if (anyReceived || yearStatements.length > 0) {
      cards.push(
        { label: 'Received ARC/PLC', value: fmtUsd(kpis.received), tone: 'favorable', sub: `${kpis.paidRows} farm × crop line${kpis.paidRows === 1 ? '' : 's'} paid` },
        { label: 'Variance', value: fmtUsd(kpis.variance), tone: varianceTone(kpis.variance), sub: kpis.variancePct != null ? `${fmtPct(kpis.variancePct * 100, 1)} of projected` : undefined },
        { label: '% of projected received', value: kpis.pctOfProjectedReceived != null ? fmtPct(kpis.pctOfProjectedReceived * 100, 0) : '—', sub: kpis.unpaidRows > 0 ? `${kpis.unpaidRows} line${kpis.unpaidRows === 1 ? '' : 's'} not yet paid` : 'everything projected is paid' },
        { label: 'Last statement', value: lastStatement ? fmtDate(lastStatement.statement_date) : '—', sub: lastStatement ? `${yearStatements.length} statement${yearStatements.length === 1 ? '' : 's'} for program year ${programYear}` : 'none uploaded yet' },
      )
    }
    cards.push({ label: 'Other USDA', value: fmtUsd(totals.other) })
    cards.push({ label: 'Grand Total', value: fmtUsd(grandByView), tone: 'favorable', sub: view === 'projected' ? 'projected' : view === 'received' ? 'received only' : 'received where paid, else projected' })
    return cards
  }, [kpis, anyReceived, yearStatements, lastStatement, programYear, totals.other, grandByView, view, shownFarms.length])

  // Per-entity payment-limit status: sum ARC/PLC for that entity's farms + the
  // entity's other payments (farm-specific and not). Eligible persons live ON
  // the entity (set once — Settings → Entities); the per-person $ cap is the
  // PROGRAM year's statutory value from Program Parameters. The entity is the
  // program year's PAYEE; the amount is the effective figure (received where
  // paid, else projected).
  const limitRows = useMemo(() => {
    return entities.filter((e) => !entityId || e.id === entityId).map((e) => {
      const entityFarms = new Set(payeeFarms.filter((f) => f.entity_id === e.id).map((f) => f.id))
      let projTotal = 0, projOnly = 0
      for (const r of farmRows) if (entityFarms.has(r.farm.id)) { projTotal += r.effectiveTotal; projOnly += r.arcPlcTotal }
      for (const o of yearOther) if (o.entity_id === e.id) { projTotal += Number(o.amount); projOnly += Number(o.amount) }
      const persons = e.payment_limit_persons ?? 1
      const perPerson = programCfg.perPersonPaymentLimit
      const limit = paymentLimitTotal(persons, perPerson)
      return { entity: e, persons, perPerson, limit, projTotal, projOnly, remaining: limit - projTotal, pct: limit > 0 ? projTotal / limit : 0 }
    }).filter((r) => r.projTotal > 0)
  }, [entities, payeeFarms, farmRows, yearOther, entityId, programCfg])

  // At-a-glance entity × crop matrix (rendered above the per-farm detail and
  // exported as the first section). Farm-linked payments roll up to the
  // program year's PAYEE; non-farm other payments attribute by their
  // entity_id, with a "— no entity —" row for anything unattributable so the
  // corner ALWAYS reconciles with the page totals.
  type EntityMatrixRow = { name: string; byCommodity: Map<string, number>; byCommodityReceived: Map<string, number>; byCommodityEffective: Map<string, number>; arcPlc: number; received: number; effective: number; other: number; total: number; limitPct: number | null }
  const matrixCommodities = useMemo(
    () => shownCommodities.filter((c) => (totals.byCommodity.get(c.id) ?? 0) !== 0 || (totals.byCommodityReceived.get(c.id) ?? 0) !== 0),
    [shownCommodities, totals],
  )
  const entityMatrix: EntityMatrixRow[] = useMemo(() => {
    type B = { byCommodity: Map<string, number>; byCommodityReceived: Map<string, number>; byCommodityEffective: Map<string, number>; arcPlc: number; received: number; effective: number; other: number }
    const buckets = new Map<string, B>()
    const bucket = (key: string) => {
      let b = buckets.get(key)
      if (!b) { b = { byCommodity: new Map(), byCommodityReceived: new Map(), byCommodityEffective: new Map(), arcPlc: 0, received: 0, effective: 0, other: 0 }; buckets.set(key, b) }
      return b
    }
    for (const r of farmRows) {
      const b = bucket(r.farm.entity_id ?? '')
      for (const [cid, p] of r.byCommodity) b.byCommodity.set(cid, (b.byCommodity.get(cid) ?? 0) + p.result.net)
      for (const [cid, v] of r.rvpByCommodity) {
        if (v.received != null) b.byCommodityReceived.set(cid, (b.byCommodityReceived.get(cid) ?? 0) + v.received)
        b.byCommodityEffective.set(cid, (b.byCommodityEffective.get(cid) ?? 0) + v.effective)
      }
      for (const [cid, p] of r.byCommodity) if (!r.rvpByCommodity.has(cid)) b.byCommodityEffective.set(cid, (b.byCommodityEffective.get(cid) ?? 0) + p.result.net)
      b.arcPlc += r.arcPlcTotal
      b.received += r.receivedTotal ?? 0
      b.effective += r.effectiveTotal
      b.other += r.other
    }
    // Non-farm other payments — same semantics as the page totals (not
    // entity-filtered), attributed by entity_id.
    for (const o of yearOther) {
      if (o.farm_id) continue
      bucket(o.entity_id ?? '').other += Number(o.amount)
    }
    const rows: EntityMatrixRow[] = []
    for (const [key, b] of Array.from(buckets.entries())) {
      if (b.arcPlc === 0 && b.other === 0 && b.received === 0) continue
      const entity = key ? entityById.get(key) ?? null : null
      const lim = entity ? limitRows.find((l) => l.entity.id === entity.id) : null
      const arcByView = view === 'projected' ? b.arcPlc : view === 'received' ? b.received : b.effective
      rows.push({
        name: entity?.name ?? '— no entity —',
        byCommodity: b.byCommodity, byCommodityReceived: b.byCommodityReceived, byCommodityEffective: b.byCommodityEffective,
        arcPlc: b.arcPlc, received: b.received, effective: b.effective, other: b.other, total: arcByView + b.other,
        limitPct: lim ? lim.pct : null,
      })
    }
    return rows.sort((a, z) => a.name.localeCompare(z.name))
  }, [farmRows, yearOther, entityById, limitRows, view])
  const matrixCell = (r: EntityMatrixRow, cid: string): number | null => {
    if (view === 'projected') return r.byCommodity.get(cid) ?? null
    if (view === 'received') return r.byCommodityReceived.get(cid) ?? null
    return r.byCommodityEffective.get(cid) ?? r.byCommodity.get(cid) ?? null
  }

  // "I set it in Settings but the report doesn't see it": benchmarks and
  // payment limits are keyed per PROGRAM year, and in payment-year framing
  // the selected year's math runs on programYear = year − 1. When rows exist
  // only for OTHER years, say so explicitly instead of silently falling back.
  const benchmarkYearsElsewhere = useMemo(() => {
    if (programYear === '' || benchmarks.length === 0 || benchmarks.some((b) => b.crop_year === programYear)) return []
    return Array.from(new Set(benchmarks.map((b) => b.crop_year))).sort((a, b) => b - a)
  }, [benchmarks, programYear])

  // Calendar-year totals per payee (1099-G reconciliation).
  const yearTotals = useMemo(() => calendarYearTotals({ statements: actuals.statements, lines: actuals.lines }), [actuals])

  function toggle(id: string) { setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }) }

  // For a viewer, "no entity selected" means their granted entities — the
  // export's filter line names them. Null for owners (keep existing wording).
  const entityName = entityId
    ? entityById.get(entityId)?.name ?? null
    : viewerAllEntitiesLabel(viewer, entities)
  const filterSummary = filterSummaryOf(
    cropYear === ''
      ? null
      : yearBasis === 'payment'
        ? `Payments received in ${paymentYear} (${programYear} program year)`
        : `${programYear} program year (paid Oct ${paymentYear})`,
    entityName ?? 'All Entities',
    view === 'projected' ? 'Projected' : view === 'received' ? 'Received' : 'Projected and received',
  )

  function buildExportPayload(): ExportPayload {
    const fmtCols = (label: string): ExportColumn[] =>
      view === 'projected' ? [{ label: `${label} Projected`, align: 'right', format: 'usd0' }]
        : view === 'received' ? [{ label: `${label} Received`, align: 'right', format: 'usd0' }]
          : [{ label: `${label} Projected`, align: 'right', format: 'usd0' }, { label: `${label} Received`, align: 'right', format: 'usd0' }, { label: `${label} Variance`, align: 'right', format: 'usd0' }]
    const fmtCells = (projectedV: number | null, receivedV: number | null): ExportCell[] => {
      const p = projectedV == null ? '' : Math.round(projectedV)
      const r = receivedV == null ? '' : Math.round(receivedV)
      const v = projectedV != null && receivedV != null ? { v: Math.round(receivedV - projectedV), tone: varianceTone(receivedV - projectedV) } : ''
      return view === 'projected' ? [p] : view === 'received' ? [r] : [p, r, v]
    }
    // Same column order as the screen: totals first, then per commodity —
    // base acres, the farm's election (PLC / ARC-CO — shown under each cell
    // on screen), and the projected / received net payment.
    const cols: ExportColumn[] = [
      { label: 'Farm' }, { label: 'FSA #' }, { label: `Entity (${programYear} payee)` },
      { label: 'Total Govt', align: 'right', format: 'usd0' }, ...fmtCols('Total ARC/PLC'), { label: 'Other', align: 'right', format: 'usd0' },
    ]
    for (const c of shownCommodities) {
      cols.push({ label: `${c.name} Base Ac`, align: 'right', format: 'int' })
      cols.push({ label: `${c.name} Program` })
      cols.push(...fmtCols(c.name))
      if (view !== 'projected') cols.push({ label: `${c.name} Status` })
    }
    const rows: ExportCell[][] = farmRows.map((r) => {
      const arcByView = view === 'projected' ? r.arcPlcTotal : view === 'received' ? (r.receivedTotal ?? 0) : r.effectiveTotal
      const cells: ExportCell[] = [
        r.farm.name, r.farm.fsa_number ?? '', payeeEntityName(r.farm.id),
        Math.round(arcByView + r.other), ...fmtCells(r.arcPlcTotal, r.receivedTotal), Math.round(r.other),
      ]
      for (const c of shownCommodities) {
        const p = r.byCommodity.get(c.id)
        const v = r.rvpByCommodity.get(c.id)
        cells.push(p ? Math.round(p.baseAcres) : '')
        cells.push(v?.paidProgram ? PROGRAM_CODE_LABEL[v.paidProgram] : p ? ELECTION_LABEL[p.election] : '')
        cells.push(...fmtCells(p ? p.result.net : v ? v.projected : null, v?.received ?? null))
        if (view !== 'projected') cells.push(v ? RECEIVED_STATUS_LABEL[v.status] : '')
      }
      return cells
    })
    const totalRow: ExportCell[] = ['Total', '', '', Math.round(grandByView), ...fmtCells(totals.arcPlc, anyReceived ? totals.received : null), Math.round(totals.other)]
    for (const c of shownCommodities) {
      totalRow.push('', '')
      totalRow.push(...fmtCells(totals.byCommodity.get(c.id) ?? 0, anyReceived ? totals.byCommodityReceived.get(c.id) ?? 0 : null))
      if (view !== 'projected') totalRow.push('')
    }
    rows.push(totalRow)

    const sections: ExportSection[] = []

    // At-a-glance entity × crop matrix — the FIRST export section, mirroring
    // the on-screen summary (limit tone on entity totals).
    if (entityMatrix.length > 0) {
      const matrixTotal: ExportCell[] = ['Total']
      for (const c of matrixCommodities) matrixTotal.push(...fmtCells(totals.byCommodity.get(c.id) ?? 0, anyReceived ? totals.byCommodityReceived.get(c.id) ?? 0 : null))
      matrixTotal.push(Math.round(totals.other), Math.round(grandByView))
      sections.push({
        title: 'By Entity x Crop',
        columns: [
          { label: `Entity (${programYear} payee)` },
          ...matrixCommodities.flatMap((c) => fmtCols(c.name)),
          { label: 'Other USDA', align: 'right', format: 'usd0' },
          { label: 'Total', align: 'right', format: 'usd0' },
        ],
        rows: [
          ...entityMatrix.map((r): ExportCell[] => [
            r.name,
            ...matrixCommodities.flatMap((c): ExportCell[] => fmtCells(r.byCommodity.get(c.id) ?? null, r.byCommodityReceived.has(c.id) ? r.byCommodityReceived.get(c.id)! : null)),
            Math.round(r.other),
            { v: Math.round(r.total), tone: r.limitPct != null && r.limitPct > 1 ? 'unfavorable' : r.limitPct != null && r.limitPct > 0.8 ? 'warning' : 'neutral' },
          ]),
          matrixTotal,
        ],
        rowMeta: [...entityMatrix.map(() => 'data' as const), 'total'],
      })
    }

    sections.push(
      { title: view === 'projected' ? 'Projected Payments by Farm' : 'Payments by Farm', columns: cols, rows, rowMeta: [...farmRows.map(() => 'data' as const), 'total'] },
    )

    // Per-entity Payment Limit Status — the second on-screen table. Mirror its
    // Entity / Limit / Projected / Remaining / Status columns, plus the persons ×
    // per-person breakdown shown inline in the Limit cell.
    if (limitRows.length > 0) {
      sections.push({
        title: 'Payment Limit Status',
        columns: [
          { label: 'Entity' },
          { label: 'Eligible Persons', align: 'right', format: 'int' },
          { label: 'Per-Person Limit', align: 'right', format: 'usd0' },
          { label: 'Payment Limit', align: 'right', format: 'usd0' },
          { label: anyReceived ? 'Received / Projected' : 'Projected', align: 'right', format: 'usd0' },
          { label: 'Remaining', align: 'right', format: 'usd0' },
          { label: 'Status' },
        ],
        rows: limitRows.map((l): ExportCell[] => [
          l.entity.name,
          l.persons,
          Math.round(l.perPerson),
          Math.round(l.limit),
          { v: Math.round(l.projTotal), tone: l.pct > 1 ? 'unfavorable' : l.pct > 0.8 ? 'warning' : 'neutral' },
          { v: Math.round(l.remaining), tone: l.remaining < 0 ? 'unfavorable' : 'neutral' },
          { v: l.pct > 1 ? 'Exceeds limit' : l.pct > 0.8 ? 'Approaching limit' : 'Under limit', tone: l.pct > 1 ? 'unfavorable' : l.pct > 0.8 ? 'warning' : 'favorable' },
        ]),
      })
    }

    // 0099: the statements as data tabs + a live Received vs Projected tab
    // (SUMIFS over the crop amounts, so the workbook stays true when a line
    // is corrected in Excel).
    if (actuals.statements.length > 0) {
      const stmtById = new Map(actuals.statements.map((s) => [s.id, s]))
      const payeeOf = (s: { payee_entity_id: string | null; payee_name: string }) => (s.payee_entity_id ? entityById.get(s.payee_entity_id)?.name ?? s.payee_name : s.payee_name)
      const linesByStatement = new Map<string, number>()
      for (const l of actuals.lines) linesByStatement.set(l.statement_id, (linesByStatement.get(l.statement_id) ?? 0) + 1)
      sections.push({
        key: SECTION.statements, title: 'Statements', plain: true,
        note: 'Every FSA Payment Statement uploaded, newest first. Blue = from the statement; the Lines and Crop Amounts tabs carry the detail.',
        columns: [
          { key: 'date', label: 'Statement date', width: 14 }, { key: 'office', label: 'Office', width: 24 }, { key: 'payee', label: 'Payee', width: 24 },
          { key: 'gross', label: 'Gross', align: 'right', format: 'usd2' }, { key: 'deductions', label: 'Deductions', align: 'right', format: 'usd2' },
          { key: 'net', label: 'Net', align: 'right', format: 'usd2' }, { key: 'lines', label: 'Lines', align: 'right', format: 'int' },
          { key: 'pages', label: 'Pages', align: 'right', format: 'int' }, { key: 'doc', label: 'Document', width: 40 },
        ],
        rows: actuals.statements.map((s): ExportCell[] => [
          input(s.statement_date), input(s.office_name ?? ''), input(payeeOf(s)), input(Number(s.gross_payment), 'usd2'), input(Number(s.deductions), 'usd2'), input(Number(s.net_payment), 'usd2'),
          input(linesByStatement.get(s.id) ?? 0, 'int'), input(s.page_count ?? null, 'int'), s.document_url ? { v: 'PDF', link: s.document_url } : '',
        ]),
      })
      sections.push({
        key: SECTION.lines, title: 'Lines', plain: true,
        note: 'One row per payment block (FSA Payment ID). Bank detail is the last four digits only.',
        columns: [
          { key: 'date', label: 'Statement date', width: 14 }, { key: 'payee', label: 'Payee', width: 22 }, { key: 'id', label: 'FSA Payment ID', width: 14 }, { key: 'tcn', label: 'Transaction control #', width: 18 },
          { key: 'program', label: 'Program', width: 10 }, { key: 'program_raw', label: 'Program title', width: 36 }, { key: 'year', label: 'Program year', align: 'right', format: 'text' },
          { key: 'farm', label: 'Farm', width: 24 }, { key: 'fsa', label: 'FSA #', width: 8 },
          { key: 'gross', label: 'Gross', align: 'right', format: 'usd2' }, { key: 'deductions', label: 'Deductions', align: 'right', format: 'usd2' }, { key: 'net', label: 'Net', align: 'right', format: 'usd2' },
          { key: 'paid', label: 'Payment date', width: 14 }, { key: 'method', label: 'Method', width: 8 }, { key: 'bank', label: 'Bank', width: 28 }, { key: 'last4', label: 'Account (last 4)', width: 10 },
          { key: 'sequester', label: 'Sequester', align: 'right', format: 'pct1' },
        ],
        rows: actuals.lines.map((l): ExportCell[] => {
          const s = stmtById.get(l.statement_id)
          return [
            input(s?.statement_date ?? ''), input(s ? payeeOf(s) : ''), input(l.fsa_payment_id), input(l.transaction_control_number ?? ''),
            input(PROGRAM_CODE_LABEL[l.program_code]), input(l.program_name_raw), input(l.program_year ?? null, 'text'),
            input(l.farm_id ? farmById.get(l.farm_id)?.name ?? '' : ''), input(l.fsa_farm_number ?? ''),
            input(Number(l.gross_payment), 'usd2'), input(Number(l.deductions), 'usd2'), input(Number(l.net_payment), 'usd2'),
            input(l.payment_date ?? ''), input(l.payment_method ?? ''), input(l.bank_name ?? ''), input(l.account_last4 ?? ''),
            l.sequester_pct != null ? input(Math.round(Number(l.sequester_pct) * 1000) / 10, 'pct1') : '',
          ]
        }),
      })
      const lineById = new Map(actuals.lines.map((l) => [l.id, l]))
      sections.push({
        key: SECTION.crops, title: 'Crop Amounts', plain: true,
        note: 'The Crop and Payment Amount Detail of every ARC/PLC block — the received payment per farm × crop × program year. The Received vs Projected tab sums this tab.',
        columns: [
          { key: 'date', label: 'Statement date', width: 14 }, { key: 'id', label: 'FSA Payment ID', width: 14 }, { key: 'program', label: 'Program', width: 10 },
          { key: 'program_year', label: 'Program year', align: 'right', format: 'text' }, { key: 'farm', label: 'Farm', width: 24 }, { key: 'fsa', label: 'FSA #', width: 8 },
          { key: 'commodity', label: 'Commodity', width: 16 }, { key: 'raw', label: 'As printed', width: 16 }, { key: 'amount', label: 'Amount', align: 'right', format: 'usd2' }, { key: 'paid', label: 'Payment date', width: 14 },
        ],
        rows: actuals.cropAmounts.map((c): ExportCell[] => {
          const l = lineById.get(c.line_id)
          const s = l ? stmtById.get(l.statement_id) : undefined
          return [
            input(s?.statement_date ?? ''), input(l?.fsa_payment_id ?? ''), input(l ? PROGRAM_CODE_LABEL[l.program_code] : ''), input(l?.program_year ?? null, 'text'),
            input(l?.farm_id ? farmById.get(l.farm_id)?.name ?? '' : ''), input(l?.fsa_farm_number ?? ''),
            input(c.commodity_id ? commodityById.get(c.commodity_id)?.name ?? c.raw_crop : ''), input(c.raw_crop), input(Number(c.amount), 'usd2'), input(l?.payment_date ?? ''),
          ]
        }),
      })
      if (programYear !== '' && rvpRows.length > 0) {
        const C = (c: string) => col(SECTION.crops, c)
        const receivedF = (): FormulaNode => sumifs(C('amount'), [C('farm'), exactCriterion(self('farm'))], [C('commodity'), exactCriterion(self('commodity'))], [C('program_year'), self('program_year')])
        sections.push({
          key: SECTION.rvp, title: 'Received vs Projected', plain: true,
          note: `Program year ${programYear}: Received is a live SUMIFS over the Crop Amounts tab (farm × commodity × program year); Variance = Received − Projected. Blue = from Turnrow; black = formulas.`,
          columns: [
            { key: 'farm', label: 'Farm', width: 24 }, { key: 'fsa', label: 'FSA #', width: 8 }, { key: 'entity', label: `Entity (${programYear} payee)`, width: 22 },
            { key: 'commodity', label: 'Commodity', width: 16 }, { key: 'program_year', label: 'Program year', align: 'right', format: 'text' },
            { key: 'projected_program', label: 'Projected under', width: 10 }, { key: 'paid_program', label: 'Paid under', width: 10 },
            { key: 'projected', label: 'Projected', align: 'right', format: 'usd2' }, { key: 'received', label: 'Received', align: 'right', format: 'usd2' }, { key: 'variance', label: 'Variance', align: 'right', format: 'usd2' },
            { key: 'status', label: 'Status', width: 30 }, { key: 'cause', label: 'Variance cause', width: 26 },
            { key: 'implied', label: 'Implied rate', align: 'right', format: 'dec2' }, { key: 'projected_rate', label: 'Projected rate', align: 'right', format: 'dec2' },
          ],
          rows: rvpRows.filter((r) => shownFarms.some((f) => f.id === r.farmId)).map((r): ExportCell[] => [
            input(farmById.get(r.farmId)?.name ?? ''), input(farmById.get(r.farmId)?.fsa_number ?? ''), input(payeeEntityName(r.farmId)),
            input(commodityById.get(r.commodityId)?.name ?? ''), input(r.programYear, 'text'),
            input(r.projectedProgram ? ELECTION_LABEL[r.projectedProgram] : ''), input(r.paidProgram ? PROGRAM_CODE_LABEL[r.paidProgram] : ''),
            input(Math.round(r.projected * 100) / 100, 'usd2'), formula(receivedF(), 'usd2'), formula(sub(self('received'), self('projected')), 'usd2'),
            input(RECEIVED_STATUS_LABEL[r.status]), input(r.cause ? VARIANCE_CAUSE_LABEL[r.cause] : ''),
            r.implied ? input(r.implied.implied, r.implied.program === 'PLC' ? 'dec2' : 'usd2') : '', r.implied?.projected != null ? input(r.implied.projected, r.implied.program === 'PLC' ? 'dec2' : 'usd2') : '',
          ]),
        })
      }
    }

    return {
      title: 'Government Payment Tracker',
      filters: filterSummary,
      summary: summaryCards.map((c) => ({ label: c.label, value: c.value, sub: c.sub, tone: c.tone })),
      sections,
    }
  }
  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmRows, totals, shownCommodities, limitRows, entityMatrix, matrixCommodities, cropYear, yearBasis, entityName, onPayloadChange, view, actuals, rvpRows, summaryCards])

  if (loading) return <p className="text-slate-500">Loading…</p>

  const canOpenSettings = viewer.role === 'owner'
  const setupNotices: ReactNode[] = []
  if (benchmarkYearsElsewhere.length > 0) {
    setupNotices.push(
      <div key="bench">
        <strong>Program-year mismatch</strong> — this view computes <b>program year {programYear}</b>
        {yearBasis === 'payment' ? <> (its payments arrive in {paymentYear})</> : null}, but your ARC-CO benchmark
        rows are for {benchmarkYearsElsewhere.join(', ')} — so ARC-CO falls back to flat estimates. Benchmarks and
        elections are keyed to the program year:{' '}
        {canOpenSettings ? (
          <Link href={`/settings/government-payments?year=${programYear}#bench`} className="underline font-semibold">
            add {programYear} rows in Settings
          </Link>
        ) : <>ask the operator to add {programYear} rows</>}
        , or switch the year / year basis above if you meant a different program year.
      </div>,
    )
  }
  if (suspects.length > 0 && !suspectNoteDismissed) {
    setupNotices.push(
      <div key="suspects" className="flex items-start gap-3">
        <span className="flex-1">
          <strong>Review other-payment years</strong> — the crop year on an Other USDA payment now means the year the
          payment is <em>received</em>. {suspects.length} existing entr{suspects.length === 1 ? 'y has' : 'ies have'} a
          payment date in the year after {suspects.length === 1 ? 'its' : 'their'} crop year
          ({suspects.slice(0, 4).map((o) => `${o.program_name} ${o.crop_year}`).join(', ')}{suspects.length > 4 ? ', …' : ''}) —
          if those crop years were meant as program years, update them to the payment year under Settings → Government
          Payments → Other USDA Payments.
        </span>
        <button type="button" onClick={() => setSuspectNoteDismissed(true)} className="min-h-10 px-2 text-xs underline whitespace-nowrap">Dismiss</button>
      </div>,
    )
  }
  if (programNotice) setupNotices.push(<div key="program">{programNotice}</div>)

  const explicitPayees = programYear !== '' ? shownFarms.filter((f) => hasExplicitPayee(f.id, programYear, payeeIdx)).length : 0
  const nothingHere = cropYear !== '' && farmRows.length === 0

  return (
    <div className="space-y-4 print-area">
      <ReportHeader title="Government Payment Tracker" filterSummary={filterSummary} actions={headerActions} />
      <ReportFilterBar activeCount={entityId ? 1 : 0}>
        <FilterField label={yearBasis === 'payment' ? 'Crop year (payments received)' : 'Program year'}>
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={selectCls}>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </FilterField>
        <FilterField label="Year basis">
          <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => switchBasis('payment')}
              aria-pressed={yearBasis === 'payment'}
              className={`px-3 min-h-10 ${yearBasis === 'payment' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              By payment year
            </button>
            <button
              type="button"
              onClick={() => switchBasis('program')}
              aria-pressed={yearBasis === 'program'}
              className={`px-3 min-h-10 border-l border-slate-300 ${yearBasis === 'program' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              By program year
            </button>
          </span>
        </FilterField>
        <EntityFilter entities={entityOptionsFor(viewer, entities)} value={entityId} onChange={setEntityId} />
        {canOpenSettings && (
          <Link
            href={`/settings/government-payments${programYear !== '' ? `?year=${programYear}` : ''}#bench`}
            className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-10 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            ARC-CO settings: benchmarks &amp; county yields →
          </Link>
        )}
      </ReportFilterBar>
      <p className="text-xs text-slate-500 no-print">
        {yearBasis === 'payment'
          ? <>Showing the payments received in the selected crop year. They were earned in the prior program year.</>
          : <>Showing a program year&rsquo;s payments, paid the following October — the framing the FSA office uses.</>}
        {explicitPayees > 0 && <> Entities are the <b>{programYear} payees</b> ({explicitPayees} farm{explicitPayees === 1 ? '' : 's'} paid to an entity other than the farm&apos;s current one{canOpenSettings ? <> — <Link href="/settings/government-payments#payee" className="underline">Payee by program year</Link></> : null}).</>}
      </p>

      <ViewTabs
        ariaLabel="Tracker view"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'tracker' as Tab, label: 'Tracker' },
          { key: 'statements' as Tab, label: `Statements${actuals.statements.length > 0 ? ` (${actuals.statements.length})` : ''}` },
          ...(canOpenSettings ? [{ key: 'upload' as Tab, label: 'Upload FSA payment statement' }] : []),
        ]}
      />

      {setupNotices.length > 0 && tab === 'tracker' && (
        <Disclosure title="Check your setup" count={setupNotices.length} tone="warning">
          {setupNotices}
        </Disclosure>
      )}

      {tab === 'upload' && canOpenSettings && (
        <section className="bg-white rounded-xl shadow p-4">
          <h2 className="font-bold text-lg mb-1">Upload an FSA payment statement</h2>
          <FsaPaymentStatementImport
            farms={farms} entities={entities} commodities={commodities} counties={counties} programConfigs={programConfigs}
            payees={actuals.payees} existingLines={actuals.lines} onChanged={refreshActuals}
          />
        </section>
      )}

      {tab === 'statements' && (
        <StatementsTab
          actuals={actuals} entities={entities} farms={farms} yearTotals={yearTotals}
          canDelete={canOpenSettings}
          onDeleted={refreshActuals}
        />
      )}

      {tab === 'tracker' && nothingHere && (
        <EmptyState message="No base acres or payment statements on file." linkHref="/settings/government-payments" linkLabel="Add base acres" role={viewer.role} />
      )}

      {tab === 'tracker' && cropYear !== '' && farmRows.length > 0 && (
        <>
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 no-print">
            <strong>Projected</strong> — PLC from current MYA estimates; ARC-CO from the county-revenue engine
            ({Math.round(programCfg.arcGuaranteePct * 100)}% guarantee, capped at {Math.round(programCfg.arcPaymentCapPct * 100)}% of
            benchmark revenue) where benchmark data exists, else your flat $/acre estimate.
            {programYear !== '' && paysHigherOf(programYear) && <> For program year {programYear} FSA pays the <strong>higher of PLC and ARC-CO</strong> on every farm and crop regardless of the election, and so does this projection.</>}{' '}
            <strong>Received</strong> is what the FSA payment statements say was paid. All ARC/PLC rows below are the <strong>{programYear} program
            year → paid Oct {paymentYear}</strong>.
          </div>

          <SummaryCards cards={summaryCards} />

          <div className="flex flex-wrap items-center gap-3 no-print">
            <SegmentedChips<View> label="Show" value={view} onChange={setView} options={[{ key: 'projected', label: 'Projected' }, { key: 'received', label: 'Received' }, { key: 'both', label: 'Both' }]} />
            {!anyReceived && <span className="text-xs text-slate-500">No statement for program year {programYear} yet{canOpenSettings ? <> — <button type="button" onClick={() => setTab('upload')} className="underline">upload one</button></> : null}.</span>}
          </div>

          {/* At-a-glance entity × crop matrix — the detail tables below stay
              unchanged; entity Total cells carry the payment-limit tone. */}
          {entityMatrix.length > 0 && (
            <section className="bg-white rounded-xl shadow p-4 space-y-2 avoid-break">
              <h2 className="font-bold text-lg">
                By Entity × Crop
                <span className="ml-2 text-sm font-normal text-slate-500">
                  {view === 'projected' ? 'projected' : view === 'received' ? 'received' : 'received where paid, else projected'} net ARC/PLC {yearBasis === 'payment' ? `received in ${paymentYear}` : `for program year ${programYear}`} + other USDA · entity = the {programYear} payee
                </span>
              </h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      <th className="text-left px-2 py-1">Entity</th>
                      {matrixCommodities.map((c) => <th key={c.id} className="text-right px-2 py-1 whitespace-nowrap">{c.name}</th>)}
                      <th className="text-right px-2 py-1 whitespace-nowrap">Other USDA</th>
                      <th className="text-right px-2 py-1">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entityMatrix.map((r) => (
                      <tr key={r.name} className="border-t border-slate-100">
                        <td className="px-2 py-1 font-semibold whitespace-nowrap">{r.name}</td>
                        {matrixCommodities.map((c) => {
                          const v = matrixCell(r, c.id)
                          const p = r.byCommodity.get(c.id) ?? null
                          const rec = r.byCommodityReceived.has(c.id) ? r.byCommodityReceived.get(c.id)! : null
                          return (
                            <td key={c.id} className="px-2 py-1 text-right tabular-nums">
                              {v != null ? fmtUsd(v) : <span className="text-slate-300">—</span>}
                              {view === 'both' && rec != null && p != null && (
                                <div className={`text-[10px] ${toneText(varianceTone(rec - p))}`}>{rec - p >= 0 ? '+' : ''}{fmtUsd(rec - p)} vs projected</div>
                              )}
                            </td>
                          )
                        })}
                        <td className="px-2 py-1 text-right tabular-nums">{r.other !== 0 ? fmtUsd(r.other) : <span className="text-slate-300">—</span>}</td>
                        <td
                          className={`px-2 py-1 text-right tabular-nums font-bold ${r.limitPct != null ? toneText(r.limitPct > 1 ? 'unfavorable' : r.limitPct > 0.8 ? 'warning' : 'neutral') : ''}`}
                        >
                          {fmtUsd(r.total)}
                          {r.limitPct != null && <span className="block text-[10px] font-normal text-slate-500">{Math.round(r.limitPct * 100)}% of limit</span>}
                        </td>
                      </tr>
                    ))}
                    <tr className={grandTotalRowCls}>
                      <td className="px-2 py-1">Total</td>
                      {matrixCommodities.map((c) => <td key={c.id} className="px-2 py-1 text-right tabular-nums">{fmtUsd(totalByView(c.id))}</td>)}
                      <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(totals.other)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(grandByView)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Variance by cause — only once something has been received. */}
          {anyReceived && (
            <section className="bg-white rounded-xl shadow p-4 avoid-break">
              <h2 className="font-bold text-lg">
                Variance explained
                <span className="ml-2 text-sm font-normal text-slate-500">received − projected on the paid farm × crop lines, by cause</span>
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 text-sm">
                {(['RATE', 'ACRES_YIELD', 'SEQUESTER', 'PROGRAM'] as const).map((k) => (
                  <div key={k} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="text-xs text-slate-500">{VARIANCE_CAUSE_LABEL[k]}</div>
                    <div className={`text-lg font-bold tabular-nums ${toneText(varianceTone(kpis.byCause[k]))}`}>{fmtUsd(kpis.byCause[k])}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Each paid line&apos;s implied rate (the actual ÷ (1 − sequester) ÷ 0.85 ÷ base acres, ÷ PLC yield for PLC) sits beside the projected rate in the farm detail. A line is attributed to the
                <b> program</b> when the other program paid, to the <b>sequester</b> when the statement&apos;s percent alone explains it, to <b>acres / yield</b> when the implied rate is more than the program can pay on your base data, else to the <b>rate</b> (the price or county revenue).
              </p>
            </section>
          )}

          {/* Per-commodity MYA — the same shared resolution the Decision Aid
              reads; toggling Auto/Manual here updates every projection below. */}
          <MyaPricePanel
            cropYear={programYear as number}
            commodities={shownCommodities}
            priceData={priceData}
            liveMya={liveMya}
            liveDetails={liveDetails}
            monthlyPrices={monthlyPrices}
            onChanged={refreshPriceData}
            onRefreshEstimates={refreshEstimates}
          />

          {/* County yield expectation — drives every ARC-CO row below. */}
          <CountyYieldExpectation
            cropYear={programYear as number}
            commodities={shownCommodities}
            farms={farms}
            counties={counties}
            baseAcres={baseAcres}
            benchmarks={benchmarks}
            onChanged={refreshPriceData}
          />

          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">
              {yearBasis === 'payment'
                ? <>Government Payment Tracker — payments received in {paymentYear}</>
                : <>Government Payment Tracker — {programYear} program year</>}
              <span className="ml-2 text-sm font-normal text-slate-500">
                {programYear} program year → paid Oct {paymentYear}
              </span>
            </h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  {/* Farm stays frozen on horizontal scroll (sticky inside the
                      section's overflow-x-auto); totals sit before the per-crop
                      amounts so the number that matters is never scrolled away. */}
                  <th className={`text-left px-2 py-1 ${stickyColHeadCls}`}>Farm</th><th className="text-left px-2 py-1">FSA #</th><th className="text-left px-2 py-1">Entity <span className="font-normal text-slate-500">({programYear} payee)</span></th>
                  <th className="text-right px-2 py-1 whitespace-nowrap">Total Govt</th>
                  <th className="text-right px-2 py-1 whitespace-nowrap">Total ARC/PLC</th>
                  {view === 'both' && <th className="text-right px-2 py-1 whitespace-nowrap">Variance</th>}
                  <th className="text-right px-2 py-1 whitespace-nowrap">Other</th>
                  {shownCommodities.map((c) => <th key={c.id} className="text-right px-2 py-1 whitespace-nowrap">{c.name}</th>)}
                  <th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {farmRows.map((r) => {
                  const arcByView = view === 'projected' ? r.arcPlcTotal : view === 'received' ? r.receivedTotal : r.effectiveTotal
                  const explicit = programYear !== '' && hasExplicitPayee(r.farm.id, programYear, payeeIdx)
                  return (
                    <tr key={r.farm.id} className="border-t border-slate-100 align-top">
                      <td className={`px-2 py-1 font-semibold ${stickyColCls}`}>{r.farm.name}</td>
                      <td className="px-2 py-1 text-xs tabular-nums">{r.farm.fsa_number ?? ''}</td>
                      <td className="px-2 py-1">
                        {payeeEntityName(r.farm.id)}
                        {explicit && <InfoTip label={`${programYear} payee`} tone="neutral" className="ml-1">Paid to this entity for program year {programYear} (set under Settings → Government Payments → Payee by program year). The farm&apos;s current entity is {farmById.get(r.farm.id)?.entity_id ? entityById.get(farmById.get(r.farm.id)!.entity_id!)?.name ?? '—' : 'none'}.</InfoTip>}
                      </td>
                      <td className="px-2 py-1 text-right font-bold tabular-nums">{arcByView != null ? fmtUsd(arcByView + r.other) : <span className="text-slate-300">—</span>}</td>
                      <td className="px-2 py-1 text-right font-semibold tabular-nums">
                        {arcByView != null ? fmtUsd(arcByView) : <span className="text-slate-300">—</span>}
                        {view === 'both' && r.receivedTotal != null && <div className="text-[10px] font-normal text-slate-500">projected {fmtUsd(r.arcPlcTotal)}</div>}
                      </td>
                      {view === 'both' && (
                        <td className={`px-2 py-1 text-right tabular-nums ${r.receivedTotal != null ? toneText(varianceTone(r.receivedTotal - r.arcPlcTotal)) : 'text-slate-300'}`}>
                          {r.receivedTotal != null ? fmtUsd(r.receivedTotal - r.arcPlcTotal) : '—'}
                        </td>
                      )}
                      <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(r.other)}</td>
                      {shownCommodities.map((c) => {
                        const p = r.byCommodity.get(c.id)
                        const v = r.rvpByCommodity.get(c.id)
                        if (!p && !v) return <td key={c.id} className="px-2 py-1 text-right tabular-nums text-slate-300">—</td>
                        const amount = amountFor(p, v)
                        const program = v?.paidProgram ? PROGRAM_CODE_LABEL[v.paidProgram] : p ? ELECTION_LABEL[p.election] : ''
                        return (
                          <td key={c.id} className={`px-2 py-1 text-right tabular-nums ${amount != null && amount > 0 ? '' : 'text-slate-400'}`}>
                            <div className="tabular-nums">{amount != null ? fmtUsd(amount) : <span className="text-slate-300">—</span>}</div>
                            {view === 'both' && v?.received != null && (
                              <div className={`text-[10px] ${toneText(varianceTone(v.variance))}`}>{v.variance != null && v.variance >= 0 ? '+' : ''}{fmtUsd(v.variance)} vs {fmtUsd(v.projected)} projected</div>
                            )}
                            <div className="text-[10px] text-slate-500">
                              {p ? `${fmtInt(p.baseAcres)} ac${p.producerShare !== 1 ? ` × ${Math.round(p.producerShare * 100)}% share` : ''} · ` : ''}{program}
                              {p && p.higherOf && p.election !== p.electedProgram && (
                                <InfoTip label="higher-of" tone="neutral" className="ml-1">Elected {ELECTION_LABEL[p.electedProgram]}, but program year {programYear} pays the higher program: PLC {fmtUsd(p.higherOf.plc)} vs ARC-CO {fmtUsd(p.higherOf.arcCo)}.</InfoTip>
                              )}
                              {p?.result.arcMethod === 'engine' && p.result.arcDetail?.capped && (
                                <span className="ml-1 rounded-full bg-slate-100 text-slate-700 px-1.5 py-0.5 whitespace-nowrap">capped at {Math.round(p.result.arcDetail.capPct * 100)}%</span>
                              )}
                              {p?.result.arcMethod === 'flat' && p.result.computable && (
                                <InfoTip label="flat estimate" tone="warning" className="ml-1">No county benchmark data for this county and crop yet, so this is your flat dollars-per-acre estimate.</InfoTip>
                              )}
                              {v && view !== 'projected' && <StatusChip status={v.status} />}
                            </div>
                          </td>
                        )
                      })}
                      <td className="px-2 py-1 no-print"><button type="button" onClick={() => toggle(r.farm.id)} aria-expanded={expanded.has(r.farm.id)} className="inline-flex items-center min-h-10 px-2 rounded-lg text-brand-deep text-xs font-semibold hover:bg-slate-100">{expanded.has(r.farm.id) ? 'Hide' : 'Detail'}</button></td>
                    </tr>
                  )
                })}
                <tr className={grandTotalRowCls}>
                  <td className={`px-2 py-1 ${stickyColCls} bg-slate-100`}>Total</td>
                  <td className="px-2 py-1" colSpan={2} />
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(grandByView)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(arcPlcByView)}</td>
                  {view === 'both' && <td className={`px-2 py-1 text-right tabular-nums ${toneText(varianceTone(kpis.variance))}`}>{anyReceived ? fmtUsd(kpis.variance) : '—'}</td>}
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(totals.other)}</td>
                  {shownCommodities.map((c) => <td key={c.id} className="px-2 py-1 text-right tabular-nums">{fmtUsd(totalByView(c.id))}</td>)}
                  <td className="no-print" />
                </tr>
              </tbody>
            </table>
            {nonFarmOther > 0 && <p className="text-xs text-slate-500 mt-2">Includes {fmtUsd(nonFarmOther)} of non-farm-specific other payments in the Other total.</p>}
          </section>

          {/* Per-farm detail */}
          {farmRows.filter((r) => expanded.has(r.farm.id)).map((r) => (
            <FarmDetail key={r.farm.id} farmRow={r} commodityById={commodityById} otherForFarm={yearOther.filter((o) => o.farm_id === r.farm.id)} crops={crops} programCfg={programCfg} statements={actuals.statements} />
          ))}

          {/* Payment limits */}
          {limitRows.length > 0 && (
            <section className="bg-white rounded-xl shadow p-4 avoid-break">
              <h2 className="font-bold text-lg mb-2">
                Payment Limit Status — {programYear} program year
                <span className="ml-2 text-sm font-normal text-slate-500">
                  eligible persons set per entity (Settings → Entities) × the {programYear} per-person limit; the entity is the {programYear} payee; the
                  cap applies per program year regardless of when the cash arrives
                </span>
              </h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className={theadCls}><tr>{['Entity', 'Limit', anyReceived ? 'Received / projected' : 'Projected', 'Remaining', 'Status'].map((h, i) => <th key={h} className={`${i >= 1 && i <= 3 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>)}</tr></thead>
                  <tbody>
                    {limitRows.map((l) => (
                      <tr key={l.entity.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-semibold">{l.entity.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(l.limit)} <span className="text-xs text-slate-400">({l.persons} × {fmtUsd(l.perPerson)})</span></td>
                        <td className={`px-3 py-2 text-right tabular-nums ${toneText(l.pct > 1 ? 'unfavorable' : l.pct > 0.8 ? 'warning' : 'neutral')}`}>
                          {fmtUsd(l.projTotal)}
                          {anyReceived && Math.abs(l.projOnly - l.projTotal) >= 0.5 && <div className="text-[10px] font-normal text-slate-500">projected {fmtUsd(l.projOnly)}</div>}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${l.remaining < 0 ? toneText('unfavorable') : ''}`}>{fmtUsd(l.remaining)}</td>
                        <td className="px-3 py-2">
                          {l.pct > 1 ? <span className="text-xs rounded-full bg-red-100 text-red-800 px-2 py-0.5">Exceeds limit</span>
                            : l.pct > 0.8 ? <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Approaching limit</span>
                            : <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Under limit</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-500 mt-2">Projections are not capped. FSA applies any actual payment reductions when limits are exceeded.</p>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function StatusChip({ status }: { status: ReceivedVsProjected['status'] }) {
  const cls = status === 'paid' ? 'bg-green-100 text-green-800'
    : status === 'paid_no_projection' ? 'bg-sky-100 text-sky-800'
      : status === 'projected_not_on_statement' ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-600'
  return <span className={`ml-1 rounded-full px-1.5 py-0.5 whitespace-nowrap ${cls}`}>{RECEIVED_STATUS_LABEL[status]}</span>
}

function StatementsTab({ actuals, entities, farms, yearTotals, canDelete, onDeleted }: {
  actuals: GovernmentActuals
  entities: Entity[]
  farms: Farm[]
  yearTotals: ReturnType<typeof calendarYearTotals>
  canDelete: boolean
  onDeleted: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [err, setErr] = useState<string | null>(null)
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const byStatement = useMemo(() => {
    const m = new Map<string, { lines: number; years: Set<number>; farms: Set<string>; programs: Set<string> }>()
    for (const l of actuals.lines) {
      const cur = m.get(l.statement_id) ?? { lines: 0, years: new Set<number>(), farms: new Set<string>(), programs: new Set<string>() }
      cur.lines += 1
      if (l.program_year != null) cur.years.add(l.program_year)
      if (l.farm_id) cur.farms.add(l.farm_id)
      cur.programs.add(PROGRAM_CODE_LABEL[l.program_code])
      m.set(l.statement_id, cur)
    }
    return m
  }, [actuals.lines])
  void farmById
  if (actuals.statements.length === 0) {
    return <EmptyState message="No FSA payment statements uploaded yet." linkHref="/reports/government-payments" linkLabel="Upload one on the Upload tab" role={canDelete ? 'owner' : 'viewer'} />
  }
  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-red-600">{err}</p>}
      <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
        <h2 className="font-bold text-lg mb-2">FSA payment statements</h2>
        <table className="min-w-full text-sm border-collapse">
          <thead className={theadCls}>
            <tr>
              <th className="text-left px-2 py-1">Statement date</th><th className="text-left px-2 py-1">Payee</th><th className="text-left px-2 py-1">Office</th>
              <th className="text-right px-2 py-1">Gross</th><th className="text-right px-2 py-1">Net</th><th className="text-right px-2 py-1">Lines</th>
              <th className="text-left px-2 py-1">Program years</th><th className="text-left px-2 py-1">Programs</th><th className="text-left px-2 py-1 no-print">Document</th><th className="no-print" />
            </tr>
          </thead>
          <tbody>
            {actuals.statements.map((s) => {
              const b = byStatement.get(s.id)
              return (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="px-2 py-1 whitespace-nowrap"><Link href={`/reports/government-payments/statements/${s.id}`} className="text-brand-deep font-semibold underline">{fmtDate(s.statement_date)}</Link></td>
                  <td className="px-2 py-1">{s.payee_entity_id ? entityById.get(s.payee_entity_id)?.name ?? s.payee_name : s.payee_name}</td>
                  <td className="px-2 py-1 text-slate-600">{s.office_name ?? '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtUsd(Number(s.gross_payment), 2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums font-semibold">{fmtUsd(Number(s.net_payment), 2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{b?.lines ?? 0}</td>
                  <td className="px-2 py-1">{b ? [...b.years].sort().join(', ') : '—'}</td>
                  <td className="px-2 py-1">{b ? [...b.programs].join(', ') : '—'}</td>
                  <td className="px-2 py-1 no-print">{s.document_url ? <a href={s.document_url} target="_blank" rel="noreferrer" className="underline text-brand-deep">PDF</a> : <span className="text-slate-400">none</span>}</td>
                  <td className="px-2 py-1 no-print"><Link href={`/reports/government-payments/statements/${s.id}`} className="inline-flex items-center min-h-10 px-2 rounded-lg text-brand-deep text-xs font-semibold hover:bg-slate-100">Open</Link></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {yearTotals.length > 0 && (
        <section className="bg-white rounded-xl shadow p-4 avoid-break">
          <h2 className="font-bold text-lg mb-1">FSA payments received by calendar year</h2>
          <p className="text-xs text-slate-500 mb-2">Every statement line&apos;s net, in the year of its payment date — the figure to reconcile against the 1099-G.</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {yearTotals.map((t) => (
              <li key={`${t.year}-${t.payeeEntityId ?? t.payeeName}`} className="py-1.5 flex items-baseline gap-3">
                <span className="flex-1">FSA payments received in <b>{t.year}</b> by <b>{t.payeeEntityId ? entityById.get(t.payeeEntityId)?.name ?? t.payeeName : t.payeeName}</b></span>
                <span className="text-xs text-slate-500">{t.lines} line{t.lines === 1 ? '' : 's'}</span>
                <span className="font-bold tabular-nums">{fmtUsd(t.net)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="hidden">{String(supabase != null)}{String(setErr != null)}</p>
    </div>
  )
}

function FarmDetail({ farmRow, commodityById, otherForFarm, crops, programCfg, statements }: {
  farmRow: { farm: Farm; byCommodity: Map<string, ProjectedPayment>; rvpByCommodity: Map<string, ReceivedVsProjected>; other: number }
  commodityById: Map<string, CoveredCommodity>
  otherForFarm: OtherGovernmentPayment[]
  crops: Crop[]
  programCfg: ResolvedProgramConfig
  statements: GovernmentActuals['statements']
}) {
  const Line = ({ label, value, tone }: { label: string; value: string; tone?: Tone }) => (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-0.5"><span className="text-slate-500">{label}</span><span className={`tabular-nums ${tone ? toneText(tone) : ''}`}>{value}</span></div>
  )
  const stmtById = new Map(statements.map((s) => [s.id, s]))
  const commodityIds = new Set<string>([...farmRow.byCommodity.keys(), ...farmRow.rvpByCommodity.keys()])
  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-4 avoid-break">
      <h3 className="font-bold">{farmRow.farm.name} — calculation detail</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        {[...commodityIds].map((cid) => {
          const p = farmRow.byCommodity.get(cid) ?? null
          const v = farmRow.rvpByCommodity.get(cid) ?? null
          const commodity = commodityById.get(cid)!
          const arcD = p?.result.arcDetail ?? null
          const factor = p?.election === 'ARC_IC' ? programCfg.arcIcPaymentFactor : programCfg.paymentFactor
          const unitLabel = commodity.unit === 'pound' ? 'lb' : 'bu'
          return (
            <div key={cid}>
              <div className="font-semibold mb-1">
                {commodity.name}{p ? <> — {ELECTION_LABEL[p.election]}</> : null}
                {p?.result.arcMethod === 'engine' && <span className="ml-1 text-[10px] rounded-full bg-sky-100 text-sky-800 px-1.5 py-0.5">county figures</span>}
                {p?.result.arcMethod === 'flat' && <span className="ml-1 text-[10px] rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5">flat estimate</span>}
                {v && <span className="ml-1 text-[10px]"><StatusChip status={v.status} /></span>}
              </div>
              {p && (
                <>
                  {p.higherOf && (
                    <Line label={`${ELECTION_LABEL[p.electedProgram]} elected · higher-of year: PLC ${fmtUsd(p.higherOf.plc)} vs ARC-CO ${fmtUsd(p.higherOf.arcCo)}`} value={`pays ${ELECTION_LABEL[p.election]}`} />
                  )}
                  <Line label="Base acres" value={fmtInt(p.baseAcres)} />
                  {p.producerShare !== 1 && (
                    <Line label={`Producer share (share-rent farm, landlord keeps ${Math.round((1 - p.producerShare) * 100)}%)`} value={`${Math.round(p.producerShare * 100)}% → pays on ${fmtNum(p.baseAcres * p.producerShare, 1)} ac`} />
                  )}
                  <Line label="Effective reference price" value={fmtPrice(p.result.effectiveReferencePrice)} />
                  {p.election === 'PLC' ? (
                    <>
                      <Line label="MYA price" value={p.result.myaPrice != null ? fmtPrice(p.result.myaPrice) : 'needs the marketing-year price'} />
                      <Line label="Effective price (floored at loan)" value={p.result.effectivePrice != null ? fmtPrice(p.result.effectivePrice) : '—'} />
                      <Line label="Payment rate/unit" value={fmtPrice(p.result.paymentRatePerUnit)} />
                      <Line label="PLC yield" value={String(p.plcYield)} />
                      <Line label="Gross/acre = rate × yield" value={`$${p.result.grossPerAcre.toFixed(2)}`} />
                    </>
                  ) : arcD ? (
                    <>
                      <Line label="MYA price" value={p.result.myaPrice != null ? fmtPrice(p.result.myaPrice) : 'needs the marketing-year price'} />
                      <Line label={`Benchmark revenue (${fmtPrice(arcD.benchmarkPrice)} × ${arcD.benchmarkYield})`} value={`$${arcD.benchmarkRevenue.toFixed(2)}/ac`} />
                      <Line label={`Guarantee (${Math.round(arcD.guaranteePct * 100)}%)`} value={`$${arcD.guarantee.toFixed(2)}/ac`} />
                      <Line label={`Actual county revenue (${arcD.actualCountyYield} yd${arcD.countyYieldVsBenchmarkPct !== 0 ? `, ${arcD.countyYieldVsBenchmarkPct > 0 ? '+' : ''}${arcD.countyYieldVsBenchmarkPct}% vs benchmark` : ''})`} value={`$${arcD.actualRevenue.toFixed(2)}/ac`} />
                      <Line label={`Payment rate/acre${arcD.capped ? ` (capped at ${Math.round(arcD.capPct * 100)}% = $${arcD.maxRatePerAcre.toFixed(2)})` : ''}`} value={`$${p.result.grossPerAcre.toFixed(2)}`} />
                    </>
                  ) : (
                    <Line label="Projected rate/acre (flat)" value={`$${p.result.grossPerAcre.toFixed(2)}`} />
                  )}
                  <Line label="Gross payment" value={fmtUsd(p.result.gross)} />
                  <Line label={`× ${factor} base factor × (1 − ${(programCfg.sequestrationPct * 100).toFixed(1)}% sequestration)`} value={fmtUsd(p.result.net)} />
                  <Line label="Projected net payment" value={fmtUsd(p.result.net)} />
                </>
              )}
              {v && v.received != null && (
                <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 p-2 space-y-0.5">
                  <div className="text-xs font-semibold text-slate-700 mb-1">Received — {v.paidProgram ? PROGRAM_CODE_LABEL[v.paidProgram] : 'program unknown'}{v.paymentDates.length > 0 ? ` · paid ${v.paymentDates.map((d) => fmtDate(d)).join(', ')}` : ''}</div>
                  <Line label="Received (statement crop amount)" value={fmtUsd(v.received, 2)} tone="favorable" />
                  {p && <Line label="Variance vs projected" value={`${fmtUsd(v.variance ?? 0, 2)}${v.variancePct != null ? ` (${fmtPct(v.variancePct * 100, 1)})` : ''}`} tone={varianceTone(v.variance)} />}
                  {v.implied && (
                    <>
                      <Line
                        label={v.implied.program === 'PLC' ? `Implied PLC rate = ${fmtUsd(v.received, 2)} ÷ ((1 − ${(v.implied.sequesterPct * 100).toFixed(1)}%) × ${factor} × ${acresText(v)} × ${v.plcYield} ${unitLabel}/ac = ${fmtInt(v.implied.denominator)})` : `Implied ARC rate per base acre = ${fmtUsd(v.received, 2)} ÷ ((1 − ${(v.implied.sequesterPct * 100).toFixed(1)}%) × ${factor} × ${acresText(v)} = ${v.implied.denominator.toFixed(2)})`}
                        value={v.implied.program === 'PLC' ? `$${v.implied.implied.toFixed(4)}/${unitLabel}` : `$${v.implied.implied.toFixed(2)}/ac`}
                      />
                      <Line label="Projected rate on the same basis" value={v.implied.projected != null ? (v.implied.program === 'PLC' ? `$${v.implied.projected.toFixed(4)}/${unitLabel}` : `$${v.implied.projected.toFixed(2)}/ac`) : `projected under ${v.projectedProgram ? ELECTION_LABEL[v.projectedProgram] : '—'}`} />
                      {v.implied.statementRate != null && (
                        <Line label="Rate FSA paid the other farms on the statements" value={v.implied.program === 'PLC' ? `$${v.implied.statementRate.toFixed(4)}/${unitLabel}` : `$${v.implied.statementRate.toFixed(2)}/ac`} />
                      )}
                      {v.shareOfFarmPaid != null && v.cause === 'ACRES_YIELD' && (
                        <Line label="Paid, as a share of what this farm's base data would pay at that rate" value={fmtPct(v.shareOfFarmPaid * 100, 1)} tone="warning" />
                      )}
                    </>
                  )}
                  {v.cause && <Line label="Variance attributed to" value={VARIANCE_CAUSE_LABEL[v.cause]} tone={v.cause === 'PROGRAM' ? 'warning' : 'neutral'} />}
                  {v.receivedDetail && (
                    <div className="text-xs text-slate-500 pt-1">
                      {v.receivedDetail.lines.map((l) => {
                        const s = stmtById.get(l.statementId)
                        return <span key={l.lineId} className="mr-3">FSA Payment ID {l.fsaPaymentId}{s ? <> · <Link href={`/reports/government-payments/statements/${s.id}`} className="underline">statement {fmtDate(s.statement_date)}</Link></> : null}</span>
                      })}
                    </div>
                  )}
                </div>
              )}
              {v && v.received == null && <div className="mt-1 text-xs text-slate-500">{RECEIVED_STATUS_LABEL[v.status]}.</div>}
            </div>
          )
        })}
      </div>
      {otherForFarm.length > 0 && (
        <div className="text-sm">
          <div className="font-semibold mb-1">Other payments</div>
          {otherForFarm.map((o) => (
            <div key={o.id} className="flex justify-between gap-4 border-b border-slate-100 py-0.5">
              <span className="text-slate-500">{o.program_name}{o.crop_id ? ` · ${crops.find((c) => c.id === o.crop_id)?.name ?? ''}` : ''} ({o.payment_status}){o.fsa_payment_line_id ? ' · from an FSA statement' : ''}</span>
              <span className="tabular-nums">{fmtUsd(o.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
