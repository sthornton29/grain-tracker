'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { marketingCropYearOptions } from '@/lib/crop-years'
import { projectPayments, expectedArcPlcDate, programYearFor, paymentAttributionYear } from '@/lib/government-payments'
import { projectInsuranceIndemnities, actualYieldByCropFromLoads, type LiveHarvest } from '@/lib/crop-insurance'
import { fieldCropAggregates, withLoadBreakouts, type CombineEntryLike } from '@/lib/yields'
import { cottonCashFlowEvents, type CottonCashEvent } from '@/lib/cotton-sales'
import { fetchCottonPhysical } from '@/lib/cotton-physical-fetch'
import { fetchSeedContracts, type SeedContractData } from '@/lib/seed-contracts-fetch'
import { buildSeedCommitments, seedCashFlowEvents, type SeedCashFlowEvent } from '@/lib/seed-contracts'
import { isCottonCrop } from '@/lib/marketing'
import { resolveProgramYearConfig } from '@/lib/program-config'
import { buildEntityScope } from '@/lib/entity-scope'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { useViewerAssumptions } from '@/lib/use-viewer-assumptions'
import { resolveCropAssumptions } from '@/lib/viewer-assumptions'
import { SupersededNotice } from '@/components/viewer-scenario'
import EntityFilter from '@/components/entity-filter'
import ExportBar from '@/components/export-bar'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import {
  SummaryCards, EmptyState, ReportHeader, ReportFilterBar, FilterField, MonthlyBars, type SummaryCardData,
  numCell, textCell, theadCls, stickyColCls, stickyColHeadCls, selectCls,
  fmtUsd, fmtInt, toneText, toneFill, signedTone, filterSummaryOf, cropYearLabel,
} from '@/components/reports/report-kit'
import { useReportCropYear } from '@/lib/report-filters'
import { fmtDate } from '@/lib/format-date'
import { AppModal } from '@/components/app-dialog'
import {
  CASH_KIND_EXPLAINER, CASH_KIND_LABEL, projectionMonths, selectCashDetails, sumCashDetails,
  type CashDetail, type CashKind, type CashSelection,
} from '@/lib/cash-flow-detail'
import type {
  Buyer, Contract, Crop, Entity, FieldPlanting,
  CropAssumption, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco, HarvestPriceEstimate, ProgramYearConfig,
  CoveredCommodity, FarmBaseAcres, ArcPlcElection, ArcPlcPriceData, ArcPlcPayment, OtherGovernmentPayment,
} from '@/lib/types'
import { loadTicketKeys } from '@/lib/ticket-matching'

type LoadRow = {
  id: string
  date: string
  contract_id: string | null
  ticket_number: string | null
  buyer_ticket_number?: string | null
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  crop_year: number | null
  dry_bushels_override: number | null
  from_type: string | null
  from_field_id: string | null
  practice: 'irrigated' | 'dryland' | null
}

type CashFlowSplitRow = {
  load_id: string
  field_id: string
  crop_id: string
  dry_bushels: number | null
  practice: 'irrigated' | 'dryland' | null
}

type LineRow = {
  load_id: string | null
  ticket_number: string | null
  net_bushels: number
  net_revenue: number | null
  settlement_id: string
}

type SettlementRow = { id: string; settlement_date: string; settlement_number: string | null; buyer_id: string | null }
type FarmRow = { id: string; entity_id: string | null; name: string }

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
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
  const [splits, setSplits] = useState<CashFlowSplitRow[]>([])
  const [combineEntries, setCombineEntries] = useState<CombineEntryLike[]>([])
  const [lines, setLines] = useState<LineRow[]>([])
  const [settlements, setSettlements] = useState<SettlementRow[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<FarmRow[]>([])
  const [fields, setFields] = useState<Array<{ id: string; farm_id: string | null }>>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
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

  // Crop year: current year by default, persisted, never overwritten on load
  // (lib/report-filters). "All crop years" stays available but is never the
  // default. Crop and buyer persist too.
  const [cropYear, setCropYear] = useReportCropYear('cash-flow:cropYear', { allowAll: true })
  const [cropId, setCropId] = usePersistentState('cash-flow:cropId', '')
  const [buyerId, setBuyerId] = usePersistentState('cash-flow:buyerId', '')
  // Entity filter — persisted per report, scoped through the SHARED helper
  // (lib/entity-scope.ts) so this page interprets "entity selected" exactly
  // like Marketing / Revenue Projections / Income Sensitivity.
  const [entityId, setEntityId] = usePersistentState('cash-flow:entity', '')

  // Viewer role (052): the grant universe caps the entity scope, and the
  // viewer's private assumption overrides layer over the shared crop
  // assumptions feeding the insurance projection.
  const viewer = useViewerScope(supabase)
  const viewerA = useViewerAssumptions(supabase, viewer)
  const assumptionRes = useMemo(() => resolveCropAssumptions(assumptions, viewerA.overrides), [assumptions, viewerA.overrides])
  const effAssumptions = assumptionRes.rows
  useEffect(() => { if (assumptionRes.staleIds.length > 0) viewerA.cleanupStale(assumptionRes.staleIds) }, [assumptionRes, viewerA])
  // Hold viewer-scoped output until the grants/overrides resolve, so a viewer
  // never sees a flash of unscoped numbers. Inert timing for owners.
  const viewerPending = viewer.loading || !viewerA.ready

  // Cotton cash events (044): CCC loan proceeds at entry, redemption payoffs /
  // equity at outcome, pool payments, priced contract deliveries, LDP, fees.
  // Only computed for a specific crop year (cotton timing is per-crop-year).
  const [cottonEvents, setCottonEvents] = useState<CottonCashEvent[]>([])
  useEffect(() => {
    if (cropYear === '') { setCottonEvents([]); return }
    if (viewer.loading) return
    let cancelled = false
    ;(async () => {
      try {
        const physical = await fetchCottonPhysical(supabase, cropYear)
        if (cancelled) return
        if (!physical.hasData) { setCottonEvents([]); return }
        // Shared attribution (same rule as the other reports): own-name rows
        // whole, marketing-agent/null rows flow down at the cotton acre share.
        const { own, flow, flowShare, hasData } = buildEntityScope({ entityId, farms, fields, entities, grantedEntityIds: viewer.grantedIds })
          .attribution({ plantings, crops })
          .cottonPartition(physical.inputs)
        if (!hasData) { setCottonEvents([]); return }
        // Live CT futures (¢/lb) so on-call contracts awaiting futures can book
        // basis + current futures as a labeled estimate instead of vanishing.
        let currentFuturesCents: number | null = null
        const cottonCrop = crops.find((c) => isCottonCrop(c.name))
        const needsQuote = [...own.contracts, ...(flowShare > 0 ? flow.contracts : [])]
          .some((c) => c.contract_type === 'on_call' && c.futures_fixed_cents == null)
        if (cottonCrop && needsQuote) {
          try {
            const res = await fetch('/api/harvest-price-estimate', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ crop_year: cropYear, crops: [{ crop_id: cottonCrop.id, crop_name: cottonCrop.name }] }),
            })
            const json = await res.json().catch(() => null)
            const price = json?.estimates?.[0]?.price
            if (price != null && Number.isFinite(Number(price))) currentFuturesCents = Number(price)
          } catch { /* no quote — the on-call estimate is simply omitted */ }
        }
        if (cancelled) return
        const events = [
          ...cottonCashFlowEvents(own, { currentFuturesCents }),
          ...(flowShare > 0
            ? cottonCashFlowEvents(flow, { currentFuturesCents }).map((e) =>
                flowShare === 1 ? e : { ...e, amount: Math.round(e.amount * flowShare * 100) / 100 })
            : []),
        ].sort((a, b) => a.date.localeCompare(b.date))
        setCottonEvents(events)
      } catch { if (!cancelled) setCottonEvents([]) }
    })()
    return () => { cancelled = true }
  }, [cropYear, entityId, supabase, crops, farms, fields, entities, plantings, viewer.loading, viewer.grantedIds])

  useEffect(() => {
    ;(async () => {
      // Paginate loads (lib/fetch-all-rows — cap-agnostic termination); one
      // missed load means a contract's delivered total quietly stays at zero.
      async function fetchAllLoads(): Promise<LoadRow[]> {
        const { data, error } = await fetchAllRows<LoadRow>((f, t) =>
          supabase
            .from('loads')
            .select('id, date, time, contract_id, ticket_number, buyer_ticket_number, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, practice')
            .order('id', { ascending: true })
            .range(f, t),
        )
        if (error) throw new Error(error.message)
        return data
      }
      const [ct, ld, sp, ln, st, cr, by, en, fa, fi, pl] = await Promise.all([
        supabase.from('contracts').select('*'),
        fetchAllLoads(),
        fetchAllRows((f, t) => supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels, practice').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue, settlement_id').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('settlements').select('id, settlement_date, settlement_number, buyer_id').order('id').range(f, t)),
        supabase.from('crops').select('*'),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        supabase.from('farms').select('id, entity_id, name'),
        supabase.from('fields').select('id, farm_id'),
        fetchAllRows((f, t) => supabase.from('field_plantings').select('*').order('id').range(f, t)),
      ])
      const [ca, po, sc, ec, hpe, pgc, cc, ba, el, apd, apay, ogp, ce] = await Promise.all([
        supabase.from('crop_assumptions').select('*'),
        fetchAllRows((f, t) => supabase.from('crop_insurance_policies').select('*').order('id').range(f, t)),
        supabase.from('crop_insurance_sco').select('*'),
        supabase.from('crop_insurance_eco').select('*'),
        fetchAllRows((f, t) => supabase.from('harvest_price_estimates').select('*').order('price_date', { ascending: false }).order('id').range(f, t)),
        supabase.from('program_year_config').select('*'),
        supabase.from('covered_commodities').select('*'),
        supabase.from('farm_base_acres').select('*'),
        supabase.from('arc_plc_elections').select('*'),
        supabase.from('arc_plc_price_data').select('*'),
        fetchAllRows((f, t) => supabase.from('arc_plc_payments').select('*').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('other_government_payments').select('*').order('id').range(f, t)),
        // May not exist yet (migration 062): an error leaves data null → [].
        fetchAllRows((f, t) => supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date').order('id').range(f, t)),
      ])
      setContracts((ct.data as Contract[]) || [])
      setLoads(ld)
      setSplits((sp.data as CashFlowSplitRow[]) || [])
      setLines((ln.data as LineRow[]) || [])
      setSettlements((st.data as SettlementRow[]) || [])
      setCrops((cr.data as Crop[]) || [])
      setBuyers((by.data as Buyer[]) || [])
      setEntities((en.data as Entity[]) || [])
      setFarms((fa.data as FarmRow[]) || [])
      setFields((fi.data as Array<{ id: string; farm_id: string | null }>) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
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
      setCombineEntries((ce.data as CombineEntryLike[]) || [])
      setLoading(false)
    })()
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const buyerById = useMemo(() => new Map(buyers.map((b) => [b.id, b])), [buyers])
  const settlementById = useMemo(() => new Map(settlements.map((s) => [s.id, s])), [settlements])

  // Shared entity scoping (lib/entity-scope.ts) — same rules as the other
  // financial reports: policies by their own entity_id, ARC/PLC by the farm's
  // entity, other USDA payments by farm-then-entity attribution, and contracts
  // through the shared attribution (entity-keyed → whole; operation-level →
  // the entity's acre share of the crop, so its sales don't vanish).
  const scope = useMemo(
    () => buildEntityScope({ entityId, farms, fields, entities, grantedEntityIds: viewer.grantedIds }),
    [entityId, farms, fields, entities, viewer.grantedIds],
  )
  const entityName = entityId
    ? entities.find((e) => e.id === entityId)?.name ?? null
    : viewerAllEntitiesLabel(viewer, entities)
  const scopedPolicies = useMemo(() => scope.byEntity(policies), [scope, policies])
  const attribution = useMemo(() => scope.attribution({ plantings, crops }), [scope, plantings, crops])

  // Crops carrying a policy, grouped by crop year, within the active filters —
  // drives the live harvest-price fetch (one call per year) so the insurance
  // projection prices at today's market, matching the Claims Monitor.
  const insurancePolicyScope = useMemo(() => {
    const m = new Map<number, Set<string>>()
    for (const p of scopedPolicies) {
      if (cropYear !== '' && p.crop_year !== cropYear) continue
      if (cropId && p.crop_id !== cropId) continue
      const set = m.get(p.crop_year) ?? new Set<string>()
      set.add(p.crop_id)
      m.set(p.crop_year, set)
    }
    return m
  }, [scopedPolicies, cropYear, cropId])

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
    for (const k of loadTicketKeys(load)) if (lineByTicket.has(k)) return lineByTicket.get(k)!
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

  // Future years are on offer too (this year + two), and any year with
  // contracts or assumptions — marketing and cash planning run ahead of planting.
  const cropYearOptions = useMemo(
    () => marketingCropYearOptions({
      plantingYears: plantings.map((p) => p.season_year),
      contractYears: contracts.map((c) => c.crop_year),
      assumptionYears: assumptions.map((a) => a.crop_year),
      extraYears: [cropYear === '' ? null : cropYear],
    }),
    [plantings, contracts, assumptions, cropYear],
  )

  type Agg = {
    contract: Contract
    delivered: number
    deliveredUnpaid: number
    unpaidLoads: number
    revenueReceived: number
    /** Received dollars by settlement (the drill-down's rows); the month
     *  comes from the settlement's date. */
    receivedBySettlement: Map<string, { amount: number; bushels: number; loads: number }>
  }
  const aggByContract = useMemo(() => {
    const map = new Map<string, Agg>()
    for (const c of contracts) map.set(c.id, {
      contract: c, delivered: 0, deliveredUnpaid: 0, unpaidLoads: 0, revenueReceived: 0,
      receivedBySettlement: new Map(),
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
        if (settlementById.has(line.settlement_id)) {
          const cur = agg.receivedBySettlement.get(line.settlement_id) ?? { amount: 0, bushels: 0, loads: 0 }
          cur.amount += rev
          cur.bushels += Number(line.net_bushels ?? 0)
          cur.loads += 1
          agg.receivedBySettlement.set(line.settlement_id, cur)
        }
      } else {
        agg.deliveredUnpaid += bu
        agg.unpaidLoads += 1
      }
    }
    return map
  }, [contracts, loads, cropById, lineByLoadId, lineByTicket, settlementById])

  const contractLabel = (c: Contract) => `Contract #${c.contract_number}${c.buyer_id ? ` · ${buyerById.get(c.buyer_id)?.name ?? ''}` : ''}${c.crop_id ? ` · ${cropById.get(c.crop_id)?.name ?? ''}` : ''}`

  // Entity scoping via the shared attribution: a contract keyed to an entity
  // belongs wholly to it; an operation-level (null-entity) contract carries
  // the entity's acre share of its crop — its bushels and dollars scale by
  // that share below, so filtered entities keep their sales and the per-entity
  // views sum back to the all-entities report.
  const shareFor = (c: Contract) => attribution.shareForContract(c)
  const visibleContracts = contracts.filter((c) => {
    if (viewerPending) return false
    // Seed production contracts (077) stage their own labeled events below —
    // keeping them out of the grain buckets prevents double counting.
    if ((c.contract_kind ?? 'grain') === 'seed_production') return false
    if (cropYear !== '' && c.crop_year !== cropYear) return false
    if (cropId && c.crop_id !== cropId) return false
    if (buyerId && c.buyer_id !== buyerId) return false
    if (shareFor(c) <= 0) return false
    return true
  })

  // Compute monthly cash flow buckets — and, beside each total, the rows it
  // is made of (lib/cash-flow-detail) so any number on screen can open them.
  type Bucket = { received: number; outstanding: number; projected: number }
  const contractFlow = useMemo(() => {
    const buckets = new Map<string, Bucket>()
    const details: CashDetail[] = []
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
      // Entity share of this contract (1 unfiltered / entity-keyed).
      const s = shareFor(c)
      const shareNote = s < 1 ? ` · ${Math.round(s * 100)}% entity share` : ''
      const href = `/contracts/${c.id}`

      // received — by settlement month
      for (const [settlementId, r] of agg.receivedBySettlement) {
        const settlement = settlementById.get(settlementId)
        if (!settlement) continue
        const m = monthKey(new Date(settlement.settlement_date + 'T00:00:00'))
        ensure(m).received += r.amount * s
        details.push({
          kind: 'received', month: m, amount: r.amount * s, status: 'received',
          label: `Settlement ${settlement.settlement_number ? `#${settlement.settlement_number}` : fmtDate(settlement.settlement_date)}${settlement.buyer_id ? ` · ${buyerById.get(settlement.buyer_id)?.name ?? ''}` : ''}`,
          sub: `${contractLabel(c)} · ${fmtInt(r.loads)} load${r.loads === 1 ? '' : 's'} · ${fmtInt(r.bushels)} bu · dated ${fmtDate(settlement.settlement_date)}${shareNote}`,
          href: `/settlements/${settlementId}`,
        })
      }

      // outstanding (delivered but unpaid) — receivable this month, valued at contract price
      const outstandingAmt = agg.deliveredUnpaid * price * s
      if (outstandingAmt > 0) {
        ensure(thisMonth).outstanding += outstandingAmt
        details.push({
          kind: 'outstanding', month: thisMonth, amount: outstandingAmt, status: 'outstanding',
          label: contractLabel(c),
          sub: `${fmtInt(agg.unpaidLoads)} load${agg.unpaidLoads === 1 ? '' : 's'} delivered, not yet on a settlement · ${fmtInt(agg.deliveredUnpaid * s)} bu × ${fmtUsd(price, 2)}${shareNote}`,
          href,
        })
      }

      // projected (not yet delivered) — spread across remaining months in delivery
      // window. Completed contracts project nothing, even with bushels remaining.
      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered) * s
      const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
      if (!complete && remainingBu > 0 && price > 0) {
        const totalProjected = remainingBu * price
        const months = projectionMonths({ todayKey: thisMonth, start: c.delivery_start_date, end: c.delivery_end_date })
        const windowNote = (c.delivery_start_date || c.delivery_end_date)
          ? `window ${c.delivery_start_date ? fmtDate(c.delivery_start_date) : 'open'} → ${c.delivery_end_date ? fmtDate(c.delivery_end_date) : 'open'}`
          : 'no delivery window'
        if (months.length === 0) {
          // No window (or end has passed) — put everything in current month
          ensure(thisMonth).projected += totalProjected
          details.push({
            kind: 'projected', month: thisMonth, amount: totalProjected, status: 'projected',
            label: contractLabel(c),
            sub: `${fmtInt(remainingBu)} bu still to deliver × ${fmtUsd(price, 2)} · ${windowNote}, so all of it is shown this month${shareNote}`,
            href,
          })
        } else {
          const per = totalProjected / months.length
          for (const m of months) {
            ensure(m).projected += per
            details.push({
              kind: 'projected', month: m, amount: per, status: 'projected',
              label: contractLabel(c),
              sub: `${fmtInt(remainingBu)} bu still to deliver × ${fmtUsd(price, 2)} = ${fmtUsd(totalProjected)}, spread over ${months.length} month${months.length === 1 ? '' : 's'} (${windowNote})${shareNote}`,
              href,
            })
          }
        }
      }
    }
    return { buckets, details }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleContracts, aggByContract, settlementById, buyerById, cropById])
  const monthly = contractFlow.buckets

  // Safety net (crop insurance + government payments) bucketed by month, with the
  // program-specific timing: ARC/PLC in October of crop_year + 1, crop insurance
  // proceeds in the chosen month (default December), other USDA payments on their
  // payment date (else December of the crop year). Respects the crop-year, crop,
  // and entity filters where each program is scoped to those dimensions.
  type SafetyBucket = { arcPlc: number; insurance: number; other: number }
  const safetyFlow = useMemo(() => {
    const buckets = new Map<string, SafetyBucket>()
    const details: CashDetail[] = []
    const ensure = (k: string) => {
      let b = buckets.get(k)
      if (!b) { b = { arcPlc: 0, insurance: 0, other: 0 }; buckets.set(k, b) }
      return b
    }
    const farmName = (id: string | null) => (id ? farms.find((f) => f.id === id)?.name ?? 'Farm' : 'No farm')

    // ARC/PLC — net projections per PROGRAM year, placed in October of program
    // year + 1 (the revenue crop year). Filtering to crop year Y therefore
    // shows the program-year-Y−1 payment arriving in fall Y — the same
    // attribution Revenue Projections and Income Sensitivity use, so each
    // program year's payment appears in exactly one crop year everywhere.
    const programYears = cropYear !== '' ? [programYearFor(cropYear)] : Array.from(new Set(elections.map((e) => e.crop_year)))
    for (const yr of programYears) {
      if (!cropId) {
        const projected = projectPayments({ cropYear: yr, baseAcres, commodities, elections, priceData: arcPriceData, payments: arcPayments })
        const m = monthKey(new Date(expectedArcPlcDate(yr) + 'T00:00:00'))
        let net = 0
        for (const p of projected) {
          if (!scope.farmInEntity(p.farmId)) continue
          net += p.result.net
          if (p.result.net !== 0) {
            details.push({
              kind: 'arcPlc', month: m, amount: p.result.net, status: 'projected',
              label: `${farmName(p.farmId)} · ${commodities.find((c) => c.id === p.commodityId)?.name ?? 'Commodity'}`,
              sub: `${p.election} · ${fmtInt(p.baseAcres)} base acres · ${yr} program year, paid Oct ${yr + 1}`,
              href: '/reports/government-payments',
            })
          }
        }
        if (net !== 0) ensure(m).arcPlc += net
      }
    }

    // Crop insurance — projected indemnity via the SHARED projection (same
    // per-practice yields + today's harvest price the Claims Monitor uses), so
    // the two pages reconcile. Run once per crop year present in the filtered
    // policies and bucket each year's total into the chosen month.
    const insuranceYears = Array.from(new Set(
      scopedPolicies
        .filter((p) => (cropYear === '' || p.crop_year === cropYear) && (!cropId || p.crop_id === cropId))
        .map((p) => p.crop_year),
    ))
    for (const yr of insuranceYears) {
      const yrPolicies = scopedPolicies.filter((p) =>
        p.crop_year === yr && (!cropId || p.crop_id === cropId))
      if (yrPolicies.length === 0) continue
      // Load-derived irrigated/dryland splits materialized onto the plantings
      // (same seam as the Claims Monitor) so the shared projection's
      // per-practice yields agree between the two pages whichever path — manual
      // allocation or fully practice-tagged loads — produced the split.
      const effPlantings = withLoadBreakouts(
        plantings,
        fieldCropAggregates(loads, splits, cropById, { cropYear: yr, combineEntries }),
      )
      const projected = projectInsuranceIndemnities({
        cropYear: yr,
        policies: yrPolicies,
        scos, ecos, assumptions: effAssumptions, plantings: effPlantings,
        actualYieldByCrop: actualYieldByCropFromLoads({ loads, plantings, crops, cropYear: yr, combineEntries }),
        harvestEstimates,
        liveHarvestByCrop: liveHarvestByYear.get(yr),
        crops,
        scoTrigger: resolveProgramYearConfig(yr, programConfigs).scoTrigger,
      })
      const total = projected.reduce((s, r) => s + r.comp.totalIndemnity, 0)
      const m = `${yr}-${String(insuranceMonth).padStart(2, '0')}`
      if (total > 0) ensure(m).insurance += total
      for (const r of projected) {
        if (r.comp.totalIndemnity <= 0) continue
        const p = r.policy
        details.push({
          kind: 'insurance', month: m, amount: r.comp.totalIndemnity, status: 'projected',
          label: `${cropById.get(p.crop_id)?.name ?? 'Crop'} · ${p.practice === 'irrigated' ? 'irrigated' : 'dryland'} · ${p.plan_type} ${fmtInt(Number(p.coverage_level) <= 1 ? Number(p.coverage_level) * 100 : Number(p.coverage_level))}%`,
          sub: `${yr} policy${p.entity_id ? ` · ${entities.find((e) => e.id === p.entity_id)?.name ?? ''}` : ''} · projected indemnity at today's harvest price`,
          href: '/reports/crop-insurance-claims',
        })
      }
    }

    // Other USDA payments — on payment_date, else December of the crop year.
    // Attributed to the year the payment lands in (payment-date year, else
    // crop_year, which for manual entries means the payment year).
    for (const o of scope.otherPayments(otherPayments)) {
      if (cropYear !== '' && paymentAttributionYear(o) !== cropYear) continue
      if (cropId && o.crop_id !== cropId) continue
      const key = o.payment_date ? monthKey(new Date(o.payment_date + 'T00:00:00')) : `${o.crop_year}-12`
      ensure(key).other += Number(o.amount)
      details.push({
        kind: 'other', month: key, amount: Number(o.amount), status: o.payment_status === 'received' ? 'received' : 'projected',
        label: o.program_name,
        sub: [o.farm_id ? farmName(o.farm_id) : null, o.crop_id ? cropById.get(o.crop_id)?.name : null, o.payment_date ? `paid ${fmtDate(o.payment_date)}` : `no date — December ${o.crop_year}`, o.payment_status].filter(Boolean).join(' · '),
        href: '/settings/government-payments',
      })
    }

    return { buckets, details }
  }, [cropYear, cropId, scope, elections, baseAcres, commodities, arcPriceData, arcPayments, scopedPolicies, scos, ecos, harvestEstimates, effAssumptions, plantings, loads, splits, combineEntries, cropById, crops, liveHarvestByYear, programConfigs, insuranceMonth, otherPayments, farms, entities])
  const safetyNet = safetyFlow.buckets

  // Seed production contracts (077): the staged-payment events — 80% base at
  // each election, final 20% + premiums at the estimated settlement, storage
  // monthly, the usage fee as an outflow — with received ledger rows replacing
  // their projections. Fetched once per crop year; events derived below.
  const [seedRaw, setSeedRaw] = useState<SeedContractData | null>(null)
  useEffect(() => {
    if (cropYear === '') { setSeedRaw(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const seed = await fetchSeedContracts(supabase, cropYear)
        if (!cancelled) setSeedRaw(seed)
      } catch { if (!cancelled) setSeedRaw(null) }
    })()
    return () => { cancelled = true }
  }, [cropYear, supabase])

  const seedEvents = useMemo(() => {
    if (cropYear === '' || viewerPending || !seedRaw || seedRaw.bundles.length === 0) return []
    // Crop-level harvest flags decide estimate vs actual committed production
    // (the monthly forecast doesn't need the field-level analysis).
    const completeIds = new Set<string>()
    for (const a of effAssumptions) if (a.harvest_complete && a.crop_year === cropYear) completeIds.add(a.crop_id)
    const aggByKey = fieldCropAggregates(loads, splits, cropById, { cropYear, combineEntries })
    const commitments = buildSeedCommitments({
      bundles: seedRaw.bundles,
      cropYear,
      plantings,
      aggByKey,
      assumptions: effAssumptions,
      harvestCompleteCropIds: completeIds,
      buyerNameById: new Map(buyers.map((b) => [b.id, b.name])),
      shareForContract: (c) => attribution.shareForContract(c),
    })
    const out: Array<SeedCashFlowEvent & { cropId: string | null; buyerId: string | null; contractId: string }> = []
    for (const b of seedRaw.bundles) {
      const commitment = (b.contract.crop_id ? commitments.get(b.contract.crop_id) ?? [] : [])
        .find((c) => c.contractId === b.contract.id)
      if (!commitment || commitment.committed.bushels <= 0) continue
      const a = effAssumptions.find((x) => x.crop_id === b.contract.crop_id && x.crop_year === cropYear)
      const ref = a?.assumed_futures != null ? Number(a.assumed_futures) + Number(a.assumed_basis ?? 0) : null
      for (const e of seedCashFlowEvents({
        details: b.details, premiums: b.premiums, elections: b.elections, payments: b.payments,
        committed: commitment.committed, referencePlusBasis: ref, cropYear,
        contractLabel: `Seed ${b.contract.contract_number}`,
      })) {
        out.push({ ...e, cropId: b.contract.crop_id, buyerId: b.contract.buyer_id, contractId: b.contract.id })
      }
    }
    return out.sort((x, y) => x.month.localeCompare(y.month))
  }, [cropYear, viewerPending, seedRaw, effAssumptions, loads, splits, cropById, combineEntries, plantings, buyers, attribution])

  const visibleSeedEvents = useMemo(
    () => seedEvents.filter((e) => (!cropId || e.cropId === cropId) && (!buyerId || e.buyerId === buyerId)),
    [seedEvents, cropId, buyerId],
  )
  const seedMonthly = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of visibleSeedEvents) m.set(e.month, (m.get(e.month) ?? 0) + e.amount)
    return m
  }, [visibleSeedEvents])

  // Cotton events, respecting the crop filter (a non-cotton crop hides them)
  // and bucketed net per month.
  const visibleCottonEvents = useMemo(() => {
    if (cropId && !isCottonCrop(cropById.get(cropId)?.name ?? '')) return []
    return cottonEvents
  }, [cottonEvents, cropId, cropById])
  const cottonMonthly = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of visibleCottonEvents) m.set(monthKey(new Date(e.date + 'T00:00:00')), (m.get(monthKey(new Date(e.date + 'T00:00:00'))) ?? 0) + e.amount)
    return m
  }, [visibleCottonEvents])

  // Every row behind every number on the page, in one list (lib/cash-flow-detail).
  const allDetails = useMemo<CashDetail[]>(() => [
    ...contractFlow.details,
    ...safetyFlow.details,
    ...visibleCottonEvents.map((e): CashDetail => ({
      kind: 'cotton', month: monthKey(new Date(e.date + 'T00:00:00')), amount: e.amount, status: e.status,
      label: e.label, sub: `${fmtDate(e.date)} · ${e.status}`, href: '/cotton/marketing',
    })),
    ...visibleSeedEvents.map((e): CashDetail => ({
      kind: 'seed', month: e.month, amount: e.amount, status: e.status,
      label: e.label, sub: e.status, href: `/contracts/${e.contractId}`,
    })),
  ], [contractFlow.details, safetyFlow.details, visibleCottonEvents, visibleSeedEvents])

  // The drill-down: which number was tapped. `rows` is resolved at open time
  // so a summary card and a table cell share one modal.
  const [drill, setDrill] = useState<{ title: string; explainer: string; rows: CashDetail[] } | null>(null)
  const closeDrill = useCallback(() => setDrill(null), [])
  function openDrill(sel: CashSelection) {
    const rows = selectCashDetails(allDetails, sel)
    const kindLabel = sel.kind === 'all' ? 'Month total' : CASH_KIND_LABEL[sel.kind]
    setDrill({
      title: `${kindLabel} · ${sel.month ? monthLabel(sel.month) : filterSummary}`,
      explainer: sel.kind === 'all' ? 'Every line that lands in this month, by kind.' : CASH_KIND_EXPLAINER[sel.kind],
      rows,
    })
  }

  const monthlyRows = useMemo(() => {
    const keys = [...new Set([...monthly.keys(), ...safetyNet.keys(), ...cottonMonthly.keys(), ...seedMonthly.keys()])].sort()
    let running = 0
    return keys.map((k) => {
      const b = monthly.get(k) ?? { received: 0, outstanding: 0, projected: 0 }
      const s = safetyNet.get(k) ?? { arcPlc: 0, insurance: 0, other: 0 }
      const cotton = cottonMonthly.get(k) ?? 0
      const seed = seedMonthly.get(k) ?? 0
      const total = b.received + b.outstanding + b.projected + s.arcPlc + s.insurance + s.other + cotton + seed
      running += total
      return { key: k, label: monthLabel(k), ...b, ...s, cotton, seed, total, cumulative: running }
    })
  }, [monthly, safetyNet, cottonMonthly, seedMonthly])

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
      const s = shareFor(c)
      value += Number(c.contracted_bushels) * price * s
      received += agg.revenueReceived * s
      outstanding += agg.deliveredUnpaid * price * s
      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered) * s
      const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
      remaining += complete ? 0 : remainingBu * price
    }
    return { value, received, outstanding, remaining }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleContracts, aggByContract])

  const filterSummary = filterSummaryOf(
    cropYearLabel(cropYear),
    entityName ?? 'All Entities',
    cropId ? cropById.get(cropId)?.name ?? 'Crop' : 'All Crops',
    buyerId ? buyerById.get(buyerId)?.name ?? 'Buyer' : 'All Buyers',
  )

  // "Contract value" is not a month bucket: its rows are each contract's
  // bushels × price, resolved here for the card.
  function openContractValue() {
    const rows: CashDetail[] = visibleContracts.map((c) => {
      const s = shareFor(c)
      const price = Number(c.price_per_bushel ?? 0)
      return {
        kind: 'projected' as const, month: '', amount: Number(c.contracted_bushels) * price * s,
        label: contractLabel(c),
        sub: `${fmtInt(Number(c.contracted_bushels) * s)} bu × ${fmtUsd(price, 2)}${s < 1 ? ` · ${Math.round(s * 100)}% entity share` : ''}${price === 0 ? ' · no price set yet' : ''}`,
        href: `/contracts/${c.id}`,
      }
    }).sort((a, b) => b.amount - a.amount)
    setDrill({ title: `Contract value · ${filterSummary}`, explainer: 'Each contract\'s bushels at its contract price. Unpriced contracts count as zero until a price is set.', rows })
  }

  const summaryCards: SummaryCardData[] = [
    { label: 'Contract value', value: fmtUsd(summary.value), onClick: openContractValue },
    { label: 'Received', value: fmtUsd(summary.received), tone: 'favorable', onClick: () => openDrill({ kind: 'received', month: null }) },
    { label: 'Outstanding', value: fmtUsd(summary.outstanding), tone: 'warning', sub: 'Delivered, not yet paid', onClick: () => openDrill({ kind: 'outstanding', month: null }) },
    { label: 'Projected', value: fmtUsd(summary.remaining), sub: 'Contracted, not yet delivered', onClick: () => openDrill({ kind: 'projected', month: null }) },
  ]

  const cottonNet = useMemo(() => visibleCottonEvents.reduce((s, e) => s + e.amount, 0), [visibleCottonEvents])
  const seedNet = useMemo(() => visibleSeedEvents.reduce((s, e) => s + e.amount, 0), [visibleSeedEvents])

  const safetyCards: SummaryCardData[] = [
    {
      label: cropYear !== '' ? `ARC/PLC (${programYearFor(cropYear)} program year — paid Oct ${cropYear})` : 'ARC/PLC',
      value: fmtUsd(safetyTotals.arcPlc),
      onClick: () => openDrill({ kind: 'arcPlc', month: null }),
    },
    { label: 'Crop Insurance', value: fmtUsd(safetyTotals.insurance), onClick: () => openDrill({ kind: 'insurance', month: null }) },
    { label: 'Other USDA', value: fmtUsd(safetyTotals.other), onClick: () => openDrill({ kind: 'other', month: null }) },
    {
      label: 'Total Safety Net', value: fmtUsd(safetyTotals.total), tone: 'favorable',
      onClick: () => setDrill({ title: `Total safety net · ${filterSummary}`, explainer: 'ARC/PLC, crop insurance, and other USDA payments together.', rows: selectCashDetails(allDetails.filter((d) => d.kind === 'arcPlc' || d.kind === 'insurance' || d.kind === 'other'), { kind: 'all', month: null }) }),
    },
    ...(visibleCottonEvents.length > 0
      ? [{ label: 'Cotton cash (net — loans, sales, LDP, fees)', value: fmtUsd(cottonNet), tone: signedTone(cottonNet), onClick: () => openDrill({ kind: 'cotton', month: null }) }]
      : []),
    ...(visibleSeedEvents.length > 0
      ? [{ label: 'Seed contracts (net — base, premiums, storage, fees)', value: fmtUsd(seedNet), tone: signedTone(seedNet), onClick: () => openDrill({ kind: 'seed', month: null }) }]
      : []),
  ]
  const activeFilters = (cropYear !== '' ? 1 : 0) + (cropId ? 1 : 0) + (buyerId ? 1 : 0) + (entityId ? 1 : 0)

  // The chart above the table: money in by month, stacked by kind.
  const barSeries = [
    { key: 'received', label: 'Received', className: toneFill('favorable') },
    { key: 'outstanding', label: 'Outstanding', className: toneFill('warning') },
    { key: 'projected', label: 'Projected', className: toneFill('neutral') },
    { key: 'safety', label: 'Safety net', className: toneFill('muted') },
  ]
  const barRows = monthlyRows.map((r) => ({
    key: r.key,
    label: r.label.replace(/ \d{4}$/, (m) => ` ’${m.slice(-2)}`),
    values: { received: r.received, outstanding: r.outstanding, projected: r.projected, safety: r.arcPlc + r.insurance + r.other },
  }))

  // Export mirrors the on-screen monthly forecast + contract detail tables.
  function buildPayload(): ExportPayload {
    const filters = [
      cropYear === '' ? 'All crop years' : `${cropYear} crop`,
      cropId ? cropById.get(cropId)?.name ?? 'Crop' : 'All crops',
      buyerId ? buyerById.get(buyerId)?.name ?? 'Buyer' : 'All buyers',
      entityName ?? 'All entities',
    ].join(' · ')

    const monthly: ExportPayload['sections'][number] = {
      title: 'Monthly Forecast',
      columns: [
        { label: 'Month' },
        { label: 'Received', align: 'right', format: 'usd0' }, { label: 'Outstanding', align: 'right', format: 'usd0' },
        { label: 'Projected', align: 'right', format: 'usd0' }, { label: 'ARC/PLC', align: 'right', format: 'usd0' },
        { label: 'Crop Insurance', align: 'right', format: 'usd0' }, { label: 'Other Govt', align: 'right', format: 'usd0' },
        { label: 'Cotton (net)', align: 'right', format: 'usd0' }, { label: 'Seed (net)', align: 'right', format: 'usd0' },
        { label: 'Month total', align: 'right', format: 'usd0' }, { label: 'Cumulative', align: 'right', format: 'usd0' },
      ],
      rows: monthlyRows.map((r) => [r.label, r.received, r.outstanding, r.projected, r.arcPlc, r.insurance, r.other, r.cotton, r.seed, r.total, r.cumulative]),
    }

    const cottonDetail: ExportPayload['sections'][number] | null = visibleCottonEvents.length > 0
      ? {
          title: 'Cotton Cash Detail',
          columns: [
            { label: 'Date' }, { label: 'Item' },
            { label: 'Amount', align: 'right', format: 'usd0' }, { label: 'Status' },
          ],
          rows: visibleCottonEvents.map((e) => [e.date, e.label, e.amount, e.status]),
        }
      : null

    const seedDetail: ExportPayload['sections'][number] | null = visibleSeedEvents.length > 0
      ? {
          title: 'Seed Contract Cash Detail',
          columns: [
            { label: 'Month' }, { label: 'Item' },
            { label: 'Amount', align: 'right', format: 'usd0' }, { label: 'Status' },
          ],
          rows: visibleSeedEvents.map((e) => [monthLabel(e.month), e.label, e.amount, e.status]),
        }
      : null

    const detail: ExportPayload['sections'][number] = {
      title: 'Contract Detail',
      columns: [
        { label: 'Contract #' }, { label: 'Buyer' }, { label: 'Crop' }, { label: 'Year', format: 'text' }, { label: 'Window' },
        { label: 'Price/bu', align: 'right', format: 'price' }, { label: 'Contracted', align: 'right', format: 'bu' },
        { label: 'Delivered', align: 'right', format: 'bu' }, { label: 'Remaining', align: 'right', format: 'bu' },
        { label: 'Value', align: 'right', format: 'usd0' }, { label: 'Received', align: 'right', format: 'usd0' },
        { label: 'Outstanding', align: 'right', format: 'usd0' }, { label: 'Projected', align: 'right', format: 'usd0' },
      ],
      rows: visibleContracts.map((c) => {
        const agg = aggByContract.get(c.id)!
        const price = Number(c.price_per_bushel ?? 0)
        const s = shareFor(c)
        const contractedBu = Number(c.contracted_bushels) * s
        const delivered = agg.delivered * s
        const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered) * s
        const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
        const window = (c.delivery_start_date || c.delivery_end_date) ? `${c.delivery_start_date ?? '?'} → ${c.delivery_end_date ?? '?'}` : '—'
        return [
          complete ? `${c.contract_number} (complete)` : c.contract_number ?? '',
          buyerById.get(c.buyer_id ?? '')?.name ?? '', cropById.get(c.crop_id ?? '')?.name ?? '', c.crop_year ?? '', window,
          price || '', contractedBu, delivered, remainingBu,
          contractedBu * price, agg.revenueReceived * s, agg.deliveredUnpaid * price * s, complete ? 0 : remainingBu * price,
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
        { label: 'Projected', value: formatNumber(summary.remaining, 'usd0') },
        { label: 'Total Safety Net', value: formatNumber(safetyTotals.total, 'usd0'), tone: 'favorable' },
      ],
      sections: [monthly, ...(cottonDetail ? [cottonDetail] : []), ...(seedDetail ? [seedDetail] : []), detail],
    }
  }

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Cash Flow Forecast"
        filterSummary={filterSummary}
        actions={!loading && !viewerPending && (monthlyRows.length > 0 || visibleContracts.length > 0) ? <ExportBar buildPayload={buildPayload} /> : undefined}
      />

      <ReportFilterBar activeCount={activeFilters}>
        <FilterField label="Crop year">
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={selectCls}>
            <option value="">All crop years</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </FilterField>
        <FilterField label="Crop">
          <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={selectCls}>
            <option value="">All crops</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Buyer">
          <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className={selectCls}>
            <option value="">All buyers</option>
            {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </FilterField>
        <EntityFilter entities={entityOptionsFor(viewer, entities)} value={entityId} onChange={setEntityId} />
      </ReportFilterBar>

      <SupersededNotice show={viewerA.superseded} onDismiss={viewerA.dismissSuperseded} />

      <SummaryCards cards={summaryCards} />

      {loading || viewerPending ? <p className="text-slate-500">Loading…</p> : (
        <>
          {/* Total Safety Net — crop insurance + government program cash, with timing. */}
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="font-semibold flex-1">Total Safety Net (projected)</h2>
              <label className="text-xs text-slate-500 flex items-center gap-2 no-print">
                Insurance proceeds month
                <select value={insuranceMonth} onChange={(e) => setInsuranceMonth(Number(e.target.value))} className={selectCls}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleDateString(undefined, { month: 'short' })}</option>
                  ))}
                </select>
              </label>
            </div>
            <SummaryCards cards={safetyCards} />
            <p className="text-xs text-slate-500">
              <strong>Estimated</strong> — ARC/PLC for a program year lands in October of the following crop year
              {cropYear !== '' ? <> (shown here: the <strong>{programYearFor(cropYear)} program year</strong> ARC/PLC — paid Oct {cropYear})</> : null},
              crop insurance proceeds in the selected month (default December), other payments on their entered date
              (attributed to the year received). Final amounts are determined by RMA / FSA after harvest and the
              marketing year.
            </p>
          </div>

          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 font-semibold">Monthly forecast</div>
            <p className="px-4 py-2 text-xs text-slate-500 leading-relaxed border-b border-slate-100">
              <span className={`font-semibold ${toneText('favorable')}`}>Received</span> — cash already collected on settled loads, in the settlement&rsquo;s month.{' '}
              <span className={`font-semibold ${toneText('warning')}`}>Outstanding</span> — grain you&rsquo;ve <em>delivered but not yet been paid for</em>, valued at the contract price and shown in the current month as money still owed to you.{' '}
              <span className={`font-semibold ${toneText('neutral')}`}>Projected</span> — contracted bushels <em>not yet delivered</em>, valued at the contract price and spread across the remaining delivery window (future income you still expect). Completed contracts add nothing to Projected.
            </p>
            {monthlyRows.length === 0 ? (
              <EmptyState
                message="No forecast data."
                hint="Cash flow projects from priced contracts and the safety-net programs above."
                linkHref="/contracts"
                linkLabel="Add contracts"
                role={viewer.role}
              />
            ) : (
              <>
                <div className="px-4 pt-3 pb-2 border-b border-slate-100">
                  <MonthlyBars series={barSeries} rows={barRows} />
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm border-collapse">
                    <thead className={theadCls}>
                      <tr>
                        {['Month', 'Received', 'Outstanding', 'Projected', 'ARC/PLC', 'Crop Insurance', 'Other USDA', 'Cotton (net)', 'Seed (net)', 'Month total', 'Cumulative']
                          .map((h, i) => <th key={h} className={`${i === 0 ? `text-left ${stickyColHeadCls}` : 'text-right'} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyRows.map((r) => {
                        // Every non-zero number is a button into its rows.
                        const cell = (kind: CashKind, amount: number, cls: string, dash = false) => (
                          <td className={`${numCell} ${cls}`}>
                            {amount === 0
                              ? (dash ? '—' : fmtUsd(0))
                              : (
                                <button
                                  type="button"
                                  onClick={() => openDrill({ kind, month: r.key })}
                                  className="underline decoration-dotted underline-offset-4 hover:decoration-solid min-h-8 px-1 rounded focus-visible:ring-2 focus-visible:ring-brand"
                                  aria-label={`${CASH_KIND_LABEL[kind]} in ${r.label}: ${fmtUsd(amount)}. Show where it comes from.`}
                                >
                                  {fmtUsd(amount)}
                                </button>
                              )}
                          </td>
                        )
                        return (
                          <tr key={r.key} className="border-t border-slate-100">
                            <td className={`${textCell} ${stickyColCls} font-semibold whitespace-nowrap`}>{r.label}</td>
                            {cell('received', r.received, toneText('favorable'))}
                            {cell('outstanding', r.outstanding, toneText('warning'))}
                            {cell('projected', r.projected, toneText('neutral'))}
                            {cell('arcPlc', r.arcPlc, '')}
                            {cell('insurance', r.insurance, '')}
                            {cell('other', r.other, '')}
                            {cell('cotton', r.cotton, toneText(signedTone(r.cotton)), true)}
                            {cell('seed', r.seed, toneText(signedTone(r.seed)), true)}
                            <td className={numCell}>
                              {r.total === 0 ? fmtUsd(0) : (
                                <button
                                  type="button"
                                  onClick={() => openDrill({ kind: 'all', month: r.key })}
                                  className="underline decoration-dotted underline-offset-4 hover:decoration-solid min-h-8 px-1 rounded focus-visible:ring-2 focus-visible:ring-brand"
                                  aria-label={`Month total for ${r.label}: ${fmtUsd(r.total)}. Show every line.`}
                                >
                                  {fmtUsd(r.total)}
                                </button>
                              )}
                            </td>
                            <td className={`${numCell} font-semibold`}>{fmtUsd(r.cumulative)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 py-2 text-xs text-slate-500 no-print">Tap any amount to see the settlements, contracts, policies, or payments behind it.</p>
              </>
            )}
          </div>

          <AppModal open={drill != null} title={drill?.title ?? ''} onClose={closeDrill} size="lg" initialFocus="none">
            {drill && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">{drill.explainer}</p>
                {drill.rows.length === 0 ? (
                  <p className="text-sm text-slate-500">Nothing lands here under the current filters.</p>
                ) : (
                  <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
                    <table className="min-w-full text-sm">
                      <thead className={theadCls}>
                        <tr>
                          <th className="text-left px-2 py-1 font-semibold">What</th>
                          <th className="text-left px-2 py-1 font-semibold">Month</th>
                          <th className="text-right px-2 py-1 font-semibold">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {drill.rows.map((d, i) => (
                          <tr key={i} className="border-t border-slate-100 align-top">
                            <td className={textCell}>
                              {d.href
                                ? <a href={d.href} className="text-brand-deep underline font-semibold">{d.label}</a>
                                : <span className="font-semibold">{d.label}</span>}
                              {d.sub && <div className="text-xs text-slate-500">{d.sub}</div>}
                            </td>
                            <td className={`${textCell} whitespace-nowrap text-xs`}>
                              {d.month ? monthLabel(d.month) : ''}
                              {d.status && (
                                <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] ${d.status === 'received' ? 'bg-green-100 text-green-800' : d.status === 'outstanding' ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>{d.status}</span>
                              )}
                            </td>
                            <td className={`${numCell} ${toneText(signedTone(d.amount))}`}>{fmtUsd(d.amount)}</td>
                          </tr>
                        ))}
                        <tr className="bg-slate-100 font-bold border-t-2 border-slate-400">
                          <td className={textCell} colSpan={2}>{drill.rows.length} line{drill.rows.length === 1 ? '' : 's'}</td>
                          <td className={numCell}>{fmtUsd(sumCashDetails(drill.rows))}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </AppModal>

          {visibleCottonEvents.length > 0 && (
            <div className="bg-white rounded-xl shadow overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-100 font-semibold">Cotton cash detail</div>
              <p className="px-4 pt-2 text-xs text-slate-500">
                Labeled cotton cash lines: CCC loan proceeds land at loan entry, redemption payoffs (outflows) and
                equity sales at their outcome dates, pool advances/progress on their payment dates, contract proceeds
                at the delivery window, LDP on its date, and fees as outflows. These roll into the Cotton (net) column above.
              </p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      {['Date', 'Item', 'Amount', 'Status'].map((h, i) => (
                        <th key={h} className={`${i === 2 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCottonEvents.map((e, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className={`${textCell} whitespace-nowrap`}>{fmtDate(e.date)}</td>
                        <td className={textCell}>{e.label}</td>
                        <td className={`${numCell} ${toneText(signedTone(e.amount))}`}>{fmtUsd(e.amount)}</td>
                        <td className={textCell}>
                          <span className={`text-xs rounded-full px-2 py-0.5 ${e.status === 'received' ? 'bg-green-100 text-green-800' : 'bg-sky-100 text-sky-800'}`}>{e.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {visibleSeedEvents.length > 0 && (
            <div className="bg-white rounded-xl shadow overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-100 font-semibold">Seed contract cash detail</div>
              <p className="px-4 pt-2 text-xs text-slate-500">
                Labeled seed-contract cash lines: 80% of each priced portion lands in its election month (unpriced
                bushels assumed priced by the deadline), the final 20% plus premiums at the estimated final settlement,
                storage pay monthly, and the usage fee as an outflow. Recorded payments replace the projection for
                their type. These roll into the Seed (net) column above.
              </p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      {['Month', 'Item', 'Amount', 'Status'].map((h, i) => (
                        <th key={h} className={`${i === 2 ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSeedEvents.map((e, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className={`${textCell} whitespace-nowrap`}>{monthLabel(e.month)}</td>
                        <td className={textCell}>{e.label}</td>
                        <td className={`${numCell} ${toneText(signedTone(e.amount))}`}>{fmtUsd(e.amount)}</td>
                        <td className={textCell}>
                          <span className={`text-xs rounded-full px-2 py-0.5 ${e.status === 'received' ? 'bg-green-100 text-green-800' : 'bg-sky-100 text-sky-800'}`}>{e.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 font-semibold">Contract detail</div>
            {visibleContracts.length === 0 ? (
              <EmptyState
                message="No contracts match these filters."
                hint="Try widening the crop year, crop, buyer, or entity filters."
                linkHref="/contracts"
                linkLabel="Add contracts"
                role={viewer.role}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      {['Contract #', 'Buyer', 'Crop', 'Year', 'Window', 'Price/bu', 'Contracted', 'Delivered', 'Remaining', 'Value', 'Received', 'Outstanding', 'Projected']
                        .map((h, i) => <th key={h} className={`${i >= 5 ? 'text-right' : 'text-left'} ${i === 0 ? stickyColHeadCls : ''} px-3 py-2 whitespace-nowrap font-semibold`}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleContracts.map((c) => {
                      const agg = aggByContract.get(c.id)!
                      const price = Number(c.price_per_bushel ?? 0)
                      // Entity share: operation-level contracts show the
                      // entity's pro-rata slice under an entity filter.
                      const s = shareFor(c)
                      const contractedBu = Number(c.contracted_bushels) * s
                      const delivered = agg.delivered * s
                      const value = contractedBu * price
                      const remainingBu = Math.max(0, Number(c.contracted_bushels) - agg.delivered) * s
                      const complete = isContractComplete(c.completed_at, Number(c.contracted_bushels), agg.delivered)
                      // Completed contracts earn nothing more — no unearned revenue
                      // booked, matching the Projected column above.
                      const unearned = complete ? 0 : remainingBu * price
                      const outstanding = agg.deliveredUnpaid * price * s
                      return (
                        <tr key={c.id} className="border-t border-slate-100">
                          <td className={`${textCell} ${stickyColCls} font-semibold whitespace-nowrap`}>
                            {c.contract_number}
                            {complete && <span className="ml-1.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-medium px-1.5 py-0.5 align-middle">complete</span>}
                            {s < 1 && <span className="ml-1.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-medium px-1.5 py-0.5 align-middle">{Math.round(s * 100)}% share</span>}
                          </td>
                          <td className={textCell}>{buyerById.get(c.buyer_id ?? '')?.name ?? ''}</td>
                          <td className={textCell}>{cropById.get(c.crop_id ?? '')?.name ?? ''}</td>
                          <td className={textCell}>{c.crop_year ?? ''}</td>
                          <td className={`${textCell} text-xs whitespace-nowrap`}>
                            {(c.delivery_start_date || c.delivery_end_date)
                              ? <>{fmtDate(c.delivery_start_date) || '?'} → {fmtDate(c.delivery_end_date) || '?'}</>
                              : <span className="text-slate-400">—</span>}
                          </td>
                          <td className={numCell}>{price ? fmtUsd(price, 2) : ''}</td>
                          <td className={numCell}>{fmtInt(contractedBu)}</td>
                          <td className={numCell}>{fmtInt(delivered)}</td>
                          <td className={numCell}>{fmtInt(remainingBu)}</td>
                          <td className={numCell}>{fmtUsd(value)}</td>
                          <td className={`${numCell} ${toneText('favorable')}`}>{fmtUsd(agg.revenueReceived * s)}</td>
                          <td className={`${numCell} ${toneText('warning')}`}>{fmtUsd(outstanding)}</td>
                          <td className={numCell}>{fmtUsd(unearned)}</td>
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
