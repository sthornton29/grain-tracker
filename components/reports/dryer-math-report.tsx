'use client'

// Grain Dryer Math — a calculator, not a ledger. THREE inputs on the main
// screen (crop · fuel type · fuel price) and the table renders immediately;
// everything else (dryer/consumption, grain price, electric rate, dryer
// depreciation, calibrate-from-records) lives in the ⚙ Assumptions
// slide-over. The dry-it-or-haul-it buyer comparison is a collapsed optional
// section at the bottom. Math in lib/dryer-math.ts (unit-tested); session
// inputs + saved dryers + the org's dryer_settings row (079).
//
// The table is TWO columns — Moisture | Total drying cost/bu — instantly
// readable. Above base the total is fuel + fan electricity + depreciation
// (flat per bushel dried, the extension convention); the breakdown lives in
// the note under the table and in the assumptions panel. Below base the
// single column carries the red cost of overdrying (sellable volume given
// away + the fuel spent removing points nobody pays for).
//
// Economics: the water above base is unsellable whether you dry it or the
// buyer's shrink table takes it, so the weight lost reaching base is never a
// cost of drying. Depreciation IS a real cost of running your dryer — but
// sunk if the dryer is owned regardless, so the buyer comparison has a
// toggle (default on) for the marginal dry-vs-haul call.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { marketingReferenceContract } from '@/lib/reference-contract'
import {
  DEFAULT_DEPRECIATION_CENTS_PER_BU,
  DEFAULT_ELECTRIC_RATE,
  SHRINK_PCT_PER_POINT,
  calibrateFromRecords,
  depreciationCentsPerBu,
  dryingCost,
  energyCostPerBuPt,
  moistureRows,
  overdryingCost,
  presetFuelPerBuPt,
  wetVsDry,
  type DryerFuel,
  type DryerSpec,
  type DryingRates,
} from '@/lib/dryer-math'
import {
  parseTiers,
  scheduleInForce,
  type RuleBasis,
  type ScheduleRuleShape,
} from '@/lib/discount-schedules'
import { coerceDiscountCategory } from '@/lib/settlement-discounts'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import DiscountScheduleImport from '@/components/discount-schedule-import'
import { EmptyState, fmtNum, numCell, textCell, theadCls } from '@/components/reports/report-kit'
import type { Buyer, BuyerDiscountSchedule, BuyerDiscountScheduleRule, Crop } from '@/lib/types'

type DryerModel = {
  id: string
  manufacturer: string
  model: string
  dryer_type: string
  default_gal_lp_per_bu_pt: number | string
  notes: string | null
}

type OrgDryer = {
  id: string
  name: string
  dryer_model_id: string | null
  fuel: DryerFuel
  fuel_per_bu_pt: number | string
  fan_kwh_per_bu_pt: number | string | null
}

/** One row per org (079): the depreciation assumption + comparison toggle. */
type DryerSettingsRow = {
  id: string
  depreciation_cents_per_bu: number | string
  include_depreciation_in_comparison: boolean
  dryer_investment: number | string | null
  useful_life_years: number | string | null
  bushels_dried_per_year: number | string | null
}

const DRYER_TYPE_LABELS: Record<string, string> = {
  cross_flow: 'cross-flow',
  mixed_flow: 'mixed-flow',
  tower: 'tower',
  heat_recovery: 'heat recovery',
  in_bin_high_temp: 'in-bin high-temp',
}

const N = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

const fmtCents = (n: number | null | undefined, d = 1) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}¢`

export default function DryerMathReport({
  onPayloadChange,
}: {
  onPayloadChange: (fn: () => ExportPayload) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [models, setModels] = useState<DryerModel[]>([])
  const [orgDryers, setOrgDryers] = useState<OrgDryer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [schedules, setSchedules] = useState<BuyerDiscountSchedule[]>([])
  const [scheduleRules, setScheduleRules] = useState<BuyerDiscountScheduleRule[]>([])
  const [schedulesVersion, setSchedulesVersion] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  // ---- THE THREE MAIN INPUTS ----
  const [cropId, setCropId] = usePersistentState('dryer:cropId', '')
  const [mainFuel, setMainFuel] = usePersistentState<DryerFuel>('dryer:fuel', 'lp')
  const [lpPrice, setLpPrice] = usePersistentState('dryer:lpPrice', '1.60')
  const [ngPrice, setNgPrice] = usePersistentState('dryer:ngPrice', '1.20')

  // ---- assumptions (slide-over) ----
  const [panelOpen, setPanelOpen] = useState(false)
  // 'auto' = the org's first saved dryer when one exists, else the quick
  // consumption input below.
  const [dryerPick, setDryerPick] = usePersistentState('dryer:pick2', 'auto')
  // Gal-LP-EQUIVALENT per bushel-point (converted for NG by BTU parity).
  const [quickPerBuPt, setQuickPerBuPt] = usePersistentState('dryer:perBuPtLpEq', '0.018')
  const [quickFanKwh, setQuickFanKwh] = usePersistentState('dryer:quickFanKwh', '')
  const [electricRate, setElectricRate] = usePersistentState('dryer:electricRate', String(DEFAULT_ELECTRIC_RATE))
  const [grainPriceStr, setGrainPriceStr] = useState('')
  const [quote, setQuote] = useState<{ symbol: string; price: number } | null>(null)

  // ---- dryer ownership (079 dryer_settings, one row per org) ----
  const [settingsRow, setSettingsRow] = useState<DryerSettingsRow | null>(null)
  const [settingsMissing, setSettingsMissing] = useState(false)
  const [deprStr, setDeprStr] = useState(String(DEFAULT_DEPRECIATION_CENTS_PER_BU))
  const [includeDeprInCompare, setIncludeDeprInCompare] = useState(true)
  // The mini-calculator's three inputs (investment ÷ life ÷ bushels/yr).
  const [invStr, setInvStr] = useState('')
  const [lifeStr, setLifeStr] = useState('')
  const [buYrStr, setBuYrStr] = useState('')

  // ---- buyer comparison (collapsed, off by default) ----
  const [compareOpen, setCompareOpen] = useState(false)
  const [buyerId, setBuyerId] = usePersistentState('dryer:buyerId', '')

  // Calibration inputs.
  const [calFuel, setCalFuel] = useState('')
  const [calBu, setCalBu] = useState('')
  const [calPts, setCalPts] = useState('')
  const [calSaved, setCalSaved] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')

  const refetchDryers = useCallback(async () => {
    const { data } = await supabase.from('org_dryers').select('*').order('name')
    setOrgDryers((data as unknown as OrgDryer[]) || [])
  }, [supabase])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [m, d, c, b, ds] = await Promise.all([
        supabase.from('dryer_models').select('*').order('manufacturer').order('model'),
        supabase.from('org_dryers').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('dryer_settings').select('*').maybeSingle(),
      ])
      if (cancelled) return
      setModels((m.data as unknown as DryerModel[]) || [])
      setOrgDryers((d.data as unknown as OrgDryer[]) || [])
      setCrops((c.data as Crop[]) || [])
      setBuyers((b.data as Buyer[]) || [])
      // 079 not applied yet → the calculator still works with the default.
      if (ds.error) setSettingsMissing(true)
      const s = (ds.data ?? null) as DryerSettingsRow | null
      setSettingsRow(s)
      if (s) {
        setDeprStr(String(N(s.depreciation_cents_per_bu) ?? DEFAULT_DEPRECIATION_CENTS_PER_BU))
        setIncludeDeprInCompare(s.include_depreciation_in_comparison !== false)
        setInvStr(s.dryer_investment != null ? String(s.dryer_investment) : '')
        setLifeStr(s.useful_life_years != null ? String(s.useful_life_years) : '')
        setBuYrStr(s.bushels_dried_per_year != null ? String(s.bushels_dried_per_year) : '')
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [supabase])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [s, r] = await Promise.all([
        supabase.from('buyer_discount_schedules').select('*'),
        fetchAllRows((f, t) => supabase.from('buyer_discount_schedule_rules').select('*').order('id').range(f, t)),
      ])
      if (cancelled) return
      setSchedules((s.data as BuyerDiscountSchedule[]) || [])
      setScheduleRules((r.data as BuyerDiscountScheduleRule[]) || [])
    })()
    return () => { cancelled = true }
  }, [supabase, schedulesVersion])

  // Default crop: Corn when present (the classic drying crop).
  useEffect(() => {
    if (!cropId && crops.length > 0) {
      const corn = crops.find((c) => /corn/i.test(c.name) && !/seed/i.test(c.name))
      setCropId((corn ?? crops[0]).id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crops])

  const crop = crops.find((c) => c.id === cropId) ?? null
  const baseMoisture = N(crop?.base_moisture_pct) ?? 15

  // Grain price default: the crop's reference-contract quote.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setQuote(null)
      if (!crop) return
      const year = new Date().getFullYear()
      const ref = marketingReferenceContract(crop.name, year, new Date())
      if (!ref) return
      try {
        const res = await fetch('/api/market-prices', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: [ref.symbol] }),
        })
        const json = await res.json().catch(() => null)
        const p = (json?.prices ?? []).find((x: { symbol: string; price: number | null }) => x.symbol === ref.symbol)
        if (!cancelled && p?.price != null) setQuote({ symbol: ref.symbol, price: Number(p.price) })
      } catch { /* manual price still works */ }
    })()
    return () => { cancelled = true }
  }, [crop?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const grainPrice = N(grainPriceStr) ?? quote?.price ?? null

  // ---- resolve the active dryer spec ----
  // 'auto' prefers the org's saved (calibrated) dryer; else quick inputs.
  const effectivePick = dryerPick === 'auto' ? (orgDryers[0]?.id ?? 'quick') : dryerPick
  const pickedOrgDryer = orgDryers.find((d) => d.id === effectivePick) ?? null
  const pickedModel = effectivePick.startsWith('model:') ? models.find((m) => m.id === effectivePick.slice(6)) ?? null : null
  const spec: DryerSpec | null = useMemo(() => {
    if (pickedOrgDryer) {
      return {
        fuel: pickedOrgDryer.fuel,
        fuelPerBuPt: N(pickedOrgDryer.fuel_per_bu_pt) ?? 0,
        fanKwhPerBuPt: N(pickedOrgDryer.fan_kwh_per_bu_pt),
      }
    }
    const galLpEq = N(pickedModel ? pickedModel.default_gal_lp_per_bu_pt : quickPerBuPt)
    if (galLpEq == null || galLpEq <= 0) return null
    return {
      fuel: mainFuel,
      fuelPerBuPt: presetFuelPerBuPt(galLpEq, mainFuel),
      fanKwhPerBuPt: pickedModel ? null : N(quickFanKwh),
    }
  }, [pickedOrgDryer, pickedModel, mainFuel, quickPerBuPt, quickFanKwh])

  // A saved dryer's own fuel wins; the main selector then displays it fixed.
  const activeFuel: DryerFuel = spec?.fuel ?? mainFuel
  const fuelPrice = activeFuel === 'ng' ? N(ngPrice) : N(lpPrice)
  const deprCents = N(deprStr) ?? DEFAULT_DEPRECIATION_CENTS_PER_BU
  const rates: DryingRates | null = useMemo(
    () => (fuelPrice != null && spec
      ? { fuelPrice, electricRate: N(electricRate) ?? DEFAULT_ELECTRIC_RATE, depreciationCentsPerBu: Math.max(0, deprCents) }
      : null),
    [fuelPrice, spec, electricRate, deprCents],
  )

  // The mini-calculator's answer (null until all three inputs are in).
  const calcDepr = depreciationCentsPerBu({ investment: invStr, usefulLifeYears: lifeStr, bushelsDriedPerYear: buYrStr })

  // Persist the ownership assumptions per org (079). Best-effort.
  const persistSettings = useCallback(async () => {
    if (settingsMissing) return
    const payload = {
      depreciation_cents_per_bu: Math.max(0, N(deprStr) ?? DEFAULT_DEPRECIATION_CENTS_PER_BU),
      include_depreciation_in_comparison: includeDeprInCompare,
      dryer_investment: N(invStr),
      useful_life_years: N(lifeStr),
      bushels_dried_per_year: N(buYrStr),
    }
    if (settingsRow) {
      await supabase.from('dryer_settings').update(payload).eq('id', settingsRow.id)
    } else {
      const { data } = await supabase.from('dryer_settings').insert(payload).select('*').maybeSingle()
      if (data) setSettingsRow(data as DryerSettingsRow)
    }
  }, [settingsMissing, deprStr, includeDeprInCompare, invStr, lifeStr, buYrStr, settingsRow, supabase])

  // The comparison toggle saves at once (it's a one-click setting).
  useEffect(() => {
    if (loading || !settingsRow) return
    if (settingsRow.include_depreciation_in_comparison === includeDeprInCompare) return
    persistSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeprInCompare])

  // Buyer schedule for the wet-vs-dry comparison — only when the section is open.
  const buyerRules: ScheduleRuleShape[] = useMemo(() => {
    if (!compareOpen || !buyerId || !cropId) return []
    const today = new Date().toISOString().slice(0, 10)
    const sched = scheduleInForce(schedules, buyerId, cropId, today)
      ?? schedules.filter((s) => s.buyer_id === buyerId && s.crop_id === cropId)
        .sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0]
      ?? null
    if (!sched) return []
    return scheduleRules.filter((r) => r.schedule_id === sched.id).map((r) => ({
      factor: coerceDiscountCategory(r.factor),
      basis: (r.basis === 'weight_shrink_pct' || r.basis === 'pct_of_price' ? r.basis : 'cents_per_bu') as RuleBasis,
      base_value: N(r.base_value),
      direction: r.direction === 'below' ? 'below' : 'above',
      rate_per_unit: N(r.rate_per_unit),
      tiers: parseTiers(r.tiers),
      cumulative: r.cumulative === true,
      rejection_at: N(r.rejection_at),
      note: r.note,
    }))
  }, [compareOpen, buyerId, cropId, schedules, scheduleRules])

  const buyersWithSchedules = useMemo(() => {
    const ids = new Set(schedules.filter((s) => s.crop_id === cropId).map((s) => s.buyer_id))
    return buyers.filter((b) => ids.has(b.id))
  }, [buyers, schedules, cropId])

  // ---- the table ----
  // Above-base rows never need the grain price (cost = fuel + fan +
  // depreciation); the overdrying rows do (lost sellable weight), so they
  // wait for one.
  const rows = useMemo(() => {
    if (!spec || !rates) return []
    return moistureRows(baseMoisture).map((m) => {
      if (m > baseMoisture) {
        const cost = dryingCost(m, baseMoisture, spec, rates, grainPrice)
        const verdict = buyerRules.length > 0
          ? wetVsDry(m, baseMoisture, spec, rates, grainPrice, buyerRules, { includeDepreciation: includeDeprInCompare })
          : null
        return { m, kind: 'wet' as const, cost, verdict }
      }
      if (m === baseMoisture) return { m, kind: 'base' as const }
      const over = grainPrice != null ? overdryingCost(m, baseMoisture, spec, rates, grainPrice) : null
      return { m, kind: 'over' as const, over }
    })
  }, [spec, rates, grainPrice, baseMoisture, buyerRules, includeDeprInCompare])

  // ---- calibration ----
  const calibration = calibrateFromRecords({
    totalFuel: N(calFuel) ?? 0,
    bushelsDried: N(calBu) ?? 0,
    avgPointsRemoved: N(calPts) ?? 0,
  })

  async function saveCalibration() {
    if (!pickedOrgDryer || calibration.fuelPerBuPt == null) return
    setErr(null)
    const { error } = await supabase
      .from('org_dryers')
      .update({ fuel_per_bu_pt: calibration.fuelPerBuPt })
      .eq('id', pickedOrgDryer.id)
    if (error) { setErr(error.message); return }
    setCalSaved(`Saved — ${pickedOrgDryer.name} now uses your ${calibration.fuelPerBuPt.toFixed(5)} ${pickedOrgDryer.fuel === 'lp' ? 'gal' : 'ccf'}/bu-pt.`)
    refetchDryers()
  }

  async function saveAsDryer() {
    if (!spec || !saveName.trim()) return
    setErr(null)
    const { error } = await supabase.from('org_dryers').insert({
      name: saveName.trim(),
      dryer_model_id: pickedModel?.id ?? null,
      fuel: spec.fuel,
      fuel_per_bu_pt: spec.fuelPerBuPt,
      fan_kwh_per_bu_pt: spec.fanKwhPerBuPt ?? null,
    })
    if (error) { setErr(error.message); return }
    setSaveName('')
    await refetchDryers()
  }

  async function deleteDryer(d: OrgDryer) {
    if (!confirm(`Delete dryer "${d.name}"?`)) return
    const { error } = await supabase.from('org_dryers').delete().eq('id', d.id)
    if (error) { setErr(error.message); return }
    if (effectivePick === d.id) setDryerPick('quick')
    refetchDryers()
  }

  // ---- export ----
  useEffect(() => {
    onPayloadChange(() => buildPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, crop?.name, spec, fuelPrice, grainPrice, buyerId, compareOpen, deprCents, includeDeprInCompare])

  function buildPayload(): ExportPayload {
    const dryerLabel = pickedOrgDryer?.name
      ?? (pickedModel ? `${pickedModel.manufacturer} ${pickedModel.model}` : 'Standard consumption')
    const comparing = buyerRules.length > 0
    const filters = [
      crop?.name ?? 'No crop',
      `base ${fmtNum(baseMoisture, 1)}%`,
      dryerLabel,
      spec ? `${spec.fuelPerBuPt.toFixed(4)} ${spec.fuel === 'lp' ? 'gal' : 'ccf'}/bu-pt` : '',
      fuelPrice != null ? `${activeFuel === 'lp' ? 'LP $' + fmtNum(fuelPrice) + '/gal' : 'NG $' + fmtNum(fuelPrice) + '/ccf'}` : '',
      `depreciation ${fmtNum(Math.max(0, deprCents), 1)}¢/bu dried`,
      grainPrice != null ? `grain $${fmtNum(grainPrice)}/bu` : '',
      comparing ? `vs ${buyers.find((b) => b.id === buyerId)?.name ?? 'buyer'}${includeDeprInCompare ? '' : ' (depreciation excluded from the comparison)'}` : '',
    ].filter(Boolean).join(' · ')
    return {
      title: 'Grain Dryer Math',
      filters,
      summary: spec && rates ? [
        { label: 'Energy per point (fuel + fan)', value: formatNumber(energyCostPerBuPt(spec, rates) * 100, 'dec1') + '¢/bu' },
        { label: 'Depreciation per bushel dried', value: formatNumber(Math.max(0, deprCents), 'dec1') + '¢/bu' },
        { label: 'Weight lost per point (not a cost)', value: SHRINK_PCT_PER_POINT.toFixed(3) + '%' },
      ] : undefined,
      sections: [{
        title: 'Total drying cost by incoming moisture — fuel + fan electricity + depreciation; rows below base are the cost of overdrying',
        columns: [
          { label: 'Moisture %', align: 'right', format: 'dec1' },
          { label: 'Total drying cost ¢/bu', align: 'right', format: 'dec1' },
          ...(comparing ? [
            { label: 'Buyer dock ¢/bu', align: 'right' as const, format: 'dec1' as const },
            { label: 'Cheaper', align: 'left' as const },
          ] : []),
        ],
        rows: rows.map((r) => {
          if (r.kind === 'base') return [r.m, null, ...(comparing ? [null, 'Base — stop here'] : [])]
          if (r.kind === 'over') {
            return r.over
              ? [r.m, { v: r.over.totalPerBu * 100, tone: 'unfavorable' as const }, ...(comparing ? [null, 'Overdried — cost of going past base'] : [])]
              : [r.m, null, ...(comparing ? [null, 'Overdried — enter a grain price'] : [])]
          }
          return [
            r.m, r.cost.totalPerBu * 100,
            ...(comparing ? [
              r.verdict?.buyerCents ?? null,
              r.verdict?.cheaper === 'dry' ? 'Dry it' : r.verdict?.cheaper === 'haul_wet' ? 'Haul it wet' : r.verdict?.cheaper === 'even' ? 'Even' : '',
            ] : []),
          ]
        }),
      }],
    }
  }

  if (loading) return <p className="text-sm text-slate-400">Loading…</p>
  if (crops.length === 0) {
    return <EmptyState message="No crops set up yet." linkHref="/settings/crops" linkLabel="Set up crops" />
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm'
  const fuelUnit = activeFuel === 'ng' ? 'ccf' : 'gal'
  const dryerLabel = pickedOrgDryer?.name ?? (pickedModel ? `${pickedModel.manufacturer} ${pickedModel.model}` : `${quickPerBuPt || '0.018'} gal-LP-eq/bu-pt`)
  const comparing = buyerRules.length > 0

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-red-600">{err}</p>}
      {settingsMissing && (
        <p className="text-sm rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
          The calculator works, but saving the depreciation assumption needs a database update — contact support.
        </p>
      )}

      {/* ---- THE THREE INPUTS ---- */}
      <div className="bg-white rounded-xl shadow p-4 no-print flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-700">
          Crop
          <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={`block mt-0.5 ${inputCls}`}>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="block text-xs text-slate-500 mt-0.5">Base {fmtNum(baseMoisture, 1)}%</span>
        </label>

        <label className="text-sm text-slate-700">
          Fuel
          <select
            value={activeFuel}
            onChange={(e) => setMainFuel(e.target.value === 'ng' ? 'ng' : 'lp')}
            disabled={pickedOrgDryer != null}
            className={`block mt-0.5 ${inputCls} disabled:bg-slate-100`}
          >
            <option value="lp">Propane (LP)</option>
            <option value="ng">Natural gas</option>
          </select>
          {pickedOrgDryer && (
            <span className="block text-xs text-slate-500 mt-0.5">Set by {pickedOrgDryer.name} — change in Assumptions</span>
          )}
        </label>

        <label className="text-sm text-slate-700">
          {activeFuel === 'ng' ? 'Fuel price $/ccf' : 'Fuel price $/gal'}
          {activeFuel === 'ng' ? (
            <input type="number" step="0.01" value={ngPrice} onChange={(e) => setNgPrice(e.target.value)} className={`block mt-0.5 w-28 ${inputCls} text-right`} />
          ) : (
            <input type="number" step="0.01" value={lpPrice} onChange={(e) => setLpPrice(e.target.value)} className={`block mt-0.5 w-28 ${inputCls} text-right`} />
          )}
        </label>

        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          title="Dryer & consumption, grain price, electric rate, depreciation, calibration"
        >
          ⚙ Assumptions
        </button>
      </div>
      <p className="text-xs text-slate-500 no-print -mt-2">
        Using {dryerLabel} · depreciation {fmtNum(Math.max(0, deprCents), 1)}¢/bu dried · grain {grainPrice != null ? `$${fmtNum(grainPrice)}/bu` : '(no price — only the overdrying rows need one)'}
        {quote && grainPriceStr === '' ? ` (${quote.symbol} today)` : ''} — adjust under ⚙ Assumptions.
      </p>

      {/* ---- the table: Moisture | Total drying cost/bu ---- */}
      {spec == null || rates == null ? (
        <p className="text-sm text-slate-400 bg-white rounded-xl shadow px-4 py-3">Set a fuel price (and consumption under ⚙ Assumptions).</p>
      ) : (
        <div className="overflow-x-auto bg-white rounded-xl shadow inline-block max-w-full align-top">
          <table className="w-auto text-sm border-collapse">
            <thead className={theadCls}>
              <tr>
                <th className={`${numCell} font-semibold`}>Moisture</th>
                <th className={`${numCell} font-semibold`} title="Fuel + fan electricity + dryer depreciation (flat per bushel dried). Shrink is not included — see the note under the table.">Total drying cost/bu</th>
                {comparing && <th className={`${numCell} font-semibold`}>Buyer dock ¢/bu</th>}
                {comparing && <th className={`${textCell} text-left font-semibold`}>Cheaper</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                if (r.kind === 'base') {
                  return (
                    <tr key={r.m} className="border-t-2 border-brand/40 bg-green-50/50 font-medium" title="Base moisture — the stop line">
                      <td className={`${numCell} text-green-800`}>{fmtNum(r.m, 1)}%</td>
                      <td className={`${numCell} text-green-800 text-xs uppercase tracking-wide`}>base</td>
                      {comparing && <td className={`${numCell} text-slate-300`}>—</td>}
                      {comparing && <td className={textCell} />}
                    </tr>
                  )
                }
                if (r.kind === 'over') {
                  const o = r.over
                  return (
                    <tr key={r.m} className="border-t border-slate-100 bg-red-50/40">
                      <td className={`${numCell} text-red-700`}>{fmtNum(r.m, 1)}%</td>
                      {o ? (
                        <td
                          className={`${numCell} font-semibold text-red-700`}
                          title={`Overdried by ${fmtNum(baseMoisture - r.m, 1)} pt: ${fmtNum(o.lostVolumePct, 2)}% of sellable weight given away (${fmtCents(o.lostVolumePerBu * 100)} at $${fmtNum(grainPrice ?? 0)}/bu) + ${fmtCents(o.extraEnergyPerBu * 100)} of fuel removing points nobody pays for`}
                        >
                          {fmtCents(o.totalPerBu * 100)} overdried
                        </td>
                      ) : (
                        <td className={`${numCell} text-red-700/80 text-xs font-normal`} title="Overdried — enter a grain price under ⚙ Assumptions to value the sellable weight given away">
                          needs grain price
                        </td>
                      )}
                      {comparing && <td className={`${numCell} text-slate-300`}>—</td>}
                      {comparing && <td className={textCell} />}
                    </tr>
                  )
                }
                const v = r.verdict
                const breakdown = [
                  `fuel ${fmtCents(r.cost.fuelPerBu * 100)}`,
                  r.cost.fanPerBu > 0 ? `fan ${fmtCents(r.cost.fanPerBu * 100)}` : null,
                  `depreciation ${fmtCents(r.cost.depreciationPerBu * 100)}`,
                ].filter(Boolean).join(' + ')
                return (
                  <tr key={r.m} className="border-t border-slate-100">
                    <td className={numCell}>{fmtNum(r.m, 1)}%</td>
                    <td className={`${numCell} font-semibold`} title={`${fmtNum(r.cost.points, 1)} pt to base: ${breakdown}`}>
                      {fmtCents(r.cost.totalPerBu * 100)}
                    </td>
                    {comparing && (
                      <td className={`${numCell} ${v?.cheaper === 'haul_wet' ? 'text-green-700 font-semibold' : ''}`}>
                        {v?.buyerCents != null ? fmtCents(v.buyerCents) : '—'}
                      </td>
                    )}
                    {comparing && (
                      <td className={textCell}>
                        {v?.cheaper === 'dry' && <span className="text-green-700 font-medium">Dry it (save {fmtCents((v.buyerCents ?? 0) - v.dryCents)})</span>}
                        {v?.cheaper === 'haul_wet' && <span className="text-sky-700 font-medium">Haul it wet (save {fmtCents(v.dryCents - (v.buyerCents ?? 0))})</span>}
                        {v?.cheaper === 'even' && <span className="text-slate-500">About even</span>}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs text-slate-500 max-w-3xl space-y-1">
        <p>
          <span className="font-semibold text-slate-600">How the cost is figured.</span> Above base, the total is three
          things: <strong>fuel</strong>{spec && rates ? ` (${fmtCents(spec.fuelPerBuPt * rates.fuelPrice * 100, 2)} per point)` : ''},{' '}
          <strong>fan electricity</strong>{spec?.fanKwhPerBuPt ? ` (${fmtCents((spec.fanKwhPerBuPt ?? 0) * (rates?.electricRate ?? DEFAULT_ELECTRIC_RATE) * 100, 2)} per point)` : ' (none entered)'}, and{' '}
          <strong>dryer depreciation</strong> — {fmtNum(Math.max(0, deprCents), 1)}¢ on every bushel that goes through the dryer,
          flat, not per point. Hover any total for its breakdown. Repairs and interest aren&rsquo;t in there: raise the
          depreciation figure under ⚙ Assumptions if you want full ownership costing.
        </p>
        <p>
          The water above base is never a cost of drying: haul it wet and the buyer&rsquo;s shrink table takes it off the
          ticket; dry it and it goes up the stack — same dry bushels either way ({fmtNum(SHRINK_PCT_PER_POINT, 3)}%
          of the wet weight per point). Rows below base are different: every half-point past base gives away sellable
          grain (valued at the grain price) <em>and</em> burns fuel removing water nobody pays for. Those rows are the
          only ones that need a grain price.
        </p>
        {comparing && (
          <p>
            The buyer comparison is apples to apples: your side is fuel and fan
            {includeDeprInCompare ? ' plus depreciation' : ' (depreciation left out — the marginal view)'}; their side is
            their moisture dock or drying charge. Their shrink comes off in both worlds, so it cancels out.
          </p>
        )}
      </div>

      {/* ---- optional buyer comparison (collapsed, off by default) ---- */}
      <div className="bg-white rounded-xl shadow no-print">
        <button
          type="button"
          onClick={() => setCompareOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-brand-deep"
        >
          {compareOpen ? '▾' : '▸'} Compare against a buyer&rsquo;s discount schedule
          <span className="font-normal text-slate-400">— does drying beat hauling it wet?</span>
        </button>
        {compareOpen && (
          <div className="px-4 pb-4 space-y-3">
            <label className="text-sm text-slate-700 block">
              Buyer
              <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className={`block mt-0.5 ${inputCls}`}>
                <option value="">— pick a buyer —</option>
                {buyersWithSchedules.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <span className="block text-xs text-slate-500 mt-0.5">
                {buyersWithSchedules.length === 0
                  ? `No ${crop?.name ?? ''} discount schedules on file — upload one below or on Settings → Buyers.`
                  : 'Their sheet prices "haul it wet" beside your drying cost in the table above — their shrink applies either way, so it cancels.'}
              </span>
            </label>
            <div className="space-y-1">
              <label className="text-sm text-slate-700 flex items-center gap-2">
                <input type="checkbox" checked={includeDeprInCompare} onChange={(e) => setIncludeDeprInCompare(e.target.checked)} />
                Include depreciation in the comparison ({fmtNum(Math.max(0, deprCents), 1)}¢/bu)
              </label>
              <p className="text-xs text-slate-500">
                If you own the dryer, its depreciation is spent whether or not this load runs through it — so for the
                marginal dry-or-haul call on one load you may prefer to leave it out. Left in, the comparison prices
                your full cost of drying.
              </p>
            </div>
            <DiscountScheduleImport onChanged={() => setSchedulesVersion((v) => v + 1)} />
          </div>
        )}
      </div>

      {/* ---- assumptions slide-over ---- */}
      {panelOpen && (
        <div className="fixed inset-0 z-40 no-print" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => { setPanelOpen(false); persistSettings() }} />
          <div className="absolute inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl overflow-y-auto p-5 space-y-5">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-lg flex-1">Assumptions</h2>
              <button type="button" onClick={() => { setPanelOpen(false); persistSettings() }} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">Done</button>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Dryer &amp; consumption</div>
              <select value={dryerPick === 'auto' ? effectivePick : dryerPick} onChange={(e) => setDryerPick(e.target.value)} className={`block w-full ${inputCls}`}>
                <option value="quick">Standard consumption (enter below)</option>
                {orgDryers.length > 0 && (
                  <optgroup label="Your dryers">
                    {orgDryers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </optgroup>
                )}
                <optgroup label="Catalog (typical estimates)">
                  {models.map((m) => (
                    <option key={m.id} value={`model:${m.id}`}>
                      {m.manufacturer} {m.model} ({DRYER_TYPE_LABELS[m.dryer_type] ?? m.dryer_type})
                    </option>
                  ))}
                </optgroup>
              </select>
              {pickedOrgDryer && (
                <p className="text-xs text-slate-500">
                  {pickedOrgDryer.fuel === 'lp' ? 'LP' : 'NG'} · {fmtNum(N(pickedOrgDryer.fuel_per_bu_pt) ?? 0, 4)} {pickedOrgDryer.fuel === 'lp' ? 'gal' : 'ccf'}/bu-pt ·{' '}
                  <button type="button" onClick={() => deleteDryer(pickedOrgDryer)} className="text-red-600">delete</button>
                </p>
              )}
              {pickedModel && (
                <p className="text-xs text-amber-700">
                  Typical estimate ({fmtNum(N(pickedModel.default_gal_lp_per_bu_pt) ?? 0, 3)} gal LP-eq/bu-pt) — calibrate with your records below.
                </p>
              )}
              {!pickedOrgDryer && !pickedModel && (
                <label className="text-sm text-slate-700 block">
                  Consumption (gal LP-equivalent per bu-pt)
                  <input type="number" step="0.001" value={quickPerBuPt} onChange={(e) => setQuickPerBuPt(e.target.value)} className={`block mt-0.5 w-28 ${inputCls} text-right`} />
                  <span className="block text-xs text-slate-500 mt-0.5">Default 0.018 (mixed-flow/tower typical); NG converts by energy content.</span>
                </label>
              )}
              {!pickedOrgDryer && (
                <label className="text-sm text-slate-700 block">
                  Fan/auger electricity (kWh per bu-pt, optional)
                  <input type="number" step="0.001" value={quickFanKwh} onChange={(e) => setQuickFanKwh(e.target.value)} className={`block mt-0.5 w-28 ${inputCls} text-right`} placeholder="0" />
                </label>
              )}
              {spec && !pickedOrgDryer && (
                <label className="text-sm text-slate-700 block">
                  Save these settings as a dryer
                  <span className="flex gap-1 mt-0.5">
                    <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={pickedModel ? `${pickedModel.manufacturer} ${pickedModel.model}` : 'My dryer'} className={`${inputCls} flex-1 min-w-0`} />
                    <button type="button" onClick={saveAsDryer} disabled={!saveName.trim()} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1 text-sm font-semibold disabled:opacity-50">Save</button>
                  </span>
                </label>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Prices</div>
              <label className="text-sm text-slate-700 block">
                Grain price $/bu
                <input
                  type="number" step="0.01" value={grainPriceStr}
                  onChange={(e) => setGrainPriceStr(e.target.value)}
                  placeholder={quote ? fmtNum(quote.price) : ''}
                  className={`block mt-0.5 w-28 ${inputCls} text-right`}
                />
                <span className="block text-xs text-slate-500 mt-0.5">
                  {quote ? `Default: ${quote.symbol} today $${fmtNum(quote.price)}. ` : 'No live quote. '}
                  Only the overdrying rows (below base) use it — drying to base costs fuel, not grain.
                </span>
              </label>
              <label className="text-sm text-slate-700 block">
                Electric $/kWh
                <input type="number" step="0.01" value={electricRate} onChange={(e) => setElectricRate(e.target.value)} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
              </label>
              <p className="text-xs text-slate-500">Base moisture comes from the crop&rsquo;s standard ({crop?.name ?? '—'}: {fmtNum(baseMoisture, 1)}%) — change it under Settings → Crops.</p>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Dryer depreciation</div>
              <label className="text-sm text-slate-700 block">
                ¢ per bushel dried
                <input
                  type="number" step="0.1" min="0" value={deprStr}
                  onChange={(e) => setDeprStr(e.target.value)}
                  onBlur={persistSettings}
                  disabled={settingsMissing}
                  className={`block mt-0.5 w-24 ${inputCls} text-right disabled:bg-slate-100`}
                />
                <span className="block text-xs text-slate-500 mt-0.5">
                  ≈ dryer investment ÷ useful life ÷ bushels dried per year (e.g. $300,000 ÷ 15 yr ÷ 500,000 bu ≈ 4¢).
                  Applied flat to every bushel that goes through the dryer, not per point. Raise it to fold in repairs
                  and interest for full ownership costing.
                </span>
              </label>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="text-xs font-semibold text-slate-600">Work it out</div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-sm text-slate-700">
                    Dryer investment $
                    <input type="number" step="1000" min="0" value={invStr} onChange={(e) => setInvStr(e.target.value)} placeholder="300,000" className={`block mt-0.5 w-28 ${inputCls} text-right`} />
                  </label>
                  <label className="text-sm text-slate-700">
                    Useful life (yr)
                    <input type="number" step="1" min="1" value={lifeStr} onChange={(e) => setLifeStr(e.target.value)} placeholder="15" className={`block mt-0.5 w-20 ${inputCls} text-right`} />
                  </label>
                  <label className="text-sm text-slate-700">
                    Bushels dried / yr
                    <input type="number" step="10000" min="1" value={buYrStr} onChange={(e) => setBuYrStr(e.target.value)} placeholder="500,000" className={`block mt-0.5 w-28 ${inputCls} text-right`} />
                  </label>
                </div>
                {calcDepr != null ? (
                  <div className="text-sm">
                    → <span className="font-semibold tabular-nums">{fmtNum(calcDepr, 2)}¢/bu</span>
                    <button
                      type="button"
                      onClick={() => setDeprStr(String(Math.round(calcDepr * 10) / 10))}
                      disabled={settingsMissing}
                      className="ml-2 rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1 text-sm font-semibold disabled:opacity-50"
                    >
                      Use {fmtNum(calcDepr, 1)}¢
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">Fill all three and the ¢/bu figure appears here.</p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Calibrate from your records</div>
              <p className="text-xs text-slate-500">
                Last season&rsquo;s totals give YOUR real number: fuel used ÷ (bushels dried × average points removed).
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm text-slate-700">
                  Total {fuelUnit} used
                  <input type="number" value={calFuel} onChange={(e) => { setCalFuel(e.target.value); setCalSaved(null) }} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
                </label>
                <label className="text-sm text-slate-700">
                  Bushels dried
                  <input type="number" value={calBu} onChange={(e) => { setCalBu(e.target.value); setCalSaved(null) }} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
                </label>
                <label className="text-sm text-slate-700">
                  Avg points removed
                  <input type="number" step="0.1" value={calPts} onChange={(e) => { setCalPts(e.target.value); setCalSaved(null) }} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
                </label>
              </div>
              {calibration.fuelPerBuPt != null && (
                <div className="text-sm">
                  → <span className="font-semibold tabular-nums">{calibration.fuelPerBuPt.toFixed(5)} {fuelUnit}/bu-pt</span>
                  {pickedOrgDryer ? (
                    <button type="button" onClick={saveCalibration} className="ml-2 rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1 text-sm font-semibold">
                      Save to {pickedOrgDryer.name}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500 ml-2">(pick or save a dryer above to keep it)</span>
                  )}
                </div>
              )}
              {calSaved && <p className="text-sm rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-green-900">{calSaved}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
