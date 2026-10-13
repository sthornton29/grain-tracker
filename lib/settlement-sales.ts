// Settlement lines → sale allocations (094, 2026-10-13). Pure; tested in
// lib/settlement-sales.test.ts and the Bunge spot fixture.
//
// A settlement prints every ticket under a "Contract Number: X" block. The
// parser now carries that X on EVERY line (SettlementLineExtraction
// .contract_number). This module turns it into sale facts:
//
//   * classifySaleText — "SPOT" / "Spot Sale" / "Cash" / "Open" … → 'spot';
//     "DP" / "Delayed price" / "Price later" → 'price_later'; "S" + digits
//     (S1, S12 — some elevator systems number spot contracts) → 'contract'
//     but POSSIBLY spot, confirmed in review; anything else → 'contract'.
//   * ticketGroups — the same ticket on several lines of ONE statement with
//     DIFFERENT contracts is a SPLIT (one truck finished a contract and the
//     rest went spot), not a duplicate: all its lines match the one load.
//     The same ticket under the SAME contract twice is a true repeat and is
//     flagged. Shares = each line's bushels / the ticket's total buyer
//     bushels; buyer_net_bushels is kept per row.
//   * allocationFromGroup — the buyer's allocation as load_sales rows for the
//     matched load; a spot line's price is its GROSS price per bushel
//     (gross ÷ net bushels — discounts stay separate, as they do for a
//     contract price), source 'settlement'.
//   * allocationDiffers — does the buyer's allocation differ from ours (we
//     said spot, Bunge applied it to the contract; we had all of 0502289 on
//     the contract)? The review shows both with the buyer's pre-selected.

import type { SettlementLineExtraction } from '@/lib/pdf-upload'
import { normalizeTicket } from '@/lib/ticket-matching'
import { sharesFromParts, type LoadSaleInput, type SaleAllocation, type SalePart, type SaleType } from '@/lib/load-sales'

export type SaleTextClass = {
  sale_type: SaleType
  /** "S12"-style numbers: treated as a contract unless the user says spot. */
  possiblySpot: boolean
  /** The printed text, trimmed (null when blank). */
  contract_number_text: string | null
}

const SPOT_WORDS = new Set(['spot', 'spotsale', 'spotsales', 'spotpurchase', 'cash', 'cashsale', 'cashsales', 'cashpurchase', 'open', 'openmarket', 'market', 'spotmarket', 'spotcash', 'nocontract', 'none'])
const PRICE_LATER_WORDS = new Set(['dp', 'delayedprice', 'delayedpricing', 'pricelater', 'pricedlater', 'unpriced', 'openstorage', 'storage', 'stored', 'deferred', 'deferredprice', 'dpc'])

/** Classify the contract text printed over a settlement line. */
export function classifySaleText(text: string | null | undefined): SaleTextClass {
  const raw = (text ?? '').trim()
  const contract_number_text = raw === '' ? null : raw
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (key === '') return { sale_type: 'contract', possiblySpot: false, contract_number_text }
  if (SPOT_WORDS.has(key) || /^spot/.test(key) && !/\d/.test(key)) return { sale_type: 'spot', possiblySpot: false, contract_number_text }
  if (PRICE_LATER_WORDS.has(key) || /^(delayed|pricelater|dp)\b/.test(key)) return { sale_type: 'price_later', possiblySpot: false, contract_number_text }
  if (/^s\d{1,4}$/.test(key)) return { sale_type: 'contract', possiblySpot: true, contract_number_text }
  return { sale_type: 'contract', possiblySpot: false, contract_number_text }
}

export type SaleLine = SettlementLineExtraction & { contract_number?: string | null; sale_type?: string | null }

export type TicketGroupLine = {
  index: number
  line: SaleLine
  cls: SaleTextClass
  sale_type: SaleType
  net_bushels: number
  gross_revenue: number
  /** gross ÷ net bushels — the line's price before discounts. */
  grossPrice: number | null
}

export type TicketGroup = {
  ticketKey: string
  ticket_number: string | null
  lines: TicketGroupLine[]
  totalBuyerBushels: number
  /** More than one line under different contracts/sale kinds. */
  split: boolean
  /** Indexes of lines that repeat an earlier line's contract on this statement. */
  repeatedLineIndexes: number[]
}

/** Lines grouped by ticket, with each line's sale classification. A line's
 *  explicit `sale_type` (set by the review) wins over its contract text. */
export function ticketGroups(lines: ReadonlyArray<SaleLine>): TicketGroup[] {
  const groups = new Map<string, TicketGroup>()
  lines.forEach((line, index) => {
    const key = normalizeTicket(line.ticket_number) || `#${index}`
    const cls = classifySaleText(line.contract_number)
    const explicit = line.sale_type === 'contract' || line.sale_type === 'spot' || line.sale_type === 'price_later' ? (line.sale_type as SaleType) : null
    const sale_type = explicit ?? cls.sale_type
    const net = Number(line.net_bushels ?? 0) || 0
    const gross = Number(line.gross_revenue ?? 0) || 0
    const gl: TicketGroupLine = { index, line, cls, sale_type, net_bushels: net, gross_revenue: gross, grossPrice: net > 0 ? round6(gross / net) : null }
    let g = groups.get(key)
    if (!g) { g = { ticketKey: key, ticket_number: line.ticket_number ?? null, lines: [], totalBuyerBushels: 0, split: false, repeatedLineIndexes: [] }; groups.set(key, g) }
    g.lines.push(gl)
    g.totalBuyerBushels += net
  })
  for (const g of groups.values()) {
    const seen = new Set<string>()
    for (const l of g.lines) {
      const k = saleKey(l)
      if (seen.has(k)) g.repeatedLineIndexes.push(l.index)
      seen.add(k)
    }
    g.split = seen.size > 1
  }
  return [...groups.values()]
}

function saleKey(l: TicketGroupLine): string {
  if (l.sale_type === 'contract') return `contract|${(l.cls.contract_number_text ?? '').toLowerCase()}`
  return l.sale_type
}

/** The sale parts a ticket's lines describe (bushels = the buyer's net
 *  bushels per line), contract ids resolved by the caller's lookup. */
export function salePartsFromGroup(
  group: TicketGroup,
  resolveContract: (contractNumberText: string | null) => string | null,
  lineIds?: ReadonlyMap<number, string>,
): Array<SalePart & { unresolvedContractText: string | null; lineIndex: number }> {
  return group.lines
    .filter((l, i) => !group.repeatedLineIndexes.includes(l.index) || i === 0)
    .map((l) => {
      const contractId = l.sale_type === 'contract' ? resolveContract(l.cls.contract_number_text) : null
      return {
        lineIndex: l.index,
        sale_type: l.sale_type,
        contract_id: contractId,
        unresolvedContractText: l.sale_type === 'contract' && !contractId ? l.cls.contract_number_text : null,
        bushels: l.net_bushels,
        buyer_net_bushels: l.net_bushels,
        spot_price: l.sale_type === 'spot' ? l.grossPrice : null,
        spot_price_source: l.sale_type === 'spot' && l.grossPrice != null ? 'settlement' : null,
        settlement_line_id: lineIds?.get(l.index) ?? null,
      }
    })
}

/** The buyer's allocation as load_sales rows: shares = each line's bushels
 *  over the ticket's total buyer bushels (so they sum to exactly 1 whatever
 *  our dry bushels say). Null when a contract line is unresolved. */
export function allocationFromGroup(
  group: TicketGroup,
  resolveContract: (contractNumberText: string | null) => string | null,
  lineIds?: ReadonlyMap<number, string>,
): { rows: LoadSaleInput[]; unresolved: string[] } {
  const parts = salePartsFromGroup(group, resolveContract, lineIds)
  const unresolved = parts.map((p) => p.unresolvedContractText).filter((t): t is string => t != null)
  if (unresolved.length > 0) return { rows: [], unresolved }
  return { rows: sharesFromParts(parts), unresolved: [] }
}

/** Compare the buyer's rows with our allocation: same kinds, same contracts,
 *  shares within tolerance → not different. */
export function allocationDiffers(
  ours: ReadonlyArray<Pick<SaleAllocation, 'saleType' | 'contractId' | 'share'>>,
  theirs: ReadonlyArray<Pick<LoadSaleInput, 'sale_type' | 'contract_id' | 'share'>>,
  tolerance = 0.005,
): boolean {
  if (ours.length !== theirs.length) return true
  const key = (t: SaleType, c: string | null | undefined) => `${t}|${t === 'contract' ? c ?? '' : ''}`
  const mine = new Map(ours.map((a) => [key(a.saleType, a.contractId), a.share]))
  for (const t of theirs) {
    const s = mine.get(key(t.sale_type, t.contract_id))
    if (s == null || Math.abs(s - t.share) > tolerance) return true
  }
  return false
}

/** Does this line's contract text name the same contract as ours? Compares
 *  digits-only after the leading block ("2002960604-10" = "2002960604-000010"). */
export function sameContractNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = contractNumberKey(a), kb = contractNumberKey(b)
  return ka !== '' && ka === kb
}

/** "2002960604-10" and "2002960604-000010" are the same contract: each dash
 *  segment loses its leading zeros; case and spaces are ignored. */
export function contractNumberKey(s: string | null | undefined): string {
  const t = (s ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (!t) return ''
  return t.split(/[-/]/).map((seg) => (/^\d+$/.test(seg) ? seg.replace(/^0+(?=\d)/, '') : seg)).join('-')
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
