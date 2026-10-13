// How each grain load was SOLD — THE seam (094, 2026-10-13).
//
// A load delivered to a buyer is applied to a CONTRACT, sold SPOT (priced at
// the buyer's posted bid the day it was delivered), or left PRICE LATER
// (delayed price / stored at the buyer — unpriced until the farmer prices it).
// One load can be split across any mix — Bunge applied 58.284 bu of ticket
// 0502289 to the last of a contract and bought the other 912.744 bu spot.
//
// The rows live in load_sales: one per (load, kind, contract), `share` = the
// fraction of the load, a load's rows summing to exactly 1. Bushels per row
// are DERIVED here (share × the load's dry bushels) so an allocation always
// reconciles to its load. A load with NO rows is UNASSIGNED (delivered to a
// buyer, sale not yet picked) — never silently a contract load.
//
// loads.contract_id is only a trigger-maintained MIRROR (the contract when a
// load is 100% on one contract, else null). Every reader of "which contract
// is this load on" / "delivered per contract" / "is this contract complete"
// goes through saleAllocations + deliveredBushelsByContract below, so a
// split load counts each contract's share and nothing else. A load with no
// rows but a contract_id (a database before 094 is applied) still reads as
// a full contract load — the app tolerates the pre-migration state.
//
// Pure functions + the two thin Supabase helpers at the bottom (paged read,
// RPC write). Tested in lib/load-sales.test.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'

export type SaleType = 'contract' | 'spot' | 'price_later'
export type SpotPriceSource = 'settlement' | 'entered' | 'estimate'

export const SALE_TYPE_LABEL: Record<SaleType, string> = {
  contract: 'Contract',
  spot: 'Spot',
  price_later: 'Price later',
}

/** A load_sales row as stored. */
export type LoadSale = {
  id: string
  load_id: string
  sale_type: SaleType
  contract_id: string | null
  share: number
  buyer_net_bushels: number | null
  spot_price: number | null
  spot_price_source: SpotPriceSource | null
  est_futures_price: number | null
  est_futures_symbol: string | null
  est_basis: number | null
  settlement_line_id: string | null
  created_at?: string
  updated_at?: string
}

/** What the writer takes (load_sales_set): the stored columns minus identity. */
export type LoadSaleInput = {
  sale_type: SaleType
  contract_id?: string | null
  share: number
  buyer_net_bushels?: number | null
  spot_price?: number | null
  spot_price_source?: SpotPriceSource | null
  est_futures_price?: number | null
  est_futures_symbol?: string | null
  est_basis?: number | null
  settlement_line_id?: string | null
}

export const LOAD_SALES_SELECT =
  'id, load_id, sale_type, contract_id, share, buyer_net_bushels, spot_price, spot_price_source, est_futures_price, est_futures_symbol, est_basis, settlement_line_id'

/** The least a load needs to be allocated: its id, the legacy mirror column
 *  (pre-094 fallback), where it went, and its dry bushels (the caller's
 *  computeBushels — crop bases differ per page, so the seam takes the number). */
export type SaleLoad = {
  id: string
  contract_id?: string | null
  to_type?: 'bin' | 'buyer' | null
  dryBu: number
}

export type SaleAllocation = {
  loadId: string
  saleType: SaleType
  contractId: string | null
  share: number
  /** share × the load's dry bushels. */
  bushels: number
  /** The stored row; null when the allocation is the pre-094 fallback from
   *  loads.contract_id (no load_sales row yet). */
  sale: LoadSale | null
}

const SHARE_EPS = 1e-6

/** Rows grouped by load. */
export function salesByLoad(sales: ReadonlyArray<LoadSale>): Map<string, LoadSale[]> {
  const out = new Map<string, LoadSale[]>()
  for (const s of sales) {
    const arr = out.get(s.load_id) ?? []
    arr.push(s)
    out.set(s.load_id, arr)
  }
  return out
}

/**
 * Every load's allocations. A load with rows → one allocation per row (bushels
 * = share × dryBu). No rows + a contract_id → ONE full contract allocation
 * (pre-094 fallback). No rows and no contract → [] (unassigned when it went
 * to a buyer; a bin load simply has no sale).
 */
export function saleAllocations(
  loads: ReadonlyArray<SaleLoad>,
  sales: ReadonlyArray<LoadSale>,
): Map<string, SaleAllocation[]> {
  const byLoad = salesByLoad(sales)
  const out = new Map<string, SaleAllocation[]>()
  for (const l of loads) {
    const rows = byLoad.get(l.id)
    if (rows && rows.length > 0) {
      out.set(
        l.id,
        rows.map((s) => ({
          loadId: l.id,
          saleType: s.sale_type,
          contractId: s.contract_id,
          share: Number(s.share),
          bushels: Number(s.share) * l.dryBu,
          sale: s,
        })),
      )
    } else if (l.contract_id) {
      out.set(l.id, [{ loadId: l.id, saleType: 'contract', contractId: l.contract_id, share: 1, bushels: l.dryBu, sale: null }])
    } else {
      out.set(l.id, [])
    }
  }
  return out
}

export type ContractDelivered = {
  /** Σ share × dry bushels over every allocation on the contract. */
  dryBu: number
  /** Loads touching the contract (a split load counts once). */
  count: number
  loadIds: string[]
}

/** Delivered bushels per contract — the ONE rule behind contract progress,
 *  completion, remaining, the load form's tracker and the cash-flow buckets. */
export function deliveredBushelsByContract(
  loads: ReadonlyArray<SaleLoad>,
  sales: ReadonlyArray<LoadSale>,
): Map<string, ContractDelivered> {
  const out = new Map<string, ContractDelivered>()
  for (const [, allocs] of saleAllocations(loads, sales)) {
    for (const a of allocs) {
      if (a.saleType !== 'contract' || !a.contractId) continue
      let d = out.get(a.contractId)
      if (!d) { d = { dryBu: 0, count: 0, loadIds: [] }; out.set(a.contractId, d) }
      d.dryBu += a.bushels
      if (!d.loadIds.includes(a.loadId)) { d.loadIds.push(a.loadId); d.count++ }
    }
  }
  return out
}

/** Every allocation of one kind, flattened (spot rows, price-later rows…). */
export function allocationsOfType(
  loads: ReadonlyArray<SaleLoad>,
  sales: ReadonlyArray<LoadSale>,
  type: SaleType,
): SaleAllocation[] {
  const out: SaleAllocation[] = []
  for (const [, allocs] of saleAllocations(loads, sales)) for (const a of allocs) if (a.saleType === type) out.push(a)
  return out
}

/** Buyer loads with no sale picked at all — the only loads the "no sale type"
 *  notices count. Spot and price-later loads are never orphans. */
export function unassignedBuyerLoads<L extends SaleLoad>(loads: ReadonlyArray<L>, sales: ReadonlyArray<LoadSale>): L[] {
  const allocs = saleAllocations(loads, sales)
  return loads.filter((l) => l.to_type === 'buyer' && (allocs.get(l.id)?.length ?? 0) === 0)
}

/** The one completion rule (was copied in four places before 094). */
export function isContractComplete(completedAt: string | null | undefined, contractedBu: number, delivered: number): boolean {
  if (completedAt != null) return true
  return contractedBu > 0 && delivered >= contractedBu
}

export type SaleKind = SaleType | 'split' | 'unassigned' | 'none'

/** What a load's allocation set is, for a chip: one kind, a split, unassigned
 *  (buyer load, no rows) or none (a bin load). */
export function saleKind(allocs: ReadonlyArray<SaleAllocation>, load?: Pick<SaleLoad, 'to_type'>): SaleKind {
  if (allocs.length === 0) return load?.to_type === 'buyer' ? 'unassigned' : 'none'
  if (allocs.length === 1) return allocs[0].saleType
  return 'split'
}

const fmtBu = (n: number) => Math.round(n).toLocaleString('en-US')

/**
 * The sale as one line of text — the loads list, load detail, contract
 * detail and every export print this:
 *   "Contract 2002960604-10" · "Spot" · "Price later" ·
 *   "split: 58 bu contract 2002960604-10 · 913 bu spot" · "Unassigned".
 */
export function describeSale(
  allocs: ReadonlyArray<SaleAllocation>,
  contractNumber: (contractId: string) => string | null | undefined,
  load?: Pick<SaleLoad, 'to_type'>,
): string {
  const kind = saleKind(allocs, load)
  if (kind === 'none') return ''
  if (kind === 'unassigned') return 'Unassigned'
  const part = (a: SaleAllocation): string =>
    a.saleType === 'contract' ? `contract ${contractNumber(a.contractId ?? '') ?? '?'}` : a.saleType === 'spot' ? 'spot' : 'price later'
  if (kind !== 'split') {
    const a = allocs[0]
    if (a.saleType === 'contract') return `Contract ${contractNumber(a.contractId ?? '') ?? '?'}`
    return SALE_TYPE_LABEL[a.saleType]
  }
  return `split: ${allocs.map((a) => `${fmtBu(a.bushels)} bu ${part(a)}`).join(' · ')}`
}

/** A sale allocation the user is building (the form's split rows, the
 *  settlement's lines for one ticket): bushels in, shares out. */
export type SalePart = {
  sale_type: SaleType
  contract_id?: string | null
  bushels: number
  buyer_net_bushels?: number | null
  spot_price?: number | null
  spot_price_source?: SpotPriceSource | null
  est_futures_price?: number | null
  est_futures_symbol?: string | null
  est_basis?: number | null
  settlement_line_id?: string | null
}

/**
 * Turn bushel parts into rows whose shares sum to EXACTLY 1: each share is
 * its part over the parts' total (not over the load's dry bushels — the
 * buyer's bushels and ours differ by shrink and scale), rounded to 1e-10,
 * with the LAST row taking the remainder. Parts ≤ 0 are dropped; one part →
 * share 1. `parts` may name a total to allocate against instead (the load's
 * dry bushels when the user typed "58 bu to the contract, the rest spot").
 */
export function sharesFromParts(parts: ReadonlyArray<SalePart>, totalOverride?: number): LoadSaleInput[] {
  const kept = parts.filter((p) => Number(p.bushels) > 0)
  if (kept.length === 0) return []
  const total = totalOverride != null && totalOverride > 0 ? totalOverride : kept.reduce((s, p) => s + Number(p.bushels), 0)
  const round = (n: number) => Math.round(n * 1e10) / 1e10
  let acc = 0
  return kept.map((p, i) => {
    const share = i === kept.length - 1 ? round(1 - acc) : round(Number(p.bushels) / total)
    acc = round(acc + share)
    return {
      sale_type: p.sale_type,
      contract_id: p.sale_type === 'contract' ? p.contract_id ?? null : null,
      share: Math.min(1, Math.max(SHARE_EPS, share)),
      buyer_net_bushels: p.buyer_net_bushels ?? null,
      spot_price: p.spot_price ?? null,
      spot_price_source: p.spot_price_source ?? null,
      est_futures_price: p.est_futures_price ?? null,
      est_futures_symbol: p.est_futures_symbol ?? null,
      est_basis: p.est_basis ?? null,
      settlement_line_id: p.settlement_line_id ?? null,
    }
  })
}

/** A whole load on one sale — the load form's plain (unsplit) choice. */
export function singleSaleRow(choice: { sale_type: SaleType; contract_id?: string | null; spot_price?: number | null; spot_price_source?: SpotPriceSource | null }): LoadSaleInput[] {
  return [{
    sale_type: choice.sale_type,
    contract_id: choice.sale_type === 'contract' ? choice.contract_id ?? null : null,
    share: 1,
    spot_price: choice.sale_type === 'spot' ? choice.spot_price ?? null : null,
    spot_price_source: choice.sale_type === 'spot' && choice.spot_price != null ? choice.spot_price_source ?? 'entered' : null,
  }]
}

/** True when the rows are a well-formed allocation (shares sum to 1,
 *  contract rows name a contract, no duplicate kind/contract). */
export function validateSaleRows(rows: ReadonlyArray<LoadSaleInput>): string | null {
  if (rows.length === 0) return null
  let sum = 0
  const seen = new Set<string>()
  for (const r of rows) {
    if (!(r.share > 0)) return 'Every part of the load needs bushels.'
    if (r.sale_type === 'contract' && !r.contract_id) return 'Pick a contract for the contract part.'
    if (r.sale_type !== 'contract' && r.contract_id) return 'Only a contract part can name a contract.'
    const key = `${r.sale_type}|${r.contract_id ?? ''}`
    if (seen.has(key)) return 'The same sale appears twice — combine those parts.'
    seen.add(key)
    sum += r.share
  }
  if (Math.abs(sum - 1) > SHARE_EPS) return 'The parts must add up to the whole load.'
  return null
}

/**
 * The overfill helper: a load of `loadBu` picked onto a contract with
 * `remainingBu` left. Returns how many bushels fit and how many must go
 * elsewhere (0 when the whole load fits or the contract has no target).
 */
export function overfillSplit(loadBu: number, remainingBu: number | null): { onContract: number; overflow: number } {
  if (remainingBu == null || remainingBu <= 0 || loadBu <= 0) return { onContract: loadBu, overflow: 0 }
  if (loadBu <= remainingBu) return { onContract: loadBu, overflow: 0 }
  return { onContract: remainingBu, overflow: loadBu - remainingBu }
}

// ---------- Supabase helpers ----------

/** Every load_sales row (paged) — optionally only for some loads. A
 *  database before 094 (relation missing) reads as no rows. */
export async function fetchLoadSales(
  supabase: SupabaseClient,
  opts: { loadIds?: ReadonlyArray<string>; orgId?: string } = {},
): Promise<LoadSale[]> {
  const ids = opts.loadIds
  if (ids && ids.length === 0) return []
  // .in() on thousands of ids is a long URL; chunk it.
  const chunks: Array<ReadonlyArray<string> | null> = ids ? [] : [null]
  if (ids) for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500))
  const out: LoadSale[] = []
  for (const chunk of chunks) {
    const { data, error } = await fetchAllRows<LoadSale>((f, t) => {
      let q = supabase.from('load_sales').select(LOAD_SALES_SELECT).order('id').range(f, t)
      if (opts.orgId) q = q.eq('org_id', opts.orgId)
      if (chunk) q = q.in('load_id', [...chunk])
      return q
    })
    if (error) {
      if (isMissingRelation(error.message)) return []
      throw new Error(error.message)
    }
    out.push(...data.map(normalizeRow))
  }
  return out
}

function normalizeRow(r: LoadSale): LoadSale {
  return {
    ...r,
    share: Number(r.share),
    buyer_net_bushels: r.buyer_net_bushels == null ? null : Number(r.buyer_net_bushels),
    spot_price: r.spot_price == null ? null : Number(r.spot_price),
    est_futures_price: r.est_futures_price == null ? null : Number(r.est_futures_price),
    est_basis: r.est_basis == null ? null : Number(r.est_basis),
  }
}

export function isMissingRelation(message: string | null | undefined): boolean {
  const m = (message ?? '').toLowerCase()
  return m.includes('load_sales') && (m.includes('does not exist') || m.includes('could not find') || m.includes('schema cache'))
}

/** Replace a load's sale rows atomically (the load_sales_set RPC). */
export async function writeLoadSales(supabase: SupabaseClient, loadId: string, rows: ReadonlyArray<LoadSaleInput>): Promise<void> {
  const err = validateSaleRows(rows)
  if (err) throw new Error(err)
  const { error } = await supabase.rpc('load_sales_set', { p_load_id: loadId, p_rows: rows.map(rpcRow) })
  if (error) throw new Error(error.message)
}

/** Many loads in one call (the settlement save, the bulk assign tool). */
export async function writeManyLoadSales(
  supabase: SupabaseClient,
  items: ReadonlyArray<{ loadId: string; rows: ReadonlyArray<LoadSaleInput> }>,
): Promise<void> {
  for (const it of items) {
    const err = validateSaleRows(it.rows)
    if (err) throw new Error(err)
  }
  if (items.length === 0) return
  const { error } = await supabase.rpc('load_sales_set_many', {
    p_items: items.map((it) => ({ load_id: it.loadId, rows: it.rows.map(rpcRow) })),
  })
  if (error) throw new Error(error.message)
}

function rpcRow(r: LoadSaleInput): Record<string, unknown> {
  return {
    sale_type: r.sale_type,
    contract_id: r.contract_id ?? null,
    share: r.share,
    buyer_net_bushels: r.buyer_net_bushels ?? null,
    spot_price: r.spot_price ?? null,
    spot_price_source: r.spot_price_source ?? null,
    est_futures_price: r.est_futures_price ?? null,
    est_futures_symbol: r.est_futures_symbol ?? null,
    est_basis: r.est_basis ?? null,
    settlement_line_id: r.settlement_line_id ?? null,
  }
}
