// The contracts pages' view of HOW every load was sold (094, 2026-10-13):
// one server helper that reads the loads, their sale rows and the lookups
// the virtual contracts need, and the pure shaping behind the Spot and
// Price-later rows on the tracker. Every page that lists contracts beside
// their deliveries (the tracker, a contract's detail, the spot and price-
// later detail pages, the settings delete guard) goes through here so a
// split load counts each part once and nothing else.
//
// Reads page every growing table through fetchAllRows. A database before 094
// (no load_sales) reads as no sale rows, so loads.contract_id still drives
// delivered bushels (saleAllocations' fallback). settlement_lines' per-line
// sale columns (contract_id / sale_type, also 094) are read with a fallback
// to the older column set.
//
// Pure helpers (allocationPaid, spotRowFacts, priceLaterRowFacts,
// priceLaterContractPayload) are tested in lib/contracts-sales-fetch.test.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import {
  deliveredBushelsByContract, fetchLoadSales, saleAllocations, unassignedBuyerLoads,
  type ContractDelivered, type LoadSale, type SaleAllocation,
} from '@/lib/load-sales'
import {
  buildPriceLaterPools, buildSpotContracts,
  type PriceLaterPool, type SaleSourceLoad, type VirtualSpotContract,
} from '@/lib/virtual-contracts'
import { loadTicketKeys } from '@/lib/ticket-matching'

/** A load as the contracts pages read it: the sale seam's fields plus what
 *  the tracker prints (ticket, where it went) and what dry bushels need. */
export type SalesLoad = SaleSourceLoad & {
  contract_id: string | null
  to_type: 'bin' | 'buyer' | null
  to_buyer_id: string | null
  date: string
  ticket_number: string | null
  buyer_ticket_number: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  from_type: 'field' | 'bin' | null
  from_field_id: string | null
}

type LoadQueryRow = Omit<SalesLoad, 'dryBu'>

export type SalesCrop = {
  id: string
  name: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
  harvest_category: 'fall' | 'spring'
  double_crop: boolean | null
}
export type SalesField = { id: string; farm_id: string | null }
export type SalesFarm = { id: string; entity_id: string | null }
export type SalesEntity = { id: string; name: string; entity_role: string | null }
export type SalesBuyer = { id: string; name: string }

export type ContractsSales = {
  loads: SalesLoad[]
  sales: LoadSale[]
  allocations: Map<string, SaleAllocation[]>
  deliveredByContract: Map<string, ContractDelivered>
  spots: VirtualSpotContract[]
  pools: PriceLaterPool[]
  /** Buyer loads with no sale picked (never spot or price-later loads). */
  unassigned: SalesLoad[]
  crops: SalesCrop[]
  fields: SalesField[]
  farms: SalesFarm[]
  entities: SalesEntity[]
  buyers: SalesBuyer[]
  /** The org's marketing-agent entity (051); spot is held there. */
  marketingAgentEntityId: string | null
  /** field id → entity id via its farm. */
  fieldEntity: Map<string, string | null>
  /** load id → its load_splits as field + fraction (percentage / 100). */
  splitsByLoad: Map<string, Array<{ field_id: string; fraction: number }>>
}

export const SALES_LOAD_SELECT =
  'id, contract_id, date, ticket_number, buyer_ticket_number, net_weight, moisture, dry_bushels_override, crop_id, crop_year, from_type, from_field_id, to_type, to_buyer_id'

/** Dry bushels of a load from ITS crop's bases — the same rule the tracker
 *  has always used (computeBushels, the override winning). */
export function loadDryBushels(
  load: Pick<SalesLoad, 'net_weight' | 'moisture' | 'dry_bushels_override' | 'crop_id'>,
  cropById: ReadonlyMap<string, Pick<SalesCrop, 'base_moisture_pct' | 'base_lb_per_bushel'>>,
): number {
  const crop = load.crop_id ? cropById.get(load.crop_id) : null
  const { dryBushels } = computeBushels({
    netWeightLb: load.net_weight,
    moisturePct: load.moisture,
    baseMoisturePct: crop?.base_moisture_pct ?? null,
    baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: load.dry_bushels_override,
  })
  return dryBushels ?? 0
}

export function marketingAgentOf(entities: ReadonlyArray<Pick<SalesEntity, 'id' | 'entity_role'>>): string | null {
  return entities.find((e) => e.entity_role === 'marketing_agent')?.id ?? null
}

/**
 * Everything the contracts pages need about sales. `cropYear` narrows the
 * loads read (a detail page for one year); `orgId` scopes a service-role
 * caller (RLS already scopes a user session).
 */
export async function fetchSalesForContracts(
  supabase: SupabaseClient,
  opts: { cropYear?: number | null; orgId?: string | null } = {},
): Promise<ContractsSales> {
  const [loadsQ, cropsQ, fieldsQ, farmsQ, entitiesQ, buyersQ, splitsQ] = await Promise.all([
    fetchAllRows<LoadQueryRow>((f, t) => {
      let q = supabase.from('loads').select(SALES_LOAD_SELECT).order('id', { ascending: true }).range(f, t)
      if (opts.cropYear != null) q = q.eq('crop_year', opts.cropYear)
      if (opts.orgId) q = q.eq('org_id', opts.orgId)
      return q
    }),
    supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel, harvest_category, double_crop').order('name'),
    supabase.from('fields').select('id, farm_id'),
    supabase.from('farms').select('id, entity_id'),
    supabase.from('entities').select('id, name, entity_role').order('name'),
    supabase.from('buyers').select('id, name').order('name'),
    fetchAllRows<{ load_id: string; field_id: string; percentage: number | null }>((f, t) => {
      let q = supabase.from('load_splits').select('load_id, field_id, percentage').order('id').range(f, t)
      if (opts.orgId) q = q.eq('org_id', opts.orgId)
      return q
    }),
  ])
  if (loadsQ.error) throw new Error(loadsQ.error.message)
  if (splitsQ.error) throw new Error(splitsQ.error.message)

  const crops = (cropsQ.data ?? []) as SalesCrop[]
  const fields = (fieldsQ.data ?? []) as SalesField[]
  const farms = (farmsQ.data ?? []) as SalesFarm[]
  const entities = (entitiesQ.data ?? []) as SalesEntity[]
  const buyers = (buyersQ.data ?? []) as SalesBuyer[]
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const loads: SalesLoad[] = loadsQ.data.map((l) => ({ ...l, dryBu: loadDryBushels(l, cropById) }))

  const sales = await fetchLoadSales(supabase, {
    loadIds: opts.cropYear != null ? loads.map((l) => l.id) : undefined,
    orgId: opts.orgId ?? undefined,
  })

  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const fieldEntity = new Map(fields.map((f) => [f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null]))
  const splitsByLoad = new Map<string, Array<{ field_id: string; fraction: number }>>()
  for (const s of splitsQ.data) {
    const arr = splitsByLoad.get(s.load_id) ?? []
    arr.push({ field_id: s.field_id, fraction: Number(s.percentage ?? 0) / 100 })
    splitsByLoad.set(s.load_id, arr)
  }
  const marketingAgentEntityId = marketingAgentOf(entities)

  return {
    loads, sales,
    allocations: saleAllocations(loads, sales),
    deliveredByContract: deliveredBushelsByContract(loads, sales),
    spots: buildSpotContracts({ loads, sales, marketingAgentEntityId, fieldEntity, splitsByLoad }),
    pools: buildPriceLaterPools(loads, sales),
    unassigned: unassignedBuyerLoads(loads, sales),
    crops, fields, farms, entities, buyers, marketingAgentEntityId, fieldEntity, splitsByLoad,
  }
}

// ---------- settlement lines ----------

export type SalesSettlementLine = {
  id: string
  settlement_id: string
  load_id: string | null
  ticket_number: string | null
  net_bushels: number
  net_revenue: number | null
  /** 094: the line's own sale facts; null on older rows (and before 094). */
  contract_id: string | null
  sale_type: string | null
}

const LINE_SELECT_094 = 'id, settlement_id, load_id, ticket_number, net_bushels, net_revenue, contract_id, sale_type'
const LINE_SELECT_PRE = 'id, settlement_id, load_id, ticket_number, net_bushels, net_revenue'

/** Every settlement line (paged), with the 094 per-line sale columns when the
 *  database has them. `loadIds` narrows to lines matched to those loads by id. */
export async function fetchSettlementLinesForSales(
  supabase: SupabaseClient,
  opts: { loadIds?: ReadonlyArray<string>; ticketNumbers?: ReadonlyArray<string> } = {},
): Promise<SalesSettlementLine[]> {
  const narrow = opts.loadIds != null || opts.ticketNumbers != null
  if (narrow && (opts.loadIds?.length ?? 0) === 0 && (opts.ticketNumbers?.length ?? 0) === 0) return []
  const filters: string[] = []
  if (opts.loadIds?.length) filters.push(`load_id.in.(${opts.loadIds.join(',')})`)
  if (opts.ticketNumbers?.length) {
    const escaped = opts.ticketNumbers.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(',')
    filters.push(`ticket_number.in.(${escaped})`)
  }
  const run = (select: string) => fetchAllRows<SalesSettlementLine>((f, t) => {
    let q = supabase.from('settlement_lines').select(select).order('id').range(f, t)
    if (filters.length) q = q.or(filters.join(','))
    return q
  })
  let res = await run(LINE_SELECT_094)
  if (res.error && /contract_id|sale_type|column/i.test(res.error.message)) res = await run(LINE_SELECT_PRE)
  if (res.error) throw new Error(res.error.message)
  return res.data.map((l) => ({ ...l, contract_id: l.contract_id ?? null, sale_type: l.sale_type ?? null }))
}

/** load → its settlement lines: matched by load id, else by ticket number
 *  (a split ticket has TWO lines; both come back). */
export function settlementLinesByLoad(lines: ReadonlyArray<SalesSettlementLine>): (load: { id: string; ticket_number: string | null; buyer_ticket_number?: string | null }) => SalesSettlementLine[] {
  const byLoad = new Map<string, SalesSettlementLine[]>()
  const byTicket = new Map<string, SalesSettlementLine[]>()
  for (const l of lines) {
    if (l.load_id) { const a = byLoad.get(l.load_id) ?? []; a.push(l); byLoad.set(l.load_id, a) }
    if (l.ticket_number) {
      const k = l.ticket_number.trim().toLowerCase()
      const a = byTicket.get(k) ?? []; a.push(l); byTicket.set(k, a)
    }
  }
  return (load) => {
    const own = byLoad.get(load.id)
    if (own && own.length > 0) return own
    for (const k of loadTicketKeys(load)) { const t = byTicket.get(k); if (t && t.length > 0) return t }
    return []
  }
}

export type AllocationPaid = { bushels: number; revenue: number }

/**
 * What the buyer has settled for ONE part of a load. When the load's lines
 * carry their own sale facts (094: contract_id / sale_type per line), the
 * part's paid figures are the line that names the same contract (or the same
 * kind); with none naming it the part is unpaid. Lines without those facts
 * (older settlements) are the load's single settlement, scaled by the part's
 * share. No lines → null (unpaid).
 */
export function allocationPaid(alloc: Pick<SaleAllocation, 'saleType' | 'contractId' | 'share'>, lines: ReadonlyArray<Pick<SalesSettlementLine, 'net_bushels' | 'net_revenue' | 'contract_id' | 'sale_type'>>): AllocationPaid | null {
  if (lines.length === 0) return null
  const typed = lines.filter((l) => l.contract_id != null || l.sale_type != null)
  const sum = (ls: ReadonlyArray<Pick<SalesSettlementLine, 'net_bushels' | 'net_revenue'>>): AllocationPaid =>
    ls.reduce((s, l) => ({ bushels: s.bushels + Number(l.net_bushels ?? 0), revenue: s.revenue + Number(l.net_revenue ?? 0) }), { bushels: 0, revenue: 0 })
  if (typed.length > 0) {
    const match = alloc.saleType === 'contract'
      ? typed.filter((l) => l.contract_id === alloc.contractId)
      : typed.filter((l) => l.contract_id == null && l.sale_type === alloc.saleType)
    if (match.length > 0) return sum(match)
    if (typed.length === lines.length) return null
    // Mixed: typed lines belong to other parts; the untyped rest is scaled.
    const rest = sum(lines.filter((l) => l.contract_id == null && l.sale_type == null))
    return { bushels: rest.bushels * alloc.share, revenue: rest.revenue * alloc.share }
  }
  const all = sum(lines)
  return { bushels: all.bushels * alloc.share, revenue: all.revenue * alloc.share }
}

// ---------- the tracker's virtual rows ----------

export type SpotRowFacts = {
  /** "Spot · Soybean 2026" */
  title: string
  /** "Bunge" · "Bunge +1" · "" with no buyer */
  buyersLabel: string
  bushels: number
  loadCount: number
  avgPrice: number | null
  /** "$13.6691" (4 decimals) or "—" */
  avgText: string
  /** "5 of 5 settled" · "4 of 5 settled · est. on 1" */
  statusText: string
  estimated: boolean
  /** Σ settled rows' price × bushels. */
  paidRevenue: number
  paidBu: number
  /** Rows not yet settled, at their current (entered / estimated) price. */
  unpaidRevenue: number
  unpaidBu: number
  /** Revenue over every priced row — the row's value. */
  value: number
}

export function fmtAvgPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
}

export function buyersLabel(buyerIds: ReadonlyArray<string | null>, nameOf: (id: string) => string | null | undefined): string {
  const names = buyerIds.map((id) => (id ? nameOf(id) ?? null : null)).filter((n): n is string => !!n)
  if (names.length === 0) return ''
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`
}

export function spotRowFacts(spot: VirtualSpotContract, cropName: string | null | undefined, nameOf: (id: string) => string | null | undefined): SpotRowFacts {
  let paidRevenue = 0, paidBu = 0, unpaidRevenue = 0, unpaidBu = 0
  for (const r of spot.rows) {
    const s = r.alloc.sale
    const price = s?.spot_price ?? null
    if (s?.spot_price_source === 'settlement' && price != null) {
      paidBu += r.alloc.bushels
      paidRevenue += price * r.alloc.bushels
    } else {
      unpaidBu += r.alloc.bushels
      if (price != null) unpaidRevenue += price * r.alloc.bushels
    }
  }
  return {
    title: `Spot · ${cropName ?? 'Crop'} ${spot.crop_year}`,
    buyersLabel: buyersLabel(spot.buyers.map((b) => b.buyerId), nameOf),
    bushels: spot.bushels,
    loadCount: spot.summary.loadCount,
    avgPrice: spot.avgPrice,
    avgText: fmtAvgPrice(spot.avgPrice),
    statusText: spot.summary.statusText,
    estimated: spot.estimated,
    paidRevenue, paidBu, unpaidRevenue, unpaidBu,
    value: spot.revenue,
  }
}

export type PriceLaterRowFacts = {
  /** "Price later · Soybean 2026 · Bunge" */
  title: string
  bushels: number
  loadCount: number
  oldestDate: string | null
  /** Today's assumed price (assumed futures + assumed basis) or null. */
  assumedPrice: number | null
  /** bushels × assumedPrice, null without an assumed futures price. */
  value: number | null
  /** The chip beside the value. */
  valueLabel: 'unpriced'
}

export function priceLaterRowFacts(
  pool: Pick<PriceLaterPool, 'crop_year' | 'bushels' | 'loadCount' | 'oldestDate'>,
  cropName: string | null | undefined,
  buyerName: string | null | undefined,
  assumption: { assumed_futures: number | null; assumed_basis: number | null } | null | undefined,
): PriceLaterRowFacts {
  const assumedPrice = assumption?.assumed_futures != null
    ? Number(assumption.assumed_futures) + Number(assumption.assumed_basis ?? 0)
    : null
  return {
    title: `Price later · ${cropName ?? 'Crop'} ${pool.crop_year}${buyerName ? ` · ${buyerName}` : ''}`,
    bushels: pool.bushels,
    loadCount: pool.loadCount,
    oldestDate: pool.oldestDate,
    assumedPrice,
    value: assumedPrice != null ? assumedPrice * pool.bushels : null,
    valueLabel: 'unpriced',
  }
}

/** A pool narrowed to some of its loads (the tracker's entity filter follows
 *  the loads' field entities). Null when nothing is left. */
export function narrowPool(pool: PriceLaterPool, keep: (row: PriceLaterPool['rows'][number]) => boolean): PriceLaterPool | null {
  const rows = pool.rows.filter(keep)
  if (rows.length === 0) return null
  let bushels = 0
  let oldestDate: string | null = null
  let newestDate: string | null = null
  for (const r of rows) {
    bushels += r.alloc.bushels
    if (r.load.date && (oldestDate == null || r.load.date < oldestDate)) oldestDate = r.load.date
    if (r.load.date && (newestDate == null || r.load.date > newestDate)) newestDate = r.load.date
  }
  return { ...pool, rows, bushels, loadCount: rows.length, oldestDate, newestDate }
}

// ---------- "Price bushels" ----------

export type PriceLaterContractInput = {
  bushels: number
  pricePerBushel: number
  /** 'YYYY-MM-DD' — the date sold. */
  date: string
  contractNumber?: string | null
  notes?: string | null
}

/** "Priced 10/13/26" — the default contract number until the buyer confirms. */
export function defaultPricedContractNumber(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return 'Priced'
  return `Priced ${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}`
}

/**
 * The contract "Price bushels" creates from a price-later pool: a fully
 * priced, delivered forward at the typed price for min(requested, pool)
 * bushels, held by the marketing-agent entity when the org has one. Pure;
 * the action inserts `payload`, then moves the oldest `bushels` onto it.
 */
export function priceLaterContractPayload(
  pool: Pick<PriceLaterPool, 'crop_id' | 'crop_year' | 'buyer_id' | 'bushels'>,
  input: PriceLaterContractInput,
  marketingAgentEntityId: string | null,
): { bushels: number; payload: Record<string, unknown> } | { error: string } {
  const price = Number(input.pricePerBushel)
  if (!Number.isFinite(price) || price <= 0) return { error: 'Enter the price per bushel.' }
  const requested = Number(input.bushels)
  if (!Number.isFinite(requested) || requested <= 0) return { error: 'Enter how many bushels to price.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { error: 'Pick the date.' }
  if (pool.bushels <= 0) return { error: 'There are no unpriced bushels left in this pool.' }
  const bushels = Math.round(Math.min(requested, pool.bushels) * 1000) / 1000
  const number = (input.contractNumber ?? '').trim() || defaultPricedContractNumber(input.date)
  return {
    bushels,
    payload: {
      contract_number: number,
      buyer_id: pool.buyer_id,
      crop_id: pool.crop_id,
      entity_id: marketingAgentEntityId,
      crop_year: pool.crop_year,
      contracted_bushels: bushels,
      delivery_type: 'delivered',
      delivery_location_id: null,
      delivery_start_date: null,
      delivery_end_date: null,
      date_sold: input.date,
      notes: (input.notes ?? '').trim() || null,
      contract_type: 'forward',
      contract_month: null,
      futures_price: null,
      basis: null,
      service_fee: 0,
      cash_price: price,
      price_per_bushel: price,
      futures_set_date: null,
      basis_set_date: null,
      pricing_status: 'fully_priced',
    },
  }
}
