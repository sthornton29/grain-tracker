'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { projectPayments, expectedArcPlcDate } from '@/lib/government-payments'
import { projectInsuranceIndemnities, actualYieldByCropFromLoads, type LiveHarvest } from '@/lib/crop-insurance'
import { resolveProgramYearConfig } from '@/lib/program-config'
import ExportBar from '@/components/export-bar'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import {
  SummaryCards, EmptyState, type SummaryCardData,
  numCell, textCell, theadCls,
} from '@/components/reports/report-kit'
import type {
  Buyer, Contract, Crop, Entity, FieldPlanting, LoadSplit,
  CropAssumption, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco, HarvestPriceEstimate, ProgramYearConfig,
  CoveredCommodity, FarmBaseAcres, ArcPlcElection, ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment,
} from '@/lib/types'

type LoadRow = {
  id: string
  contract_id: string | null
  ticket_number: string | null
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  crop_year: number | null
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

// A contract is "complete" when explicitly marked complete or fully delivered
// (mirrors the contracts list). A completed contract books NO further projected
// revenue even if bushels remain — once it's closed out, no more grain will ship
// against it, so we stop assuming future income from those undelivered bushels.
function isContractComplete(completedAt: string | null, contractedBu: number, delivered: number): boolean {
  if (completedAt != null) return true
  return contractedBu > 0 && delivered >= contractedBu
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
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])
  // Today's live Barchart harvest estimate per crop year → crop_id, fetched so
  // the insurance projection uses the same price the Claims Monitor does.
  const [liveHarvestByYear, setLiveHarvestByYear] = useState<Map<number, Map<string, LiveHarvest>>>(new Map())
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
            .select('id, contract_id, ticket_number, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id')
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
        supabase.from('field_plantings').select('*'),
        supabase.from('load_splits').select('load_id, field_id'),
      ])
      const [ca, po, sc, ec, hpe, pgc, cc, ba, el, apd, apay, ogp] = await Promise.all([
        supabase.from('crop_assumptions').select('*'),
        supabase.from('crop_insurance_policies').select('*'),
        supabase.from('crop_insurance_sco').select('*'),
        supabase.from('crop_insurance_eco').select('*'),
        supabase.from('harvest_price_estimates').select('*').order('price_date', { ascending: false }),
        supabase.from('program_year_config').select('*'),
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
      setProgramConfigs((pgc.data as ProgramYearConfig[]) || [])
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

  // Crops carrying a policy, grouped by crop year, within the active filters —
  // drives the live harvest-price fetch (one call per year) so the insurance
  // projection prices at today's market, matching the Claims Monitor.
  const insurancePolicyScope = useMemo(() => {
    const m = new Map<number, Set<string>>()
    for (const p of policies) {
      if (cropYear !== '' && p.crop_year !== cropYear) continue
      if (entityId && p.entity_id !== entityId) continue
      if (cropId && p.crop_id !== cropId) continue
      const set = m.get(p.crop_year) ?? new Set<string>()
      set.add(p.crop_id)
      m.set(p.crop_year, set)
    }
    return m
  }, [policies, cropYear, entityId, cropId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const out = new Map<number, Map<string, LiveHarvest>>()
      for (const [yr, ids] of insurancePolicyScope) {
        const cropsPayload = Array.from(ids)
          .map((id) => ({ crop_id: id, crop_name: cropById.get(id)?.name ?? '' }))
          .filter((c) => c.crop_name)
        if (cropsPayload.length === 0) continue
        try {
          const res = await fetch('/api/harvest-price-estimate', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ crop_year: yr, crops: cropsPayload }),
          })
          const json = await res.json().catch(() => null)
          if (!json) continue
          const m = new Map<string, LiveHarvest>()
          for (const e of (json.estimates ?? []) as Array<{ crop_id: string; price: number | null; stale: boolean; price_date: string | null }>) {
            if (e.price != null) m.set(e.crop_id, { price: Number(e.price), stale: !!e.stale, priceDate: e.price_date })
          }
          out.set(yr, m)
        } catch { /* fall back to stored estimate / projected in the resolver */ }
      }
      if (!cancelled) setLiveHarvestByYear(out)
    })()
    return () => { cancelled = true }
  }, [insurancePolicyScope, cropById])
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

      // projected (not yet delivered) — spread across remaining months in delivery
      // window. Completed contracts project nothing, even with bushels remaining.
      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
      const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
      if (!complete && remainingBu > 0 && price > 0) {
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

    // Crop insurance — projected indemnity via the SHARED projection (same
    // per-practice yields + today's harvest price the Claims Monitor uses), so
    // the two pages reconcile. Run once per crop year present in the filtered
    // policies and bucket each year's total into the chosen month.
    const insuranceYears = Array.from(new Set(
      policies
        .filter((p) => (cropYear === '' || p.crop_year === cropYear) && (!entityId || p.entity_id === entityId) && (!cropId || p.crop_id === cropId))
        .map((p) => p.crop_year),
    ))
    for (const yr of insuranceYears) {
      const yrPolicies = policies.filter((p) =>
        p.crop_year === yr && (!entityId || p.entity_id === entityId) && (!cropId || p.crop_id === cropId))
      if (yrPolicies.length === 0) continue
      const projected = projectInsuranceIndemnities({
        cropYear: yr,
        policies: yrPolicies,
        scos, ecos, assumptions, plantings,
        actualYieldByCrop: actualYieldByCropFromLoads({ loads, plantings, crops, cropYear: yr }),
        harvestEstimates,
        liveHarvestByCrop: liveHarvestByYear.get(yr),
        scoTrigger: resolveProgramYearConfig(yr, programConfigs).scoTrigger,
      })
      const total = projected.reduce((s, r) => s + r.comp.totalIndemnity, 0)
      if (total > 0) ensure(`${yr}-${String(insuranceMonth).padStart(2, '0')}`).insurance += total
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
  }, [cropYear, cropId, entityId, elections, baseAcres, commodities, arcPriceData, arcPayments, farmEntity, policies, scos, ecos, harvestEstimates, assumptions, plantings, loads, crops, liveHarvestByYear, programConfigs, insuranceMonth, otherPayments])

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
      const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
      remaining += complete ? 0 : remainingBu * price
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

  // Export mirrors the on-screen monthly forecast + contract detail tables.
  function buildPayload(): ExportPayload {
    const filters = [
      cropYear === '' ? 'All crop years' : `${cropYear} crop`,
      cropId ? cropById.get(cropId)?.name ?? 'Crop' : 'All crops',
      buyerId ? buyerById.get(buyerId)?.name ?? 'Buyer' : 'All buyers',
      entityId ? entities.find((e) => e.id === entityId)?.name ?? 'Entity' : 'All entities',
    ].join(' · ')

    const monthly: ExportPayload['sections'][number] = {
      title: 'Monthly Forecast',
      columns: [
        { label: 'Month' },
        { label: 'Received', align: 'right', format: 'usd0' }, { label: 'Outstanding', align: 'right', format: 'usd0' },
        { label: 'Projected', align: 'right', format: 'usd0' }, { label: 'ARC/PLC', align: 'right', format: 'usd0' },
        { label: 'Crop Insurance', align: 'right', format: 'usd0' }, { label: 'Other Govt', align: 'right', format: 'usd0' },
        { label: 'Month total', align: 'right', format: 'usd0' }, { label: 'Cumulative', align: 'right', format: 'usd0' },
      ],
      rows: monthlyRows.map((r) => [r.label, r.received, r.outstanding, r.projected, r.arcPlc, r.insurance, r.other, r.total, r.cumulative]),
    }

    const detail: ExportPayload['sections'][number] = {
      title: 'Contract Detail',
      columns: [
        { label: 'Contract #' }, { label: 'Buyer' }, { label: 'Crop' }, { label: 'Year', format: 'text' }, { label: 'Window' },
        { label: 'Price/bu', align: 'right', format: 'price' }, { label: 'Contracted', align: 'right', format: 'bu' },
        { label: 'Delivered', align: 'right', format: 'bu' }, { label: 'Remaining', align: 'right', format: 'bu' },
        { label: 'Value', align: 'right', format: 'usd0' }, { label: 'Received', align: 'right', format: 'usd0' },
        { label: 'Outstanding', align: 'right', format: 'usd0' }, { label: 'Unearned', align: 'right', format: 'usd0' },
      ],
      rows: visibleContracts.map((c) => {
        const agg = aggByContract.get(c.id)!
        const price = Number(c.price_per_bushel ?? 0)
        const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered)
        const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
        const window = (c.delivery_start_date || c.delivery_end_date) ? `${c.delivery_start_date ?? '?'} → ${c.delivery_end_date ?? '?'}` : '—'
        return [
          complete ? `${c.contract_number} (complete)` : c.contract_number ?? '',
          buyerById.get(c.buyer_id ?? '')?.name ?? '', cropById.get(c.crop_id ?? '')?.name ?? '', c.crop_year ?? '', window,
          price || '', Number(c.contracted_bushels), agg.delivered, remainingBu,
          Number(c.contracted_bushels) * price, agg.revenueReceived, agg.deliveredUnpaid * price, complete ? 0 : remainingBu * price,
        ]
      }),
    }

    return {
      title: 'Cash Flow Forecast',
      filters,
      summary: [
        { label: 'Contract value', value: formatNumber(summary.value, 'usd0') },
        { label: 'Received', value: formatNumber(summary.received, 'usd0'), tone: 'favorable' },
        { label: 'Outstanding', value: formatNumber(summary.outstanding, 'usd0'), tone: 'warning' },
        { label: 'Remaining', value: formatNumber(summary.remaining, 'usd0') },
        { label: 'Total Safety Net', value: formatNumber(safetyTotals.total, 'usd0'), tone: 'favorable' },
      ],
      sections: [monthly, detail],
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Cash Flow Forecast</h1>
        {!loading && (monthlyRows.length > 0 || visibleContracts.length > 0) && <ExportBar buildPayload={buildPayload} />}
      </div>

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
            <p className="px-4 py-2 text-xs text-slate-500 leading-relaxed border-b border-slate-100">
              <span className="font-semibold text-green-700">Received</span> — cash already collected on settled loads, in the settlement&rsquo;s month.{' '}
              <span className="font-semibold text-amber-700">Outstanding</span> — grain you&rsquo;ve <em>delivered but not yet been paid for</em>, valued at the contract price and shown in the current month as money still owed to you.{' '}
              <span className="font-semibold text-sky-700">Projected</span> — contracted bushels <em>not yet delivered</em>, valued at the contract price and spread across the remaining delivery window (future income you still expect). Completed contracts add nothing to Projected.
            </p>
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
                      const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
                      // Completed contracts earn nothing more — no unearned revenue
                      // booked, matching the Projected column above.
                      const unearned = complete ? 0 : remainingBu * price
                      const outstanding = agg.deliveredUnpaid * price
                      return (
                        <tr key={c.id} className="border-t border-slate-100">
                          <td className={`${textCell} font-semibold whitespace-nowrap`}>
                            {c.contract_number}
                            {complete && <span className="ml-1.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-medium px-1.5 py-0.5 align-middle">complete</span>}
                          </td>
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
