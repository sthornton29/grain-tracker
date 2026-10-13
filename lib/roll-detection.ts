// Roll detection for the brokerage-statement review (083). Pure.
//
// A roll on a statement is a closed offset group in commodity X paired with
// a newly opened position in the same commodity, same side, a DIFFERENT
// contract month, filled the SAME day the group closed — or SEVERAL such
// fills whose quantities sum exactly to the closed count (the 10/12 cotton
// roll opened MAR 27 as five fills of 3, 12, 3, 3 and 2). Strongest when the
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
  /** The stored position's roll group, when it was already saved as a roll leg. */
  existingRollGroupId?: string | null
}

export type RollCandidate = {
  closedKey: string
  /** The first open leg's key (kept for callers that expect one leg). */
  openKey: string
  /** EVERY open leg of the roll — the fills whose quantities sum to the closed count. */
  openKeys: string[]
  commodity: string
  side: 'long' | 'short'
  fromMonth: string
  toMonth: string
  /** YYYY-MM-DD, the day both legs traded. */
  date: string
  closedContracts: number
  /** Σ of the open legs' contracts. */
  openContracts: number
  closePrice: number
  /** Contract-weighted average of the open legs' prices. */
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
  /** True when every opened leg is already a stored position (link only). */
  openAlreadyRecorded: boolean
  /** The whole roll is already in the app — closed legs recorded AND every
   *  open leg stored with a roll group. Nothing to do; shown as "Already recorded". */
  alreadyRecorded: boolean
}

/** S and SE are the spread codes; E (electronic) is not. Case/space tolerant. */
export function isSpreadCode(code: string | null | undefined): boolean {
  const c = (code ?? '').trim().toUpperCase()
  return c === 'S' || c === 'SE' || c === 'ES'
}

function monthKey(m: string): string {
  return m.trim().toUpperCase()
}

/**
 * The open legs of one roll: the subset of same-month candidates whose
 * quantities sum EXACTLY to the closed count. Preference order: a single
 * exact-count fill with a spread code; the spread-coded fills when they sum
 * exactly; all the month's fills when they sum exactly; a single exact-count
 * fill; the smallest exact subset (spread-coded first). null = no exact set.
 */
export function pickOpenLegs(candidates: readonly RollDetectOpen[], closedContracts: number): RollDetectOpen[] | null {
  const sum = (xs: readonly RollDetectOpen[]) => xs.reduce((s, o) => s + o.num_contracts, 0)
  const spread = candidates.filter((o) => isSpreadCode(o.execution_code))
  const singleSpread = spread.find((o) => o.num_contracts === closedContracts)
  if (singleSpread) return [singleSpread]
  if (spread.length > 0 && sum(spread) === closedContracts) return spread.slice()
  if (sum(candidates) === closedContracts) return candidates.slice()
  const single = candidates.find((o) => o.num_contracts === closedContracts)
  if (single) return [single]
  // Exact subset search (statement order, bounded — a day's fills are few).
  const n = Math.min(candidates.length, 14)
  let best: RollDetectOpen[] | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: RollDetectOpen[] = []
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(candidates[i])
    if (sum(subset) !== closedContracts) continue
    const score = subset.length * 10 + subset.filter((o) => !isSpreadCode(o.execution_code)).length
    if (score < bestScore) { best = subset; bestScore = score }
  }
  return best
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

    // One target month per roll: the month whose fills consume the closed
    // count exactly wins (spread-coded first, then statement order); with no
    // exact set anywhere, fall back to the closest single fill (a count
    // mismatch the reviewer sees as low confidence).
    const months: string[] = []
    for (const o of candidates) if (!months.includes(monthKey(o.contract_month))) months.push(monthKey(o.contract_month))
    let legs: RollDetectOpen[] | null = null
    let legsScore = Number.POSITIVE_INFINITY
    for (const m of months) {
      const picked = pickOpenLegs(candidates.filter((o) => monthKey(o.contract_month) === m), closedContracts)
      if (!picked) continue
      const score = (picked.some((o) => isSpreadCode(o.execution_code)) || groupSpread ? 0 : 1) * 100 + months.indexOf(m)
      if (score < legsScore) { legs = picked; legsScore = score }
    }
    if (!legs) {
      const score = (o: RollDetectOpen, i: number) =>
        (isSpreadCode(o.execution_code) || groupSpread ? 0 : 1) * 100_000 + Math.abs(o.num_contracts - closedContracts) * 1000 + i
      let best: RollDetectOpen | null = null
      let bestScore = Number.POSITIVE_INFINITY
      candidates.forEach((o, i) => {
        const s = score(o, i)
        if (s < bestScore) { best = o; bestScore = s }
      })
      legs = [best! as RollDetectOpen]
    }
    for (const o of legs) usedOpens.add(o.key)

    const openContracts = legs.reduce((s, o) => s + o.num_contracts, 0)
    const openPrice = Math.round((legs.reduce((s, o) => s + o.trade_price * o.num_contracts, 0) / openContracts) * 1e7) / 1e7
    const spreadCode = groupSpread || legs.some((o) => isSpreadCode(o.execution_code))
    const partial = g.lots.some((l) => l.heldContracts != null && l.contracts < l.heldContracts)
    const countMismatch = openContracts !== closedContracts
    const reasons: string[] = []
    if (spreadCode) reasons.push('spread order on the statement')
    else reasons.push('separate close and open the same day, no spread code')
    if (legs.length > 1) reasons.push(`${legs.length} fills make up the new month`)
    if (partial) reasons.push('fewer lots rolled than held')
    if (countMismatch) reasons.push(`closed ${closedContracts}, opened ${openContracts}`)

    let confidence: RollConfidence
    if (countMismatch) confidence = 'low'
    else if (spreadCode && !partial) confidence = 'high'
    else confidence = 'medium'

    const closedAlreadyRecorded = g.lots.length > 0 && g.lots.every((l) => l.alreadyImported)
    const openAlreadyRecorded = legs.every((o) => o.existingId != null)
    const alreadyRecorded = closedAlreadyRecorded && openAlreadyRecorded && legs.every((o) => o.existingRollGroupId != null)
    if (alreadyRecorded) reasons.push('already recorded in Turnrow')

    const matchedYear = g.lots.map((l) => l.crop_year).find((y) => y != null && y !== '')
    out.push({
      closedKey: g.key,
      openKey: legs[0].key,
      openKeys: legs.map((o) => o.key),
      commodity: g.commodity,
      side: g.side,
      fromMonth: monthKey(g.contract_month),
      toMonth: monthKey(legs[0].contract_month),
      date: closeDate,
      closedContracts,
      openContracts,
      closePrice: g.close_price,
      openPrice,
      spreadPerUnit: Math.round((openPrice - g.close_price) * 1e6) / 1e6,
      spreadCode,
      partial,
      countMismatch,
      confidence,
      reasons,
      defaultOn: confidence !== 'low' && !alreadyRecorded,
      inheritedCropYear: matchedYear != null ? Number(matchedYear) : null,
      closedAlreadyRecorded,
      openAlreadyRecorded,
      alreadyRecorded,
    })
  }
  return out
}
