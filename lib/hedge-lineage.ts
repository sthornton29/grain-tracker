// Roll lineage + the effective entry price of a rolled hedge (083).
//
// A roll closes one leg and opens the next month's leg in the same crop's
// hedge. The rows link up as:
//   new leg.rolled_from_position_id → the closed leg it came from
//   roll_group_id                   → shared by the closed leg(s) of ONE roll
//                                     and the leg they rolled into; when that
//                                     leg is itself rolled later, its
//                                     roll_group_id moves to the newer roll
//                                     ("the roll this row was closed into")
//                                     and rolled_from keeps the lineage.
//
// Effective entry price since the ORIGINAL entry = original entry ± the
// cumulative roll spreads:  4.9525 + (5.585 − 5.435) = 5.1025 for a short
// rolled DEC 26 → MAR 27. It is the price the whole crop-year hedge reads at
// — the marketing engine never needs it (realized P&L counted once + open
// legs at their own prices already sums to the same economics, see
// lib/marketing.test.ts), but the person reading the hedging page does.
// Multi-lot closes (two DEC lots rolled together into one MAR lot) weight
// the closed legs by contracts. Pure functions.

import { roundPrice } from '@/lib/hedging'

export type LineagePosition = {
  id: string
  contract_month: string
  trade_price: number | string
  trade_date: string
  num_contracts: number | string
  status: 'open' | 'closed'
  close_price?: number | string | null
  roll_group_id?: string | null
  rolled_from_position_id?: string | null
}

export type RollStep = {
  fromMonth: string
  toMonth: string
  /** Contract-weighted close price of the leg(s) rolled out of. */
  closePrice: number
  openPrice: number
  /** openPrice − closePrice: what the roll added to (or took off) the entry. */
  spread: number
  date: string
  /** Contracts that rolled (Σ of the closed legs). */
  contracts: number
}

export type EffectiveEntry = {
  /** Original entry ± Σ roll spreads — the price the hedge reads at. */
  effectivePrice: number
  /** The entry of the first leg in the lineage (contract-weighted when several). */
  originalEntry: number
  originalMonth: string
  originalDate: string
  /** One step per roll, oldest first. Empty when the position was never rolled into. */
  steps: RollStep[]
}

function num(v: number | string | null | undefined): number {
  return v == null ? 0 : Number(v)
}

/** The closed leg(s) of the roll that produced `newLeg`: the leg it points
 *  back to plus any other member of that roll group that is not itself the
 *  leg the group created. Empty when the position was never rolled into. */
export function rolledFromLegs<T extends LineagePosition>(newLeg: T, all: readonly T[]): T[] {
  if (!newLeg.rolled_from_position_id) return []
  const from = all.find((p) => p.id === newLeg.rolled_from_position_id)
  if (!from) return []
  const group = from.roll_group_id
  if (!group) return [from]
  const members = all.filter((p) => p.roll_group_id === group)
  const memberIds = new Set(members.map((m) => m.id))
  const legs = members.filter(
    (m) => m.id !== newLeg.id && !(m.rolled_from_position_id != null && memberIds.has(m.rolled_from_position_id)),
  )
  if (!legs.some((l) => l.id === from.id)) legs.unshift(from)
  return legs
}

/** The leg(s) a position rolled INTO (forward link). Usually one; a partial
 *  roll can leave siblings. */
export function rolledIntoLegs<T extends LineagePosition>(position: T, all: readonly T[]): T[] {
  return all.filter((p) => p.rolled_from_position_id === position.id)
}

export function effectiveEntry<T extends LineagePosition>(position: T, all: readonly T[]): EffectiveEntry {
  const seen = new Set<string>()
  const walk = (p: T): EffectiveEntry => {
    seen.add(p.id)
    const legs = rolledFromLegs(p, all).filter((l) => !seen.has(l.id))
    if (legs.length === 0) {
      const price = roundPrice(num(p.trade_price))
      return { effectivePrice: price, originalEntry: price, originalMonth: p.contract_month, originalDate: p.trade_date, steps: [] }
    }
    const totalQ = legs.reduce((s, l) => s + num(l.num_contracts), 0) || 1
    let wEntry = 0
    let wOriginal = 0
    let wClose = 0
    let first: EffectiveEntry | null = null
    let steps: RollStep[] = []
    for (const leg of legs) {
      const q = num(leg.num_contracts)
      const inner = walk(leg)
      if (!first || inner.steps.length > steps.length) { first = inner; steps = inner.steps }
      wEntry += inner.effectivePrice * q
      wOriginal += inner.originalEntry * q
      wClose += num(leg.close_price ?? leg.trade_price) * q
    }
    const closePrice = roundPrice(wClose / totalQ)
    const openPrice = roundPrice(num(p.trade_price))
    const spread = roundPrice(openPrice - closePrice)
    const step: RollStep = {
      fromMonth: legs[0].contract_month,
      toMonth: p.contract_month,
      closePrice,
      openPrice,
      spread,
      date: p.trade_date,
      contracts: legs.reduce((s, l) => s + num(l.num_contracts), 0),
    }
    return {
      effectivePrice: roundPrice(wEntry / totalQ + spread),
      originalEntry: roundPrice(wOriginal / totalQ),
      originalMonth: first!.originalMonth,
      originalDate: first!.originalDate,
      steps: [...steps, step],
    }
  }
  return walk(position)
}

/** Origin → … → the newest leg, following rolled_from backwards and the
 *  forward link onwards. The given position is always in the chain. */
export function lineageChain<T extends LineagePosition>(position: T, all: readonly T[]): T[] {
  const back: T[] = []
  const seen = new Set<string>([position.id])
  let cur: T | undefined = position
  while (cur?.rolled_from_position_id) {
    const from = all.find((p) => p.id === cur!.rolled_from_position_id)
    if (!from || seen.has(from.id)) break
    seen.add(from.id)
    back.unshift(from)
    cur = from
  }
  const forward: T[] = []
  let head: T = position
  for (;;) {
    const next: T[] = rolledIntoLegs(head, all).filter((p) => !seen.has(p.id))
    if (next.length === 0) break
    // The largest leg carries the lineage forward (a partial roll's remainder
    // stays behind as the still-open parent).
    next.sort((a: T, b: T) => num(b.num_contracts) - num(a.num_contracts))
    seen.add(next[0].id)
    forward.push(next[0])
    head = next[0]
  }
  return [...back, position, ...forward]
}

/** True when the position is any part of a roll (closed into one or opened by one). */
export function isRolled(position: LineagePosition): boolean {
  return position.rolled_from_position_id != null || position.roll_group_id != null
}
