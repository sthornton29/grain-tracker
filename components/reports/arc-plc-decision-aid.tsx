'use client'

// ARC/PLC Decision Aid. For each farm × commodity with base acres, projects the
// PLC payment (MYA vs the effective reference price) and the ARC-CO payment
// (the real county-revenue engine: 90% guarantee on benchmark revenue, capped
// at 12% — lib/government-payments.ts computeArcCoPayment) side by side from
// the SAME inputs the Payment Tracker uses (computeCommodityPayment with the
// shared MYA resolution, benchmark data, county yield expectation, and
// program_year_config parameters), recommends the higher one, and lets the
// user set the election. Counties without benchmark data fall back to the
// user-entered flat $/acre estimate, clearly labeled. A What-If MYA slider
// moves BOTH programs (ARC-CO actual county revenue uses the MYA too).

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useLiveMyaDetailed } from '@/lib/use-live-mya'
import EntityFilter from '@/components/entity-filter'
import MyaPricePanel from '@/components/reports/mya-price-panel'
import CountyYieldExpectation from '@/components/government/county-yield-expectation'
import {
  applyMyaResolution, computeCommodityPayment, resolveArcBenchmark, ELECTION_LABEL,
  type CommodityPaymentResult,
} from '@/lib/government-payments'
import { resolveProgramYearConfig, programConfigNotice } from '@/lib/program-config'
import type { ExportPayload } from '@/lib/exports'
import type {
  Farm, Entity, County, FieldPlanting, CoveredCommodity, FarmBaseAcres, ArcPlcElection, ArcPlcPriceData,
  ArcPlcPayment, ArcPlcElectionType, ArcBenchmarkData, MyaMonthlyPrice, ProgramYearConfig,
} from '@/lib/types'
import {
  EmptyState, fmtUsd, numCell, textCell, theadCls, toneText,
} from '@/components/reports/report-kit'

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const usd = (n: number | null | undefined, d = 0) => fmtUsd(n, d)

export default function ArcPlcDecisionAid({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [farms, setFarms] = useState<Farm[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [commodities, setCommodities] = useState<CoveredCommodity[]>([])
  const [baseAcres, setBaseAcres] = useState<FarmBaseAcres[]>([])
  const [elections, setElections] = useState<ArcPlcElection[]>([])
  const [priceData, setPriceData] = useState<ArcPlcPriceData[]>([])
  const [payments, setPayments] = useState<ArcPlcPayment[]>([])
  const [benchmarks, setBenchmarks] = useState<ArcBenchmarkData[]>([])
  const [monthlyPrices, setMonthlyPrices] = useState<MyaMonthlyPrice[]>([])
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])
  const [cropYear, setCropYear] = usePersistentState<number | ''>('arc-plc-aid:cropYear', '')
  const [entityId, setEntityId] = usePersistentState('arc-plc-aid:entity', '')
  const [myaPct, setMyaPct] = useState(0)
  const [detailRow, setDetailRow] = useState<string | null>(null)

  async function refresh() {
    const [fa, en, co, pl, cc, ba, el, pd, pay, bm, mp, pyc] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('counties').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('covered_commodities').select('*').order('name'),
      supabase.from('farm_base_acres').select('*'),
      supabase.from('arc_plc_elections').select('*'),
      supabase.from('arc_plc_price_data').select('*'),
      supabase.from('arc_plc_payments').select('*'),
      supabase.from('arc_benchmark_data').select('*'),
      supabase.from('mya_monthly_prices').select('*'),
      supabase.from('program_year_config').select('*'),
    ])
    setFarms((fa.data as Farm[]) || [])
    setEntities((en.data as Entity[]) || [])
    setCounties((co.data as County[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setCommodities((cc.data as CoveredCommodity[]) || [])
    setBaseAcres((ba.data as FarmBaseAcres[]) || [])
    setElections((el.data as ArcPlcElection[]) || [])
    setPriceData((pd.data as ArcPlcPriceData[]) || [])
    setPayments((pay.data as ArcPlcPayment[]) || [])
    setBenchmarks((bm.data as ArcBenchmarkData[]) || [])
    setMonthlyPrices((mp.data as MyaMonthlyPrice[]) || [])
    setProgramConfigs((pyc.data as ProgramYearConfig[]) || [])
  }
  useEffect(() => {
    ;(async () => { await refresh(); setLoading(false) })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Default the crop year once data loads: latest election year, else this year.
  useEffect(() => {
    if (cropYear !== '' || loading) return
    const yrs = elections.map((e) => e.crop_year)
    setCropYear(yrs.length > 0 ? Math.max(...yrs) : new Date().getFullYear())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, elections])

  const commodityById = useMemo(() => new Map(commodities.map((c) => [c.id, c])), [commodities])
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  const farmCounty = (farmId: string): County | null => {
    const f = farmById.get(farmId)
    return f?.county_id ? (countyById.get(f.county_id) ?? null) : null
  }
  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...plantings.map((p) => p.season_year), ...elections.map((e) => e.crop_year), new Date().getFullYear()], cropYear === '' ? null : cropYear),
    [plantings, elections, cropYear],
  )

  // Live MYA estimates — the marketing-year blend (shared hook; resets on year
  // change so a failed refetch never leaves last year's prices in play).
  const { prices: liveMya, details: liveDetails, refresh: refreshEstimates } = useLiveMyaDetailed(cropYear, commodities)

  // Per-year program parameters (90% guarantee / 12% cap / factors / seq).
  const programCfg = useMemo(
    () => resolveProgramYearConfig(cropYear === '' ? new Date().getFullYear() : cropYear, programConfigs),
    [cropYear, programConfigs],
  )
  const cfgNotice = programConfigNotice(programCfg)

  // The SAME resolved price rows the Payment Tracker feeds projectPayments —
  // then the What-If slider scales the resolved MYA on top (both programs).
  const effectivePriceData = useMemo(() => {
    if (cropYear === '') return []
    const resolved = applyMyaResolution({ cropYear, commodities, priceData, liveEstimates: liveMya })
    if (myaPct === 0) return resolved
    const k = 1 + myaPct / 100
    return resolved.map((p) => p.crop_year !== cropYear ? p : {
      ...p,
      mya_price_final: p.mya_price_final != null ? Number(p.mya_price_final) * k : null,
      mya_price_estimate: p.mya_price_estimate != null ? Number(p.mya_price_estimate) * k : null,
    })
  }, [cropYear, commodities, priceData, liveMya, myaPct])

  const priceFor = (commodityId: string) => effectivePriceData.find((p) => p.commodity_id === commodityId && p.crop_year === cropYear) ?? null

  // Commodities with eligible base acres — the ones whose MYA matters here.
  const shownCommodities = useMemo(() => {
    const ids = new Set(baseAcres.filter((b) => !b.is_unassigned && b.commodity_id).map((b) => b.commodity_id!))
    return commodities.filter((c) => ids.has(c.id))
  }, [baseAcres, commodities])
  function arcRate(farmId: string, commodityId: string | null): number | null {
    if (commodityId == null) return null
    const p = payments.find((x) => x.farm_id === farmId && x.commodity_id === commodityId && x.crop_year === cropYear)
    return p ? Number(p.payment_rate_per_unit) : null
  }
  function electionFor(farmId: string, commodityId: string | null): ArcPlcElectionType {
    if (commodityId == null) return 'PLC'
    return elections.find((e) => e.farm_id === farmId && e.commodity_id === commodityId && e.crop_year === cropYear)?.election ?? 'PLC'
  }

  type Row = {
    base: FarmBaseAcres
    commodity: CoveredCommodity
    farmName: string
    county: string | null
    plc: CommodityPaymentResult
    arc: CommodityPaymentResult
    plcNet: number | null
    arcNet: number | null
    election: ArcPlcElectionType
    favors: 'PLC' | 'ARC' | null
  }
  const rows: Row[] = useMemo(() => {
    if (cropYear === '') return []
    return baseAcres
      .filter((b) => !b.is_unassigned && b.commodity_id && (!entityId || farmById.get(b.farm_id)?.entity_id === entityId))
      .map((b) => {
        const commodity = commodityById.get(b.commodity_id!)
        if (!commodity) return null
        const countyRec = farmCounty(b.farm_id)
        // Resolve on county_id — county names repeat across states; the name
        // is only a fallback for legacy benchmark rows without a county_id.
        const benchmark = resolveArcBenchmark({
          commodityId: b.commodity_id!, cropYear: cropYear as number,
          countyId: countyRec?.id ?? null, county: countyRec?.name ?? null, benchmarks,
        })
        const county = countyRec ? `${countyRec.name}, ${countyRec.state_code}` : null
        const shared = {
          commodity,
          baseAcres: Number(b.base_acres),
          plcYield: Number(b.plc_yield),
          priceData: priceFor(b.commodity_id!),
          arcRatePerAcre: arcRate(b.farm_id, b.commodity_id),
          benchmark,
          sequestrationPct: programCfg.sequestrationPct,
          paymentFactor: programCfg.paymentFactor,
          arcGuaranteePct: programCfg.arcGuaranteePct,
          arcPaymentCapPct: programCfg.arcPaymentCapPct,
          arcIcPaymentFactor: programCfg.arcIcPaymentFactor,
        }
        const plc = computeCommodityPayment({ ...shared, election: 'PLC' })
        const arc = computeCommodityPayment({ ...shared, election: 'ARC_CO' })
        const plcNet = plc.computable ? plc.net : null
        const arcNet = arc.computable ? arc.net : null
        const favors: 'PLC' | 'ARC' | null = plcNet != null && arcNet != null ? (plcNet >= arcNet ? 'PLC' : 'ARC') : plcNet != null ? 'PLC' : arcNet != null ? 'ARC' : null
        return { base: b, commodity, farmName: farmById.get(b.farm_id)?.name ?? '—', county, plc, arc, plcNet, arcNet, election: electionFor(b.farm_id, b.commodity_id), favors }
      })
      .filter((r): r is Row => r != null)
      .sort((a, b) => a.farmName.localeCompare(b.farmName) || a.commodity.name.localeCompare(b.commodity.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseAcres, commodityById, farmById, cropYear, entityId, effectivePriceData, payments, elections, benchmarks, programCfg])

  async function setElection(farmId: string, commodityId: string | null, election: ArcPlcElectionType) {
    if (commodityId == null) return
    await supabase.from('arc_plc_elections').upsert({ farm_id: farmId, commodity_id: commodityId, crop_year: cropYear, election }, { onConflict: 'farm_id,commodity_id,crop_year' })
    refresh()
  }

  function buildExportPayload(): ExportPayload {
    return {
      title: 'ARC/PLC Decision Aid',
      filters: `Crop year: ${cropYear || '—'}${entityId ? ` · Entity: ${entities.find((e) => e.id === entityId)?.name ?? ''}` : ''}${myaPct !== 0 ? ` · MYA what-if: ${myaPct > 0 ? '+' : ''}${myaPct}%` : ''} · ARC guarantee ${Math.round(programCfg.arcGuaranteePct * 100)}% / cap ${Math.round(programCfg.arcPaymentCapPct * 100)}%`,
      sections: [{
        title: 'Projected Payments by Farm × Commodity',
        columns: [
          { label: 'Farm' }, { label: 'Commodity' }, { label: 'County' }, { label: 'Base Acres', align: 'right', format: 'int' }, { label: 'PLC Yield', align: 'right', format: 'yield' },
          { label: 'PLC Projected', align: 'right', format: 'usd0' }, { label: 'ARC-CO Projected', align: 'right', format: 'usd0' }, { label: 'ARC Basis' }, { label: 'Recommendation' }, { label: 'Current Election' },
        ],
        rows: rows.map((r) => [
          r.farmName, r.commodity.name, r.county ?? '', Math.round(r.base.base_acres), Number(r.base.plc_yield),
          r.plcNet != null ? Math.round(r.plcNet) : '', r.arcNet != null ? Math.round(r.arcNet) : '',
          r.arc.arcMethod === 'engine' ? (r.arc.arcDetail?.capped ? 'County engine (capped)' : 'County engine') : r.arc.computable ? 'Flat $/acre estimate' : '',
          r.favors === 'PLC' ? 'Favors PLC' : r.favors === 'ARC' ? 'Favors ARC-CO' : '—', ELECTION_LABEL[r.election],
        ]),
      }],
    }
  }
  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cropYear, entityId, myaPct, onPayloadChange])

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

      {cropYear === '' && <p className="text-amber-700 text-sm">Pick a crop year.</p>}
      {cropYear !== '' && rows.length === 0 && (
        <EmptyState
          message="No base acres on file"
          hint="Add base acres to project ARC-CO and PLC payments."
          linkHref="/settings/government-payments"
          linkLabel="Set up base acres"
        />
      )}

      {cropYear !== '' && rows.length > 0 && (
        <>
          {cfgNotice && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 no-print">{cfgNotice}</div>
          )}
          <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900 no-print">
            Under OBBBA (2025+ crop years), <strong>SCO can be purchased regardless of your ARC/PLC election</strong> —
            the old rule making ARC-enrolled acres ineligible for SCO no longer applies, and the SCO premium subsidy is
            now 80%. Weigh SCO alongside either program.
            {cropYear === 2025 && (
              <> For <strong>2025 only</strong>, FSA automatically pays the higher of ARC or PLC per farm × commodity
              regardless of your election — the comparison below shows which side that will likely be.</>
            )}
          </div>

          {/* Per-commodity MYA — the shared resolution the Payment Tracker also
              reads, so both pages project from the same price. */}
          <MyaPricePanel
            cropYear={cropYear}
            commodities={shownCommodities}
            priceData={priceData}
            liveMya={liveMya}
            liveDetails={liveDetails}
            monthlyPrices={monthlyPrices}
            onChanged={refresh}
            onRefreshEstimates={refreshEstimates}
          />

          {/* County yield expectation — drives ARC-CO actual county revenue. */}
          <CountyYieldExpectation
            cropYear={cropYear}
            commodities={shownCommodities}
            farms={farms}
            counties={counties}
            baseAcres={baseAcres}
            benchmarks={benchmarks}
            onChanged={refresh}
          />

          {/* What-If MYA */}
          <section className="bg-white rounded-xl shadow p-4 space-y-2 no-print">
            <h2 className="font-bold text-lg">What-If: MYA price</h2>
            <label className="flex items-center gap-3 flex-wrap text-sm">
              <span className="w-44 text-slate-600">MYA adjustment: <strong>{myaPct > 0 ? '+' : ''}{myaPct}%</strong></span>
              <input type="range" min={-30} max={30} step={5} value={myaPct} onChange={(e) => setMyaPct(Number(e.target.value))} className="flex-1 min-w-[12rem]" />
              <button onClick={() => setMyaPct(0)} className="text-xs text-slate-500 underline">reset</button>
            </label>
            <p className="text-xs text-slate-500">
              PLC payments rise as the MYA falls below the effective reference price. ARC-CO moves too: a lower MYA
              lowers actual county revenue against the {Math.round(programCfg.arcGuaranteePct * 100)}% guarantee (until
              the {Math.round(programCfg.arcPaymentCapPct * 100)}% cap binds).
            </p>
          </section>

          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">Decision Aid — {cropYear}</h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>{['Farm', 'Commodity', 'Base Acres', 'PLC Yield', 'PLC Projected', 'ARC-CO Projected', 'Recommendation', 'Election', ''].map((h) => <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <FragmentRows key={r.base.id}>
                    <tr className="border-t border-slate-100">
                      <td className={`${textCell} font-semibold`}>{r.farmName}</td>
                      <td className={textCell}>
                        {r.commodity.name}
                        {r.county && <span className="text-xs text-slate-400"> · {r.county}</span>}
                      </td>
                      <td className={numCell}>{Number(r.base.base_acres).toLocaleString()}</td>
                      <td className={numCell}>{Number(r.base.plc_yield)}</td>
                      <td className={`${numCell} ${r.favors === 'PLC' ? `bg-green-50 font-semibold ${toneText('favorable')}` : ''}`}>{r.plcNet != null ? usd(r.plcNet) : <span className={toneText('warning')}>needs MYA</span>}</td>
                      <td className={`${numCell} ${r.favors === 'ARC' ? `bg-green-50 font-semibold ${toneText('favorable')}` : ''}`}>
                        {r.arcNet != null ? usd(r.arcNet) : <span className={toneText('warning')}>{r.arc.arcMethod === 'flat' ? 'enter rate or benchmark' : 'needs MYA'}</span>}
                        {r.arc.arcMethod === 'engine' && r.arc.arcDetail?.capped && (
                          <span className="ml-1 text-[10px] rounded-full bg-violet-100 text-violet-800 px-1.5 py-0.5 whitespace-nowrap align-middle">capped at {Math.round((r.arc.arcDetail.capPct) * 100)}%</span>
                        )}
                        {r.arc.arcMethod === 'flat' && r.arcNet != null && (
                          <span className="ml-1 text-[10px] rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5 whitespace-nowrap align-middle" title="No county benchmark data — using your flat $/acre estimate">flat est.</span>
                        )}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {r.favors === 'PLC' ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Favors PLC</span>
                          : r.favors === 'ARC' ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Favors ARC-CO</span>
                          : <span className={toneText('muted')}>—</span>}
                      </td>
                      <td className="px-2 py-1"><span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{ELECTION_LABEL[r.election]}</span></td>
                      <td className="px-2 py-1 no-print whitespace-nowrap">
                        <button onClick={() => setElection(r.base.farm_id, r.base.commodity_id, 'PLC')} className="text-xs text-sky-700 mr-2">Elect PLC</button>
                        <button onClick={() => setElection(r.base.farm_id, r.base.commodity_id, 'ARC_CO')} className="text-xs text-sky-700 mr-2">Elect ARC-CO</button>
                        <button onClick={() => setDetailRow(detailRow === r.base.id ? null : r.base.id)} className="text-xs text-slate-500 underline">
                          {detailRow === r.base.id ? 'hide' : 'drivers'}
                        </button>
                      </td>
                    </tr>
                    {detailRow === r.base.id && (
                      <tr className="bg-slate-50 no-print">
                        <td colSpan={9} className="px-3 py-2 text-xs text-slate-600">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 max-w-3xl">
                            <div>
                              <b>PLC:</b> rate = max(0, ERP {usd(r.plc.effectiveReferencePrice, 2)} − max(MYA{' '}
                              {r.plc.myaPrice != null ? usd(r.plc.myaPrice, 2) : '—'}, loan {usd(Number(r.commodity.national_loan_rate), 2)})) ={' '}
                              {usd(r.plc.paymentRatePerUnit, 4)}/unit × PLC yield {Number(r.base.plc_yield)} × {Number(r.base.base_acres).toLocaleString()} ac
                              × {programCfg.paymentFactor} × (1 − {(programCfg.sequestrationPct * 100).toFixed(1)}% seq.) = <b>{r.plcNet != null ? usd(r.plcNet) : '—'}</b>
                            </div>
                            <div>
                              {r.arc.arcMethod === 'engine' && r.arc.arcDetail ? (
                                <>
                                  <b>ARC-CO (county engine):</b> benchmark {usd(r.arc.arcDetail.benchmarkPrice, 2)} × {r.arc.arcDetail.benchmarkYield} ={' '}
                                  {usd(r.arc.arcDetail.benchmarkRevenue, 2)}/ac; guarantee {Math.round(r.arc.arcDetail.guaranteePct * 100)}% = {usd(r.arc.arcDetail.guarantee, 2)};
                                  actual = {r.arc.arcDetail.actualCountyYield} ({r.arc.arcDetail.countyYieldVsBenchmarkPct > 0 ? '+' : ''}{r.arc.arcDetail.countyYieldVsBenchmarkPct}% vs benchmark)
                                  × MYA = {usd(r.arc.arcDetail.actualRevenue, 2)}; rate = {usd(r.arc.paymentRatePerUnit, 2)}/ac
                                  {r.arc.arcDetail.capped ? ` (capped at ${Math.round(r.arc.arcDetail.capPct * 100)}% = ${usd(r.arc.arcDetail.maxRatePerAcre, 2)})` : ''} ×{' '}
                                  {Number(r.base.base_acres).toLocaleString()} ac × {programCfg.paymentFactor} × (1 − {(programCfg.sequestrationPct * 100).toFixed(1)}% seq.) = <b>{r.arcNet != null ? usd(r.arcNet) : '—'}</b>
                                </>
                              ) : (
                                <>
                                  <b>ARC-CO (flat fallback):</b> no county benchmark data — user-entered rate{' '}
                                  {r.arc.computable ? `${usd(r.arc.paymentRatePerUnit, 2)}/ac` : 'not entered'} × {Number(r.base.base_acres).toLocaleString()} ac
                                  × {programCfg.paymentFactor} × (1 − {(programCfg.sequestrationPct * 100).toFixed(1)}% seq.)
                                  {r.arcNet != null ? <> = <b>{usd(r.arcNet)}</b></> : null}. Add benchmark data in Settings for the real county-revenue calc.
                                </>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </FragmentRows>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-slate-500 mt-2">
              Projected — PLC and ARC-CO computed from the same MYA resolution, FSA benchmark data, your county yield
              expectation, and the {Math.round(programCfg.arcGuaranteePct * 100)}% guarantee / {Math.round(programCfg.arcPaymentCapPct * 100)}% cap
              parameters. The Payment Tracker uses the identical engine. FSA determines final payments after the marketing year.
            </p>
          </section>
        </>
      )}
    </div>
  )
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
