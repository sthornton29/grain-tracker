import Link from 'next/link'
import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import ContractFilterPersistence from '@/components/contract-filter-persistence'
import {
  CONTRACT_FILTER_COOKIE, CONTRACTS_ALL_HREF, activeContractFilterCount, hasAnyContractFilterParam,
  parseContractFilters, savedContractFilters, serializeContractFilters,
} from '@/lib/contract-filters'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { buildDoubleCropSet, cropYearOptionsFromPlantings } from '@/lib/plantings'
import { buildEntityScope } from '@/lib/entity-scope'
import { expectedProductionFromBreakout, isCottonCrop, segmentAcresByCrop } from '@/lib/marketing'
import { contractPosition } from '@/lib/contract-position'
import { fmtDate } from '@/lib/format-date'
import ContractFlagIcon, { CONTRACT_FLAG_LABEL, type ContractFlag } from '@/components/contract-flag'
import StaticExportBar from '@/components/static-export-bar'
import {
  SummaryCards, StackedBar, EmptyState,
  theadCls, stickyColCls, stickyColHeadCls, grandTotalRowCls,
  fmtInt, fmtUsd, fmtPct, fmtNum,
} from '@/components/reports/report-kit'
import type { ExportPayload } from '@/lib/exports'
import { CONTRACT_TYPE_LABEL, effectiveContractType, type ContractType, type PricingStatus } from '@/lib/contracts'
import { parseContractMonth } from '@/lib/hedging'
import { blendedElectedPrice, cumulativePricedPct, effectivePriceWalk, missingPremiumRows } from '@/lib/seed-contracts'
import type { SeedContractDetails, SeedContractPayment, SeedContractPremium, SeedPricingElection } from '@/lib/seed-contracts'
import type { CropAssumption } from '@/lib/types'
import ContractFilters from './contract-filters'
import LinkRow from './link-row'

export const dynamic = 'force-dynamic'

type ContractRow = {
  id: string
  contract_number: string
  contracted_bushels: number
  price_per_bushel: number | null
  notes: string | null
  crop_year: number | null
  delivery_type: 'pickup' | 'delivered'
  delivery_start_date: string | null
  delivery_end_date: string | null
  date_sold: string | null
  completed_at: string | null
  buyer_id: string | null
  crop_id: string | null
  entity_id: string | null
  contract_month: string | null
  contract_type: ContractType
  contract_kind: 'grain' | 'seed_production' | null
  pricing_status: PricingStatus
  futures_price: number | null
  basis: number | null
  cash_price: number | null
  buyer: { name: string } | null
  crop: { name: string } | null
  delivery_location: { name: string } | null
}

function isSeedKind(c: Pick<ContractRow, 'contract_kind'>): boolean {
  return c.contract_kind === 'seed_production'
}

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
  to_type: string | null
}

type CropRow = {
  id: string
  name: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
  harvest_category: 'fall' | 'spring'
  double_crop: boolean | null
}

type SettlementLineRow = {
  load_id: string | null
  ticket_number: string | null
  net_bushels: number
  net_revenue: number | null
}

type FieldRow = { id: string; farm_id: string | null }
type FarmRow = { id: string; entity_id: string | null }
type EntityRow = { id: string; name: string; entity_role: string | null }
type PlantingRow = {
  id: string; field_id: string; crop_id: string; season_year: number
  planted_acres: number | null; irrigated_acres: number | null; dryland_acres: number | null
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

// A delivery window as "9/1/2026 → 10/31/2026" (a missing end reads "open").
function windowLabel(start: string | null, end: string | null): string {
  if (!start && !end) return '—'
  return `${start ? fmtDate(start) : 'open'} → ${end ? fmtDate(end) : 'open'}`
}

// Days until a contract month's first notice day, approximated as the last
// calendar day of the month before the delivery month (CBOT grain convention).
// Negative = already passed. null when the month can't be parsed.
function daysUntilFirstNotice(contractMonth: string | null): number | null {
  const p = parseContractMonth(contractMonth)
  if (!p) return null
  const fnd = new Date(p.year4, p.monthNum - 1, 0)
  fnd.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((fnd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

// Paginated fetch of every load (lib/fetch-all-rows — cap-agnostic
// termination, so a lowered db-max-rows can never silently truncate it).
async function fetchAllContractLoads(supabase: SupabaseClient): Promise<LoadRow[]> {
  const { data, error } = await fetchAllRows<LoadRow>((f, t) =>
    supabase
      .from('loads')
      .select('id, contract_id, ticket_number, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, to_type')
      .order('id', { ascending: true })
      .range(f, t),
  )
  if (error) throw new Error(error.message)
  return data
}

function isFuture(start: string | null): boolean {
  if (!start) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today < new Date(start + 'T00:00:00')
}

const cellCls = 'px-3 py-2'
const numCls = 'px-3 py-2 text-right tabular-nums whitespace-nowrap'

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  // A bare /contracts (nav link, bookmark) restores the remembered filters
  // BEFORE anything renders — the cookie is written by the filter bar and
  // cleared by it before it ever navigates to a bare URL on purpose (see
  // lib/contract-filters). So the list never shows one thing and then flips.
  if (!hasAnyContractFilterParam(searchParams)) {
    const saved = savedContractFilters(cookies().get(CONTRACT_FILTER_COOKIE)?.value)
    if (saved) redirect(`/contracts?${saved}`)
  }

  const supabase = createClient()
  const filters = parseContractFilters(searchParams)
  const entityId = filters.entity
  const cropFilter = filters.crop
  const typeFilter = filters.type
  const pricingFilter = filters.pricing
  const cropYear = filters.crop_year ? Number(filters.crop_year) : null
  const sortKey = filters.sort
  const sortDir = filters.dir
  const hideCompleted = filters.hide_completed
  const hideFuture = filters.hide_future

  const [contractsRes, loads, cropsRes, fieldsRes, farmsRes, entitiesRes, linesRes, plantingsRes] = await Promise.all([
    fetchAllRows((f, t) => supabase
      .from('contracts')
      .select(`
        id, contract_number, contracted_bushels, price_per_bushel, notes,
        crop_year, delivery_type, delivery_start_date, delivery_end_date, date_sold, completed_at,
        buyer_id, crop_id, entity_id,
        contract_month, contract_type, contract_kind, pricing_status, futures_price, basis, cash_price,
        buyer:buyers(name), crop:crops(name), delivery_location:delivery_locations(name)
      `)
      .order('contract_number')
      .order('id')
      .range(f, t)),
    fetchAllContractLoads(supabase),
    supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel, harvest_category, double_crop').order('name'),
    supabase.from('fields').select('id, farm_id'),
    supabase.from('farms').select('id, entity_id'),
    supabase.from('entities').select('id, name, entity_role').order('name'),
    fetchAllRows((f, t) => supabase.from('settlement_lines').select('load_id, ticket_number, net_bushels, net_revenue').order('id').range(f, t)),
    fetchAllRows((f, t) => supabase.from('field_plantings').select('season_year').order('id').range(f, t)),
  ])

  const allContracts = (contractsRes.data as unknown as ContractRow[]) ?? []
  const crops = (cropsRes.data ?? []) as CropRow[]
  const fields = (fieldsRes.data ?? []) as FieldRow[]
  const farms = (farmsRes.data ?? []) as FarmRow[]
  const entities = (entitiesRes.data ?? []) as EntityRow[]
  const lines = (linesRes.data ?? []) as SettlementLineRow[]

  const cropById = new Map(crops.map((c) => [c.id, c]))
  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const fieldEntity = new Map(fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null]))

  // Build maps:
  //   loadIdToLine:     load_id    -> line (paid lookup by load_id)
  //   ticketToLine:     ticket#    -> line (paid lookup by ticket, for loads whose line was added later)
  const loadIdToLine = new Map<string, SettlementLineRow>()
  const ticketToLine = new Map<string, SettlementLineRow>()
  for (const l of lines) {
    if (l.load_id) loadIdToLine.set(l.load_id, l)
    if (l.ticket_number) ticketToLine.set(l.ticket_number.trim().toLowerCase(), l)
  }

  function lineForLoad(load: LoadRow): SettlementLineRow | null {
    if (loadIdToLine.has(load.id)) return loadIdToLine.get(load.id)!
    const t = load.ticket_number?.trim().toLowerCase()
    if (t && ticketToLine.has(t)) return ticketToLine.get(t)!
    return null
  }

  const plantingYears = ((plantingsRes.data ?? []) as Array<{ season_year: number | null }>).map((p) => p.season_year)
  const cropYearOptions = cropYearOptionsFromPlantings(plantingYears, cropYear)

  // Seed production contracts (077): pricing elections + staged payments drive
  // their progress semantics (% priced, complete on the received final
  // payment) instead of delivered-vs-contracted.
  const seedIds = allContracts.filter(isSeedKind).map((c) => c.id)
  const seedDetailsBy = new Map<string, SeedContractDetails>()
  const seedElectionsBy = new Map<string, SeedPricingElection[]>()
  const seedPremiumsBy = new Map<string, SeedContractPremium[]>()
  const seedPaymentsBy = new Map<string, SeedContractPayment[]>()
  if (seedIds.length > 0) {
    const [dQ, eQ, prQ, pQ] = await Promise.all([
      supabase.from('seed_contract_details').select('*').in('contract_id', seedIds),
      supabase.from('seed_pricing_elections').select('*').in('contract_id', seedIds).order('election_date'),
      supabase.from('seed_contract_premiums').select('*').in('contract_id', seedIds).order('sort_order'),
      supabase.from('seed_contract_payments').select('*').in('contract_id', seedIds),
    ])
    for (const d of ((dQ.data ?? []) as SeedContractDetails[])) seedDetailsBy.set(d.contract_id, d)
    for (const e of ((eQ.data ?? []) as SeedPricingElection[])) {
      const arr = seedElectionsBy.get(e.contract_id) ?? []
      arr.push(e); seedElectionsBy.set(e.contract_id, arr)
    }
    for (const p of ((prQ.data ?? []) as SeedContractPremium[])) {
      const arr = seedPremiumsBy.get(p.contract_id!) ?? []
      arr.push(p); seedPremiumsBy.set(p.contract_id!, arr)
    }
    for (const p of ((pQ.data ?? []) as SeedContractPayment[])) {
      const arr = seedPaymentsBy.get(p.contract_id) ?? []
      arr.push(p); seedPaymentsBy.set(p.contract_id, arr)
    }
  }

  function loadDryBu(l: LoadRow): number {
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

  type Agg = {
    delivered: number
    paidBushels: number
    revenue: number
    deliveredUnpaid: number
    entityIds: Set<string>
    loadCount: number
  }
  const aggByContract = new Map<string, Agg>()
  function ensure(id: string): Agg {
    let a = aggByContract.get(id)
    if (!a) { a = { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set(), loadCount: 0 }; aggByContract.set(id, a) }
    return a
  }
  // Two kinds of loads whose bushels can't be counted against a contract here:
  // loads still pointing at a contract that has since been deleted, and loads
  // delivered to a buyer with no contract picked at all. Both notices respect
  // the crop year / crop / entity filters, so the counts describe the same
  // slice of the operation the table does.
  const knownContractIds = new Set(allContracts.map((c) => c.id))
  const loadInFilters = (load: LoadRow): boolean => {
    if (cropYear != null && load.crop_year != null && load.crop_year !== cropYear) return false
    if (cropFilter && load.crop_id !== cropFilter) return false
    if (entityId) {
      const ent = load.from_field_id ? fieldEntity.get(load.from_field_id) ?? null : null
      if (ent !== entityId) return false
    }
    return true
  }
  let orphanLoadCount = 0
  let noContractBuyerLoads = 0
  for (const load of loads) {
    if (!load.contract_id) {
      if (load.to_type === 'buyer' && loadInFilters(load)) noContractBuyerLoads++
      continue
    }
    if (!knownContractIds.has(load.contract_id)) { if (loadInFilters(load)) orphanLoadCount++; continue }
    const agg = ensure(load.contract_id)
    agg.loadCount++
    const bu = loadDryBu(load)
    agg.delivered += bu
    const line = lineForLoad(load)
    if (line) {
      agg.paidBushels += Number(line.net_bushels ?? 0)
      agg.revenue += Number(line.net_revenue ?? 0)
    } else {
      agg.deliveredUnpaid += bu
    }
    if (load.from_type === 'field' && load.from_field_id) {
      const ent = fieldEntity.get(load.from_field_id) ?? null
      if (ent) agg.entityIds.add(ent)
    }
  }

  // contract_number has no unique constraint, so detect dupes and tell them
  // apart on screen by buyer · crop · date sold (otherwise two rows look
  // identical and the user can't tell which one their loads are attached to).
  const numberCounts = new Map<string, number>()
  for (const c of allContracts) numberCounts.set(c.contract_number, (numberCounts.get(c.contract_number) ?? 0) + 1)

  function flagFor(c: ContractRow): ContractFlag {
    if (c.completed_at != null) return 'complete'
    if (isSeedKind(c)) {
      // A seed contract is done when the final base payment has been received
      // (delivered bushels don't close it — settlement does).
      const pays = seedPaymentsBy.get(c.id) ?? []
      if (pays.some((p) => p.payment_type === 'base_final' && p.status === 'received')) return 'complete'
      if (isFuture(c.delivery_start_date)) return 'future'
      return 'open'
    }
    const agg = aggByContract.get(c.id)
    const delivered = agg?.delivered ?? 0
    if (delivered >= Number(c.contracted_bushels) && Number(c.contracted_bushels) > 0) return 'complete'
    if (isFuture(c.delivery_start_date)) return 'future'
    return 'open'
  }

  // Every filter but the two "show" toggles. The toggles are applied after,
  // separately, so the notice below can say how many the toggles hid.
  const passesNarrowing = (c: ContractRow): boolean => {
    if (cropYear != null && c.crop_year !== cropYear) return false
    if (cropFilter && c.crop_id !== cropFilter) return false
    // Strict entity match: only contracts whose own entity_id matches show up.
    // Contracts with no entity_id are excluded under an entity filter so loads
    // delivered against a different entity's contract can't smuggle this one in.
    if (entityId && c.entity_id !== entityId) return false
    if (typeFilter && (isSeedKind(c) ? typeFilter !== 'seed' : effectiveContractType(c) !== typeFilter)) return false
    if (pricingFilter && c.pricing_status !== pricingFilter) return false
    return true
  }
  let hiddenCompleted = 0
  let hiddenFuture = 0
  const visible = allContracts.filter((c) => {
    if (!passesNarrowing(c)) return false
    const flag = flagFor(c)
    if (hideCompleted && flag === 'complete') { hiddenCompleted++; return false }
    if (hideFuture && flag === 'future') { hiddenFuture++; return false }
    return true
  })
  // Under an entity filter, contracts written with no entity (operation-level)
  // are left out on purpose — say so, with the count, instead of a table that
  // looks mysteriously short.
  const operationLevelHidden = entityId
    ? allContracts.filter((c) => !c.entity_id && passesNarrowing({ ...c, entity_id: entityId })).length
    : 0

  if (sortKey === 'crop') {
    const m = sortDir === 'asc' ? 1 : -1
    visible.sort((a, b) => {
      const ac = a.crop?.name ?? ''
      const bc = b.crop?.name ?? ''
      const byCrop = m * ac.localeCompare(bc)
      return byCrop !== 0 ? byCrop : a.contract_number.localeCompare(b.contract_number)
    })
  }

  function sortHref(col: string) {
    const nextDir = sortKey === col && sortDir === 'asc' ? 'desc' : 'asc'
    return `?${serializeContractFilters({ ...filters, sort: col, dir: nextDir })}`
  }

  // First-notice-day warning: HTAs awaiting basis / basis contracts awaiting
  // futures whose contract month's first notice day is within 30 days (or past).
  // Computed over all contracts so a filter can't hide a looming deadline — but
  // skip completed contracts (marked complete or fully delivered): there's nothing
  // left to price on a finished contract, so the deadline no longer applies.
  const fndWarnings = allContracts
    .filter((c) => c.pricing_status === 'awaiting_basis' || c.pricing_status === 'awaiting_futures')
    .filter((c) => flagFor(c) !== 'complete')
    .map((c) => ({ c, days: daysUntilFirstNotice(c.contract_month) }))
    .filter((x): x is { c: ContractRow; days: number } => x.days != null && x.days <= 30)
    .sort((a, b) => a.days - b.days)

  // Seed-row display facts: committed bushels (contract estimate), % priced
  // from the elections ledger, the blended elected price, and — when fully
  // priced — the expected settlement revenue (elected + premiums − usage fee;
  // premiums valued conservatively without the irrigated share, which needs
  // the linked plantings the Marketing dashboard has).
  function seedRowInfo(c: ContractRow): {
    committedBu: number
    pricedPct: number
    electedPrice: number | null
    expectedRevenue: number | null
    /** The selected expected outcome has no premium rows: the projection is
     *  base-only — a data gap the row flags, never a silent $0 premium. */
    missingPremiums: boolean
  } {
    const details = seedDetailsBy.get(c.id) ?? null
    const elections = seedElectionsBy.get(c.id) ?? []
    const premiums = seedPremiumsBy.get(c.id) ?? []
    const committedBu = details != null ? Number(details.estimated_bushels) : Number(c.contracted_bushels)
    const pricedPct = Math.min(100, cumulativePricedPct(elections))
    const electedPrice = blendedElectedPrice(elections)
    let expectedRevenue: number | null = null
    if (details) {
      const walk = effectivePriceWalk({ details, premiums, elections, referencePlusBasis: null, irrigatedShare: 0 })
      if (walk.expectedNetPerBu != null) expectedRevenue = walk.expectedNetPerBu * committedBu
    }
    const missingPremiums = details != null && missingPremiumRows(premiums, details.expected_outcome)
    return { committedBu, pricedPct, electedPrice, expectedRevenue, missingPremiums }
  }

  // One row model for the table, the totals, the cards and the export.
  type RowFacts = {
    c: ContractRow
    seed: ReturnType<typeof seedRowInfo> | null
    agg: Agg
    contracted: number
    delivered: number
    remaining: number
    pct: number
    price: number | null
    value: number | null
    paidBu: number
    unpaidBu: number
    unpaidDollars: number | null
    flag: ContractFlag
  }
  const rows: RowFacts[] = visible.map((c) => {
    const agg = aggByContract.get(c.id) ?? { delivered: 0, paidBushels: 0, revenue: 0, deliveredUnpaid: 0, entityIds: new Set<string>(), loadCount: 0 }
    const seed = isSeedKind(c) ? seedRowInfo(c) : null
    const contracted = seed ? seed.committedBu : Number(c.contracted_bushels)
    const remaining = Math.max(0, contracted - agg.delivered)
    const pct = seed
      ? seed.pricedPct
      : contracted > 0 ? Math.min(100, (agg.delivered / contracted) * 100) : 0
    const price = seed ? seed.electedPrice : (c.price_per_bushel != null ? Number(c.price_per_bushel) : null)
    const value = seed ? seed.expectedRevenue : price != null ? price * contracted : null
    const unpaidDollars = !seed && price != null ? agg.deliveredUnpaid * price : null
    return { c, seed, agg, contracted, delivered: agg.delivered, remaining, pct, price, value, paidBu: agg.paidBushels, unpaidBu: agg.deliveredUnpaid, unpaidDollars, flag: flagFor(c) }
  })

  const totals = rows.reduce(
    (t, r) => ({
      contracted: t.contracted + r.contracted,
      delivered: t.delivered + r.delivered,
      remaining: t.remaining + r.remaining,
      value: t.value + (r.value ?? 0),
      paidBu: t.paidBu + r.paidBu,
      unpaidBu: t.unpaidBu + r.unpaidBu,
      unpaidDollars: t.unpaidDollars + (r.unpaidDollars ?? 0),
      loads: t.loads + r.agg.loadCount,
      pricedBu: t.pricedBu + ((r.seed ? r.seed.pricedPct >= 100 : r.c.pricing_status === 'fully_priced') ? r.contracted : 0),
    }),
    { contracted: 0, delivered: 0, remaining: 0, value: 0, paidBu: 0, unpaidBu: 0, unpaidDollars: 0, loads: 0, pricedBu: 0 },
  )
  const pricedPct = totals.contracted > 0 ? (totals.pricedBu / totals.contracted) * 100 : null

  // Sold vs unsold needs a crop year: expected production from that year's
  // plantings and expected yields (the Marketing dashboard's math), narrowed
  // to the entity's fields through lib/entity-scope.
  let productionBu: number | null = null
  let productionNote: string | null = null
  if (cropYear != null) {
    const [plQ, asQ] = await Promise.all([
      fetchAllRows<PlantingRow>((f, t) => supabase
        .from('field_plantings')
        .select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres')
        .eq('season_year', cropYear)
        .order('id')
        .range(f, t)),
      supabase.from('crop_assumptions').select('*').eq('crop_year', cropYear),
    ])
    const scope = buildEntityScope({ entityId, farms, fields, entities })
    const scoped = scope.plantings(plQ.data ?? [])
    const cropMeta = new Map(crops.map((c) => [c.id, { harvest_category: c.harvest_category, double_crop: c.double_crop ?? false }]))
    const doubleCropIds = buildDoubleCropSet(scoped, cropMeta)
    const seg = segmentAcresByCrop(scoped, cropYear, doubleCropIds)
    const prodByCrop = expectedProductionFromBreakout(seg, (asQ.data ?? []) as CropAssumption[], cropYear, { assumedAcres: false })
    if (cropFilter) {
      productionBu = prodByCrop.get(cropFilter) ?? null
      if (productionBu == null) productionNote = `Enter an expected yield for ${cropById.get(cropFilter)?.name ?? 'this crop'} on the Marketing page to see sold vs unsold.`
    } else {
      let sum = 0
      let any = false
      for (const [cropId, bu] of prodByCrop) {
        if (isCottonCrop(cropById.get(cropId)?.name)) continue
        sum += bu; any = true
      }
      productionBu = any ? sum : null
      if (!any) productionNote = `Enter expected yields for ${cropYear} on the Marketing page to see sold vs unsold.`
    }
  }
  const position = cropYear != null
    ? contractPosition(rows.map((r) => ({ bushels: r.contracted, pricingStatus: r.c.pricing_status, isSeed: r.seed != null })), productionBu)
    : null

  const filterSummary = [
    entityId ? entities.find((e) => e.id === entityId)?.name ?? 'Entity' : 'All entities',
    cropFilter ? crops.find((c) => c.id === cropFilter)?.name ?? 'Crop' : 'All crops',
    cropYear ? `${cropYear} crop` : 'All crop years',
    typeFilter ? (typeFilter === 'seed' ? 'Seed' : CONTRACT_TYPE_LABEL[typeFilter as ContractType]) : null,
    pricingFilter ? pricingFilter.replace(/_/g, ' ') : null,
    hideCompleted ? 'completed hidden' : null,
    hideFuture ? 'not-open-yet hidden' : null,
  ].filter(Boolean).join(' · ')

  // Formatted PDF/Excel of the visible contracts (mirrors the table; payload is
  // plain data handed to the client StaticExportBar).
  const contractsExportPayload: ExportPayload = {
    title: 'Contract Tracker',
    filters: filterSummary,
    summary: [
      { label: 'Contracted', value: `${fmtInt(totals.contracted)} bu` },
      { label: 'Delivered', value: `${fmtInt(totals.delivered)} bu` },
      { label: 'Remaining', value: `${fmtInt(totals.remaining)} bu` },
      { label: 'Delivered but unpaid', value: `${fmtInt(totals.unpaidBu)} bu` },
    ],
    sections: [{
      columns: [
        { label: 'Contract #' }, { label: 'Buyer' }, { label: 'Crop' }, { label: 'Type' }, { label: 'Crop year', format: 'text' },
        { label: 'Date sold' }, { label: 'Delivery' }, { label: 'Delivery window' },
        { label: 'Contracted', align: 'right', format: 'bu' }, { label: 'Delivered', align: 'right', format: 'bu' }, { label: 'Remaining', align: 'right', format: 'bu' },
        { label: 'Progress %', align: 'right', format: 'pct1' }, { label: '$/bu', align: 'right', format: 'price' },
        { label: 'Contract value', align: 'right', format: 'usd0' }, { label: 'Paid bu', align: 'right', format: 'bu' }, { label: 'Unpaid bu', align: 'right', format: 'bu' },
        { label: 'Unpaid $', align: 'right', format: 'usd0' },
      ],
      rows: [
        ...rows.map((r) => {
          const c = r.c
          const location = c.delivery_type === 'delivered' ? `Delivered to ${c.delivery_location?.name ?? '—'}` : 'Pickup'
          const typeLabel = r.seed ? (r.seed.missingPremiums ? 'Seed (no premiums)' : 'Seed') : CONTRACT_TYPE_LABEL[effectiveContractType(c)]
          return [
            c.contract_number, c.buyer?.name ?? '', c.crop?.name ?? '', typeLabel, c.crop_year ?? '',
            c.date_sold ? fmtDate(c.date_sold) : '', location, windowLabel(c.delivery_start_date, c.delivery_end_date),
            r.contracted, r.delivered, r.remaining, r.pct, r.price ?? '', r.value ?? '', r.paidBu, r.unpaidBu, r.unpaidDollars ?? '',
          ]
        }),
        ['Totals', '', '', '', '', '', '', '', totals.contracted, totals.delivered, totals.remaining, '', '', totals.value, totals.paidBu, totals.unpaidBu, totals.unpaidDollars],
      ],
      rowMeta: [...rows.map(() => 'data' as const), 'total'],
    }],
  }

  const anyFilters = activeContractFilterCount(filters) > 0

  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <ContractFilterPersistence />
      </Suspense>
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold">Contract Tracker</h1>
          <p className="text-sm text-slate-500">{filterSummary}</p>
        </div>
        {rows.length > 0 && <StaticExportBar payload={contractsExportPayload} />}
        {/* Grain contracts are 95%+ of volume: the primary button goes straight
            to the grain form. Seed contracts live behind the caret. */}
        <div className="inline-flex items-stretch rounded-lg bg-brand text-white text-sm font-semibold shadow-sm">
          <Link
            href="/contracts/new"
            className="rounded-l-lg px-3 min-h-10 inline-flex items-center hover:bg-brand-deep"
          >
            New Contract
          </Link>
          <details className="relative">
            <summary
              aria-label="More contract types"
              className="list-none cursor-pointer select-none h-full flex items-center rounded-r-lg border-l border-white/30 px-3 hover:bg-brand-deep"
            >
              ▾
            </summary>
            <div className="absolute right-0 z-10 mt-1 w-64 rounded-lg border border-slate-200 bg-white shadow-lg py-1 font-normal text-slate-700">
              <Link href="/contracts/seed/new" className="block px-3 py-2 text-sm hover:bg-slate-50">
                Seed contract
                <span className="block text-xs text-slate-400">Acreage-based seed production</span>
              </Link>
              <Link href="/settings/contracts" className="block px-3 py-2 text-sm hover:bg-slate-50">
                Several at once
                <span className="block text-xs text-slate-400">From a spreadsheet or a contract document</span>
              </Link>
            </div>
          </details>
        </div>
      </div>

      <ContractFilters
        values={filters}
        entities={entities}
        crops={crops}
        cropYearOptions={cropYearOptions}
      />

      <p className="text-sm text-slate-500 flex items-center gap-3 flex-wrap">
        {(['open', 'complete', 'future'] as ContractFlag[]).map((v) => (
          <span key={v} className="flex items-center"><ContractFlagIcon variant={v} /> {CONTRACT_FLAG_LABEL[v].toLowerCase()}</span>
        ))}
        {(hiddenCompleted > 0 || hiddenFuture > 0 || operationLevelHidden > 0) && (
          <span className="text-slate-600">
            Not shown:{' '}
            {[
              hiddenCompleted > 0 ? `${fmtInt(hiddenCompleted)} completed` : null,
              hiddenFuture > 0 ? `${fmtInt(hiddenFuture)} not open yet` : null,
              operationLevelHidden > 0 ? `${fmtInt(operationLevelHidden)} with no entity (an entity filter shows only contracts written in that entity's name)` : null,
            ].filter(Boolean).join(' · ')}
          </span>
        )}
      </p>

      {noContractBuyerLoads > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>{fmtInt(noContractBuyerLoads)}</strong> load{noContractBuyerLoads === 1 ? '' : 's'} went to a buyer with no contract picked, so {noContractBuyerLoads === 1 ? 'its' : 'their'} bushels don&rsquo;t count against any contract here.{' '}
          <Link href="/loads" className="underline font-semibold">Open Loads</Link> to attach {noContractBuyerLoads === 1 ? 'it' : 'them'}.
        </div>
      )}

      {orphanLoadCount > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>{fmtInt(orphanLoadCount)}</strong> load{orphanLoadCount === 1 ? '' : 's'} point{orphanLoadCount === 1 ? 's' : ''} at a contract that has since been deleted, so {orphanLoadCount === 1 ? 'its' : 'their'} bushels can&rsquo;t be totaled here.{' '}
          <Link href="/loads" className="underline font-semibold">Open Loads</Link> to pick the right contract, or contact support.
        </div>
      )}

      {fndWarnings.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 space-y-1">
          <div className="font-semibold">
            {fndWarnings.length} contract{fndWarnings.length === 1 ? '' : 's'} approaching first notice day without pricing set:
          </div>
          <ul className="list-disc pl-5 space-y-0.5">
            {fndWarnings.map(({ c, days }) => (
              <li key={c.id}>
                <Link href={`/contracts/${c.id}`} className="underline font-semibold">#{c.contract_number}</Link>
                {' '}({CONTRACT_TYPE_LABEL[effectiveContractType(c)]} {c.contract_month}) — needs{' '}
                {c.pricing_status === 'awaiting_basis' ? 'basis' : 'futures'} set ·{' '}
                first notice {days < 0 ? `${-days} days ago` : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <SummaryCards cards={[
          { label: 'Contracted', value: `${fmtInt(totals.contracted)} bu`, sub: `${rows.length} contract${rows.length === 1 ? '' : 's'}` },
          { label: 'Delivered', value: `${fmtInt(totals.delivered)} bu`, sub: `${fmtInt(totals.loads)} load${totals.loads === 1 ? '' : 's'}`, tone: 'favorable' },
          { label: 'Remaining to deliver', value: `${fmtInt(totals.remaining)} bu`, tone: totals.remaining > 0 ? 'neutral' : 'muted' },
          { label: 'Delivered but unpaid', value: `${fmtInt(totals.unpaidBu)} bu`, sub: totals.unpaidDollars > 0 ? `about ${fmtUsd(totals.unpaidDollars)} at contract price` : 'nothing waiting on a settlement', tone: totals.unpaidBu > 0 ? 'warning' : 'muted' },
          { label: 'Fully priced', value: pricedPct != null ? fmtPct(pricedPct) : '—', sub: `${fmtInt(totals.pricedBu)} of ${fmtInt(totals.contracted)} bu`, tone: pricedPct != null && pricedPct >= 100 ? 'favorable' : 'neutral' },
        ]} />
      )}

      {position && rows.length > 0 && (
        <div className="bg-white rounded-xl shadow p-4 space-y-2">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="font-semibold">Sold vs unsold · {cropYear} crop{cropFilter ? ` · ${cropById.get(cropFilter)?.name ?? ''}` : ''}</h2>
            {position.productionBu != null && (
              <span className="text-xs text-slate-500">
                {fmtInt(position.productionBu)} bu expected production · {fmtPct(position.contractedPct)} under contract
              </span>
            )}
          </div>
          {position.productionBu != null ? (
            <>
              <StackedBar segments={[
                { value: position.soldBu, className: 'bg-green-600', label: `Sold ${fmtInt(position.soldBu)}` },
                { value: position.openPricedBu, className: 'bg-amber-500', label: `Priced open ${fmtInt(position.openPricedBu)}` },
                { value: position.unsoldBu ?? 0, className: 'bg-slate-400', label: `Unsold ${fmtInt(position.unsoldBu)}` },
              ]} height="h-6" />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-600 mr-1 align-middle" />Sold (fully priced or seed): <b>{fmtInt(position.soldBu)} bu</b></span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500 mr-1 align-middle" />Contracted, pricing still open: <b>{fmtInt(position.openPricedBu)} bu</b></span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-400 mr-1 align-middle" />Unsold: <b>{fmtInt(position.unsoldBu)} bu</b></span>
                {position.overContractedBu > 0 && <span className="text-amber-700 font-semibold">Contracted {fmtInt(position.overContractedBu)} bu more than expected production.</span>}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">
              Sold so far: <b>{fmtInt(position.soldBu)} bu</b> fully priced, <b>{fmtInt(position.openPricedBu)} bu</b> with pricing open.{' '}
              {productionNote ?? ''} <Link href="/reports/marketing" className="text-brand-deep underline">Marketing</Link>
            </p>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          message={anyFilters ? 'No contracts match these filters.' : 'No contracts yet.'}
          hint={anyFilters ? 'Try clearing a filter.' : 'Add your first grain contract to start tracking deliveries and payments.'}
          linkHref={anyFilters ? CONTRACTS_ALL_HREF : '/contracts/new'}
          linkLabel={anyFilters ? 'Clear filters' : 'New contract'}
        />
      ) : (
        <div className="overflow-x-auto bg-white rounded-xl shadow">
          <table className="min-w-full text-sm border-collapse">
            <thead className={theadCls}>
              <tr>
                <th className={`${stickyColHeadCls} text-left ${cellCls} whitespace-nowrap`}>Contract #</th>
                <th className={`text-left ${cellCls} whitespace-nowrap`}>Buyer</th>
                <th className={`text-left ${cellCls} whitespace-nowrap`}>
                  <Link href={sortHref('crop')} className="hover:text-slate-900 select-none" scroll={false}>
                    Crop{sortKey === 'crop' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </Link>
                </th>
                {['Type', 'Crop year', 'Date sold', 'Delivery', 'Delivery window'].map((h) => (
                  <th key={h} className={`text-left ${cellCls} whitespace-nowrap`}>{h}</th>
                ))}
                {['Contracted', 'Delivered'].map((h) => (
                  <th key={h} className={`text-right ${cellCls} whitespace-nowrap`}>{h}</th>
                ))}
                <th className={`text-left ${cellCls} whitespace-nowrap`}>Progress</th>
                {['$/bu', 'Contract value', 'Paid bu', 'Unpaid bu', 'Unpaid $'].map((h) => (
                  <th key={h} className={`text-right ${cellCls} whitespace-nowrap`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = r.c
                const isDup = (numberCounts.get(c.contract_number) ?? 0) > 1
                const endIn = daysUntil(c.delivery_end_date)
                // Don't flag a closing delivery window on a finished contract.
                const endWarning = r.flag !== 'complete' && endIn != null && endIn >= 0 && endIn <= 14
                const seed = r.seed

                return (
                  <LinkRow key={c.id} href={`/contracts/${c.id}`} className="border-t border-slate-100">
                    <td className={`${stickyColCls} ${cellCls} font-semibold whitespace-nowrap`}>
                      <ContractFlagIcon variant={r.flag} />
                      <Link href={`/contracts/${c.id}`} className="text-brand-deep hover:underline">
                        {c.contract_number}
                      </Link>
                      {isDup && (
                        <span className="block text-[11px] font-normal text-amber-800">
                          same # as another — {[c.buyer?.name, c.crop?.name, c.date_sold ? `sold ${fmtDate(c.date_sold)}` : null].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </td>
                    <td className={cellCls}>{c.buyer?.name ?? ''}</td>
                    <td className={cellCls}>{c.crop?.name ?? ''}</td>
                    <td className={cellCls}>
                      {seed
                        ? (
                          <span className="whitespace-nowrap">
                            <span className="text-xs rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5">Seed</span>
                            {seed.missingPremiums && (
                              <span className="ml-1 text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">no premiums yet</span>
                            )}
                          </span>
                        )
                        : <span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{CONTRACT_TYPE_LABEL[effectiveContractType(c)]}</span>}
                    </td>
                    <td className={cellCls}>{c.crop_year ?? ''}</td>
                    <td className={`${cellCls} whitespace-nowrap`}>
                      {c.date_sold ? fmtDate(c.date_sold) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className={cellCls}>
                      {c.delivery_type === 'delivered'
                        ? <>Delivered to {c.delivery_location?.name ?? '—'}</>
                        : 'Pickup'}
                    </td>
                    <td className={`${cellCls} whitespace-nowrap ${endWarning ? 'text-amber-700 font-semibold' : ''}`}>
                      {(c.delivery_start_date || c.delivery_end_date)
                        ? <>{windowLabel(c.delivery_start_date, c.delivery_end_date)}{endWarning ? ` (${endIn} day${endIn === 1 ? '' : 's'} left)` : ''}</>
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className={numCls}>
                      {fmtInt(r.contracted)}
                      {seed && <span className="ml-1 text-xs text-slate-400">(est.)</span>}
                    </td>
                    <td className={numCls}>
                      {fmtInt(r.delivered)}
                      <span className="ml-1 text-xs text-slate-400">({r.agg.loadCount} load{r.agg.loadCount === 1 ? '' : 's'})</span>
                    </td>
                    <td className={`${cellCls} w-44`}>
                      <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                        <div className={`h-2 ${seed ? 'bg-emerald-500' : 'bg-green-600'}`} style={{ width: `${r.pct}%` }} />
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 whitespace-nowrap">
                        {seed ? `${r.pct.toFixed(0)}% priced` : `${r.pct.toFixed(0)}% delivered · ${fmtInt(r.remaining)} bu left`}
                      </div>
                    </td>
                    <td className={numCls}>
                      {seed
                        ? (r.price != null
                            ? <span>{fmtUsd(r.price, 2)}{seed.pricedPct < 100 && <span className="ml-1 text-[10px] rounded bg-amber-100 text-amber-800 px-1">{100 - seed.pricedPct}% unpriced</span>}</span>
                            : <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">unpriced</span>)
                        : c.pricing_status === 'fully_priced'
                        ? (c.cash_price != null ? fmtUsd(Number(c.cash_price), 2) : '')
                        : c.pricing_status === 'awaiting_basis'
                        ? <span>Futures {fmtUsd(Number(c.futures_price ?? 0), 2)} <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">basis open</span></span>
                        : <span>Basis {fmtNum(Number(c.basis ?? 0), 2)} <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">futures open</span></span>}
                    </td>
                    <td className={numCls}>{r.value != null ? fmtUsd(r.value) : ''}</td>
                    <td className={numCls}>{fmtInt(r.paidBu)}</td>
                    <td className={`${numCls} ${r.unpaidBu > 0 ? 'text-amber-700 font-semibold' : ''}`}>{fmtInt(r.unpaidBu)}</td>
                    <td className={`${numCls} ${r.unpaidBu > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{r.unpaidDollars != null && r.unpaidBu > 0 ? fmtUsd(r.unpaidDollars) : ''}</td>
                  </LinkRow>
                )
              })}
              <tr className={grandTotalRowCls}>
                <td className={`${stickyColCls} ${cellCls} bg-slate-100`}>Totals</td>
                <td className={cellCls} colSpan={7}>{rows.length} contract{rows.length === 1 ? '' : 's'}</td>
                <td className={numCls}>{fmtInt(totals.contracted)}</td>
                <td className={numCls}>{fmtInt(totals.delivered)}</td>
                <td className={`${cellCls} text-xs font-normal text-slate-600 whitespace-nowrap`}>{fmtInt(totals.remaining)} bu left</td>
                <td className={numCls} />
                <td className={numCls}>{fmtUsd(totals.value)}</td>
                <td className={numCls}>{fmtInt(totals.paidBu)}</td>
                <td className={numCls}>{fmtInt(totals.unpaidBu)}</td>
                <td className={numCls}>{totals.unpaidDollars > 0 ? fmtUsd(totals.unpaidDollars) : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Contract value is price × contracted bushels. Paid bu are the buyer&rsquo;s settled bushels from settlements; Unpaid bu are delivered loads not yet on a settlement, and Unpaid $ is those bushels at the contract price.
        Seed contracts show bushels as an estimate and their progress as the share priced, not delivered.
      </p>
    </div>
  )
}
