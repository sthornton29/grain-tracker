'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { projectPayments, expectedArcPlcDate } from '@/lib/government-payments'
import { computePolicy, type PolicyInputs, type ScoConfig, type EcoConfig } from '@/lib/crop-insurance'
import {
  SummaryCards, EmptyState, type SummaryCardData,
  numCell, textCell, theadCls,
} from '@/components/reports/report-kit'
import type {
  Buyer, Contract, Crop, Entity, FieldPlanting, LoadSplit,
  CropAssumption, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco, HarvestPriceEstimate,
  CoveredCommodity, FarmBaseAcres, ArcPlcElection, ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment,
} from '@/lib/types'

type LoadRow = {
  id: string
  contract_id: string | null
  ticket_number: string | null
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
}

type LineRow = {
  load_id: string | null
  ticket_number: string | null
  net_bushels: number
  net_revenue: number | null
  settlement_id: string
}

type SettlementRow = { id: string; settlement_date: string }
type FieldRow = { id: string; farm_id: string | null }
type FarmRow = { id: string; entity_id: string | null }

const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d })

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function addMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
}
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export default function CashFlowPage() {
  const supabase = useMemo(() => createClient(), [])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [lines, setLines] = useState<LineRow[]>([])
  const [settlements, setSettlements] = useState<SettlementRow[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [fields, setFields] = useState<FieldRow[]>([])
  const [farms, setFarms] = useState<FarmRow[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loadSplits, setLoadSplits] = useState<LoadSplit[]>([])
  // Safety-net data: crop insurance + government payments.
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [policies, setPolicies] = useState<CropInsurancePolicy[]>([])
  const [scos, setScos] = useState<CropInsuranceSco[]>([])
  const [ecos, setEcos] = useState<CropInsuranceEco[]>([])
  const [harvestEstimates, setHarvestEstimates] = useState<HarvestPriceEstimate[]>([])
  const [commodities, setCommodities] = useState<CoveredCommodity[]>([])
  const [baseAcres, setBaseAcres] = useState<FarmBaseAcres[]>([])
  const [elections, setElections] = useState<ArcPlcElection[]>([])
  const [arcPriceData, setArcPriceData] = useState<ArcPlcPriceData[]>([])
  const [arcPayments, setArcPayments] = useState<ArcPlcPayment[]>([])
  const [otherPayments, setOtherPayments] = useState<OtherGovernmentPayment[]>([])
  const [loading, setLoading] = useState(true)
  // Month (1-12) crop insurance proceeds are assumed to arrive; default December.
  const [insuranceMonth, setInsuranceMonth] = useState(12)

  const [cropYear, setCropYear] = useState<number | ''>('')
  const [cropId, setCropId] = useState('')
  const [buyerId, setBuyerId] = useState('')
  const [entityId, setEntityId] = useState('')

  useEffect(() => {
    ;(async () => {
      // Paginate loads to defeat the project-level db-max-rows cap; one
      // missed load means a contract's delivered total quietly stays at zero.
      async function fetchAllLoads(): Promise<LoadRow[]> {
        const PAGE = 1000
        const out: LoadRow[] = []
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('loads')
            .select('id, contract_id, ticket_number, net_weight, moisture, crop_id, dry_bushels_override, from_type, from_field_id')
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1)
          if (error) throw error
          const batch = (data ?? []) as LoadRow[]
          out.push(...batch)
          if (batch.length < PAGE) break
        }
        return out
      }
      const [ct, ld, ln, st, cr, by, en, fi, fa, pl, sp] = await Promise.all([
        supabase.from('contracts').select('*'),
        fetchAllLoads(),
        supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue, settlement_id'),
        supabase.from('settlements').select('id, settlement_date'),
        supabase.from('crops').select('*'),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('fields').select('id, farm_id'),
        supabase.from('farms').select('id, entity_id'),
        supabase.from('field_plantings').select('season_year'),
        supabase.from('load_splits').select('load_id, field_id'),
      ])
      const [ca, po, sc, ec, hpe, cc, ba, el, apd, apay, ogp] = await Promise.all([
        supabase.from('crop_assumptions').select('*'),
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
      setContracts((ct.data as Contract[]) || [])
      setLoads(ld)
      setLines((ln.data as LineRow[]) || [])
      setSettlements((st.data as SettlementRow[]) || [])
      setCrops((cr.data as Crop[]) || [])
      setBuyers((by.data as Buyer[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFields((fi.data as FieldRow[]) || [])
      setFarms((fa.data as FarmRow[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoadSplits((sp.data as LoadSplit[]) || [])
      setAssumptions((ca.data as CropAssumption[]) || [])
      setPolicies((po.data as CropInsurancePolicy[]) || [])
      setScos((sc.data as CropInsuranceSco[]) || [])
      setEcos((ec.data as CropInsuranceEco[]) || [])
      setHarvestEstimates((hpe.data as HarvestPriceEstimate[]) || [])
      setCommodities((cc.data as CoveredCommodity[]) || [])
      setBaseAcres((ba.data as FarmBaseAcres[]) || [])
      setElections((el.data as ArcPlcElection[]) || [])
      setArcPriceData((apd.data as ArcPlcPriceData[]) || [])
      setArcPayments((apay.data as ArcPlcPayment[]) || [])
      setOtherPayments((ogp.data as OtherGovernmentPayment[]) || [])
      setLoading(false)
    })()
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const buyerById = useMemo(() => new Map(buyers.map((b) => [b.id, b])), [buyers])
  const settlementById = useMemo(() => new Map(settlements.map((s) => [s.id, s])), [settlements])
  const fieldEntity = useMemo(() => {
    const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
    return new Map(fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null]))
  }, [farms, fields])
  const splitsByLoadId = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of loadSplits) {
      const list = m.get(s.load_id) ?? []
      list.push(s.field_id)
      m.set(s.load_id, list)
    }
    return m
  }, [loadSplits])

  const lineByLoadId = useMemo(() => {
    const m = new Map<string, LineRow>()
    for (const l of lines) if (l.load_id) m.set(l.load_id, l)
    return m
  }, [lines])
  const lineByTicket = useMemo(() => {
    const m = new Map<string, LineRow>()
    for (const l of lines) if (l.ticket_number) m.set(l.ticket_number.trim().toLowerCase(), l)
    return m
  }, [lines])

  function lineFor(load: LoadRow): LineRow | null {
    if (lineByLoadId.has(load.id)) return lineByLoadId.get(load.id)!
    const t = load.ticket_number?.trim().toLowerCase()
    if (t && lineByTicket.has(t)) return lineByTicket.get(t)!
    return null
  }

  function dryBu(l: LoadRow): number {
    const crop = l.crop_id ? cropById.get(l.crop_id) : null
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight,
      moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null,
      baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    return dryBushels ?? 0
  }

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  type Agg = {
    contract: Contract
    delivered: number
    deliveredUnpaid: number
    revenueReceived: number
    revenueByMonth: Map<string, number>  // from settlements
    entityIds: Set<string>
  }
  const aggByContract = useMemo(() => {
    const map = new Map<string, Agg>()
    for (const c of contracts) map.set(c.id, {
      contract: c, delivered: 0, deliveredUnpaid: 0, revenueReceived: 0,
      revenueByMonth: new Map(), entityIds: new Set(),
    })
    for (const load of loads) {
      if (!load.contract_id) continue
      const agg = map.get(load.contract_id)
      if (!agg) continue
      const bu = dryBu(load)
      agg.delivered += bu
      const line = lineFor(load)
      if (line) {
        const rev = Number(line.net_revenue ?? 0)
        agg.revenueReceived += rev
        const settlement = settlementById.get(line.settlement_id)
        if (settlement) {
          const key = monthKey(new Date(settlement.settlement_date + 'T00:00:00'))
          agg.revenueByMonth.set(key, (agg.revenueByMonth.get(key) ?? 0) + rev)
        }
      } else {
        agg.deliveredUnpaid += bu
      }
      if (load.from_type === 'field') {
        if (load.from_field_id) {
          const ent = fieldEntity.get(load.from_field_id) ?? null
          if (ent) agg.entityIds.add(ent)
        } else {
          // Split load — attribute to every entity its constituent fields touch.
          const fieldIds = splitsByLoadId.get(load.id) ?? []
          for (const fid of fieldIds) {
            const ent = fieldEntity.get(fid) ?? null
            if (ent) agg.entityIds.add(ent)
          }
        }
      }
    }
    return map
  }, [contracts, loads, cropById, lineByLoadId, lineByTicket, settlementById, fieldEntity, splitsByLoadId])

  const visibleContracts = contracts.filter((c) => {
    if (cropYear !== '' && c.crop_year !== cropYear) return false
    if (cropId && c.crop_id !== cropId) return false
    if (buyerId && c.buyer_id !== buyerId) return false
    if (entityId) {
      const agg = aggByContract.get(c.id)
      if (!agg || !agg.entityIds.has(entityId)) return false
    }
    return true
  })

  // Compute monthly cash flow buckets
  type Bucket = { received: number; outstanding: number; projected: number }
  const monthly = useMemo(() => {
    const buckets = new Map<string, Bucket>()
    const ensure = (k: string) => {
      let b = buckets.get(k)
      if (!b) { b = { received: 0, outstanding: 0, projected: 0 }; buckets.set(k, b) }
      return b
    }
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const thisMonth = monthKey(today)

    for (const c of visibleContracts) {
      const agg = aggByContract.get(c.id)
      if (!agg) continue
      const price = Number(c.price_per_bushel ?? 0)

      // received — by settlement month
      for (const [m, amount] of agg.revenueByMonth) {
        ensure(m).received += amount
      }

      // outstanding (delivered but unpaid) — receivable this month, valued at contract price
      const outstandingAmt = agg.deliveredUnpaid * price
      if (outstandingAmt > 0) ensure(thisMonth).outstanding += outstandingAmt

      // projected (not yet delivered) — spread across remaining months in delivery window
      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
      if (remainingBu > 0 && price > 0) {
        const totalProjected = remainingBu * price
        const months: string[] = []
        let cursor = startOfMonth(today)
        if (c.delivery_start_date) {
          const s = startOfMonth(new Date(c.delivery_start_date + 'T00:00:00'))
          if (s > cursor) cursor = s
        }
        const end = c.delivery_end_date ? new Date(c.delivery_end_date + 'T00:00:00') : null
        if (end && end >= cursor) {
          const endKey = monthKey(end)
          while (monthKey(cursor) <= endKey) {
            months.push(monthKey(cursor))
            cursor = addMonth(cursor)
          }
        }
        if (months.length === 0) {
          // No window (or end has passed) — put everything in current month
          ensure(thisMonth).projected += totalProjected
        } else {
          const per = totalProjected / months.length
          for (const m of months) ensure(m).projected += per
        }
      }
    }
    return buckets
  }, [visibleContracts, aggByContract])

  // Farm -> entity, for filtering ARC/PLC by the entity dropdown.
  const farmEntity = useMemo(() => new Map(farms.map((f) => [f.id, f.entity_id])), [farms])

  // Safety net (crop insurance + government payments) bucketed by month, with the
  // program-specific timing: ARC/PLC in October of crop_year + 1, crop insurance
  // proceeds in the chosen month (default December), other USDA payments on their
  // payment date (else December of the crop year). Respects the crop-year, crop,
  // and entity filters where each program is scoped to those dimensions.
  type SafetyBucket = { arcPlc: number; insurance: number; other: number }
  const safetyNet = useMemo(() => {
    const buckets = new Map<string, SafetyBucket>()
    const ensure = (k: string) => {
      let b = buckets.get(k)
      if (!b) { b = { arcPlc: 0, insurance: 0, other: 0 }; buckets.set(k, b) }
      return b
    }

    // ARC/PLC — net projections per crop year, placed in October of year + 1.
    const electionYears = cropYear !== '' ? [cropYear] : Array.from(new Set(elections.map((e) => e.crop_year)))
    for (const yr of electionYears) {
      if (!cropId) {
        const projected = projectPayments({ cropYear: yr, baseAcres, commodities, elections, priceData: arcPriceData, payments: arcPayments })
        let net = 0
        for (const p of projected) {
          if (entityId && farmEntity.get(p.farmId) !== entityId) continue
          net += p.result.net
        }
        if (net !== 0) ensure(monthKey(new Date(expectedArcPlcDate(yr) + 'T00:00:00'))).arcPlc += net
      }
    }

    // Crop insurance — total indemnity per policy, placed in the chosen month.
    const scoBy = new Map(scos.map((s) => [s.policy_id, s]))
    const ecoBy = new Map(ecos.map((e) => [e.policy_id, e]))
    for (const p of policies) {
      if (cropYear !== '' && p.crop_year !== cropYear) continue
      if (entityId && p.entity_id !== entityId) continue
      if (cropId && p.crop_id !== cropId) continue
      let harvest = p.harvest_price != null ? Number(p.harvest_price) : null
      if (harvest == null) {
        const fin = harvestEstimates.find((e) => e.crop_id === p.crop_id && e.crop_year === p.crop_year && e.price_type === 'harvest_final')
        const est = harvestEstimates.find((e) => e.crop_id === p.crop_id && e.crop_year === p.crop_year && e.price_type === 'harvest_estimate')
        harvest = fin ? Number(fin.price) : est ? Number(est.price) : Number(p.projected_price)
      }
      const a = assumptions.find((x) => x.crop_id === p.crop_id && x.crop_year === p.crop_year)
      const assumedYield = a?.expected_yield != null ? Number(a.expected_yield) : Number(p.aph_yield)
      const base: PolicyInputs = {
        planType: p.plan_type, coverageLevel: Number(p.coverage_level), aphYield: Number(p.aph_yield),
        projectedPrice: Number(p.projected_price), harvestPrice: harvest, insuredAcres: Number(p.insured_acres), actualYield: assumedYield,
      }
      const scoRow = scoBy.get(p.id)
      const ecoRow = ecoBy.get(p.id)
      const sco: ScoConfig | null = scoRow ? {
        coverageTrigger: Number(scoRow.coverage_trigger), expectedCountyYield: Number(scoRow.expected_county_yield),
        countyYieldAssumptionPct: scoRow.county_yield_assumption_pct == null ? 0 : Number(scoRow.county_yield_assumption_pct),
        premiumPerAcre: scoRow.premium_per_acre == null ? null : Number(scoRow.premium_per_acre),
        totalPremium: scoRow.total_premium == null ? null : Number(scoRow.total_premium),
      } : null
      const eco: EcoConfig | null = ecoRow ? {
        ecoTriggerLevel: Number(ecoRow.eco_trigger_level), expectedCountyYield: Number(ecoRow.expected_county_yield),
        countyYieldAssumptionPct: ecoRow.county_yield_assumption_pct == null ? 0 : Number(ecoRow.county_yield_assumption_pct),
        premiumPerAcre: ecoRow.premium_per_acre == null ? null : Number(ecoRow.premium_per_acre),
        totalPremium: ecoRow.total_premium == null ? null : Number(ecoRow.total_premium),
      } : null
      const comp = computePolicy({ base, basePremium: 0, sco, eco })
      if (comp.totalIndemnity > 0) {
        ensure(`${p.crop_year}-${String(insuranceMonth).padStart(2, '0')}`).insurance += comp.totalIndemnity
      }
    }

    // Other USDA payments — on payment_date, else December of the crop year.
    for (const o of otherPayments) {
      if (cropYear !== '' && o.crop_year !== cropYear) continue
      if (entityId && o.entity_id !== entityId) continue
      if (cropId && o.crop_id !== cropId) continue
      const key = o.payment_date ? monthKey(new Date(o.payment_date + 'T00:00:00')) : `${o.crop_year}-12`
      ensure(key).other += Number(o.amount)
    }

    return buckets
  }, [cropYear, cropId, entityId, elections, baseAcres, commodities, arcPriceData, arcPayments, farmEntity, policies, scos, ecos, harvestEstimates, assumptions, insuranceMonth, otherPayments])

  const monthlyRows = useMemo(() => {
    const keys = [...new Set([...monthly.keys(), ...safetyNet.keys()])].sort()
    let running = 0
    return keys.map((k) => {
      const b = monthly.get(k) ?? { received: 0, outstanding: 0, projected: 0 }
      const s = safetyNet.get(k) ?? { arcPlc: 0, insurance: 0, other: 0 }
      const total = b.received + b.outstanding + b.projected + s.arcPlc + s.insurance + s.other
      running += total
      return { key: k, label: monthLabel(k), ...b, ...s, total, cumulative: running }
    })
  }, [monthly, safetyNet])

  // Safety-net totals across the visible window, for the summary cards.
  const safetyTotals = useMemo(() => {
    let arcPlc = 0, insurance = 0, other = 0
    for (const s of safetyNet.values()) { arcPlc += s.arcPlc; insurance += s.insurance; other += s.other }
    return { arcPlc, insurance, other, total: arcPlc + insurance + other }
  }, [safetyNet])

  const summary = useMemo(() => {
    let value = 0, received = 0, outstanding = 0, remaining = 0
    for (const c of visibleContracts) {
      const agg = aggByContract.get(c.id)!
      const price = Number(c.price_per_bushel ?? 0)
      value += Number(c.contracted_bushels) * price
      received += agg.revenueReceived
      outstanding += agg.deliveredUnpaid * price
      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
      remaining += remainingBu * price
    }
    return { value, received, outstanding, remaining }
  }, [visibleContracts, aggByContract])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  const summaryCards: SummaryCardData[] = [
    { label: 'Contract value', value: `$${fmt(summary.value)}` },
    { label: 'Received', value: `$${fmt(summary.received)}`, tone: 'favorable' },
    { label: 'Outstanding', value: `$${fmt(summary.outstanding)}`, tone: 'warning' },
    { label: 'Remaining', value: `$${fmt(summary.remaining)}` },
  ]

  const safetyCards: SummaryCardData[] = [
    { label: 'ARC/PLC', value: `$${fmt(safetyTotals.arcPlc)}` },
    { label: 'Crop Insurance', value: `$${fmt(safetyTotals.insurance)}` },
    { label: 'Other Govt', value: `$${fmt(safetyTotals.other)}` },
    { label: 'Total Safety Net', value: `$${fmt(safetyTotals.total)}`, tone: 'favorable' },
  ]

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Cash Flow Forecast</h1>

      <SummaryCards cards={summaryCards} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
          <option value="">All crop years</option>
          {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
        </select>
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">All crops</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className={inputCls}>
          <option value="">All buyers</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
          <option value="">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      {loading ? <p className="text-slate-500">Loading…</p> : (
        <>
          {/* Total Safety Net — crop insurance + government program cash, with timing. */}
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="font-semibold flex-1">Total Safety Net (projected)</h2>
              <label className="text-xs text-slate-500 flex items-center gap-2">
                Insurance proceeds month
                <select value={insuranceMonth} onChange={(e) => setInsuranceMonth(Number(e.target.value))} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleDateString(undefined, { month: 'short' })}</option>
                  ))}
                </select>
              </label>
            </div>
            <SummaryCards cards={safetyCards} />
            <p className="text-xs text-slate-500">
              <strong>Estimated</strong> — ARC/PLC lands in October of the year after the crop year, crop insurance
              proceeds in the selected month (default December), other payments on their entered date. Final amounts are
              determined by RMA / FSA after harvest and the marketing year.
            </p>
          </div>

          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 font-semibold">Monthly forecast</div>
            {monthlyRows.length === 0 ? (
              <EmptyState
                message="No forecast data."
                hint="Cash flow projects from priced contracts and the safety-net programs above."
                linkHref="/contracts"
                linkLabel="Add contracts"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      {['Month', 'Received', 'Outstanding', 'Projected', 'ARC/PLC', 'Crop Insurance', 'Other Govt', 'Month total', 'Cumulative']
                        .map((h, i) => <th key={h} className={`${i === 0 ? 'text-left' : 'text-right'} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyRows.map((r) => (
                      <tr key={r.key} className="border-t border-slate-100">
                        <td className={`${textCell} font-semibold`}>{r.label}</td>
                        <td className={`${numCell} text-green-700`}>${fmt(r.received)}</td>
                        <td className={`${numCell} text-amber-700`}>${fmt(r.outstanding)}</td>
                        <td className={`${numCell} text-sky-700`}>${fmt(r.projected)}</td>
                        <td className={`${numCell} text-indigo-700`}>${fmt(r.arcPlc)}</td>
                        <td className={`${numCell} text-purple-700`}>${fmt(r.insurance)}</td>
                        <td className={`${numCell} text-teal-700`}>${fmt(r.other)}</td>
                        <td className={numCell}>${fmt(r.total)}</td>
                        <td className={`${numCell} font-semibold`}>${fmt(r.cumulative)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 font-semibold">Contract detail</div>
            {visibleContracts.length === 0 ? (
              <EmptyState
                message="No contracts match these filters."
                hint="Try widening the crop year, crop, buyer, or entity filters."
                linkHref="/contracts"
                linkLabel="Add contracts"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      {['Contract #', 'Buyer', 'Crop', 'Year', 'Window', 'Price/bu', 'Contracted', 'Delivered', 'Remaining', 'Value', 'Received', 'Outstanding', 'Unearned']
                        .map((h, i) => <th key={h} className={`${i >= 5 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleContracts.map((c) => {
                      const agg = aggByContract.get(c.id)!
                      const price = Number(c.price_per_bushel ?? 0)
                      const value = Number(c.contracted_bushels) * price
                      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
                      const unearned = remainingBu * price
                      const outstanding = agg.deliveredUnpaid * price
                      return (
                        <tr key={c.id} className="border-t border-slate-100">
                          <td className={`${textCell} font-semibold`}>{c.contract_number}</td>
                          <td className={textCell}>{buyerById.get(c.buyer_id ?? '')?.name ?? ''}</td>
                          <td className={textCell}>{cropById.get(c.crop_id ?? '')?.name ?? ''}</td>
                          <td className={textCell}>{c.crop_year ?? ''}</td>
                          <td className={`${textCell} text-xs whitespace-nowrap`}>
                            {(c.delivery_start_date || c.delivery_end_date)
                              ? <>{c.delivery_start_date ?? '?'} → {c.delivery_end_date ?? '?'}</>
                              : <span className="text-slate-400">—</span>}
                          </td>
                          <td className={numCell}>{price ? price.toFixed(4) : ''}</td>
                          <td className={numCell}>{fmt(Number(c.contracted_bushels))}</td>
                          <td className={numCell}>{fmt(agg.delivered)}</td>
                          <td className={numCell}>{fmt(remainingBu)}</td>
                          <td className={numCell}>${fmt(value)}</td>
                          <td className={`${numCell} text-green-700`}>${fmt(agg.revenueReceived)}</td>
                          <td className={`${numCell} text-amber-700`}>${fmt(outstanding)}</td>
                          <td className={`${numCell} text-sky-700`}>${fmt(unearned)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
