// The settlement's sale review — ours vs the buyer's, per matched load
// (094, 2026-10-13). Pure; tested in lib/settlement-sale-review.test.ts.
//
// The New Settlement screen and the saved settlement's "Re-read contract
// assignments" action both run the same steps:
//
//   1. ticketGroups over the kept lines (lib/settlement-sales) — one group
//      per ticket, a ticket under two contract blocks being ONE split load.
//   2. Each line's printed contract text resolves to one of the buyer's
//      contracts (sameContractNumber), or to the contract the user linked
//      it to in the review ("Link to contract"). Unresolved text blocks the
//      contract part until it is linked.
//   3. The buyer's allocation (allocationFromGroup) is compared with OURS
//      (saleAllocations over the load's stored rows). When they differ the
//      review shows both, the buyer's pre-selected, with "Keep ours".
//   4. buildApplyPlan turns the choices into what to write: the load_sales
//      rows per load (writeManyLoadSales) and the per-line sale columns on
//      settlement_lines. "Keep ours" writes nothing for the load — except
//      that a spot row of ours still takes the settlement's PRICE (the
//      settlement always wins on price).

import {
  allocationDiffers,
  allocationFromGroup,
  contractNumberKey,
  sameContractNumber,
  ticketGroups,
  type SaleLine,
  type TicketGroup,
} from '@/lib/settlement-sales'
import {
  describeSale,
  SALE_TYPE_LABEL,
  type LoadSaleInput,
  type SaleAllocation,
  type SaleType,
  type SpotPriceSource,
} from '@/lib/load-sales'
import { fmtPrice } from '@/lib/spot-price'

export type ReviewContract = {
  id: string
  contract_number: string
  buyer_id?: string | null
  crop_id?: string | null
  crop_year?: number | null
}

/** The user's "Link to contract" picks: contract text key → contract id. */
export type ContractLinks = ReadonlyMap<string, string>

/**
 * The contract one line's printed text names: the user's explicit link
 * first, then number equality against the buyer's contracts — the ones on
 * the settlement's crop first, any crop otherwise (a number is a number).
 */
export function resolveContractText(
  text: string | null | undefined,
  contracts: ReadonlyArray<ReviewContract>,
  links?: ContractLinks,
  cropId?: string | null,
): string | null {
  const key = contractNumberKey(text)
  if (!key) return null
  const linked = links?.get(key)
  if (linked) return linked
  const hits = contracts.filter((c) => sameContractNumber(c.contract_number, text))
  if (hits.length === 0) return null
  if (cropId) {
    const sameCrop = hits.find((c) => c.crop_id === cropId)
    if (sameCrop) return sameCrop.id
  }
  return hits[0].id
}

export type SaleChoice = 'theirs' | 'ours'

export type ReviewLineSale = {
  index: number
  /** Null when the line prints no contract text and nothing stands in for
   *  it (a statement with no blocks and no header contract): sale not set. */
  sale_type: SaleType | null
  contract_number_text: string | null
  contract_id: string | null
  /** "S12"-style text: a contract unless the user confirms spot. */
  possiblySpot: boolean
}

export type SpotPriceChange = {
  before: number | null
  beforeSource: SpotPriceSource | null
  after: number
}

export type SaleReviewGroup = {
  ticketKey: string
  ticket: string | null
  group: TicketGroup
  /** The load every line of the ticket matched (null = unmatched). */
  loadId: string | null
  /** Per line: the sale columns to store on settlement_lines. */
  lines: ReviewLineSale[]
  /** The buyer's allocation as rows (empty while a contract line is unresolved). */
  theirs: LoadSaleInput[]
  /** Contract texts that resolve to none of the buyer's contracts. */
  unresolved: string[]
  /** Our stored allocation for the load (null = no load; [] = unassigned). */
  ours: SaleAllocation[] | null
  /** Ours and the buyer's disagree on kinds / contracts / shares. */
  differs: boolean
  /** Our spot row was an estimate or a typed bid and the statement prices it. */
  spotPriceChange: SpotPriceChange | null
}

export type SaleReviewInput = {
  lines: ReadonlyArray<SaleLine>
  /** The load a line matched (the review's match result), by line index. */
  loadIdForLine: (index: number) => string | null
  /** saleAllocations(...) for the matched loads. */
  oursByLoad: ReadonlyMap<string, SaleAllocation[]>
  /** This buyer's contracts, any crop year. */
  contracts: ReadonlyArray<ReviewContract>
  links?: ContractLinks
  /** The settlement's crop when known (the header contract's). */
  cropId?: string | null
}

/** One review group per ticket, with everything the screen and the apply
 *  plan need. Lines are the KEPT lines (summary rows already dropped). */
export function buildSaleReview(input: SaleReviewInput): SaleReviewGroup[] {
  const resolve = (text: string | null) => resolveContractText(text, input.contracts, input.links, input.cropId)
  return ticketGroups(input.lines).map((group) => {
    const loadId = group.lines.map((l) => input.loadIdForLine(l.index)).find((id): id is string => !!id) ?? null
    const lines: ReviewLineSale[] = group.lines.map((l) => ({
      index: l.index,
      sale_type: l.sale_type === 'contract' && !l.cls.contract_number_text ? null : l.sale_type,
      contract_number_text: l.cls.contract_number_text,
      contract_id: l.sale_type === 'contract' ? resolve(l.cls.contract_number_text) : null,
      possiblySpot: l.sale_type === 'contract' && l.cls.possiblySpot,
    }))
    const theirsRaw = allocationFromGroup(group, resolve)
    // A contract part with no number at all can't be written — the sale
    // stays unknown for that load (no rows, nothing blocked by a link).
    const theirs = theirsRaw.rows.some((r) => r.sale_type === 'contract' && !r.contract_id) ? [] : theirsRaw.rows
    const unresolved = theirsRaw.unresolved
    const ours = loadId ? input.oursByLoad.get(loadId) ?? [] : null
    const differs = ours != null && theirs.length > 0 && (ours.length === 0 || allocationDiffers(ours, theirs))
    return {
      ticketKey: group.ticketKey,
      ticket: group.ticket_number,
      group,
      loadId,
      lines,
      theirs,
      unresolved: [...new Set(unresolved)],
      ours,
      differs,
      spotPriceChange: spotPriceChangeFor(ours, group),
    }
  })
}

/** The settlement's spot price vs the price our spot row carried — shown
 *  once per load when ours was an estimate or a typed bid. */
export function spotPriceChangeFor(ours: ReadonlyArray<SaleAllocation> | null, group: TicketGroup): SpotPriceChange | null {
  if (!ours) return null
  const mine = ours.find((a) => a.saleType === 'spot')
  if (!mine) return null
  const settled = settlementSpotPrice(group)
  if (settled == null) return null
  const before = mine.sale?.spot_price ?? null
  const source = mine.sale?.spot_price_source ?? null
  if (source === 'settlement' && before != null && Math.abs(before - settled) < 0.0005) return null
  return { before, beforeSource: source, after: settled }
}

/** The group's spot line price (gross ÷ net bushels), or null. */
export function settlementSpotPrice(group: TicketGroup): number | null {
  const spot = group.lines.find((l) => l.sale_type === 'spot' && l.grossPrice != null)
  return spot?.grossPrice ?? null
}

/** "est. $13.39, settled $13.38" / "your bid $13.39, settled $13.38". */
export function spotPriceChangeText(c: SpotPriceChange): string {
  const after = `settled ${fmtPrice(c.after)}`
  if (c.before == null) return `spot price not set, ${after}`
  const before = c.beforeSource === 'estimate' ? `est. ${fmtPrice(c.before)}` : c.beforeSource === 'entered' ? `your bid ${fmtPrice(c.before)}` : `was ${fmtPrice(c.before)}`
  return `${before}, ${after}`
}

const fmtBu = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 }))

function partText(saleType: SaleType, contractId: string | null | undefined, contractNumber: (id: string) => string | null | undefined): string {
  if (saleType === 'contract') return `contract ${contractNumber(contractId ?? '') ?? '?'}`
  return saleType === 'spot' ? 'spot' : 'price later'
}

/** The buyer's allocation in words: "all on contract 2002960604-10" ·
 *  "all spot" · "58.3 bu contract 2002960604-10, 912.7 bu spot". */
export function describeTheirs(rows: ReadonlyArray<LoadSaleInput>, contractNumber: (id: string) => string | null | undefined): string {
  if (rows.length === 0) return ''
  if (rows.length === 1) {
    const r = rows[0]
    return r.sale_type === 'contract' ? `all on ${partText('contract', r.contract_id, contractNumber)}` : `all ${partText(r.sale_type, null, contractNumber)}`
  }
  return rows.map((r) => `${fmtBu(Number(r.buyer_net_bushels ?? 0))} bu ${partText(r.sale_type, r.contract_id, contractNumber)}`).join(', ')
}

/** Our allocation in words: "all on contract 2002960604-10" · "all spot" ·
 *  "split: 59 bu contract 2002960604-10 · 916 bu spot" · "no sale picked yet". */
export function describeOurs(allocs: ReadonlyArray<SaleAllocation>, contractNumber: (id: string) => string | null | undefined): string {
  if (allocs.length === 0) return 'no sale picked yet'
  if (allocs.length === 1) {
    const a = allocs[0]
    return a.saleType === 'contract' ? `all on ${partText('contract', a.contractId, contractNumber)}` : `all ${partText(a.saleType, null, contractNumber)}`
  }
  return describeSale(allocs, contractNumber, { to_type: 'buyer' })
}

/** The one-line comparison the review prints:
 *  "Ours: all on contract 2002960604-10 · Bunge: 58.3 bu contract 2002960604-10, 912.7 bu spot". */
export function compareText(g: Pick<SaleReviewGroup, 'ours' | 'theirs'>, contractNumber: (id: string) => string | null | undefined, buyerName: string): string {
  return `Ours: ${describeOurs(g.ours ?? [], contractNumber)} · ${buyerName || 'Buyer'}: ${describeTheirs(g.theirs, contractNumber)}`
}

/** The Sale chip's label for one line: "Contract 2002960604-10" · "Spot" ·
 *  "Price later" · "S12 · possibly spot". Falls back to the header contract
 *  when the line carries no contract text of its own. */
export function saleChipLabel(
  line: { sale_type?: string | null; contract_number_text?: string | null },
  fallbackContractNumber?: string | null,
): string {
  const t = line.sale_type
  if (t === 'spot') return 'Spot'
  if (t === 'price_later') return SALE_TYPE_LABEL.price_later
  const text = (line.contract_number_text ?? '').trim()
  if (text) {
    if (/^s\d{1,4}$/i.test(text) && t !== 'contract') return `${text} · possibly spot`
    return `Contract ${text}`
  }
  if (t === 'contract' || fallbackContractNumber) return fallbackContractNumber ? `Contract ${fallbackContractNumber}` : 'Contract'
  return 'Sale not set'
}

/** The "S12 → it's spot" confirmation: the lines take an explicit sale
 *  type, which ticketGroups honors over the printed text. */
export function withSaleType<L extends SaleLine>(lines: ReadonlyArray<L>, indexes: ReadonlyArray<number>, saleType: SaleType | null): L[] {
  const set = new Set(indexes)
  return lines.map((l, i) => (set.has(i) ? { ...l, sale_type: saleType } : l))
}

export type ApplyPlan = {
  /** The load_sales rows to write per load (writeManyLoadSales). */
  loadWrites: Array<{ loadId: string; rows: LoadSaleInput[] }>
  /** The sale columns per line (by line index). */
  lineUpdates: Array<{ index: number; sale_type: SaleType | null; contract_number_text: string | null; contract_id: string | null }>
  /** Loads left alone because a contract on their lines is still unlinked. */
  blockedLoadIds: string[]
}

/**
 * What applying the review writes. Per matched load: the buyer's rows when
 * that is the choice (the default; always when we had nothing), with each
 * row's settlement_line_id set from `lineIds`; "Keep ours" writes nothing —
 * unless our spot row's price differs from the statement's, in which case
 * our rows go back with the settled price (source 'settlement'). A load
 * whose lines name an unlinked contract is left alone and reported.
 */
export function buildApplyPlan(
  groups: ReadonlyArray<SaleReviewGroup>,
  choices: ReadonlyMap<string, SaleChoice> = new Map(),
  lineIds?: ReadonlyMap<number, string>,
): ApplyPlan {
  const plan: ApplyPlan = { loadWrites: [], lineUpdates: [], blockedLoadIds: [] }
  for (const g of groups) {
    for (const l of g.lines) {
      plan.lineUpdates.push({ index: l.index, sale_type: l.sale_type, contract_number_text: l.contract_number_text, contract_id: l.contract_id })
    }
    if (!g.loadId) continue
    if (g.unresolved.length > 0 || g.theirs.length === 0) { plan.blockedLoadIds.push(g.loadId); continue }
    const ours = g.ours ?? []
    const choice = ours.length === 0 ? 'theirs' : choices.get(g.ticketKey) ?? 'theirs'
    if (choice === 'theirs') {
      const rows = withLineIds(g, lineIds)
      plan.loadWrites.push({ loadId: g.loadId, rows })
      continue
    }
    // Keep ours — but the settlement always wins on PRICE.
    const settled = settlementSpotPrice(g.group)
    const spotLine = g.group.lines.find((l) => l.sale_type === 'spot')
    const mine = ours.find((a) => a.saleType === 'spot')
    if (settled == null || !mine) continue
    const already = mine.sale?.spot_price_source === 'settlement' && mine.sale.spot_price != null && Math.abs(mine.sale.spot_price - settled) < 0.0005
    if (already) continue
    plan.loadWrites.push({
      loadId: g.loadId,
      rows: ours.map((a) => {
        const base = allocationToInput(a)
        if (a.saleType !== 'spot') return base
        return { ...base, spot_price: settled, spot_price_source: 'settlement', settlement_line_id: spotLine ? lineIds?.get(spotLine.index) ?? base.settlement_line_id ?? null : base.settlement_line_id ?? null }
      }),
    })
  }
  return plan
}

/** The buyer's rows for a group with settlement_line_id filled in from the
 *  inserted line ids (when known). */
function withLineIds(g: SaleReviewGroup, lineIds?: ReadonlyMap<number, string>): LoadSaleInput[] {
  if (!lineIds) return g.theirs
  const { rows } = allocationFromGroup(g.group, (text) => resolveFromLines(g, text), lineIds)
  return rows.length > 0 ? rows : g.theirs
}

function resolveFromLines(g: SaleReviewGroup, text: string | null): string | null {
  const key = contractNumberKey(text)
  return g.lines.find((l) => contractNumberKey(l.contract_number_text) === key && l.contract_id)?.contract_id ?? null
}

/** A stored allocation back to writer input (the row as it is). */
export function allocationToInput(a: SaleAllocation): LoadSaleInput {
  const s = a.sale
  return {
    sale_type: a.saleType,
    contract_id: a.saleType === 'contract' ? a.contractId : null,
    share: a.share,
    buyer_net_bushels: s?.buyer_net_bushels ?? null,
    spot_price: s?.spot_price ?? null,
    spot_price_source: s?.spot_price_source ?? null,
    est_futures_price: s?.est_futures_price ?? null,
    est_futures_symbol: s?.est_futures_symbol ?? null,
    est_basis: s?.est_basis ?? null,
    settlement_line_id: s?.settlement_line_id ?? null,
  }
}

/** The distinct unresolved contract texts across the review, keyed for the
 *  "Link to contract" select (one pick covers every line printing it). */
export function unresolvedContractTexts(groups: ReadonlyArray<SaleReviewGroup>): Array<{ key: string; text: string; lineCount: number }> {
  const out = new Map<string, { key: string; text: string; lineCount: number }>()
  for (const g of groups) {
    for (const l of g.lines) {
      if (l.sale_type !== 'contract' || l.contract_id || !l.contract_number_text) continue
      const key = contractNumberKey(l.contract_number_text)
      const cur = out.get(key)
      if (cur) cur.lineCount += 1
      else out.set(key, { key, text: l.contract_number_text, lineCount: 1 })
    }
  }
  return [...out.values()]
}

/** Line indexes whose text reads like "S12" and is not yet confirmed. */
export function possiblySpotLines(groups: ReadonlyArray<SaleReviewGroup>): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = []
  for (const g of groups) for (const l of g.lines) if (l.possiblySpot && l.contract_number_text) out.push({ index: l.index, text: l.contract_number_text })
  return out
}

/** The groups the review needs to show (something differs, is unresolved,
 *  or a spot price changes); the rest simply agree. */
export function groupsNeedingReview(groups: ReadonlyArray<SaleReviewGroup>): SaleReviewGroup[] {
  return groups.filter((g) => g.loadId && (g.differs || g.unresolved.length > 0 || g.spotPriceChange != null))
}
