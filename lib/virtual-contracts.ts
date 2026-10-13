// The SPOT contract and the PRICE-LATER pools — virtual contracts built from
// sale allocations (094, 2026-10-13). Pure; tested in lib/virtual-contracts.test.ts.
//
// SPOT: for each crop × crop year, all spot loads together act as ONE
// contract with no contract number, priced at the bushel-weighted average of
// its loads. It enters the marketing engine through the SAME path a fully
// priced forward does (toMarketingContract: contract_type 'forward',
// pricing_status 'fully_priced', cash_price = the average; futures + basis
// supplied only when every priced load carries a futures settle, so the
// futures buildup can list "Spot (N loads)" as its own source line — else the
// engine's flat-cash path). The over-contracting cap applies as usual.
//
// Entity: spot is held by the org's marketing-agent entity (051) and flows
// down pro-rata by acre share exactly like its contracts. In an org WITHOUT
// a marketing agent, each spot load is attributed to its source field's
// entity (split loads by their load_splits; bin loads carry no field →
// operation-level, pro-rata), so one virtual contract per crop × year ×
// entity.
//
// PRICE LATER: per crop × crop year × buyer — bushels delivered but UNPRICED.
// They never become a contract input; the engine values them like any other
// unpriced bushel (assumed futures + assumed basis). "Price bushels" creates
// a real forward contract and moves allocations onto it FIFO by delivery
// date (planPriceLaterPricing), splitting the last load if needed.

import type { Contract } from '@/lib/types'
import { saleAllocations, type LoadSale, type SaleAllocation, type SaleLoad } from '@/lib/load-sales'
import { spotSummary, type SpotSummary } from '@/lib/spot-price'

export const SPOT_ID_PREFIX = 'spot:'
export const PRICE_LATER_ID_PREFIX = 'price-later:'

export function spotContractId(cropId: string, cropYear: number, entityId: string | null = null): string {
  return `${SPOT_ID_PREFIX}${cropId}:${cropYear}${entityId ? `:${entityId}` : ''}`
}
export function parseSpotContractId(id: string): { cropId: string; cropYear: number; entityId: string | null } | null {
  if (!id.startsWith(SPOT_ID_PREFIX)) return null
  const [cropId, year, entityId] = id.slice(SPOT_ID_PREFIX.length).split(':')
  const cropYear = Number(year)
  if (!cropId || !Number.isFinite(cropYear)) return null
  return { cropId, cropYear, entityId: entityId || null }
}
export function priceLaterPoolId(cropId: string, cropYear: number, buyerId: string): string {
  return `${PRICE_LATER_ID_PREFIX}${cropId}:${cropYear}:${buyerId}`
}
export function parsePriceLaterPoolId(id: string): { cropId: string; cropYear: number; buyerId: string } | null {
  if (!id.startsWith(PRICE_LATER_ID_PREFIX)) return null
  const [cropId, year, buyerId] = id.slice(PRICE_LATER_ID_PREFIX.length).split(':')
  const cropYear = Number(year)
  if (!cropId || !buyerId || !Number.isFinite(cropYear)) return null
  return { cropId, cropYear, buyerId }
}
export function isVirtualContractId(id: string | null | undefined): boolean {
  return !!id && (id.startsWith(SPOT_ID_PREFIX) || id.startsWith(PRICE_LATER_ID_PREFIX))
}

/** A load as the virtual builders need it. */
export type SaleSourceLoad = SaleLoad & {
  crop_id: string | null
  crop_year: number | null
  to_buyer_id: string | null
  date: string | null
  from_field_id?: string | null
  from_type?: 'field' | 'bin' | null
  ticket_number?: string | null
  buyer_ticket_number?: string | null
}

export type SpotLoadRow = {
  load: SaleSourceLoad
  alloc: SaleAllocation
  entityId: string | null
}

export type VirtualSpotContract = {
  id: string
  crop_id: string
  crop_year: number
  entity_id: string | null
  bushels: number
  revenue: number
  avgPrice: number | null
  summary: SpotSummary
  rows: SpotLoadRow[]
  buyers: Array<{ buyerId: string | null; bushels: number; revenue: number; avgPrice: number | null; loadCount: number; summary: SpotSummary }>
  /** True while any load's price is an estimate (or missing). */
  estimated: boolean
}

export type SpotBuildArgs = {
  loads: ReadonlyArray<SaleSourceLoad>
  sales: ReadonlyArray<LoadSale>
  /** The org's marketing-agent entity (051) — spot is held there. */
  marketingAgentEntityId: string | null
  /** field id → entity id (via its farm), for orgs with no marketing agent. */
  fieldEntity?: ReadonlyMap<string, string | null>
  /** load id → its load_splits (field_id + fraction), for split-source loads. */
  splitsByLoad?: ReadonlyMap<string, ReadonlyArray<{ field_id: string; fraction: number }>>
}

/** One virtual spot contract per crop × crop year (× entity without an agent). */
export function buildSpotContracts(args: SpotBuildArgs): VirtualSpotContract[] {
  const allocs = saleAllocations(args.loads, args.sales)
  type Group = { crop_id: string; crop_year: number; entity_id: string | null; rows: SpotLoadRow[]; parts: SaleAllocation[] }
  const groups = new Map<string, Group>()
  const push = (load: SaleSourceLoad, alloc: SaleAllocation, entityId: string | null) => {
    if (load.crop_id == null || load.crop_year == null) return
    const id = spotContractId(load.crop_id, load.crop_year, entityId)
    let g = groups.get(id)
    if (!g) { g = { crop_id: load.crop_id, crop_year: load.crop_year, entity_id: entityId, rows: [], parts: [] }; groups.set(id, g) }
    g.rows.push({ load, alloc, entityId })
    g.parts.push(alloc)
  }
  for (const load of args.loads) {
    for (const a of allocs.get(load.id) ?? []) {
      if (a.saleType !== 'spot') continue
      if (args.marketingAgentEntityId) { push(load, a, args.marketingAgentEntityId); continue }
      // No agent: the source field's entity; split sources fan out by fraction.
      const splits = args.splitsByLoad?.get(load.id)
      if (splits && splits.length > 0) {
        for (const s of splits) {
          const ent = args.fieldEntity?.get(s.field_id) ?? null
          push(load, { ...a, share: a.share * s.fraction, bushels: a.bushels * s.fraction }, ent)
        }
        continue
      }
      const ent = load.from_field_id ? args.fieldEntity?.get(load.from_field_id) ?? null : null
      push(load, a, ent)
    }
  }
  const out: VirtualSpotContract[] = []
  for (const [id, g] of groups) {
    const summary = spotSummary(g.parts)
    const byBuyer = new Map<string | null, SaleAllocation[]>()
    for (const r of g.rows) {
      const arr = byBuyer.get(r.load.to_buyer_id) ?? []
      arr.push(r.alloc)
      byBuyer.set(r.load.to_buyer_id, arr)
    }
    const buyers = [...byBuyer.entries()].map(([buyerId, parts]) => {
      const s = spotSummary(parts)
      return { buyerId, bushels: s.bushels, revenue: s.revenue, avgPrice: s.avgPrice, loadCount: s.loadCount, summary: s }
    }).sort((a, b) => b.bushels - a.bushels)
    g.rows.sort((a, b) => (a.load.date ?? '').localeCompare(b.load.date ?? '') || (a.load.ticket_number ?? '').localeCompare(b.load.ticket_number ?? ''))
    out.push({
      id, crop_id: g.crop_id, crop_year: g.crop_year, entity_id: g.entity_id,
      bushels: summary.bushels, revenue: summary.revenue, avgPrice: summary.avgPrice, summary, rows: g.rows, buyers,
      estimated: summary.estimatedCount > 0 || summary.unpricedCount > 0,
    })
  }
  return out.sort((a, b) => a.crop_year - b.crop_year || a.crop_id.localeCompare(b.crop_id) || (a.entity_id ?? '').localeCompare(b.entity_id ?? ''))
}

/** A spot contract as a Contract row for the marketing engine (and anything
 *  else that takes the contracts list). Unpriced bushels are left OUT of the
 *  input — they are not sold at a known price yet — so a spot row with no
 *  price never counts as priced. */
export function toMarketingContract(spot: VirtualSpotContract): Contract & { source_label: string; virtual: 'spot' } {
  const s = spot.summary
  const pricedBu = s.bushels - s.unpricedBushels
  const fut = s.futures
  return {
    id: spot.id,
    contract_number: 'SPOT',
    buyer_id: null,
    crop_id: spot.crop_id,
    entity_id: spot.entity_id,
    crop_year: spot.crop_year,
    contracted_bushels: round2(pricedBu),
    price_per_bushel: s.avgPrice,
    notes: null,
    delivery_type: 'delivered',
    delivery_location_id: null,
    delivery_start_date: null,
    delivery_end_date: null,
    completed_at: null,
    date_sold: null,
    contract_kind: 'grain',
    created_at: '',
    contract_month: null,
    contract_type: 'forward',
    futures_price: fut ? fut.avgFutures : null,
    basis: fut ? fut.avgBasis : null,
    cash_price: s.avgPrice,
    service_fee: 0,
    futures_set_date: null,
    basis_set_date: null,
    pricing_status: 'fully_priced',
    source_label: `Spot (${s.loadCount} load${s.loadCount === 1 ? '' : 's'})`,
    virtual: 'spot',
  }
}

/** Real contracts + the spot contracts, for any engine consumer. */
export function withSpotContracts<C extends Contract>(contracts: ReadonlyArray<C>, spots: ReadonlyArray<VirtualSpotContract>): Array<C | ReturnType<typeof toMarketingContract>> {
  return [...contracts, ...spots.filter((s) => s.bushels - s.summary.unpricedBushels > 0).map(toMarketingContract)]
}

// ---------- Price later ----------

export type PriceLaterLoadRow = { load: SaleSourceLoad; alloc: SaleAllocation }

export type PriceLaterPool = {
  id: string
  crop_id: string
  crop_year: number
  buyer_id: string
  bushels: number
  loadCount: number
  oldestDate: string | null
  newestDate: string | null
  rows: PriceLaterLoadRow[]
}

/** One pool per crop × crop year × buyer with price-later bushels. */
export function buildPriceLaterPools(loads: ReadonlyArray<SaleSourceLoad>, sales: ReadonlyArray<LoadSale>): PriceLaterPool[] {
  const allocs = saleAllocations(loads, sales)
  const pools = new Map<string, PriceLaterPool>()
  for (const load of loads) {
    for (const a of allocs.get(load.id) ?? []) {
      if (a.saleType !== 'price_later' || load.crop_id == null || load.crop_year == null || load.to_buyer_id == null) continue
      const id = priceLaterPoolId(load.crop_id, load.crop_year, load.to_buyer_id)
      let p = pools.get(id)
      if (!p) { p = { id, crop_id: load.crop_id, crop_year: load.crop_year, buyer_id: load.to_buyer_id, bushels: 0, loadCount: 0, oldestDate: null, newestDate: null, rows: [] }; pools.set(id, p) }
      p.bushels += a.bushels
      p.loadCount++
      p.rows.push({ load, alloc: a })
      if (load.date && (p.oldestDate == null || load.date < p.oldestDate)) p.oldestDate = load.date
      if (load.date && (p.newestDate == null || load.date > p.newestDate)) p.newestDate = load.date
    }
  }
  for (const p of pools.values()) p.rows.sort((a, b) => (a.load.date ?? '').localeCompare(b.load.date ?? '') || a.load.id.localeCompare(b.load.id))
  return [...pools.values()].sort((a, b) => a.crop_year - b.crop_year || a.crop_id.localeCompare(b.crop_id) || a.buyer_id.localeCompare(b.buyer_id))
}

export type PriceLaterMove = {
  loadId: string
  /** Bushels of this load moved onto the new contract. */
  bushels: number
  /** The load's new rows: the contract part (+ the price-later remainder when split). */
  rows: Array<{ sale_type: 'contract' | 'price_later'; contract_id: string | null; share: number }>
  split: boolean
}

export type PriceLaterPlan = {
  moves: PriceLaterMove[]
  /** Bushels actually moved (≤ requested, ≤ the pool). */
  priced: number
  /** Bushels still in the pool afterwards. */
  leftover: number
}

/**
 * FIFO by delivery date: fill `bushelsToPrice` from the pool's loads oldest
 * first; the last load is split (contract share + price-later remainder)
 * when it does not fit whole. Each move's rows REPLACE that load's
 * price-later row — other rows on the load (a contract or spot part of an
 * earlier split) are preserved by the caller (see applyPriceLaterPlan).
 */
export function planPriceLaterPricing(pool: PriceLaterPool, bushelsToPrice: number, contractId: string): PriceLaterPlan {
  const moves: PriceLaterMove[] = []
  let left = Math.max(0, bushelsToPrice)
  let priced = 0
  const round = (n: number) => Math.round(n * 1e10) / 1e10
  for (const r of pool.rows) {
    if (left <= 1e-9) break
    const bu = r.alloc.bushels
    if (bu <= 0) continue
    const take = Math.min(bu, left)
    const whole = take >= bu - 1e-9
    // Shares are of the LOAD: the price-later row's share scaled by the part taken.
    const contractShare = whole ? r.alloc.share : round(r.alloc.share * (take / bu))
    const remainderShare = whole ? 0 : round(r.alloc.share - contractShare)
    const rows: PriceLaterMove['rows'] = [{ sale_type: 'contract', contract_id: contractId, share: contractShare }]
    if (remainderShare > 0) rows.push({ sale_type: 'price_later', contract_id: null, share: remainderShare })
    moves.push({ loadId: r.load.id, bushels: take, rows, split: !whole })
    priced += take
    left -= take
  }
  return { moves, priced, leftover: Math.max(0, pool.bushels - priced) }
}

/** The full new row set for a load after a price-later move: the load's
 *  other rows untouched, its price-later row replaced by the move's rows. */
export function applyPriceLaterMove(existing: ReadonlyArray<LoadSale>, move: PriceLaterMove): Array<{ sale_type: 'contract' | 'spot' | 'price_later'; contract_id: string | null; share: number; buyer_net_bushels: number | null; spot_price: number | null; spot_price_source: LoadSale['spot_price_source']; est_futures_price: number | null; est_futures_symbol: string | null; est_basis: number | null; settlement_line_id: string | null }> {
  const kept = existing
    .filter((s) => s.sale_type !== 'price_later')
    .map((s) => ({
      sale_type: s.sale_type, contract_id: s.contract_id, share: Number(s.share), buyer_net_bushels: s.buyer_net_bushels, spot_price: s.spot_price,
      spot_price_source: s.spot_price_source, est_futures_price: s.est_futures_price, est_futures_symbol: s.est_futures_symbol, est_basis: s.est_basis, settlement_line_id: s.settlement_line_id,
    }))
  const added = move.rows.map((r) => ({
    sale_type: r.sale_type, contract_id: r.contract_id, share: r.share, buyer_net_bushels: null, spot_price: null, spot_price_source: null,
    est_futures_price: null, est_futures_symbol: null, est_basis: null, settlement_line_id: null,
  }))
  // A contract part landing on a contract the load already has a row for merges.
  const out = [...kept]
  for (const a of added) {
    const dup = a.sale_type === 'contract' ? out.find((o) => o.sale_type === 'contract' && o.contract_id === a.contract_id) : null
    if (dup) dup.share = Math.round((dup.share + a.share) * 1e10) / 1e10
    else out.push(a)
  }
  // Shares sum to 1 exactly: the last row absorbs rounding.
  const sum = out.reduce((s, r) => s + r.share, 0)
  if (out.length > 0 && Math.abs(sum - 1) > 1e-9) out[out.length - 1].share = Math.round((out[out.length - 1].share + (1 - sum)) * 1e10) / 1e10
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
