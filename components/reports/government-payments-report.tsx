'use client'

// Government Payments tracker. For a crop year: one row per farm with a column
// per covered commodity (base acres + election + projected net payment), the
// farm's other USDA payments, and a grand total — plus per-entity payment-limit
// status and an expandable per-farm calculation breakdown. ARC-CO rows run the
// same county-revenue engine as the Decision Aid (shared projectPayments /
// computeCommodityPayment — the two pages agree to the cent), with a badge
// when the payment-rate cap binds.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useLiveMyaDetailed } from '@/lib/use-live-mya'
import EntityFilter from '@/components/entity-filter'
import MyaPricePanel from '@/components/reports/mya-price-panel'
import CountyYieldExpectation from '@/components/government/county-yield-expectation'
import {
  projectPayments, applyMyaResolution, ELECTION_LABEL, paymentLimitTotal,
  type ProjectedPayment,
} from '@/lib/government-payments'
import { resolveProgramYearConfig, programConfigNotice, type ResolvedProgramConfig } from '@/lib/program-config'
import { fmtPrice } from '@/lib/hedging'
import {
  SummaryCards, EmptyState, theadCls, grandTotalRowCls, toneText,
  type SummaryCardData,
} from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload, type ExportCell } from '@/lib/exports'
import type {
  Farm, Entity, County, Crop, FieldPlanting, CoveredCommodity, FarmBaseAcres, ArcPlcElection,
  ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment, PaymentLimitConfig, ProgramYearConfig,
  ArcBenchmarkData, MyaMonthlyPrice,
} from '@/lib/types'

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const usd = (n: number | null | undefined, d = 0) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`

export default function GovernmentPaymentsReport({ onPayloadChange }: Props) {
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
  const [limits, setLimits] = useState<PaymentLimitConfig[]>([])
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [benchmarks, setBenchmarks] = useState<ArcBenchmarkData[]>([])
  const [monthlyPrices, setMonthlyPrices] = useState<MyaMonthlyPrice[]>([])
  const [cropYear, setCropYear] = usePersistentState<number | ''>('gov-pay:cropYear', '')
  const [entityId, setEntityId] = usePersistentState('gov-pay:entity', '')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    ;(async () => {
      const [fa, en, cr, pl, cc, ba, el, pd, pay, op, lim, pc, co, bm, mp] = await Promise.all([
        supabase.from('farms').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('field_plantings').select('*'),
        supabase.from('covered_commodities').select('*').order('name'),
        supabase.from('farm_base_acres').select('*'),
        supabase.from('arc_plc_elections').select('*'),
        supabase.from('arc_plc_price_data').select('*'),
        supabase.from('arc_plc_payments').select('*'),
        supabase.from('other_government_payments').select('*'),
        supabase.from('payment_limit_config').select('*'),
        supabase.from('program_year_config').select('*'),
        supabase.from('counties').select('*').order('name'),
        supabase.from('arc_benchmark_data').select('*'),
        supabase.from('mya_monthly_prices').select('*'),
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
      setLimits((lim.data as PaymentLimitConfig[]) || [])
      setProgramConfigs((pc.data as ProgramYearConfig[]) || [])
      setCounties((co.data as County[]) || [])
      setBenchmarks((bm.data as ArcBenchmarkData[]) || [])
      setMonthlyPrices((mp.data as MyaMonthlyPrice[]) || [])
      const yrs = (el.data as ArcPlcElection[] | null)?.map((e) => e.crop_year) ?? []
      if (yrs.length > 0) setCropYear((cy) => (cy === '' ? Math.max(...yrs) : cy))
      else setCropYear((cy) => (cy === '' ? new Date().getFullYear() : cy))
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const commodityById = useMemo(() => new Map(commodities.map((c) => [c.id, c])), [commodities])
  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...plantings.map((p) => p.season_year), ...elections.map((e) => e.crop_year), new Date().getFullYear()], cropYear === '' ? null : cropYear),
    [plantings, elections, cropYear],
  )

  // Live MYA estimates — the marketing-year blend (shared hook — resets on
  // year change so a failed refetch never leaves last year's prices in play).
  const { prices: liveMya, details: liveDetails, refresh: refreshEstimates } = useLiveMyaDetailed(cropYear, commodities)

  // Stored price data with the SHARED per-commodity MYA resolution applied
  // (manual override > published final > WASDE > live/stored estimate) — the
  // same function the Decision Aid reads, so both pages project the same
  // payments.
  const effectivePriceData = useMemo(() => {
    if (cropYear === '') return priceData
    return applyMyaResolution({ cropYear, commodities, priceData, liveEstimates: liveMya })
  }, [priceData, liveMya, cropYear, commodities])

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
    () => resolveProgramYearConfig(cropYear === '' ? new Date().getFullYear() : cropYear, programConfigs),
    [cropYear, programConfigs],
  )
  const programNotice = cropYear === '' ? null : programConfigNotice(programCfg)

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  // county_id is what disambiguates same-named counties across states; the
  // name rides along as the fallback for legacy benchmark rows.
  const farmCountyList = useMemo(
    () => farms.map((f) => ({
      id: f.id,
      county: f.county_id ? (countyById.get(f.county_id)?.name ?? null) : null,
      county_id: f.county_id ?? null,
    })),
    [farms, countyById],
  )

  // Project all farm × commodity payments for the year — same engine and same
  // inputs as the Decision Aid.
  const projected: ProjectedPayment[] = useMemo(() => {
    if (cropYear === '') return []
    return projectPayments({
      cropYear, baseAcres, commodities, elections, priceData: effectivePriceData, payments,
      benchmarks, farms: farmCountyList,
      sequestrationPct: programCfg.sequestrationPct,
      paymentFactor: programCfg.paymentFactor,
      arcGuaranteePct: programCfg.arcGuaranteePct,
      arcPaymentCapPct: programCfg.arcPaymentCapPct,
      arcIcPaymentFactor: programCfg.arcIcPaymentFactor,
    })
  }, [cropYear, baseAcres, commodities, elections, effectivePriceData, payments, benchmarks, farmCountyList, programCfg])

  // Only eligible (assigned) base drives the payment columns; unassigned base is
  // excluded from this report entirely.
  const eligibleBase = useMemo(() => baseAcres.filter((b) => !b.is_unassigned && b.commodity_id), [baseAcres])

  // Commodities that have eligible base acres on any farm — the dynamic columns.
  const shownCommodities = useMemo(() => {
    const ids = new Set(eligibleBase.map((b) => b.commodity_id))
    return commodities.filter((c) => ids.has(c.id))
  }, [eligibleBase, commodities])

  // Farms that have any eligible base acres, scoped to the selected entity.
  const shownFarms = useMemo(() => {
    const ids = new Set(eligibleBase.map((b) => b.farm_id))
    return farms.filter((f) => ids.has(f.id) && (!entityId || f.entity_id === entityId)).sort((a, b) => a.name.localeCompare(b.name))
  }, [farms, eligibleBase, entityId])

  // (farmId|commodityId) -> projected payment.
  const projByKey = useMemo(() => new Map(projected.map((p) => [`${p.farmId}|${p.commodityId}`, p])), [projected])

  const yearOther = useMemo(() => otherPayments.filter((o) => o.crop_year === cropYear), [otherPayments, cropYear])
  const otherByFarm = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of yearOther) if (o.farm_id) m.set(o.farm_id, (m.get(o.farm_id) ?? 0) + Number(o.amount))
    return m
  }, [yearOther])
  const nonFarmOther = useMemo(() => yearOther.filter((o) => !o.farm_id).reduce((s, o) => s + Number(o.amount), 0), [yearOther])

  type FarmRow = { farm: Farm; arcPlcTotal: number; other: number; total: number; byCommodity: Map<string, ProjectedPayment> }
  const farmRows: FarmRow[] = useMemo(() => {
    return shownFarms.map((farm) => {
      const byCommodity = new Map<string, ProjectedPayment>()
      let arcPlcTotal = 0
      for (const c of shownCommodities) {
        const p = projByKey.get(`${farm.id}|${c.id}`)
        if (p) { byCommodity.set(c.id, p); arcPlcTotal += p.result.net }
      }
      const other = otherByFarm.get(farm.id) ?? 0
      return { farm, arcPlcTotal, other, total: arcPlcTotal + other, byCommodity }
    })
  }, [shownFarms, shownCommodities, projByKey, otherByFarm])

  const totals = useMemo(() => {
    const byCommodity = new Map<string, number>()
    let arcPlc = 0, other = 0
    for (const r of farmRows) {
      for (const [cid, p] of r.byCommodity) byCommodity.set(cid, (byCommodity.get(cid) ?? 0) + p.result.net)
      arcPlc += r.arcPlcTotal
      other += r.other
    }
    other += nonFarmOther
    return { byCommodity, arcPlc, other, grand: arcPlc + other }
  }, [farmRows, nonFarmOther])

  // Headline summary straight from the already-computed totals (no new math).
  const summaryCards: SummaryCardData[] = useMemo(() => [
    { label: 'Total ARC/PLC', value: usd(totals.arcPlc), tone: 'favorable' },
    { label: 'Other USDA', value: usd(totals.other) },
    { label: 'Grand Total', value: usd(totals.grand), tone: 'favorable', sub: `${shownFarms.length} farm${shownFarms.length === 1 ? '' : 's'}` },
  ], [totals, shownFarms])

  // Per-entity payment-limit status: sum ARC/PLC for that entity's farms + the
  // entity's other payments (farm-specific and not).
  const limitRows = useMemo(() => {
    return entities.filter((e) => !entityId || e.id === entityId).map((e) => {
      const entityFarms = new Set(farms.filter((f) => f.entity_id === e.id).map((f) => f.id))
      let projTotal = 0
      for (const r of farmRows) if (entityFarms.has(r.farm.id)) projTotal += r.arcPlcTotal
      for (const o of yearOther) if (o.entity_id === e.id) projTotal += Number(o.amount)
      const cfg = limits.find((l) => l.entity_id === e.id && l.crop_year === cropYear)
      const persons = cfg?.eligible_persons ?? 1
      const perPerson = cfg ? Number(cfg.per_person_limit) : programCfg.perPersonPaymentLimit
      const limit = paymentLimitTotal(persons, perPerson)
      return { entity: e, persons, perPerson, limit, projTotal, remaining: limit - projTotal, pct: limit > 0 ? projTotal / limit : 0 }
    }).filter((r) => r.projTotal > 0 || limits.some((l) => l.entity_id === r.entity.id && l.crop_year === cropYear))
  }, [entities, farms, farmRows, yearOther, limits, cropYear, entityId, programCfg])

  function toggle(id: string) { setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }) }

  function buildExportPayload(): ExportPayload {
    const cols: ExportPayload['sections'][number]['columns'] = [{ label: 'Farm' }, { label: 'FSA #' }, { label: 'Entity' }]
    // Per commodity: base acres, the farm's election (PLC / ARC-CO — shown under
    // each cell on screen), and the projected net payment.
    for (const c of shownCommodities) {
      cols.push({ label: `${c.name} Base Ac`, align: 'right', format: 'int' })
      cols.push({ label: `${c.name} Election` })
      cols.push({ label: `${c.name} Payment`, align: 'right', format: 'usd0' })
    }
    cols.push({ label: 'Total ARC/PLC', align: 'right', format: 'usd0' }, { label: 'Other', align: 'right', format: 'usd0' }, { label: 'Total Govt', align: 'right', format: 'usd0' })
    const rows: ExportCell[][] = farmRows.map((r) => {
      const cells: ExportCell[] = [r.farm.name, r.farm.fsa_number ?? '', entityById.get(r.farm.entity_id ?? '')?.name ?? '']
      for (const c of shownCommodities) {
        const p = r.byCommodity.get(c.id)
        cells.push(p ? Math.round(p.baseAcres) : '')
        cells.push(p ? ELECTION_LABEL[p.election] : '')
        cells.push(p ? Math.round(p.result.net) : '')
      }
      cells.push(Math.round(r.arcPlcTotal), Math.round(r.other), Math.round(r.total))
      return cells
    })
    const totalRow: ExportCell[] = ['Total', '', '']
    for (const c of shownCommodities) { totalRow.push('', ''); totalRow.push(Math.round(totals.byCommodity.get(c.id) ?? 0)) }
    totalRow.push(Math.round(totals.arcPlc), Math.round(totals.other), Math.round(totals.grand))
    rows.push(totalRow)

    const sections: ExportPayload['sections'] = [
      { title: 'Projected Payments by Farm', columns: cols, rows, rowMeta: [...farmRows.map(() => 'data' as const), 'total'] },
    ]

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
          { label: 'Projected', align: 'right', format: 'usd0' },
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

    return {
      title: 'Government Payment Tracker',
      filters: `Crop year: ${cropYear || '—'}${entityId ? ` · Entity: ${entityById.get(entityId)?.name ?? ''}` : ''}`,
      summary: [
        { label: 'Total ARC/PLC', value: formatNumber(totals.arcPlc, 'usd0'), tone: 'favorable' },
        { label: 'Other USDA', value: formatNumber(totals.other, 'usd0') },
        { label: 'Grand Total', value: formatNumber(totals.grand, 'usd0'), tone: 'favorable', sub: `${shownFarms.length} farm${shownFarms.length === 1 ? '' : 's'}` },
      ],
      sections,
    }
  }
  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmRows, totals, shownCommodities, limitRows, cropYear, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  if (loading) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4 print-area">
      <div className="flex flex-wrap gap-3 items-end no-print">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year *</span>
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <EntityFilter entities={entities} value={entityId} onChange={setEntityId} />
      </div>

      {programNotice && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-300 px-3 py-2 text-sm text-yellow-900">
          {programNotice}
        </div>
      )}

      {cropYear !== '' && farmRows.length === 0 && (
        <EmptyState message="No base acres on file." linkHref="/settings/government-payments" linkLabel="Add base acres" />
      )}

      {cropYear !== '' && farmRows.length > 0 && (
        <>
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 no-print">
            <strong>Projected</strong> — PLC from current MYA estimates; ARC-CO from the county-revenue engine
            ({Math.round(programCfg.arcGuaranteePct * 100)}% guarantee, capped at {Math.round(programCfg.arcPaymentCapPct * 100)}% of
            benchmark revenue) where benchmark data exists, else your flat $/acre estimate. FSA determines final
            payments after the marketing year.
          </div>

          <SummaryCards cards={summaryCards} />

          {/* Per-commodity MYA — the same shared resolution the Decision Aid
              reads; toggling Auto/Manual here updates every projection below. */}
          <MyaPricePanel
            cropYear={cropYear}
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
            cropYear={cropYear}
            commodities={shownCommodities}
            farms={farms}
            counties={counties}
            baseAcres={baseAcres}
            benchmarks={benchmarks}
            onChanged={refreshPriceData}
          />

          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">Government Payment Tracker — {cropYear}</h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  <th className="text-left px-2 py-1">Farm</th><th className="text-left px-2 py-1">FSA #</th><th className="text-left px-2 py-1">Entity</th>
                  {shownCommodities.map((c) => <th key={c.id} className="text-right px-2 py-1 whitespace-nowrap">{c.name}</th>)}
                  <th className="text-right px-2 py-1 whitespace-nowrap">Total ARC/PLC</th>
                  <th className="text-right px-2 py-1 whitespace-nowrap">Other</th>
                  <th className="text-right px-2 py-1 whitespace-nowrap">Total Govt</th>
                  <th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {farmRows.map((r) => (
                  <tr key={r.farm.id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-1 font-semibold">{r.farm.name}</td>
                    <td className="px-2 py-1 font-mono text-xs">{r.farm.fsa_number ?? ''}</td>
                    <td className="px-2 py-1">{entityById.get(r.farm.entity_id ?? '')?.name ?? '—'}</td>
                    {shownCommodities.map((c) => {
                      const p = r.byCommodity.get(c.id)
                      if (!p) return <td key={c.id} className="px-2 py-1 text-right tabular-nums text-slate-300">—</td>
                      return (
                        <td key={c.id} className={`px-2 py-1 text-right tabular-nums ${p.result.net > 0 ? '' : 'text-slate-400'}`}>
                          <div className="font-mono">{usd(p.result.net)}</div>
                          <div className="text-[10px] text-slate-500">
                            {Number(p.baseAcres).toLocaleString()} ac · {ELECTION_LABEL[p.election]}
                            {p.result.arcMethod === 'engine' && p.result.arcDetail?.capped && (
                              <span className="ml-1 rounded-full bg-violet-100 text-violet-800 px-1.5 py-0.5 whitespace-nowrap">capped at {Math.round(p.result.arcDetail.capPct * 100)}%</span>
                            )}
                            {p.result.arcMethod === 'flat' && p.result.computable && (
                              <span className="ml-1 rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5 whitespace-nowrap" title="No county benchmark data — flat $/acre estimate">flat est.</span>
                            )}
                          </div>
                        </td>
                      )
                    })}
                    <td className="px-2 py-1 text-right font-mono font-semibold tabular-nums">{usd(r.arcPlcTotal)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(r.other)}</td>
                    <td className="px-2 py-1 text-right font-mono font-bold tabular-nums">{usd(r.total)}</td>
                    <td className="px-2 py-1 no-print"><button onClick={() => toggle(r.farm.id)} className="text-sky-700 text-xs">{expanded.has(r.farm.id) ? 'Hide' : 'Detail'}</button></td>
                  </tr>
                ))}
                <tr className={grandTotalRowCls}>
                  <td className="px-2 py-1" colSpan={3}>Total</td>
                  {shownCommodities.map((c) => <td key={c.id} className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.byCommodity.get(c.id) ?? 0)}</td>)}
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.arcPlc)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.other)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{usd(totals.grand)}</td>
                  <td className="no-print" />
                </tr>
              </tbody>
            </table>
            {nonFarmOther > 0 && <p className="text-xs text-slate-500 mt-2">Includes {usd(nonFarmOther)} of non-farm-specific other payments in the Other total.</p>}
          </section>

          {/* Per-farm detail */}
          {farmRows.filter((r) => expanded.has(r.farm.id)).map((r) => (
            <FarmDetail key={r.farm.id} farmRow={r} commodityById={commodityById} otherForFarm={yearOther.filter((o) => o.farm_id === r.farm.id)} crops={crops} programCfg={programCfg} />
          ))}

          {/* Payment limits */}
          {limitRows.length > 0 && (
            <section className="bg-white rounded-xl shadow p-4 avoid-break">
              <h2 className="font-bold text-lg mb-2">Payment Limit Status</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600"><tr>{['Entity', 'Limit', 'Projected', 'Remaining', 'Status'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
                  <tbody>
                    {limitRows.map((l) => (
                      <tr key={l.entity.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-semibold">{l.entity.name}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{usd(l.limit)} <span className="text-xs text-slate-400">({l.persons} × {usd(l.perPerson)})</span></td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${toneText(l.pct > 1 ? 'unfavorable' : l.pct > 0.8 ? 'warning' : 'neutral')}`}>{usd(l.projTotal)}</td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${l.remaining < 0 ? 'text-red-700' : ''}`}>{usd(l.remaining)}</td>
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

function FarmDetail({ farmRow, commodityById, otherForFarm, crops, programCfg }: {
  farmRow: { farm: Farm; byCommodity: Map<string, ProjectedPayment>; other: number }
  commodityById: Map<string, CoveredCommodity>
  otherForFarm: OtherGovernmentPayment[]
  crops: Crop[]
  programCfg: ResolvedProgramConfig
}) {
  const Line = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-0.5"><span className="text-slate-500">{label}</span><span className="font-mono">{value}</span></div>
  )
  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-4 avoid-break">
      <h3 className="font-bold">{farmRow.farm.name} — calculation detail</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        {[...farmRow.byCommodity.values()].map((p) => {
          const commodity = commodityById.get(p.commodityId)!
          const arcD = p.result.arcDetail
          const factor = p.election === 'ARC_IC' ? programCfg.arcIcPaymentFactor : programCfg.paymentFactor
          return (
            <div key={p.commodityId}>
              <div className="font-semibold mb-1">
                {commodity.name} — {ELECTION_LABEL[p.election]}
                {p.result.arcMethod === 'engine' && <span className="ml-1 text-[10px] rounded-full bg-sky-100 text-sky-800 px-1.5 py-0.5">county engine</span>}
                {p.result.arcMethod === 'flat' && <span className="ml-1 text-[10px] rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5">flat estimate</span>}
              </div>
              <Line label="Base acres" value={p.baseAcres.toLocaleString()} />
              <Line label="Effective reference price" value={fmtPrice(p.result.effectiveReferencePrice)} />
              {p.election === 'PLC' ? (
                <>
                  <Line label="MYA price" value={p.result.myaPrice != null ? fmtPrice(p.result.myaPrice) : 'needs MYA'} />
                  <Line label="Effective price (floored at loan)" value={p.result.effectivePrice != null ? fmtPrice(p.result.effectivePrice) : '—'} />
                  <Line label="Payment rate/unit" value={fmtPrice(p.result.paymentRatePerUnit)} />
                  <Line label="PLC yield" value={String(p.plcYield)} />
                  <Line label="Gross/acre = rate × yield" value={`$${p.result.grossPerAcre.toFixed(2)}`} />
                </>
              ) : arcD ? (
                <>
                  <Line label="MYA price" value={p.result.myaPrice != null ? fmtPrice(p.result.myaPrice) : 'needs MYA'} />
                  <Line label={`Benchmark revenue (${fmtPrice(arcD.benchmarkPrice)} × ${arcD.benchmarkYield})`} value={`$${arcD.benchmarkRevenue.toFixed(2)}/ac`} />
                  <Line label={`Guarantee (${Math.round(arcD.guaranteePct * 100)}%)`} value={`$${arcD.guarantee.toFixed(2)}/ac`} />
                  <Line label={`Actual county revenue (${arcD.actualCountyYield} yd${arcD.countyYieldVsBenchmarkPct !== 0 ? `, ${arcD.countyYieldVsBenchmarkPct > 0 ? '+' : ''}${arcD.countyYieldVsBenchmarkPct}% vs benchmark` : ''})`} value={`$${arcD.actualRevenue.toFixed(2)}/ac`} />
                  <Line label={`Payment rate/acre${arcD.capped ? ` (capped at ${Math.round(arcD.capPct * 100)}% = $${arcD.maxRatePerAcre.toFixed(2)})` : ''}`} value={`$${p.result.grossPerAcre.toFixed(2)}`} />
                </>
              ) : (
                <Line label="Projected rate/acre (flat)" value={`$${p.result.grossPerAcre.toFixed(2)}`} />
              )}
              <Line label="Gross payment" value={`$${p.result.gross.toLocaleString()}`} />
              <Line label={`× ${factor} base factor × (1 − ${(programCfg.sequestrationPct * 100).toFixed(1)}% seq.)`} value={`$${p.result.net.toLocaleString()}`} />
              <Line label="Net payment" value={`$${p.result.net.toLocaleString()}`} />
            </div>
          )
        })}
      </div>
      {otherForFarm.length > 0 && (
        <div className="text-sm">
          <div className="font-semibold mb-1">Other payments</div>
          {otherForFarm.map((o) => (
            <div key={o.id} className="flex justify-between gap-4 border-b border-slate-100 py-0.5">
              <span className="text-slate-500">{o.program_name}{o.crop_id ? ` · ${crops.find((c) => c.id === o.crop_id)?.name ?? ''}` : ''} ({o.payment_status})</span>
              <span className="font-mono">${Number(o.amount).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
