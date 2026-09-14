// Roll detection for the brokerage-statement review (083). Pure.
//
// A roll on a statement is a closed offset group in commodity X paired with
// a newly opened position in the same commodity, same side, a DIFFERENT
// contract month, filled the SAME day the group closed. Strongest when the
// Confirmation legs carry the spread code (S / SE — the two legs were one
// spread order); a same-day close + open without the code is still a roll,
// just with less certainty ("treat as roll?"). A roll of fewer lots than the
// position held is a partial roll (the close spins the rolled lots off).
//
// Only the pairing lives here. What a confirmed roll does (close + open +
// linkage in one transaction, crop year inherited) is hedge_execute_roll in
// supabase/083 — see lib/hedge-roll.ts for the payload.

import { normalizeTradeDate } from '@/lib/statement-matching'

export type RollConfidence = 'high' | 'medium' | 'low'

export type RollDetectLot = {
  contracts: number
  open_price: number
  open_date: string
  /** The open DB position this lot closes (null = not held in the app). */
  matchedOpenId: string | null
  /** Contracts the matched DB position holds (null when not matched). */
  heldContracts: number | null
  alreadyImported: boolean
  /** Crop year known for this lot (from the matched DB position). */
  crop_year: number | string | null
}

export type RollDetectGroup = {
  key: string
  commodity: string
  contract_month: string
  side: 'long' | 'short'
  close_date: string
  close_price: number
  close_execution_code?: string | null
  lots: RollDetectLot[]
}

export type RollDetectOpen = {
  key: string
  commodity: string
  contract_month: string
  side: 'long' | 'short'
  num_contracts: number
  trade_date: string
  trade_price: number
  execution_code?: string | null
  /** Already recorded in the app (the review would otherwise skip it). */
  existingId?: string | null
}

export type RollCandidate = {
  closedKey: string
  openKey: string
  commodity: string
  side: 'long' | 'short'
  fromMonth: string
  toMonth: string
  /** YYYY-MM-DD, the day both legs traded. */
  date: string
  closedContracts: number
  openContracts: number
  closePrice: number
  openPrice: number
  /** openPrice − closePrice per unit: what the roll added to the entry. */
  spreadPerUnit: number
  /** Either leg carried the S / SE spread code. */
  spreadCode: boolean
  /** Fewer lots rolled than the matched position holds. */
  partial: boolean
  /** The closed and opened contract counts differ. */
  countMismatch: boolean
  confidence: RollConfidence
  /** Plain-language reasons shown beside the confidence chip. */
  reasons: string[]
  /** Whether "treat as roll" starts checked. */
  defaultOn: boolean
  /** Crop year the new leg inherits — known when a lot matched a stored position. */
  inheritedCropYear: number | null
  /** True when every closed lot is already a stored closed row (link only). */
  closedAlreadyRecorded: boolean
  /** True when the opened leg is already a stored position (link only). */
  openAlreadyRecorded: boolean
}

/** S and SE are the spread codes; E (electronic) is not. Case/space tolerant. */
export function isSpreadCode(code: string | null | undefined): boolean {
  const c = (code ?? '').trim().toUpperCase()
  return c === 'S' || c === 'SE' || c === 'ES'
}

function monthKey(m: string): string {
  return m.trim().toUpperCase()
}

export function detectRolls(groups: readonly RollDetectGroup[], opens: readonly RollDetectOpen[]): RollCandidate[] {
  const out: RollCandidate[] = []
  const usedOpens = new Set<string>()

  for (const g of groups) {
    const closeDate = normalizeTradeDate(g.close_date)
    if (!closeDate) continue
    const closedContracts = g.lots.reduce((s, l) => s + (l.contracts ?? 0), 0)
    if (closedContracts <= 0) continue
    const groupSpread = isSpreadCode(g.close_execution_code)

    const candidates = opens.filter(
      (o) =>
        !usedOpens.has(o.key) &&
        o.commodity === g.commodity &&
        o.side === g.side &&
        monthKey(o.contract_month) !== monthKey(g.contract_month) &&
        normalizeTradeDate(o.trade_date) === closeDate &&
        o.num_contracts > 0,
    )
    if (candidates.length === 0) continue

    // Best pairing: exact contract count first, then a spread code, then the
    // smallest count difference, then statement order.
    const score = (o: RollDetectOpen, i: number) =>
      (o.num_contracts === closedContracts ? 0 : 1) * 1_000_000 +
      (isSpreadCode(o.execution_code) || groupSpread ? 0 : 1) * 100_000 +
      Math.abs(o.num_contracts - closedContracts) * 1000 +
      i
    let best: RollDetectOpen | null = null
    let bestScore = Number.POSITIVE_INFINITY
    candidates.forEach((o, i) => {
      const s = score(o, i)
      if (s < bestScore) { best = o; bestScore = s }
    })
    const open = best! as RollDetectOpen
    usedOpens.add(open.key)

    const spreadCode = groupSpread || isSpreadCode(open.execution_code)
    const partial = g.lots.some((l) => l.heldContracts != null && l.contracts < l.heldContracts)
    const countMismatch = open.num_contracts !== closedContracts
    const reasons: string[] = []
    if (spreadCode) reasons.push('spread order on the statement')
    else reasons.push('separate close and open the same day, no spread code')
    if (partial) reasons.push('fewer lots rolled than held')
    if (countMismatch) reasons.push(`closed ${closedContracts}, opened ${open.num_contracts}`)

    let confidence: RollConfidence
    if (countMismatch) confidence = 'low'
    else if (spreadCode && !partial) confidence = 'high'
    else confidence = 'medium'

    const matchedYear = g.lots.map((l) => l.crop_year).find((y) => y != null && y !== '')
    out.push({
      closedKey: g.key,
      openKey: open.key,
      commodity: g.commodity,
      side: g.side,
      fromMonth: monthKey(g.contract_month),
      toMonth: monthKey(open.contract_month),
      date: closeDate,
      closedContracts,
      openContracts: open.num_contracts,
      closePrice: g.close_price,
      openPrice: open.trade_price,
      spreadPerUnit: Math.round((open.trade_price - g.close_price) * 1e6) / 1e6,
      spreadCode,
      partial,
      countMismatch,
      confidence,
      reasons,
      defaultOn: confidence !== 'low',
      inheritedCropYear: matchedYear != null ? Number(matchedYear) : null,
      closedAlreadyRecorded: g.lots.length > 0 && g.lots.every((l) => l.alreadyImported),
      openAlreadyRecorded: open.existingId != null,
    })
  }
  return out
}
