// The "Hedging summary by crop year" cards — ONE pure rule (2026-10-13).
//
// Bushels hedged = the OPEN futures only. A rolled hedge replaces its old
// leg with a new one; the old leg is closed and its result is realized. The
// card used to add every lot ever traded in the crop year, so 23 DEC 26
// cotton rolled into 23 MAR 27 read as "46 contracts hedged" while the
// table below showed 23. Closed lots now contribute only their realized
// result (and a "closed this year" line so the traded history is still
// visible). Options follow the same rule.
//
// Tested in lib/hedging-summary.test.ts.

import type { Commodity } from '@/lib/hedging'

export type SummaryFuturesInput = {
  crop_year: number
  commodity: string
  status: string
  num_contracts: number
  trade_price: number | string
}

export type SummaryOptionInput = {
  crop_year: number
  commodity: string
  status: string
  num_contracts: number
  side: 'buy' | 'sell' | string
}

export type SummaryLeg = {
  /** Open contracts (the hedge in force). */
  contracts: number
  /** Open quantity in the commodity's unit (bu / lbs). */
  quantity: number
  /** Σ open trade price × contracts — avg hedge price = priceWeight / contracts. */
  priceWeight: number
  /** Contracts closed (lifted or rolled away) in the crop year. */
  closedContracts: number
  /** Net premium cash on options (buying pays out, selling collects). */
  premium: number
  unrealized: number
  realized: number
  hasOpen: boolean
}

export type CropYearSummary = { cropYear: number; commodity: Commodity; fut: SummaryLeg; opt: SummaryLeg }

export const emptySummaryLeg = (): SummaryLeg => ({ contracts: 0, quantity: 0, priceWeight: 0, closedContracts: 0, premium: 0, unrealized: 0, realized: 0, hasOpen: false })

export function summarizeByCropYear<F extends SummaryFuturesInput, O extends SummaryOptionInput>(args: {
  futures: ReadonlyArray<F>
  options: ReadonlyArray<O>
  quantityFor: (commodity: string, contracts: number) => number
  /** Unrealized P&L of an OPEN futures position (null when unpriced). */
  futuresUnrealized: (p: F) => number | null
  /** Realized P&L net of commission of a CLOSED futures position. */
  futuresRealized: (p: F) => number
  optionUnrealized: (o: O) => number | null
  optionRealized: (o: O) => number
  /** Signed premium cash for an option (negative = paid). */
  optionPremium: (o: O) => number
}): CropYearSummary[] {
  const m = new Map<string, CropYearSummary>()
  const get = (cropYear: number, commodity: string) => {
    const key = `${cropYear}|${commodity}`
    let cur = m.get(key)
    if (!cur) { cur = { cropYear, commodity: commodity as Commodity, fut: emptySummaryLeg(), opt: emptySummaryLeg() }; m.set(key, cur) }
    return cur
  }
  for (const p of args.futures) {
    const f = get(p.crop_year, p.commodity).fut
    if (p.status === 'open') {
      f.contracts += p.num_contracts
      f.quantity += args.quantityFor(p.commodity, p.num_contracts)
      f.priceWeight += Number(p.trade_price) * p.num_contracts
      f.unrealized += args.futuresUnrealized(p) ?? 0
      f.hasOpen = true
    } else {
      f.closedContracts += p.num_contracts
      f.realized += args.futuresRealized(p)
    }
  }
  for (const o of args.options) {
    const g = get(o.crop_year, o.commodity).opt
    g.premium += args.optionPremium(o)
    if (o.status === 'open') {
      g.contracts += o.num_contracts
      g.quantity += args.quantityFor(o.commodity, o.num_contracts)
      g.unrealized += args.optionUnrealized(o) ?? 0
      g.hasOpen = true
    } else {
      g.closedContracts += o.num_contracts
      g.realized += args.optionRealized(o)
    }
  }
  return Array.from(m.values()).sort((a, b) => b.cropYear - a.cropYear || a.commodity.localeCompare(b.commodity))
}

/** True when a leg has anything to show: an open hedge or a closed result. */
export function legHasActivity(leg: SummaryLeg): boolean {
  return leg.contracts > 0 || leg.closedContracts > 0
}
