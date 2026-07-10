'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { fetchAllCounties } from '@/lib/counties'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import EntityFilter from '@/components/entity-filter'
import {
  ELECTION_LABEL, COMMON_PROGRAMS, effectiveReferencePrice,
  computeArcCoFlatPayment, expectedArcPlcDate, paymentLimitTotal,
} from '@/lib/government-payments'
import {
  DEFAULT_PER_PERSON_PAYMENT_LIMIT, DEFAULT_SCO_TRIGGER, DEFAULT_SEQUESTRATION_PCT,
  DEFAULT_ERP_CAP_PCT, DEFAULT_PAYMENT_FACTOR, DEFAULT_ARC_IC_PAYMENT_FACTOR,
  defaultArcGuaranteePct, defaultArcPaymentCapPct, defaultErpOlympicFactor,
  resolveProgramYearConfig,
} from '@/lib/program-config'
import FsaBaseAcresImport from '@/components/government/fsa-base-acres-import'
import type {
  Farm, Entity, Crop, County, FieldPlanting, CoveredCommodity, FarmBaseAcres, ArcPlcElection,
  ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment, PaymentLimitConfig, ArcPlcElectionType,
  ProgramYearConfig, ArcBenchmarkData,
} from '@/lib/types'

const num = (s: string): number | null => {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const usd = (n: number | null | undefined, d = 0) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`

export default function GovernmentPaymentsSettingsPage() {
  const supabase = useMemo(() => createClient(), [])
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
  const [cropYear, setCropYear] = useState<number>(new Date().getFullYear())
  const [entityFilter, setEntityFilter] = usePersistentState('gov-pay-settings:entity', '')
  const [err, setErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState<string>('base')

  async function refresh() {
    const [fa, en, cr, pl, cc, ba, el, pd, pay, op, lim, pc, co, bm] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('covered_commodities').select('*').order('name'),
      supabase.from('farm_base_acres').select('*'),
      supabase.from('arc_plc_elections').select('*'),
      supabase.from('arc_plc_price_data').select('*'),
      supabase.from('arc_plc_payments').select('*'),
      supabase.from('other_government_payments').select('*').order('created_at', { ascending: false }),
      supabase.from('payment_limit_config').select('*'),
      supabase.from('program_year_config').select('*').order('crop_year', { ascending: false }),
      fetchAllCounties(supabase),
      supabase.from('arc_benchmark_data').select('*'),
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
    setCounties(co || [])
    setBenchmarks((bm.data as ArcBenchmarkData[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  // Deep links from the reports (e.g. the Payment Tracker's "ARC-CO settings"
  // button → #bench): open the hashed section and scroll to it once mounted.
  useEffect(() => {
    const h = window.location.hash.replace('#', '')
    if (!['base', 'elect', 'price', 'bench', 'arc', 'limit', 'program', 'other'].includes(h)) return
    setOpen(h)
    requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView({ block: 'start' }))
  }, [])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...plantings.map((p) => p.season_year), cropYear, new Date().getFullYear()]),
    [plantings, cropYear],
  )
  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const commodityById = useMemo(() => new Map(commodities.map((c) => [c.id, c])), [commodities])
  // The counties the operation's farms sit in — sorted to the top of the
  // benchmark county picker.
  const farmCountyIds = useMemo(() => new Set(farms.map((f) => f.county_id).filter((id): id is string => !!id)), [farms])
  // Resolved program parameters for the selected year (used to default the
  // payment limit, with most-recent-year fallback).
  const programParams = useMemo(() => resolveProgramYearConfig(cropYear, programConfigs), [cropYear, programConfigs])
  // Years to list in the Program Parameters editor: every configured year plus
  // the selected and current year, descending.
  const programParamYears = useMemo(() => {
    const set = new Set<number>(programConfigs.map((c) => c.crop_year))
    set.add(cropYear); set.add(new Date().getFullYear())
    return [...set].sort((a, b) => b - a)
  }, [programConfigs, cropYear])
  const priceFor = (commodityId: string) => priceData.find((p) => p.commodity_id === commodityId && p.crop_year === cropYear) ?? null
  const electionFor = (farmId: string, commodityId: string | null): ArcPlcElectionType =>
    commodityId == null ? 'PLC' : elections.find((e) => e.farm_id === farmId && e.commodity_id === commodityId && e.crop_year === cropYear)?.election ?? 'PLC'
  const arcRateFor = (farmId: string, commodityId: string | null): number | null => {
    if (commodityId == null) return null
    const p = payments.find((x) => x.farm_id === farmId && x.commodity_id === commodityId && x.crop_year === cropYear)
    return p ? Number(p.payment_rate_per_unit) : null
  }

  // ----- mutations -----
  async function saveBaseAcre(farm_id: string, commodity_id: string, base_acres: number, plc_yield: number) {
    if (!farm_id || !commodity_id) { setErr('Pick a farm and commodity.'); return }
    const { error } = await supabase.from('farm_base_acres').upsert(
      { farm_id, commodity_id, base_acres, plc_yield, source: 'manual', updated_at: new Date().toISOString() },
      { onConflict: 'farm_id,commodity_id' },
    )
    if (error) { setErr(error.message); return }
    setErr(null); refresh()
  }
  async function deleteBaseAcre(id: string) {
    if (!confirm('Delete this base-acre record?')) return
    await supabase.from('farm_base_acres').delete().eq('id', id); refresh()
  }
  // Convert unassigned/generic base into eligible base for a commodity: add (or
  // increment) the eligible row and reduce/remove the unassigned row.
  async function convertUnassigned(row: FarmBaseAcres, commodity_id: string, acres: number, plc_yield: number) {
    if (!commodity_id || acres <= 0) { setErr('Pick a commodity and a positive number of acres to convert.'); return }
    if (acres > Number(row.base_acres)) { setErr('Cannot convert more than the unassigned acres available.'); return }
    setErr(null)
    const existing = baseAcres.find((b) => b.farm_id === row.farm_id && b.commodity_id === commodity_id && !b.is_unassigned)
    const newAcres = (existing ? Number(existing.base_acres) : 0) + acres
    const newYield = plc_yield > 0 ? plc_yield : (existing ? Number(existing.plc_yield) : 0)
    const up = await supabase.from('farm_base_acres').upsert(
      { farm_id: row.farm_id, commodity_id, base_acres: newAcres, plc_yield: newYield, is_unassigned: false, source: 'manual', updated_at: new Date().toISOString() },
      { onConflict: 'farm_id,commodity_id' },
    )
    if (up.error) { setErr(up.error.message); return }
    const remaining = Number(row.base_acres) - acres
    if (remaining <= 0.0001) {
      await supabase.from('farm_base_acres').delete().eq('id', row.id)
    } else {
      await supabase.from('farm_base_acres').update({ base_acres: remaining, updated_at: new Date().toISOString() }).eq('id', row.id)
    }
    refresh()
  }
  async function setElection(farm_id: string, commodity_id: string, election: ArcPlcElectionType) {
    const { error } = await supabase.from('arc_plc_elections').upsert(
      { farm_id, commodity_id, crop_year: cropYear, election }, { onConflict: 'farm_id,commodity_id,crop_year' },
    )
    if (error) { setErr(error.message); return }
    refresh()
  }
  async function savePrice(commodity_id: string, patch: Partial<ArcPlcPriceData>) {
    const existing = priceFor(commodity_id)
    const { error } = await supabase.from('arc_plc_price_data').upsert(
      {
        commodity_id, crop_year: cropYear,
        effective_reference_price: patch.effective_reference_price ?? existing?.effective_reference_price ?? null,
        mya_price_estimate: patch.mya_price_estimate ?? existing?.mya_price_estimate ?? null,
        mya_price_final: patch.mya_price_final ?? existing?.mya_price_final ?? null,
        // WASDE is an explicit clear-able field: the row editor always sends it
        // (null clears), unlike the coalescing fields above.
        wasde_midpoint: 'wasde_midpoint' in patch ? patch.wasde_midpoint : existing?.wasde_midpoint ?? null,
        source: 'manual', updated_at: new Date().toISOString(),
      },
      { onConflict: 'commodity_id,crop_year' },
    )
    if (error) { setErr(error.message); return }
    refresh()
  }
  async function refreshMya() {
    setRefreshing(true); setErr(null)
    try {
      // All commodities: traded ones blend futures-implied months; untraded
      // ones still blend from any entered monthly prices.
      await fetch('/api/mya-estimate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ crop_year: cropYear, commodities: commodities.map((c) => ({ commodity_id: c.id, name: c.name })), force: true }),
      })
      await refresh()
    } catch { setErr('Could not refresh MYA estimates.') } finally { setRefreshing(false) }
  }
  async function saveArcRate(farm_id: string, commodity_id: string, ratePerAcre: number) {
    const ba = baseAcres.find((b) => b.farm_id === farm_id && b.commodity_id === commodity_id)
    const acres = ba ? Number(ba.base_acres) : 0
    const election = electionFor(farm_id, commodity_id)
    const pf = election === 'ARC_IC' ? programParams.arcIcPaymentFactor : programParams.paymentFactor
    const r = computeArcCoFlatPayment({
      projectedRatePerAcre: ratePerAcre, baseAcres: acres,
      paymentFactor: pf, sequestrationPct: programParams.sequestrationPct,
    })
    const { error } = await supabase.from('arc_plc_payments').upsert(
      {
        farm_id, commodity_id, crop_year: cropYear, election,
        base_acres: acres, plc_yield: ba ? Number(ba.plc_yield) : 0,
        payment_rate_per_unit: ratePerAcre, gross_payment: r.gross,
        payment_factor: pf, sequestration_pct: programParams.sequestrationPct, net_payment: r.net,
        payment_status: 'projected', expected_payment_date: expectedArcPlcDate(cropYear),
      },
      { onConflict: 'farm_id,commodity_id,crop_year' },
    )
    if (error) { setErr(error.message); return }
    refresh()
  }
  async function saveBenchmark(patch: {
    id?: string
    commodity_id: string
    county: string | null
    county_id: string | null
    benchmark_price: number | null
    benchmark_yield: number | null
    price_source?: 'usda' | 'manual' | 'ai'
    yield_source?: 'usda' | 'manual' | 'ai'
    source_description?: string | null
  }) {
    const payload = {
      commodity_id: patch.commodity_id,
      crop_year: cropYear,
      county: patch.county,
      county_id: patch.county_id,
      benchmark_price: patch.benchmark_price,
      benchmark_yield: patch.benchmark_yield,
      price_source: patch.price_source ?? 'manual',
      yield_source: patch.yield_source ?? 'manual',
      source_description: patch.source_description ?? null,
      updated_at: new Date().toISOString(),
    }
    const { error } = patch.id
      ? await supabase.from('arc_benchmark_data').update(payload).eq('id', patch.id)
      : await supabase.from('arc_benchmark_data').insert(payload)
    if (error) { setErr(error.message); return }
    setErr(null); refresh()
  }
  async function deleteBenchmark(id: string) {
    if (!confirm('Delete this benchmark row?')) return
    await supabase.from('arc_benchmark_data').delete().eq('id', id); refresh()
  }
  async function saveLimit(entity_id: string, eligible_persons: number, per_person_limit: number) {
    const { error } = await supabase.from('payment_limit_config').upsert(
      { entity_id, crop_year: cropYear, eligible_persons, per_person_limit, updated_at: new Date().toISOString() },
      { onConflict: 'entity_id,crop_year' },
    )
    if (error) { setErr(error.message); return }
    refresh()
  }
  async function saveProgramConfig(year: number, patch: {
    sco_trigger: number; per_person_payment_limit: number; sequestration_pct: number
    arc_guarantee_pct: number; arc_payment_cap_pct: number; erp_olympic_factor: number
    erp_cap_pct: number; payment_factor: number; arc_ic_payment_factor: number
  }) {
    const { error } = await supabase.from('program_year_config').upsert(
      { crop_year: year, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'crop_year' },
    )
    if (error) { setErr(error.message); return }
    setErr(null); refresh()
  }

  // Entity scoping: base acres/elections are per farm, farms belong to entities.
  const entityFarms = useMemo(
    () => (entityFilter ? farms.filter((f) => f.entity_id === entityFilter) : farms),
    [farms, entityFilter],
  )
  const entityFarmIds = useMemo(() => (entityFilter ? new Set(entityFarms.map((f) => f.id)) : null), [entityFarms, entityFilter])
  const entityBaseAcres = useMemo(
    () => (entityFarmIds ? baseAcres.filter((b) => entityFarmIds.has(b.farm_id)) : baseAcres),
    [baseAcres, entityFarmIds],
  )
  const entityList = useMemo(() => (entityFilter ? entities.filter((e) => e.id === entityFilter) : entities), [entities, entityFilter])

  // Eligible (assigned) base vs unassigned/generic base.
  const byFarmName = (a: FarmBaseAcres, b: FarmBaseAcres) => (farmById.get(a.farm_id)?.name ?? '').localeCompare(farmById.get(b.farm_id)?.name ?? '')
  const eligibleRows = useMemo(() => entityBaseAcres.filter((b) => !b.is_unassigned).sort(byFarmName), [entityBaseAcres, farmById]) // eslint-disable-line react-hooks/exhaustive-deps
  const unassignedRows = useMemo(() => entityBaseAcres.filter((b) => b.is_unassigned).sort(byFarmName), [entityBaseAcres, farmById]) // eslint-disable-line react-hooks/exhaustive-deps
  // Per-farm base totals: eligible, unassigned, total.
  const perFarmBase = useMemo(() => {
    const m = new Map<string, { eligible: number; unassigned: number }>()
    for (const b of entityBaseAcres) {
      const cur = m.get(b.farm_id) ?? { eligible: 0, unassigned: 0 }
      if (b.is_unassigned) cur.unassigned += Number(b.base_acres)
      else cur.eligible += Number(b.base_acres)
      m.set(b.farm_id, cur)
    }
    return m
  }, [entityBaseAcres])
  const arcElectedRows = useMemo(
    () => eligibleRows.filter((b) => b.commodity_id && electionFor(b.farm_id, b.commodity_id) !== 'PLC'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligibleRows, elections, cropYear],
  )

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 bg-white'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Government Payments</h1>
        <Link href="/reports/arc-plc-decision-aid" className="text-sm rounded-lg bg-slate-700 text-white px-3 py-2 font-semibold">Decision Aid →</Link>
        <Link href="/reports/government-payments" className="text-sm rounded-lg bg-slate-700 text-white px-3 py-2 font-semibold">Tracker →</Link>
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year</span>
          <select value={cropYear} onChange={(e) => setCropYear(Number(e.target.value))} className={inputCls}>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <EntityFilter entities={entities} value={entityFilter} onChange={setEntityFilter} />
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Base Acres & Yields */}
      <Section id="base" title="Base Acres & Yields" open={open === 'base'} onToggle={() => setOpen(open === 'base' ? '' : 'base')}>
        <FsaBaseAcresImport farms={entityFarms} commodities={commodities} existingBaseAcres={entityBaseAcres} cropYear={cropYear} onImported={refresh} />
        <AddBaseAcreForm farms={entityFarms} commodities={commodities} onSave={saveBaseAcre} />

        {/* Per-farm base totals */}
        {perFarmBase.size > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr>{['Farm', 'Eligible Base', 'Unassigned Base', 'Total Base'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {[...perFarmBase.entries()]
                  .sort((a, b) => (farmById.get(a[0])?.name ?? '').localeCompare(farmById.get(b[0])?.name ?? ''))
                  .map(([fid, t]) => (
                    <tr key={fid} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-semibold">{farmById.get(fid)?.name ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{t.eligible.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">{t.unassigned.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">{(t.eligible + t.unassigned).toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Eligible base */}
        <div className="overflow-x-auto">
          <div className="text-sm font-semibold text-slate-700 mb-1">Eligible Base (ARC/PLC payment-eligible)</div>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Farm', 'FSA #', 'Commodity', 'Base Acres', 'PLC Yield', 'Source', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {eligibleRows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No eligible base acres yet.</td></tr>}
              {eligibleRows.map((b) => (
                <BaseAcreRow key={b.id} row={b} farm={farmById.get(b.farm_id)} commodity={b.commodity_id ? commodityById.get(b.commodity_id) : undefined} onSave={saveBaseAcre} onDelete={deleteBaseAcre} />
              ))}
            </tbody>
          </table>
        </div>

        {/* Unassigned / generic base */}
        {unassignedRows.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
            <div className="text-sm font-semibold text-slate-500">Unassigned Base (not eligible for ARC/PLC)</div>
            <p className="text-xs text-slate-400">
              These acres are retained on the farm record by FSA but are not currently eligible for ARC/PLC payments.
              Under the One Big Beautiful Bill Act, some unassigned acres may become eligible starting with the 2026 crop year.
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm text-slate-500">
                <thead className="text-slate-400"><tr>{['Farm', 'Unassigned Acres', 'Convert to commodity', 'Acres', 'PLC yield', '', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>
                  {unassignedRows.map((b) => (
                    <ConvertUnassignedRow key={b.id} row={b} farmName={farmById.get(b.farm_id)?.name ?? '—'} commodities={commodities} onConvert={convertUnassigned} onDelete={deleteBaseAcre} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      {/* Elections */}
      <Section id="elect" title="ARC/PLC Elections" open={open === 'elect'} onToggle={() => setOpen(open === 'elect' ? '' : 'elect')}>
        <p className="text-sm text-slate-500">
          Set the program election for each farm × commodity for {cropYear}. Under OBBBA (2025+), SCO can be purchased
          regardless of the ARC/PLC election (subsidy 80%) — the old ARC-blocks-SCO rule no longer applies.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Farm', 'Commodity', 'Base Acres', 'Election'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {eligibleRows.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Add eligible base acres first.</td></tr>}
              {eligibleRows.filter((b) => b.commodity_id).map((b) => (
                <tr key={b.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{farmById.get(b.farm_id)?.name ?? '—'}</td>
                  <td className="px-3 py-2">{b.commodity_id ? commodityById.get(b.commodity_id)?.name ?? '—' : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{Number(b.base_acres).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <select value={electionFor(b.farm_id, b.commodity_id)} onChange={(e) => b.commodity_id && setElection(b.farm_id, b.commodity_id, e.target.value as ArcPlcElectionType)} className="rounded border border-slate-300 px-2 py-1">
                      {(['PLC', 'ARC_CO', 'ARC_IC'] as ArcPlcElectionType[]).map((opt) => <option key={opt} value={opt}>{ELECTION_LABEL[opt]}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Price Data */}
      <Section id="price" title="Price Data" open={open === 'price'} onToggle={() => setOpen(open === 'price' ? '' : 'price')}>
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-sm text-slate-500 flex-1">
            MYA estimates are a marketing-year blend of USDA monthly prices (+ futures-implied months for traded
            commodities) — enter monthly prices, run the USDA lookup, and set WASDE midpoints from the MYA panel on
            the Decision Aid or Tracker; every commodity (including seed cotton) has the same Auto | Manual toggle
            there. Seed cotton&apos;s monthly price is blended in the app from the NASS lint + cottonseed series. A typed
            WASDE midpoint overrides the blend; a Manual estimate and a published Final outrank both.
          </p>
          <button onClick={refreshMya} disabled={refreshing} className="rounded-lg bg-slate-700 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Refresh MYA blend'}</button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Commodity', 'Unit', 'Statutory Ref', 'Effective Ref', 'MYA Estimate', 'WASDE Midpoint', 'MYA Final', 'Loan Rate', 'Source', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {commodities.map((c) => (
                <PriceDataRow key={c.id} commodity={c} priceData={priceFor(c.id)} onSave={savePrice} />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ARC-CO benchmarks (FSA-published price & county yield) */}
      <Section id="bench" title="ARC-CO Benchmarks" open={open === 'bench'} onToggle={() => setOpen(open === 'bench' ? '' : 'bench')}>
        <p className="text-sm text-slate-500">
          FSA-published ARC-CO benchmark data for {cropYear}: the <b>benchmark price</b> (national, 5-yr Olympic
          average with effective-reference-price substitution — 2025/2026: corn $5.03, soybeans $12.17, wheat $6.98)
          and the <b>benchmark county yield</b> (5-yr Olympic average trend-adjusted). A row with no county is the
          default for all counties; add county rows if your farms span counties with different benchmarks. The{' '}
          <b>FSA lookup</b> reads the county yield straight from FSA&apos;s published “ARC-County Benchmark Yields and
          Revenues” workbook (cached; falls back to the most recent published year) and takes the price from the
          seeded national values; an AI web search remains as a labeled fallback. You confirm before anything is
          saved.
        </p>
        <AddBenchmarkForm commodities={commodities} counties={counties} existing={benchmarks.filter((b) => b.crop_year === cropYear)} preferredCountyIds={farmCountyIds} onAdd={saveBenchmark} />
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Commodity', 'County', 'Benchmark Price', 'Benchmark Yield', 'Source', '', ''].map((h, i) => <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {benchmarks.filter((b) => b.crop_year === cropYear).length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No benchmark rows for {cropYear} yet — add one above.</td></tr>
              )}
              {benchmarks
                .filter((b) => b.crop_year === cropYear)
                .sort((a, b) => (commodityById.get(a.commodity_id)?.name ?? '').localeCompare(commodityById.get(b.commodity_id)?.name ?? '') || (a.county ?? '').localeCompare(b.county ?? ''))
                .map((b) => (
                  <BenchmarkRow
                    key={b.id}
                    row={b}
                    commodity={commodityById.get(b.commodity_id)}
                    counties={counties}
                    cropYear={cropYear}
                    defaultPrice={
                      benchmarks.find((x) =>
                        x.commodity_id === b.commodity_id && x.crop_year === cropYear &&
                        x.county_id == null && (x.county ?? '').trim() === '' && x.benchmark_price != null,
                      )?.benchmark_price ?? null
                    }
                    onSave={saveBenchmark}
                    onDelete={deleteBenchmark}
                    onErr={setErr}
                  />
                ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ARC projected rates — the flat fallback */}
      <Section id="arc" title="ARC Flat Rates (fallback)" open={open === 'arc'} onToggle={() => setOpen(open === 'arc' ? '' : 'arc')}>
        <p className="text-sm text-slate-500">
          <b>Fallback only:</b> ARC-CO is normally computed from the benchmark data above (county-revenue engine).
          This flat $/base-acre estimate is used when a county has no benchmark data yet — and for ARC-IC, which FSA
          computes from individual farm revenue. Enter your best estimate from your FSA office or extension decision
          tools.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Farm', 'Commodity', 'Election', 'Base Acres', 'Projected $/acre', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {arcElectedRows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No farm/commodity is elected to ARC for {cropYear}.</td></tr>}
              {arcElectedRows.map((b) => (
                <ArcRateRow key={b.id} row={b} farmName={farmById.get(b.farm_id)?.name ?? '—'} commodityName={(b.commodity_id ? commodityById.get(b.commodity_id)?.name : null) ?? '—'}
                  election={ELECTION_LABEL[electionFor(b.farm_id, b.commodity_id)]} rate={arcRateFor(b.farm_id, b.commodity_id)} onSave={saveArcRate} />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Payment limits */}
      <Section id="limit" title="Payment Limits" open={open === 'limit'} onToggle={() => setOpen(open === 'limit' ? '' : 'limit')}>
        <p className="text-sm text-slate-500">Per-person limit defaults to the configured Program Parameters value for {cropYear} ({usd(programParams.perPersonPaymentLimit)}). Total limit = eligible persons × per-person limit.</p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Entity', 'Eligible Persons', 'Per-Person Limit', 'Total Limit', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {entityList.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No entities.</td></tr>}
              {entityList.map((e) => (
                <LimitRow key={e.id} entity={e} config={limits.find((l) => l.entity_id === e.id && l.crop_year === cropYear) ?? null} defaultLimit={programParams.perPersonPaymentLimit} onSave={saveLimit} />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Program parameters (per-year constants) */}
      <Section id="program" title="Program Parameters" open={open === 'program'} onToggle={() => setOpen(open === 'program' ? '' : 'program')}>
        <p className="text-sm text-slate-500">
          Per-crop-year program values used across crop-insurance and ARC/PLC calculations — all data, not code. The
          OBBBA values (2025–2031): ARC guarantee 90% (was 86%), ARC payment cap 12% (was 10%), ERP Olympic factor
          88% (was 85%), ERP cap 115%, payment factor 0.85 (ARC-CO/PLC) and 0.65 (ARC-IC); plus the SCO trigger
          (0.86 for 2026, 0.90 from 2027), the per-person FSA payment limit, and the sequestration rate. A year with
          no row falls back to the most recent configured year (historical years default to the pre-OBBBA values).
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Crop Year', 'SCO Trigger', 'Per-Person Limit', 'Sequestration %', 'ARC Guarantee', 'ARC Cap', 'ERP Factor', 'ERP Cap', 'Pay Factor', 'ARC-IC Factor', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {programParamYears.map((y) => (
                <ProgramParamsRow key={y} year={y} config={programConfigs.find((c) => c.crop_year === y) ?? null} onSave={saveProgramConfig} />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Other payments */}
      <Section id="other" title="Other USDA Payments" open={open === 'other'} onToggle={() => setOpen(open === 'other' ? '' : 'other')}>
        <AddOtherPaymentForm entities={entityList} crops={crops} farms={entityFarms} cropYear={cropYear} defaultEntityId={entityFilter} onSaved={refresh} onErr={setErr} />
        {(() => { const visibleOther = entityFilter ? otherPayments.filter((p) => p.entity_id === entityFilter) : otherPayments; return (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Program', 'Year', 'Entity', 'Crop', 'Farm', 'Amount', 'Date', 'Status', ''].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {visibleOther.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No other payments.</td></tr>}
              {visibleOther.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-semibold">{p.program_name}</td>
                  <td className="px-3 py-2">{p.crop_year}</td>
                  <td className="px-3 py-2">{entities.find((e) => e.id === p.entity_id)?.name ?? '—'}</td>
                  <td className="px-3 py-2">{crops.find((c) => c.id === p.crop_id)?.name ?? '—'}</td>
                  <td className="px-3 py-2">{farmById.get(p.farm_id ?? '')?.name ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{usd(p.amount, 2)}</td>
                  <td className="px-3 py-2">{p.payment_date ?? '—'}</td>
                  <td className="px-3 py-2 capitalize">{p.payment_status}</td>
                  <td className="px-3 py-2"><button onClick={async () => { await supabase.from('other_government_payments').delete().eq('id', p.id); refresh() }} className="text-red-600">Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        ) })()}
      </Section>
    </div>
  )
}

function Section({ id, title, open, onToggle, children }: { id?: string; title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div id={id} className="bg-white rounded-xl shadow overflow-hidden scroll-mt-4">
      <button onClick={onToggle} className="w-full text-left px-4 py-3 font-semibold flex items-center justify-between">
        <span>{title}</span><span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  )
}

function AddBaseAcreForm({ farms, commodities, onSave }: { farms: Farm[]; commodities: CoveredCommodity[]; onSave: (f: string, c: string, ba: number, py: number) => void }) {
  const [farm, setFarm] = useState(''); const [commodity, setCommodity] = useState(''); const [acres, setAcres] = useState(''); const [yld, setYld] = useState('')
  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm bg-white'
  return (
    <div className="flex flex-wrap items-end gap-2 border border-slate-200 rounded-lg p-3">
      <select value={farm} onChange={(e) => setFarm(e.target.value)} className={inputCls}><option value="">Farm…</option>{farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
      <select value={commodity} onChange={(e) => setCommodity(e.target.value)} className={inputCls}><option value="">Commodity…</option>{commodities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <input type="number" step="0.01" placeholder="Base acres" value={acres} onChange={(e) => setAcres(e.target.value)} className={`${inputCls} w-28`} />
      <input type="number" step="0.1" placeholder="PLC yield" value={yld} onChange={(e) => setYld(e.target.value)} className={`${inputCls} w-28`} />
      <button onClick={() => { if (farm && commodity) { onSave(farm, commodity, num(acres) ?? 0, num(yld) ?? 0); setFarm(''); setCommodity(''); setAcres(''); setYld('') } }}
        className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold">Add</button>
    </div>
  )
}

function BaseAcreRow({ row, farm, commodity, onSave, onDelete }: { row: FarmBaseAcres; farm?: Farm; commodity?: CoveredCommodity; onSave: (f: string, c: string, ba: number, py: number) => void; onDelete: (id: string) => void }) {
  const [acres, setAcres] = useState(String(Number(row.base_acres)))
  const [yld, setYld] = useState(String(Number(row.plc_yield)))
  const inputCls = 'rounded border border-slate-300 px-2 py-1 w-24'
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-semibold">{farm?.name ?? '—'}</td>
      <td className="px-3 py-2 font-mono text-xs">{farm?.fsa_number ?? ''}</td>
      <td className="px-3 py-2">{commodity?.name ?? '—'}</td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={acres} onChange={(e) => setAcres(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.1" value={yld} onChange={(e) => setYld(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2 text-xs text-slate-400">{row.source === 'document_import' ? 'imported' : 'manual'}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <button onClick={() => onSave(row.farm_id, row.commodity_id ?? '', num(acres) ?? 0, num(yld) ?? 0)} className="text-green-700 font-semibold mr-3">Save</button>
        <button onClick={() => onDelete(row.id)} className="text-red-600">Delete</button>
      </td>
    </tr>
  )
}

function PriceDataRow({ commodity, priceData, onSave }: { commodity: CoveredCommodity; priceData: ArcPlcPriceData | null; onSave: (id: string, patch: Partial<ArcPlcPriceData>) => void }) {
  const [effRef, setEffRef] = useState(priceData?.effective_reference_price != null ? String(Number(priceData.effective_reference_price)) : '')
  const [est, setEst] = useState(priceData?.mya_price_estimate != null ? String(Number(priceData.mya_price_estimate)) : '')
  const [wasde, setWasde] = useState(priceData?.wasde_midpoint != null ? String(Number(priceData.wasde_midpoint)) : '')
  const [fin, setFin] = useState(priceData?.mya_price_final != null ? String(Number(priceData.mya_price_final)) : '')
  useEffect(() => {
    setEffRef(priceData?.effective_reference_price != null ? String(Number(priceData.effective_reference_price)) : '')
    setEst(priceData?.mya_price_estimate != null ? String(Number(priceData.mya_price_estimate)) : '')
    setWasde(priceData?.wasde_midpoint != null ? String(Number(priceData.wasde_midpoint)) : '')
    setFin(priceData?.mya_price_final != null ? String(Number(priceData.mya_price_final)) : '')
  }, [priceData])
  const inputCls = 'rounded border border-slate-300 px-2 py-1 w-24'
  const effShown = effectiveReferencePrice(commodity, priceData)
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-semibold">{commodity.name}</td>
      <td className="px-3 py-2 text-xs text-slate-500">{commodity.unit}</td>
      <td className="px-3 py-2 text-right font-mono">{Number(commodity.statutory_reference_price).toFixed(4)}</td>
      <td className="px-3 py-2"><input type="number" step="0.0001" placeholder={effShown.toFixed(4)} value={effRef} onChange={(e) => setEffRef(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.0001" value={est} onChange={(e) => setEst(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={wasde} onChange={(e) => setWasde(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.0001" value={fin} onChange={(e) => setFin(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2 text-right font-mono text-xs">{Number(commodity.national_loan_rate).toFixed(4)}</td>
      <td className="px-3 py-2 text-xs text-slate-400">{priceData?.source ?? '—'}</td>
      <td className="px-3 py-2">
        <button onClick={() => onSave(commodity.id, { effective_reference_price: num(effRef), mya_price_estimate: num(est), wasde_midpoint: num(wasde), mya_price_final: num(fin) })} className="text-green-700 font-semibold">Save</button>
      </td>
    </tr>
  )
}

function ArcRateRow({ row, farmName, commodityName, election, rate, onSave }: { row: FarmBaseAcres; farmName: string; commodityName: string; election: string; rate: number | null; onSave: (f: string, c: string, r: number) => void }) {
  const [val, setVal] = useState(rate != null ? String(rate) : '')
  useEffect(() => { setVal(rate != null ? String(rate) : '') }, [rate])
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2">{farmName}</td>
      <td className="px-3 py-2">{commodityName}</td>
      <td className="px-3 py-2"><span className="text-xs rounded-full bg-indigo-100 text-indigo-800 px-2 py-0.5">{election}</span></td>
      <td className="px-3 py-2 text-right font-mono">{Number(row.base_acres).toLocaleString()}</td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={val} onChange={(e) => setVal(e.target.value)} className="rounded border border-slate-300 px-2 py-1 w-28" /></td>
      <td className="px-3 py-2"><button onClick={() => onSave(row.farm_id, row.commodity_id ?? '', num(val) ?? 0)} className="text-green-700 font-semibold">Save</button></td>
    </tr>
  )
}

function ConvertUnassignedRow({ row, farmName, commodities, onConvert, onDelete }: {
  row: FarmBaseAcres
  farmName: string
  commodities: CoveredCommodity[]
  onConvert: (row: FarmBaseAcres, commodityId: string, acres: number, plcYield: number) => void
  onDelete: (id: string) => void
}) {
  const [commodity, setCommodity] = useState('')
  const [acres, setAcres] = useState(String(Number(row.base_acres)))
  const [yld, setYld] = useState('')
  const inputCls = 'rounded border border-slate-300 px-2 py-1'
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-semibold">{farmName}</td>
      <td className="px-3 py-2 text-right font-mono">{Number(row.base_acres).toLocaleString()}</td>
      <td className="px-3 py-2">
        <select value={commodity} onChange={(e) => setCommodity(e.target.value)} className={inputCls}>
          <option value="">— commodity —</option>
          {commodities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={acres} onChange={(e) => setAcres(e.target.value)} className={`${inputCls} w-24`} /></td>
      <td className="px-3 py-2"><input type="number" step="0.1" placeholder="opt" value={yld} onChange={(e) => setYld(e.target.value)} className={`${inputCls} w-20`} /></td>
      <td className="px-3 py-2">
        <button
          onClick={() => commodity && onConvert(row, commodity, num(acres) ?? 0, num(yld) ?? 0)}
          disabled={!commodity}
          className="rounded-lg bg-sky-700 text-white px-3 py-1 text-xs font-semibold disabled:opacity-50"
        >Convert</button>
      </td>
      <td className="px-3 py-2"><button onClick={() => onDelete(row.id)} className="text-red-600 text-xs">Delete</button></td>
    </tr>
  )
}

function LimitRow({ entity, config, defaultLimit, onSave }: { entity: Entity; config: PaymentLimitConfig | null; defaultLimit: number; onSave: (e: string, persons: number, limit: number) => void }) {
  const [persons, setPersons] = useState(String(config?.eligible_persons ?? 1))
  const [limit, setLimit] = useState(String(config?.per_person_limit ?? defaultLimit))
  useEffect(() => { setPersons(String(config?.eligible_persons ?? 1)); setLimit(String(config?.per_person_limit ?? defaultLimit)) }, [config, defaultLimit])
  const total = paymentLimitTotal(num(persons) ?? 0, num(limit) ?? 0)
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-semibold">{entity.name}</td>
      <td className="px-3 py-2"><input type="number" step="1" value={persons} onChange={(e) => setPersons(e.target.value)} className="rounded border border-slate-300 px-2 py-1 w-20" /></td>
      <td className="px-3 py-2"><input type="number" step="1000" value={limit} onChange={(e) => setLimit(e.target.value)} className="rounded border border-slate-300 px-2 py-1 w-28" /></td>
      <td className="px-3 py-2 text-right font-mono font-semibold">{usd(total)}</td>
      <td className="px-3 py-2"><button onClick={() => onSave(entity.id, num(persons) ?? 1, num(limit) ?? defaultLimit)} className="text-green-700 font-semibold">Save</button></td>
    </tr>
  )
}

// One editable row of the program_year_config table. Pre-fills with the built-in
// (era-aware) defaults for a year that has no row yet, so saving creates it.
function ProgramParamsRow({ year, config, onSave }: {
  year: number
  config: ProgramYearConfig | null
  onSave: (year: number, patch: {
    sco_trigger: number; per_person_payment_limit: number; sequestration_pct: number
    arc_guarantee_pct: number; arc_payment_cap_pct: number; erp_olympic_factor: number
    erp_cap_pct: number; payment_factor: number; arc_ic_payment_factor: number
  }) => void
}) {
  const d = {
    sco: config?.sco_trigger ?? DEFAULT_SCO_TRIGGER,
    limit: config?.per_person_payment_limit ?? DEFAULT_PER_PERSON_PAYMENT_LIMIT,
    seq: config?.sequestration_pct ?? DEFAULT_SEQUESTRATION_PCT,
    guar: config?.arc_guarantee_pct ?? defaultArcGuaranteePct(year),
    cap: config?.arc_payment_cap_pct ?? defaultArcPaymentCapPct(year),
    erpF: config?.erp_olympic_factor ?? defaultErpOlympicFactor(year),
    erpC: config?.erp_cap_pct ?? DEFAULT_ERP_CAP_PCT,
    pf: config?.payment_factor ?? DEFAULT_PAYMENT_FACTOR,
    icf: config?.arc_ic_payment_factor ?? DEFAULT_ARC_IC_PAYMENT_FACTOR,
  }
  const [sco, setSco] = useState(String(d.sco))
  const [limit, setLimit] = useState(String(d.limit))
  const [seq, setSeq] = useState(String(d.seq))
  const [guar, setGuar] = useState(String(d.guar))
  const [cap, setCap] = useState(String(d.cap))
  const [erpF, setErpF] = useState(String(d.erpF))
  const [erpC, setErpC] = useState(String(d.erpC))
  const [pf, setPf] = useState(String(d.pf))
  const [icf, setIcf] = useState(String(d.icf))
  useEffect(() => {
    setSco(String(config?.sco_trigger ?? DEFAULT_SCO_TRIGGER))
    setLimit(String(config?.per_person_payment_limit ?? DEFAULT_PER_PERSON_PAYMENT_LIMIT))
    setSeq(String(config?.sequestration_pct ?? DEFAULT_SEQUESTRATION_PCT))
    setGuar(String(config?.arc_guarantee_pct ?? defaultArcGuaranteePct(year)))
    setCap(String(config?.arc_payment_cap_pct ?? defaultArcPaymentCapPct(year)))
    setErpF(String(config?.erp_olympic_factor ?? defaultErpOlympicFactor(year)))
    setErpC(String(config?.erp_cap_pct ?? DEFAULT_ERP_CAP_PCT))
    setPf(String(config?.payment_factor ?? DEFAULT_PAYMENT_FACTOR))
    setIcf(String(config?.arc_ic_payment_factor ?? DEFAULT_ARC_IC_PAYMENT_FACTOR))
  }, [config, year])
  const inputCls = 'rounded border border-slate-300 px-2 py-1 w-20'
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-semibold">{year}{!config && <span className="ml-2 text-xs text-amber-700">not yet set</span>}</td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={sco} onChange={(e) => setSco(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="1000" value={limit} onChange={(e) => setLimit(e.target.value)} className="rounded border border-slate-300 px-2 py-1 w-28" /></td>
      <td className="px-3 py-2"><input type="number" step="0.001" value={seq} onChange={(e) => setSeq(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={guar} onChange={(e) => setGuar(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={erpF} onChange={(e) => setErpF(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={erpC} onChange={(e) => setErpC(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={pf} onChange={(e) => setPf(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2"><input type="number" step="0.01" value={icf} onChange={(e) => setIcf(e.target.value)} className={inputCls} /></td>
      <td className="px-3 py-2">
        <button
          onClick={() => onSave(year, {
            sco_trigger: num(sco) ?? DEFAULT_SCO_TRIGGER,
            per_person_payment_limit: num(limit) ?? DEFAULT_PER_PERSON_PAYMENT_LIMIT,
            sequestration_pct: num(seq) ?? DEFAULT_SEQUESTRATION_PCT,
            arc_guarantee_pct: num(guar) ?? defaultArcGuaranteePct(year),
            arc_payment_cap_pct: num(cap) ?? defaultArcPaymentCapPct(year),
            erp_olympic_factor: num(erpF) ?? defaultErpOlympicFactor(year),
            erp_cap_pct: num(erpC) ?? DEFAULT_ERP_CAP_PCT,
            payment_factor: num(pf) ?? DEFAULT_PAYMENT_FACTOR,
            arc_ic_payment_factor: num(icf) ?? DEFAULT_ARC_IC_PAYMENT_FACTOR,
          })}
          className="text-green-700 font-semibold"
        >Save</button>
      </td>
    </tr>
  )
}

// ---------- ARC-CO Benchmarks ----------

// County + state label used everywhere a benchmark county is shown or picked —
// county names repeat across states, so a bare name is ambiguous.
const countyLabel = (c: County) => `${c.name}, ${c.state_code}`

function AddBenchmarkForm({ commodities, counties, existing, preferredCountyIds, onAdd }: {
  commodities: CoveredCommodity[]
  counties: County[]
  existing: ArcBenchmarkData[]
  // The operation's own counties (from farms) — sorted to the top of the list.
  preferredCountyIds: ReadonlySet<string>
  onAdd: (patch: { commodity_id: string; county: string | null; county_id: string | null; benchmark_price: number | null; benchmark_yield: number | null }) => void
}) {
  const OTHER = '__other__'
  const [commodity, setCommodity] = useState('')
  // The county picker DEFAULTS to the operation's own counties (from farms) —
  // one select, "County, ST" labels. "Other county…" reveals the state →
  // county cascade over the FULL reference table (county names repeat across
  // states, so the pair is the only unambiguous pick for arbitrary counties).
  const [pick, setPick] = useState('') // '' = default row, a county id, or OTHER
  const [stateCode, setStateCode] = useState('')
  const [countyId, setCountyId] = useState('')
  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm bg-white'
  const myCounties = useMemo(
    () => counties
      .filter((c) => preferredCountyIds.has(c.id))
      .sort((a, b) => a.state_code.localeCompare(b.state_code) || a.name.localeCompare(b.name)),
    [counties, preferredCountyIds],
  )
  const states = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of counties) if (!m.has(c.state_code)) m.set(c.state_code, c.state)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [counties])
  const stateCounties = useMemo(
    () => counties.filter((c) => c.state_code === stateCode).sort((a, b) => a.name.localeCompare(b.name)),
    [counties, stateCode],
  )
  const countyRec = pick === OTHER
    ? (countyId ? counties.find((c) => c.id === countyId) ?? null : null)
    : (pick ? counties.find((c) => c.id === pick) ?? null : null)
  const needsCounty = pick === OTHER && !countyRec
  const dup = commodity !== '' && existing.some((b) =>
    b.commodity_id === commodity &&
    (countyRec
      ? b.county_id === countyRec.id || (b.county_id == null && (b.county ?? '').trim().toLowerCase() === countyRec.name.toLowerCase())
      : pick === '' && b.county_id == null && (b.county ?? '').trim() === ''))
  return (
    <div className="flex flex-wrap items-end gap-2 border border-slate-200 rounded-lg p-3">
      <select value={commodity} onChange={(e) => setCommodity(e.target.value)} className={inputCls}>
        <option value="">Commodity…</option>
        {commodities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={pick} onChange={(e) => { setPick(e.target.value); setStateCode(''); setCountyId('') }} className={inputCls}>
        <option value="">All counties (default row)</option>
        {myCounties.length > 0 && (
          <optgroup label="Your counties">
            {myCounties.map((c) => <option key={c.id} value={c.id}>{countyLabel(c)}</option>)}
          </optgroup>
        )}
        <option value={OTHER}>Other county…</option>
      </select>
      {pick === OTHER && (
        <>
          <select value={stateCode} onChange={(e) => { setStateCode(e.target.value); setCountyId('') }} className={inputCls}>
            <option value="">State…</option>
            {states.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          <select value={countyId} onChange={(e) => setCountyId(e.target.value)} disabled={!stateCode} className={`${inputCls} disabled:opacity-50`}>
            <option value="">{stateCode ? 'County…' : '—'}</option>
            {stateCounties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </>
      )}
      <button
        onClick={() => { if (commodity && !dup && !needsCounty) { onAdd({ commodity_id: commodity, county: countyRec?.name ?? null, county_id: countyRec?.id ?? null, benchmark_price: null, benchmark_yield: null }); setCommodity(''); setPick(''); setStateCode(''); setCountyId('') } }}
        disabled={!commodity || dup || needsCounty}
        className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
      >Add row</button>
      {dup && <span className="text-xs text-amber-700">That commodity × county row already exists.</span>}
      {needsCounty && !dup && <span className="text-xs text-amber-700">Pick the state and county (or choose “All counties” for the default row).</span>}
    </div>
  )
}

type AiLookup = { benchmark_yield: number | null; benchmark_price: number | null; data_year: number | null; source_description: string; confidence: 'high' | 'low' }
type FsaFileLookup = {
  rows: Array<{ practice: 'irrigated' | 'non_irrigated' | 'all'; benchmark_yield: number | null; benchmark_price: number | null; benchmark_revenue: number | null }>
  data_year: number | null
  requested_year: number
  county: string
  state: string
  fetched_at: string | null
  source_description: string
  not_found?: boolean
  // Client-side only: the file service failed (network/parse) — the strip
  // shows the error and offers the AI fallback.
  error?: string
}
const PRACTICE_LABEL: Record<'irrigated' | 'non_irrigated' | 'all', string> = {
  all: 'All practices', non_irrigated: 'Non-irrigated', irrigated: 'Irrigated',
}

function BenchmarkRow({ row, commodity, counties, cropYear, defaultPrice, onSave, onDelete, onErr }: {
  row: ArcBenchmarkData
  commodity?: CoveredCommodity
  counties: County[]
  cropYear: number
  /** The seeded/published national benchmark price (the all-counties default row). */
  defaultPrice: number | null
  onSave: (patch: {
    id?: string; commodity_id: string; county: string | null; county_id: string | null; benchmark_price: number | null; benchmark_yield: number | null
    price_source?: 'usda' | 'manual' | 'ai'; yield_source?: 'usda' | 'manual' | 'ai'; source_description?: string | null
  }) => void
  onDelete: (id: string) => void
  onErr: (s: string) => void
}) {
  const [price, setPrice] = useState(row.benchmark_price != null ? String(Number(row.benchmark_price)) : '')
  const [yld, setYld] = useState(row.benchmark_yield != null ? String(Number(row.benchmark_yield)) : '')
  const [looking, setLooking] = useState(false)
  const [aiResult, setAiResult] = useState<AiLookup | null>(null)
  const [fileResult, setFileResult] = useState<FsaFileLookup | null>(null)
  const [filePractice, setFilePractice] = useState<'irrigated' | 'non_irrigated' | 'all'>('all')
  // Retry targets when the row's own county × year has no published data: a
  // nearby county (same state) and/or an earlier program year. The values
  // always SAVE to this row's county — provenance records what was borrowed.
  const [altCountyId, setAltCountyId] = useState('')
  const [altYear, setAltYear] = useState(cropYear)
  // What the current lookup result was actually fetched for.
  const [usedTarget, setUsedTarget] = useState<{ county: County; year: number } | null>(null)
  useEffect(() => {
    setPrice(row.benchmark_price != null ? String(Number(row.benchmark_price)) : '')
    setYld(row.benchmark_yield != null ? String(Number(row.benchmark_yield)) : '')
    setAltCountyId('')
    setAltYear(cropYear)
    setUsedTarget(null)
    setFileResult(null)
    setAiResult(null)
  }, [row, cropYear])

  // The county record behind this row: by county_id, or — for legacy rows that
  // predate county_id — by name when that name is unambiguous nationwide.
  // Saving through this row persists the resolved id, healing legacy rows.
  const countyRec = useMemo(() => {
    if (row.county_id) return counties.find((c) => c.id === row.county_id) ?? null
    const name = (row.county ?? '').trim().toLowerCase()
    if (!name) return null
    const matches = counties.filter((c) => c.name.trim().toLowerCase() === name)
    return matches.length === 1 ? matches[0] : null
  }, [row.county_id, row.county, counties])
  const ambiguousLegacy = row.county != null && row.county.trim() !== '' && !countyRec

  const sourceChip = (s: 'usda' | 'manual' | 'ai') => (
    <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${s === 'usda' ? 'bg-green-100 text-green-800' : s === 'ai' ? 'bg-violet-100 text-violet-800' : 'bg-slate-200 text-slate-600'}`}>{s}</span>
  )

  function lookupGuard(): boolean {
    if (!commodity) return false
    if (!countyRec) {
      onErr(ambiguousLegacy
        ? `Can't tell which state "${row.county}" is in — delete this row and re-add it picking “County, ST” from the list, then retry the lookup.`
        : 'The lookup needs a county + state. The default (all counties) row holds the national benchmark price — add county rows for yields, or copy the price from one.')
      return false
    }
    return true
  }

  // Primary lookup: the county YIELD comes straight from FSA's published
  // "ARC-County Benchmark Yields and Revenues" workbook (parsed + cached
  // server-side); the PRICE comes from the file / seeded national values.
  // The AI web search below is only a labeled fallback. `target` lets the
  // user retry against a nearby county and/or an earlier program year when
  // this row's own county × year has nothing published.
  async function fsaFileLookup(target?: { county: County; year: number }) {
    if (!lookupGuard()) return
    const t = target ?? { county: countyRec!, year: cropYear }
    setLooking(true); setAiResult(null); setFileResult(null); setUsedTarget(t)
    try {
      const res = await fetch('/api/fsa-benchmark-yield', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commodity: commodity!.name,
          county: t.county.name,
          state: t.county.state_code,
          county_id: t.county.id,
          crop_year: t.year,
        }),
      })
      const json = await res.json().catch(() => null)
      const failed = (error: string) => setFileResult({
        rows: [], data_year: null, requested_year: t.year, county: t.county.name, state: t.county.state_code,
        fetched_at: null, source_description: '', not_found: true, error,
      })
      if (!res.ok || !json?.data) { failed(json?.error ?? 'FSA file lookup failed.'); return }
      const data = json.data as FsaFileLookup
      setFileResult(data)
      const practices = data.rows.map((r) => r.practice)
      setFilePractice(practices.includes('all') ? 'all' : practices.includes('non_irrigated') ? 'non_irrigated' : 'irrigated')
    } catch {
      setFileResult({
        rows: [], data_year: null, requested_year: t.year, county: t.county.name, state: t.county.state_code,
        fetched_at: null, source_description: '', not_found: true, error: 'FSA file lookup failed — check your connection.',
      })
    } finally {
      setLooking(false)
    }
  }

  // Provenance notes when the confirmed values were borrowed from a nearby
  // county or an earlier program year — the save always lands on THIS row.
  function borrowNote(): string {
    let s = ''
    if (usedTarget && countyRec && usedTarget.county.id !== countyRec.id) {
      s += ` — nearby-county data (${usedTarget.county.name} County, ${usedTarget.county.state_code}) applied to ${countyRec.name} County, ${countyRec.state_code}`
    }
    if (usedTarget && usedTarget.year !== cropYear) s += ` — used for program year ${cropYear}`
    return s
  }

  function confirmFile() {
    if (!fileResult) return
    const picked = fileResult.rows.find((r) => r.practice === filePractice) ?? fileResult.rows[0]
    if (!picked || picked.benchmark_yield == null) return
    // Price precedence: the file's own printed benchmark price, else the
    // seeded/published national value, else whatever is typed on the row.
    const filePrice = picked.benchmark_price ?? defaultPrice
    const usePrice = filePrice ?? (price.trim() !== '' ? Number(price) : null)
    onSave({
      id: row.id, commodity_id: row.commodity_id,
      county: countyRec?.name ?? row.county, county_id: countyRec?.id ?? row.county_id,
      benchmark_price: usePrice,
      benchmark_yield: picked.benchmark_yield,
      // The workbook IS the FSA-published source.
      yield_source: 'usda',
      price_source: filePrice != null ? 'usda' : row.price_source,
      source_description: `${fileResult.source_description}${picked.practice !== 'all' ? ` (${PRACTICE_LABEL[picked.practice]})` : ''}${borrowNote()}`,
    })
    setFileResult(null)
  }

  // Labeled fallback when the file service can't find the county/commodity —
  // keeps the AI web search's low-confidence guardrails.
  async function aiLookup(target?: { county: County; year: number }) {
    if (!lookupGuard()) return
    const t = target ?? { county: countyRec!, year: cropYear }
    setLooking(true); setAiResult(null); setFileResult(null); setUsedTarget(t)
    try {
      const res = await fetch('/api/arc-benchmark-lookup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commodity: commodity!.name,
          county: t.county.name,
          state: t.county.state,
          county_id: t.county.id,
          crop_year: t.year,
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.data) { onErr(json?.error ?? 'AI lookup failed.'); return }
      setAiResult(json.data as AiLookup)
    } catch {
      onErr('AI lookup failed — enter the benchmark manually from your FSA office or fsa.usda.gov.')
    } finally {
      setLooking(false)
    }
  }

  function confirmAi() {
    if (!aiResult) return
    onSave({
      id: row.id, commodity_id: row.commodity_id,
      county: countyRec?.name ?? row.county, county_id: countyRec?.id ?? row.county_id,
      benchmark_price: aiResult.benchmark_price ?? (price.trim() !== '' ? Number(price) : null),
      benchmark_yield: aiResult.benchmark_yield ?? (yld.trim() !== '' ? Number(yld) : null),
      price_source: aiResult.benchmark_price != null ? 'ai' : row.price_source,
      yield_source: aiResult.benchmark_yield != null ? 'ai' : row.yield_source,
      source_description: `${aiResult.source_description || ''}${borrowNote()}` || null,
    })
    setAiResult(null)
  }

  const inputCls = 'rounded border border-slate-300 px-2 py-1 w-24'
  const altSelectCls = 'rounded border border-slate-300 px-1.5 py-1 text-xs bg-white'
  const nearbyCounties = countyRec
    ? counties.filter((c) => c.state_code === countyRec.state_code && c.id !== countyRec.id).sort((a, b) => a.name.localeCompare(b.name))
    : []
  const altCounty = altCountyId ? counties.find((c) => c.id === altCountyId) ?? null : null
  const retryTarget = countyRec ? { county: altCounty ?? countyRec, year: altYear } : null
  // Offered when a lookup comes back empty: retry against a nearby county
  // (same state) and/or an earlier program year — values still save to THIS
  // row, with the borrowed source recorded in the provenance.
  const altControls = countyRec && (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1 text-xs text-slate-600">
        County
        <select value={altCountyId} onChange={(e) => setAltCountyId(e.target.value)} className={altSelectCls}>
          <option value="">{countyRec.name} (this row)</option>
          {nearbyCounties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-slate-600">
        Year
        <select value={altYear} onChange={(e) => setAltYear(Number(e.target.value))} className={altSelectCls}>
          {[cropYear, cropYear - 1, cropYear - 2, cropYear - 3].map((y) => (
            <option key={y} value={y}>{y}{y !== cropYear ? ' (prior)' : ''}</option>
          ))}
        </select>
      </label>
      <button
        onClick={() => retryTarget && fsaFileLookup(retryTarget)}
        disabled={looking}
        className="rounded-lg bg-green-800 text-white px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
      >{looking ? 'Looking up…' : 'Retry FSA lookup'}</button>
      <button
        onClick={() => retryTarget && aiLookup(retryTarget)}
        disabled={looking}
        className="rounded-lg bg-violet-700 text-white px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
      >AI web search</button>
    </span>
  )
  const borrowedCounty = usedTarget && countyRec && usedTarget.county.id !== countyRec.id ? usedTarget.county : null
  return (
    <>
      <tr className="border-t border-slate-100 align-middle">
        <td className="px-3 py-2 font-semibold whitespace-nowrap">{commodity?.name ?? '—'}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          {countyRec ? countyLabel(countyRec)
            : ambiguousLegacy ? <span title="This row predates county+state keying and its name exists in several states — re-add it as “County, ST”.">{row.county} <span className="text-xs text-amber-700">(state unknown)</span></span>
            : <span className="text-slate-400">all counties</span>}
        </td>
        <td className="px-3 py-2"><input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className={inputCls} /></td>
        <td className="px-3 py-2"><input type="number" step="0.1" value={yld} onChange={(e) => setYld(e.target.value)} className={inputCls} /></td>
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="inline-flex gap-1">price {sourceChip(row.price_source)} · yield {sourceChip(row.yield_source)}</span>
          {row.source_description && <div className="text-[10px] text-slate-400 max-w-[220px]">{row.source_description}</div>}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <button
            onClick={() => onSave({ id: row.id, commodity_id: row.commodity_id, county: countyRec?.name ?? row.county, county_id: countyRec?.id ?? row.county_id, benchmark_price: num(price), benchmark_yield: num(yld), price_source: 'manual', yield_source: 'manual', source_description: row.source_description })}
            className="text-green-700 font-semibold mr-3"
          >Save</button>
          <button
            onClick={() => { setAltCountyId(''); setAltYear(cropYear); fsaFileLookup() }}
            disabled={looking || !countyRec}
            title={countyRec
              ? 'County yield from FSA’s published benchmark workbook + the seeded national price — you confirm before anything saves.'
              : ambiguousLegacy ? 'State unknown — re-add this row as “County, ST” first.' : 'The lookup needs a county + state — add county rows for yields.'}
            className="rounded-lg bg-green-800 text-white px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
          >
            {looking ? 'Looking up…' : 'FSA lookup'}
          </button>
        </td>
        <td className="px-3 py-2"><button onClick={() => onDelete(row.id)} className="text-red-600 text-xs">Delete</button></td>
      </tr>
      {fileResult && (
        <tr className="bg-green-50">
          <td colSpan={7} className="px-3 py-2 text-sm">
            {fileResult.not_found || fileResult.rows.every((r) => r.benchmark_yield == null) ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-slate-700">
                  {fileResult.error
                    ? fileResult.error
                    : <>FSA&apos;s published benchmark file has no {commodity?.name} row for {fileResult.county} County, {fileResult.state}{fileResult.requested_year !== cropYear ? ` (${fileResult.requested_year})` : ''}. Try a nearby county or a prior year, or the AI web search:</>}
                </span>
                {altControls}
                <button onClick={() => setFileResult(null)} className="text-xs text-slate-500 underline">dismiss</button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  FSA file:{' '}
                  {fileResult.rows.filter((r) => r.benchmark_yield != null).map((r) => (
                    <label key={r.practice} className="inline-flex items-center gap-1 mr-2">
                      {fileResult.rows.filter((x) => x.benchmark_yield != null).length > 1 && (
                        <input type="radio" name={`fsa-practice-${row.id}`} checked={filePractice === r.practice} onChange={() => setFilePractice(r.practice)} />
                      )}
                      <span>{PRACTICE_LABEL[r.practice]} yield <b>{r.benchmark_yield}</b></span>
                    </label>
                  ))}
                  {(() => {
                    const shown = fileResult.rows.find((r) => r.practice === filePractice) ?? fileResult.rows[0]
                    const p = shown?.benchmark_price ?? defaultPrice
                    return p != null
                      ? <span>· price <b>${Number(p)}</b> <span className="text-xs text-slate-500">({shown?.benchmark_price != null ? 'from the FSA file' : 'seeded national benchmark'})</span></span>
                      : <span className="text-xs text-amber-700">· no published price found — current price kept</span>
                  })()}
                  {fileResult.data_year != null && fileResult.data_year !== cropYear && (
                    <span className="ml-1 text-xs rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-800" title={`Data from the ${fileResult.data_year} FSA benchmark file, saved against this ${cropYear} row.`}>
                      {fileResult.data_year} data
                    </span>
                  )}
                  {borrowedCounty && (
                    <span className="ml-1 text-xs rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-800" title={`Looked up ${borrowedCounty.name} County, ${borrowedCounty.state_code} — confirming saves these values to ${countyRec?.name} County, ${countyRec?.state_code} with the borrowed source recorded.`}>
                      nearby county: {borrowedCounty.name} → saves to {countyRec?.name}
                    </span>
                  )}
                </span>
                <span className="text-xs text-slate-500 flex-1 min-w-[200px]">{fileResult.source_description}</span>
                <button onClick={confirmFile} className="rounded-lg bg-green-700 text-white px-3 py-1 text-xs font-semibold">Confirm &amp; save</button>
                <button onClick={() => aiLookup(usedTarget ?? undefined)} disabled={looking} className="text-xs text-violet-700 underline">AI web search instead</button>
                <button onClick={() => setFileResult(null)} className="text-xs text-slate-500 underline">dismiss</button>
              </div>
            )}
          </td>
        </tr>
      )}
      {aiResult && (
        <tr className="bg-violet-50">
          <td colSpan={7} className="px-3 py-2 text-sm">
            <div className="mb-1 text-xs text-violet-800 font-semibold">AI web search (fallback — verify against FSA data)</div>
            <div className="flex flex-wrap items-center gap-3">
              <span>
                AI found: yield <b>{aiResult.benchmark_yield ?? '—'}</b>, price <b>{aiResult.benchmark_price != null ? `$${aiResult.benchmark_price}` : '—'}</b>{' '}
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${aiResult.confidence === 'high' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{aiResult.confidence} confidence</span>
                {aiResult.data_year != null && aiResult.data_year !== cropYear && (
                  <span className="ml-1 text-xs rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-800" title={`${aiResult.data_year} data, saved against this ${cropYear} row.`}>
                    {aiResult.data_year} data
                  </span>
                )}
                {borrowedCounty && (
                  <span className="ml-1 text-xs rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-800" title={`Looked up ${borrowedCounty.name} County, ${borrowedCounty.state_code} — confirming saves these values to ${countyRec?.name} County, ${countyRec?.state_code} with the borrowed source recorded.`}>
                    nearby county: {borrowedCounty.name} → saves to {countyRec?.name}
                  </span>
                )}
              </span>
              <span className="text-xs text-slate-500 flex-1 min-w-[200px]">{aiResult.source_description}</span>
              {(aiResult.benchmark_yield != null || aiResult.benchmark_price != null) && aiResult.confidence === 'high' ? (
                <button onClick={confirmAi} className="rounded-lg bg-green-700 text-white px-3 py-1 text-xs font-semibold">Confirm &amp; save</button>
              ) : (
                <span className="text-xs text-amber-800">
                  {aiResult.benchmark_yield == null && aiResult.benchmark_price == null
                    ? 'Nothing reliable found — enter the values manually from your FSA office or fsa.usda.gov.'
                    : 'Low confidence — verify against FSA data before saving, or enter manually.'}
                </span>
              )}
              {(aiResult.benchmark_yield != null || aiResult.benchmark_price != null) && aiResult.confidence === 'low' && (
                <button onClick={confirmAi} className="rounded-lg bg-white border border-slate-300 px-3 py-1 text-xs">Use anyway</button>
              )}
              <button onClick={() => setAiResult(null)} className="text-xs text-slate-500 underline">dismiss</button>
            </div>
            {aiResult.benchmark_yield == null && aiResult.benchmark_price == null && altControls && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-600">Or try a nearby county / prior year:</span>
                {altControls}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function AddOtherPaymentForm({ entities, crops, farms, cropYear, defaultEntityId = '', onSaved, onErr }: { entities: Entity[]; crops: Crop[]; farms: Farm[]; cropYear: number; defaultEntityId?: string; onSaved: () => void; onErr: (s: string) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [program, setProgram] = useState(''); const [customProgram, setCustomProgram] = useState('')
  const [entityId, setEntityId] = useState(defaultEntityId); const [cropId, setCropId] = useState(''); const [farmId, setFarmId] = useState('')
  const [amount, setAmount] = useState(''); const [date, setDate] = useState(''); const [status, setStatus] = useState<'projected' | 'confirmed' | 'received'>('projected'); const [year, setYear] = useState(String(cropYear))
  useEffect(() => { setYear(String(cropYear)) }, [cropYear])
  useEffect(() => { setEntityId(defaultEntityId) }, [defaultEntityId])
  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm bg-white'

  async function add() {
    const name = program === 'Other' ? customProgram.trim() : program
    if (!name) { onErr('Pick or enter a program name.'); return }
    const { error } = await supabase.from('other_government_payments').insert({
      entity_id: entityId || null, program_name: name, crop_year: Number(year) || cropYear,
      crop_id: cropId || null, farm_id: farmId || null, amount: num(amount) ?? 0,
      payment_date: date || null, payment_status: status,
    })
    if (error) { onErr(error.message); return }
    setProgram(''); setCustomProgram(''); setEntityId(defaultEntityId); setCropId(''); setFarmId(''); setAmount(''); setDate(''); setStatus('projected')
    onSaved()
  }
  return (
    <div className="flex flex-wrap items-end gap-2 border border-slate-200 rounded-lg p-3">
      <select value={program} onChange={(e) => setProgram(e.target.value)} className={inputCls}>
        <option value="">Program…</option>
        {COMMON_PROGRAMS.map((p) => <option key={p} value={p}>{p}</option>)}
        <option value="Other">Other…</option>
      </select>
      {program === 'Other' && <input placeholder="Program name" value={customProgram} onChange={(e) => setCustomProgram(e.target.value)} className={inputCls} />}
      <input type="number" placeholder="Year" value={year} onChange={(e) => setYear(e.target.value)} className={`${inputCls} w-20`} />
      <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}><option value="">Entity…</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
      <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}><option value="">Crop (opt)…</option>{crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select value={farmId} onChange={(e) => setFarmId(e.target.value)} className={inputCls}><option value="">Farm (opt)…</option>{farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
      <input type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputCls} w-28`} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
      <select value={status} onChange={(e) => setStatus(e.target.value as 'projected' | 'confirmed' | 'received')} className={inputCls}>
        <option value="projected">Projected</option><option value="confirmed">Confirmed</option><option value="received">Received</option>
      </select>
      <button onClick={add} className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold">Add</button>
      <p className="w-full text-xs text-slate-500 mt-1">
        <strong>Year</strong> = the crop year the payment is <em>received</em> in (the payment year). For
        program-linked payments paid the fall after the program year (ARC/PLC-style), enter the payment year — the
        Payment Tracker and revenue reports attribute payments to the year the cash arrives.
      </p>
    </div>
  )
}
