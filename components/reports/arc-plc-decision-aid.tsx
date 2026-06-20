'use client'

// ARC/PLC Decision Aid. For each farm × commodity with base acres, projects the
// PLC payment (from MYA vs the effective reference price) and the ARC-CO payment
// (user-entered rate) side by side, recommends the higher one, and lets the user
// set the election. A What-If MYA slider shows how PLC moves; ARC-CO stays
// user-entered because it depends on county yields the app doesn't track.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import EntityFilter from '@/components/entity-filter'
import {
  computePlcPayment, computeArcCoPayment, effectiveReferencePrice, myaPrice, ELECTION_LABEL,
} from '@/lib/government-payments'
import type { ExportPayload } from '@/lib/exports'
import type {
  Farm, Entity, FieldPlanting, CoveredCommodity, FarmBaseAcres, ArcPlcElection, ArcPlcPriceData, ArcPlcPayment, ArcPlcElectionType,
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
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [commodities, setCommodities] = useState<CoveredCommodity[]>([])
  const [baseAcres, setBaseAcres] = useState<FarmBaseAcres[]>([])
  const [elections, setElections] = useState<ArcPlcElection[]>([])
  const [priceData, setPriceData] = useState<ArcPlcPriceData[]>([])
  const [payments, setPayments] = useState<ArcPlcPayment[]>([])
  const [liveMya, setLiveMya] = useState<Map<string, number>>(new Map())
  const [cropYear, setCropYear] = usePersistentState<number | ''>('arc-plc-aid:cropYear', '')
  const [entityId, setEntityId] = usePersistentState('arc-plc-aid:entity', '')
  const [myaPct, setMyaPct] = useState(0)

  async function refresh() {
    const [fa, en, pl, cc, ba, el, pd, pay] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('covered_commodities').select('*').order('name'),
      supabase.from('farm_base_acres').select('*'),
      supabase.from('arc_plc_elections').select('*'),
      supabase.from('arc_plc_price_data').select('*'),
      supabase.from('arc_plc_payments').select('*'),
    ])
    setFarms((fa.data as Farm[]) || [])
    setEntities((en.data as Entity[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setCommodities((cc.data as CoveredCommodity[]) || [])
    setBaseAcres((ba.data as FarmBaseAcres[]) || [])
    setElections((el.data as ArcPlcElection[]) || [])
    setPriceData((pd.data as ArcPlcPriceData[]) || [])
    setPayments((pay.data as ArcPlcPayment[]) || [])
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
  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([...plantings.map((p) => p.season_year), ...elections.map((e) => e.crop_year), new Date().getFullYear()], cropYear === '' ? null : cropYear),
    [plantings, elections, cropYear],
  )

  // Refresh live MYA estimates for tradeable commodities.
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

  const priceFor = (commodityId: string) => priceData.find((p) => p.commodity_id === commodityId && p.crop_year === cropYear) ?? null
  // Effective MYA for a commodity: live estimate → stored → applied with the slider.
  function effMya(commodity: CoveredCommodity): number | null {
    const base = liveMya.get(commodity.id) ?? myaPrice(priceFor(commodity.id))
    if (base == null) return null
    return base * (1 + myaPct / 100)
  }
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
        const mya = effMya(commodity)
        const effRef = effectiveReferencePrice(commodity, priceFor(b.commodity_id!))
        const plcNet = mya != null
          ? computePlcPayment({ effectiveReferencePrice: effRef, myaPrice: mya, nationalLoanRate: Number(commodity.national_loan_rate), plcYield: Number(b.plc_yield), baseAcres: Number(b.base_acres) }).net
          : null
        const rate = arcRate(b.farm_id, b.commodity_id)
        const arcNet = rate != null ? computeArcCoPayment({ projectedRatePerAcre: rate, baseAcres: Number(b.base_acres) }).net : null
        const favors: 'PLC' | 'ARC' | null = plcNet != null && arcNet != null ? (plcNet >= arcNet ? 'PLC' : 'ARC') : plcNet != null ? 'PLC' : arcNet != null ? 'ARC' : null
        return { base: b, commodity, farmName: farmById.get(b.farm_id)?.name ?? '—', plcNet, arcNet, election: electionFor(b.farm_id, b.commodity_id), favors }
      })
      .filter((r): r is Row => r != null)
      .sort((a, b) => a.farmName.localeCompare(b.farmName) || a.commodity.name.localeCompare(b.commodity.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseAcres, commodityById, farmById, cropYear, entityId, priceData, payments, elections, liveMya, myaPct])

  async function setElection(farmId: string, commodityId: string | null, election: ArcPlcElectionType) {
    if (commodityId == null) return
    await supabase.from('arc_plc_elections').upsert({ farm_id: farmId, commodity_id: commodityId, crop_year: cropYear, election }, { onConflict: 'farm_id,commodity_id,crop_year' })
    refresh()
  }

  function buildExportPayload(): ExportPayload {
    return {
      title: 'ARC/PLC Decision Aid',
      filters: `Crop year: ${cropYear || '—'}${entityId ? ` · Entity: ${entities.find((e) => e.id === entityId)?.name ?? ''}` : ''}${myaPct !== 0 ? ` · MYA what-if: ${myaPct > 0 ? '+' : ''}${myaPct}%` : ''}`,
      sections: [{
        title: 'Projected Payments by Farm × Commodity',
        columns: [
          { label: 'Farm' }, { label: 'Commodity' }, { label: 'Base Acres', align: 'right', format: 'int' }, { label: 'PLC Yield', align: 'right', format: 'yield' },
          { label: 'PLC Projected', align: 'right', format: 'usd0' }, { label: 'ARC-CO Projected', align: 'right', format: 'usd0' }, { label: 'Recommendation' }, { label: 'Current Election' },
        ],
        rows: rows.map((r) => [
          r.farmName, r.commodity.name, Math.round(r.base.base_acres), Number(r.base.plc_yield),
          r.plcNet != null ? Math.round(r.plcNet) : '', r.arcNet != null ? Math.round(r.arcNet) : '',
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
          <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900 no-print">
            Farms enrolled in <strong>PLC are eligible for SCO</strong> crop insurance. Farms enrolled in <strong>ARC are NOT</strong> eligible for SCO.
          </div>

          {/* What-If MYA */}
          <section className="bg-white rounded-xl shadow p-4 space-y-2 no-print">
            <h2 className="font-bold text-lg">What-If: MYA price</h2>
            <label className="flex items-center gap-3 flex-wrap text-sm">
              <span className="w-44 text-slate-600">MYA adjustment: <strong>{myaPct > 0 ? '+' : ''}{myaPct}%</strong></span>
              <input type="range" min={-30} max={30} step={5} value={myaPct} onChange={(e) => setMyaPct(Number(e.target.value))} className="flex-1 min-w-[12rem]" />
              <button onClick={() => setMyaPct(0)} className="text-xs text-slate-500 underline">reset</button>
            </label>
            <p className="text-xs text-slate-500">PLC payments rise as MYA falls below the effective reference price. ARC-CO is user-entered and unaffected by this slider.</p>
          </section>

          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto">
            <h2 className="font-bold text-lg mb-2">Decision Aid — {cropYear}</h2>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>{['Farm', 'Commodity', 'Base Acres', 'PLC Yield', 'PLC Projected', 'ARC-CO Projected', 'Recommendation', 'Election', ''].map((h) => <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.base.id} className="border-t border-slate-100">
                    <td className={`${textCell} font-semibold`}>{r.farmName}</td>
                    <td className={textCell}>{r.commodity.name}</td>
                    <td className={numCell}>{Number(r.base.base_acres).toLocaleString()}</td>
                    <td className={numCell}>{Number(r.base.plc_yield)}</td>
                    <td className={`${numCell} ${r.favors === 'PLC' ? `bg-green-50 font-semibold ${toneText('favorable')}` : ''}`}>{r.plcNet != null ? usd(r.plcNet) : <span className={toneText('warning')}>needs MYA</span>}</td>
                    <td className={`${numCell} ${r.favors === 'ARC' ? `bg-green-50 font-semibold ${toneText('favorable')}` : ''}`}>{r.arcNet != null ? usd(r.arcNet) : <span className={toneText('warning')}>enter rate</span>}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {r.favors === 'PLC' ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Favors PLC</span>
                        : r.favors === 'ARC' ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Favors ARC-CO</span>
                        : <span className={toneText('muted')}>—</span>}
                    </td>
                    <td className="px-2 py-1"><span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{ELECTION_LABEL[r.election]}</span></td>
                    <td className="px-2 py-1 no-print whitespace-nowrap">
                      <button onClick={() => setElection(r.base.farm_id, r.base.commodity_id, 'PLC')} className="text-xs text-sky-700 mr-2">Elect PLC</button>
                      <button onClick={() => setElection(r.base.farm_id, r.base.commodity_id, 'ARC_CO')} className="text-xs text-sky-700">Elect ARC-CO</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-slate-500 mt-2">
              Projected — based on current MYA estimates and your ARC-CO rate entries. FSA determines final payments after the marketing year.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
