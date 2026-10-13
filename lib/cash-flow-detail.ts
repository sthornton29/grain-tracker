// Cash Flow drill-down: every dollar on the report is the sum of small,
// nameable pieces (a settlement, a contract's undelivered bushels, one
// policy's projected indemnity, one USDA payment). The report collects those
// pieces as CashDetail rows while it buckets the totals, and any number on
// screen opens the rows behind it. This module is the pure part: the row
// shape, the kind labels, and the selection / totaling a cell needs — plus,
// since 094, the sale-aware buckets (contract aggregates from allocations,
// the Spot row's received / outstanding, the price-later info line).

import { saleAllocations, type LoadSale, type SaleAllocation, type SaleLoad, type SaleType } from '@/lib/load-sales'
import type { PriceLaterPool, VirtualSpotContract } from '@/lib/virtual-contracts'

export type CashKind = 'received' | 'outstanding' | 'projected' | 'arcPlc' | 'insurance' | 'other' | 'cotton' | 'seed'

export const CASH_KIND_LABEL: Record<CashKind, string> = {
  received: 'Received',
  outstanding: 'Outstanding',
  projected: 'Projected',
  arcPlc: 'ARC/PLC',
  insurance: 'Crop insurance',
  other: 'Other USDA',
  cotton: 'Cotton (net)',
  seed: 'Seed contracts (net)',
}

/** One sentence per kind: what the rows are, in the farmer's words. */
export const CASH_KIND_EXPLAINER: Record<CashKind, string> = {
  received: 'Money already collected — each settlement, in the month it was dated. A split load counts each contract\'s share; spot loads count under their Spot row.',
  outstanding: 'Grain delivered but not yet on a settlement — contract loads at the contract price, spot loads at their current price (an estimate until the settlement arrives). Shown in the current month as money still owed to you.',
  projected: 'Contracted bushels not yet delivered, valued at the contract price and spread across the remaining delivery window. Spot sales are never projected — only what has already been delivered.',
  arcPlc: 'Projected ARC/PLC by farm and commodity, landing in October of the following crop year.',
  insurance: 'Projected crop insurance indemnity by policy, in the month you chose for proceeds.',
  other: 'Other USDA payments on their entered date (or December of the crop year).',
  cotton: 'Cotton cash lines — loans, sales, LDP, and fees — in their month.',
  seed: 'Seed contract cash — base payments, premiums, storage, and the usage fee — in their month.',
}

export type CashDetail = {
  kind: CashKind
  /** YYYY-MM bucket the amount lands in. */
  month: string
  /** What it is: "Settlement #4471 · Bunge", "Contract #C-12 · ADM". */
  label: string
  /** How it was figured: "1,204 bu × $4.35", "12 loads". */
  sub?: string
  amount: number
  /** Where to go for the record itself. */
  href?: string
  status?: 'received' | 'outstanding' | 'projected'
}

/** A selection on the report: one kind (or every kind) for one month (or
 *  every month). */
export type CashSelection = { kind: CashKind | 'all'; month: string | null }

export function selectCashDetails(rows: readonly CashDetail[], sel: CashSelection): CashDetail[] {
  return rows
    .filter((r) => (sel.kind === 'all' || r.kind === sel.kind) && (sel.month == null || r.month === sel.month))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => {
      if (sel.month == null && a.month !== b.month) return a.month.localeCompare(b.month)
      if (sel.kind === 'all' && a.kind !== b.kind) return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      return Math.abs(b.amount) - Math.abs(a.amount)
    })
}

const KIND_ORDER: CashKind[] = ['received', 'outstanding', 'projected', 'arcPlc', 'insurance', 'other', 'cotton', 'seed']

export function sumCashDetails(rows: readonly CashDetail[]): number {
  return rows.reduce((s, r) => s + r.amount, 0)
}

/** The month keys a projection spreads across: from the later of this month
 *  and the window start, through the window end. Empty when there is no end,
 *  or the end has passed — the caller then books it all in the current month. */
export function projectionMonths(args: { todayKey: string; start: string | null; end: string | null }): string[] {
  const startKey = args.start ? args.start.slice(0, 7) : args.todayKey
  let cursor = startKey > args.todayKey ? startKey : args.todayKey
  if (!args.end) return []
  const endKey = args.end.slice(0, 7)
  if (endKey < cursor) return []
  const out: string[] = []
  for (let i = 0; i < 240 && cursor <= endKey; i++) {
    out.push(cursor)
    const [y, m] = cursor.split('-').map(Number)
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }
  return out
}

// ---------------------------------------------------------------------------
// Sale-aware buckets (094): the dollars behind the contract rows and the
// Spot rows come from sale ALLOCATIONS (lib/load-sales), never from a load's
// mirror contract_id — a split load counts each part's share, a settlement
// line that names its contract or says "spot" is attributed by that name,
// and an untagged line is split by the load's shares.
// ---------------------------------------------------------------------------

/** A settlement line as the buckets need it (094 adds the per-line tag). */
export type CashLine = {
  settlement_id: string
  net_bushels: number | string | null
  net_revenue: number | string | null
  contract_id?: string | null
  sale_type?: SaleType | null
}

const num = (v: unknown) => Number(v) || 0

/** The share of a settlement line that belongs to one allocation: a line
 *  tagged with the allocation's contract (or "spot" for a spot part) counts
 *  whole; a line tagged for something else counts nothing; an untagged line
 *  counts the allocation's share of the load. */
export function lineShareFor(line: CashLine, alloc: Pick<SaleAllocation, 'saleType' | 'contractId' | 'share'>): number {
  if (line.contract_id) return alloc.saleType === 'contract' && line.contract_id === alloc.contractId ? 1 : 0
  if (line.sale_type) return line.sale_type === alloc.saleType ? (alloc.saleType === 'contract' ? alloc.share : 1) : 0
  return alloc.share
}

export type ContractCashAgg = {
  /** Σ share × dry bushels on the contract (the delivered rule). */
  delivered: number
  /** Delivered bushels on loads with no settlement line yet. */
  deliveredUnpaid: number
  unpaidLoads: number
  revenueReceived: number
  /** Received dollars by settlement (the drill-down's rows). */
  receivedBySettlement: Map<string, { amount: number; bushels: number; loads: number }>
}

/** Per-contract delivered / unpaid / received, from allocations. Every
 *  contract id that any allocation names gets an entry. */
export function contractCashAggregates(args: {
  loads: ReadonlyArray<SaleLoad>
  sales: ReadonlyArray<LoadSale>
  linesForLoad: (loadId: string) => ReadonlyArray<CashLine>
}): Map<string, ContractCashAgg> {
  const out = new Map<string, ContractCashAgg>()
  const ensure = (id: string) => {
    let a = out.get(id)
    if (!a) { a = { delivered: 0, deliveredUnpaid: 0, unpaidLoads: 0, revenueReceived: 0, receivedBySettlement: new Map() }; out.set(id, a) }
    return a
  }
  for (const [loadId, allocs] of saleAllocations(args.loads, args.sales)) {
    const lines = args.linesForLoad(loadId)
    for (const alloc of allocs) {
      if (alloc.saleType !== 'contract' || !alloc.contractId) continue
      const agg = ensure(alloc.contractId)
      agg.delivered += alloc.bushels
      if (lines.length === 0) {
        agg.deliveredUnpaid += alloc.bushels
        agg.unpaidLoads += 1
        continue
      }
      for (const line of lines) {
        const f = lineShareFor(line, alloc)
        if (f <= 0) continue
        const rev = num(line.net_revenue) * f
        agg.revenueReceived += rev
        const cur = agg.receivedBySettlement.get(line.settlement_id) ?? { amount: 0, bushels: 0, loads: 0 }
        cur.amount += rev
        cur.bushels += num(line.net_bushels) * f
        cur.loads += 1
        agg.receivedBySettlement.set(line.settlement_id, cur)
      }
    }
  }
  return out
}

export type SpotCashResult = {
  details: CashDetail[]
  received: number
  outstanding: number
  /** True when any unsettled load is priced by an estimate (or not priced). */
  estimated: boolean
  settledLoads: number
  unsettledLoads: number
  unsettledBushels: number
}

const defaultBu = (n: number) => Math.round(n).toLocaleString('en-US')
const defaultUsd2 = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const defaultUsd0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/**
 * The Spot row's cash: settled loads → Received in the settlement's month;
 * unsettled loads → Outstanding in the current month at each load's current
 * price; NEVER Projected (spot has no target — only what has been delivered).
 */
export function spotCashRows(args: {
  spot: VirtualSpotContract
  label: string
  href?: string
  linesForLoad: (loadId: string) => ReadonlyArray<CashLine>
  settlementMonth: (settlementId: string) => string | null
  settlementLabel: (settlementId: string) => string
  settlementHref?: (settlementId: string) => string
  thisMonth: string
  /** Entity share (1 unfiltered). */
  share?: number
  fmtBu?: (n: number) => string
  fmtUsd?: (n: number) => string
}): SpotCashResult {
  const share = args.share ?? 1
  const fmtBu = args.fmtBu ?? defaultBu
  const fmtUsd = args.fmtUsd ?? defaultUsd2
  const shareNote = share < 1 ? ` · ${Math.round(share * 100)}% entity share` : ''
  const bySettlement = new Map<string, { amount: number; bushels: number; loads: number }>()
  let outstanding = 0, unsettledLoads = 0, unsettledBushels = 0, settledLoads = 0
  let estimated = false
  for (const r of args.spot.rows) {
    const lines = args.linesForLoad(r.load.id)
    if (lines.length === 0) {
      const price = r.alloc.sale?.spot_price ?? null
      const src = r.alloc.sale?.spot_price_source ?? null
      if (price == null || src === 'estimate') estimated = true
      outstanding += r.alloc.bushels * (price ?? 0)
      unsettledLoads += 1
      unsettledBushels += r.alloc.bushels
      continue
    }
    settledLoads += 1
    for (const line of lines) {
      const f = lineShareFor(line, r.alloc)
      if (f <= 0) continue
      const cur = bySettlement.get(line.settlement_id) ?? { amount: 0, bushels: 0, loads: 0 }
      cur.amount += num(line.net_revenue) * f
      cur.bushels += num(line.net_bushels) * f
      cur.loads += 1
      bySettlement.set(line.settlement_id, cur)
    }
  }
  const details: CashDetail[] = []
  let received = 0
  for (const [settlementId, r] of bySettlement) {
    const month = args.settlementMonth(settlementId)
    if (!month) continue
    received += r.amount * share
    details.push({
      kind: 'received', month, amount: r.amount * share, status: 'received',
      label: args.settlementLabel(settlementId),
      sub: `${args.label} · ${fmtBu(r.loads)} load${r.loads === 1 ? '' : 's'} · ${fmtBu(r.bushels * share)} bu${shareNote}`,
      href: args.settlementHref?.(settlementId),
    })
  }
  const avg = unsettledBushels > 0 ? outstanding / unsettledBushels : 0
  outstanding *= share
  if (outstanding > 0) {
    details.push({
      kind: 'outstanding', month: args.thisMonth, amount: outstanding, status: 'outstanding',
      label: args.label,
      sub: `${fmtBu(unsettledLoads)} load${unsettledLoads === 1 ? '' : 's'} delivered, not yet on a settlement · ${fmtBu(unsettledBushels * share)} bu × ${fmtUsd(avg)}${estimated ? ' (est. — current price until the settlement arrives)' : ''}${shareNote}`,
      href: args.href,
    })
  }
  return { details, received, outstanding, estimated, settledLoads, unsettledLoads, unsettledBushels }
}

export type PriceLaterInfo = {
  bushels: number
  /** Σ bushels × today's price where a price is known; null when none is. */
  value: number | null
  /** Bushels with no price assumption to value them at. */
  unvaluedBushels: number
  /** "4,200 bu unpriced at buyers (~$52,000 at today's price)". */
  text: string
  byCrop: Array<{ cropId: string; cropYear: number; bushels: number; value: number | null }>
}

/** The price-later line under the Cash Flow table — no dated cash, just the
 *  bushels waiting to be priced and what they are worth at today's price
 *  (assumed futures + assumed basis, or the page's market quote). */
export function priceLaterInfo(args: {
  pools: ReadonlyArray<PriceLaterPool>
  /** Today's cash price for the crop (assumed futures + basis, or a quote); null when unknown. */
  priceFor: (cropId: string, cropYear: number) => number | null
  cropName?: (cropId: string) => string | null | undefined
  share?: number | ((pool: PriceLaterPool) => number)
  fmtBu?: (n: number) => string
  fmtUsd?: (n: number) => string
}): PriceLaterInfo | null {
  const fmtBu = args.fmtBu ?? defaultBu
  const fmtUsd = args.fmtUsd ?? defaultUsd0
  const byKey = new Map<string, PriceLaterInfo['byCrop'][number]>()
  for (const p of args.pools) {
    const share = typeof args.share === 'function' ? args.share(p) : args.share ?? 1
    if (share <= 0 || p.bushels <= 0) continue
    const key = `${p.crop_id}|${p.crop_year}`
    const price = args.priceFor(p.crop_id, p.crop_year)
    const bu = p.bushels * share
    const cur = byKey.get(key) ?? { cropId: p.crop_id, cropYear: p.crop_year, bushels: 0, value: price == null ? null : 0 }
    cur.bushels += bu
    if (price != null) cur.value = (cur.value ?? 0) + bu * price
    byKey.set(key, cur)
  }
  const byCrop = [...byKey.values()]
  const bushels = byCrop.reduce((s, c) => s + c.bushels, 0)
  if (bushels <= 0) return null
  const valued = byCrop.filter((c) => c.value != null)
  const value = valued.length > 0 ? valued.reduce((s, c) => s + (c.value ?? 0), 0) : null
  const unvaluedBushels = byCrop.filter((c) => c.value == null).reduce((s, c) => s + c.bushels, 0)
  const parts = byCrop.length > 1 && args.cropName
    ? ` — ${byCrop.map((c) => `${fmtBu(c.bushels)} bu ${args.cropName!(c.cropId) ?? 'crop'} ${c.cropYear}`).join(' · ')}`
    : ''
  const worth = value == null
    ? ' (no price assumption set yet — add one under Marketing to value them)'
    : ` (~${fmtUsd(value)} at today's price${unvaluedBushels > 0 ? `; ${fmtBu(unvaluedBushels)} bu have no price assumption` : ''})`
  return {
    bushels, value, unvaluedBushels, byCrop,
    text: `${fmtBu(bushels)} bu unpriced at buyers${worth}${parts}`,
  }
}
