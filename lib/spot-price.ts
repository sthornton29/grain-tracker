// The price of a SPOT load — ONE pure rule (094, 2026-10-13).
//
// A spot load is priced at the buyer's posted bid the day it was delivered.
// We usually learn that price only when the settlement arrives, so until then
// the app estimates it. In order:
//
//   1. 'settlement' — the matched settlement line's price per bushel. Always
//      wins; when it lands the row flips to this source.
//   2. 'entered'    — the bid the farmer typed at delivery ("Bid $/bu (if you
//      know it)").
//   3. 'estimate'   — the futures settle on the delivery date for the month
//      the elevator bids off (deliveryFuturesSymbol: the nearest listed month
//      whose first notice day is after the delivery date) PLUS a basis: the
//      buyer's implied spot basis from its most recent SETTLED spot loads of
//      the same crop (settled price − that day's futures settle; the average
//      of those within 30 days of the delivery, else the latest one), or the
//      crop's assumed basis from Marketing assumptions when the buyer has no
//      history. With no settle on file for that date the estimate uses
//      today's quote and says so ("est. (today's futures)").
//
// The estimate's futures, symbol and basis are stored on the row so the chip
// can explain itself: "est. $13.39 (ZSX26 9/28 close + Bunge basis +0.19)".
// Tested in lib/spot-price.test.ts with FIXTURE futures values.

import { COMMODITY_SPECS, buildContractSymbol, type Commodity } from '@/lib/hedging'
import { cropToHedgeCommodity } from '@/lib/contracts'
import { contractMonthLabel } from '@/lib/reference-contract'
import type { LoadSale, SaleAllocation, SpotPriceSource } from '@/lib/load-sales'

const MONTH_NUM_BY_CODE: Record<string, number> = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 }

/** First notice day of a delivery month, CBOT grain convention: the last
 *  calendar day of the month before. */
export function firstNoticeDay(monthNum: number, year: number): Date {
  return new Date(year, monthNum - 1, 0)
}

export type DeliveryFutures = { symbol: string; contractMonth: string; monthNum: number; year: number; commodity: Commodity }

/**
 * The futures month an elevator bids off on a delivery date: the nearest
 * listed month whose first notice day is AFTER that date (a 9/28 soybean
 * delivery → ZSX26; a Nov 5 delivery → ZSF27, since NOV's notice period
 * opened Oct 31). Null for crops with no traded future (canola, sesame).
 */
export function deliveryFuturesSymbol(cropName: string | null | undefined, deliveryDate: string | Date): DeliveryFutures | null {
  const commodity = cropToHedgeCommodity(cropName)
  if (!commodity) return null
  const d = typeof deliveryDate === 'string' ? parseISODate(deliveryDate) : deliveryDate
  if (!d) return null
  const months = COMMODITY_SPECS[commodity].contractMonths.map((c) => MONTH_NUM_BY_CODE[c]).sort((a, b) => a - b)
  for (let year = d.getFullYear(); year <= d.getFullYear() + 2; year++) {
    for (const m of months) {
      if (firstNoticeDay(m, year).getTime() > d.getTime()) {
        const contractMonth = contractMonthLabel(m, year)
        return { symbol: buildContractSymbol(commodity, contractMonth), contractMonth, monthNum: m, year, commodity }
      }
    }
  }
  return null
}

function parseISODate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function daysBetween(a: string, b: string): number {
  const da = parseISODate(a), db = parseISODate(b)
  if (!da || !db) return Number.POSITIVE_INFINITY
  return Math.abs(Math.round((da.getTime() - db.getTime()) / 86400000))
}

/** A settled spot load with the futures settle on its delivery date. */
export type SettledSpotPoint = { date: string; settledPrice: number; futuresSettle: number }

export type ImpliedBasis = {
  basis: number
  /** How many settled loads the figure averages (1 = the latest alone). */
  count: number
  /** The delivery date(s) behind it, newest first. */
  dates: string[]
}

/**
 * The buyer's implied spot basis for a crop as of a delivery date: the
 * average over its settled spot loads delivered within 30 days before (or
 * on) that date; when none are that recent, the latest settled load on its
 * own. Null with no history at all.
 */
export function impliedBuyerBasis(history: ReadonlyArray<SettledSpotPoint>, asOf: string): ImpliedBasis | null {
  const pts = history
    .filter((h) => h.date <= asOf && Number.isFinite(h.settledPrice) && Number.isFinite(h.futuresSettle))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  if (pts.length === 0) return null
  const recent = pts.filter((p) => daysBetween(p.date, asOf) <= 30)
  const use = recent.length > 0 ? recent : [pts[0]]
  const basis = use.reduce((s, p) => s + (p.settledPrice - p.futuresSettle), 0) / use.length
  return { basis: round6(basis), count: use.length, dates: use.map((p) => p.date) }
}

export type SpotEstimateInputs = {
  /** The futures settle for the delivery date's bid month, or today's quote. */
  futures: { price: number; symbol: string; priceDate: string | null; isToday: boolean } | null
  /** The buyer's implied basis (impliedBuyerBasis), null without history. */
  buyerBasis: ImpliedBasis | null
  /** The crop's assumed basis from Marketing assumptions (0 when unset). */
  assumedBasis: number
  buyerName?: string | null
}

export type SpotPriceDecision = {
  price: number | null
  source: SpotPriceSource | null
  /** The chip: "settled $13.74" · "your bid $13.74" · "est. $13.39 (ZSX26 9/28 close + Bunge basis +0.19)". */
  label: string
  est_futures_price: number | null
  est_futures_symbol: string | null
  est_basis: number | null
  /** Which basis the estimate used. */
  basisSource: 'buyer' | 'assumed' | null
  /** True when the estimate had to use today's quote instead of a settle on the delivery date. */
  usedTodaysFutures: boolean
}

/** Decide a spot row's price. */
export function resolveSpotPrice(args: {
  settlementPrice?: number | null
  enteredBid?: number | null
  estimate?: SpotEstimateInputs | null
}): SpotPriceDecision {
  const none: SpotPriceDecision = { price: null, source: null, label: 'no price yet', est_futures_price: null, est_futures_symbol: null, est_basis: null, basisSource: null, usedTodaysFutures: false }
  if (args.settlementPrice != null && Number.isFinite(args.settlementPrice)) {
    return { ...none, price: round6(args.settlementPrice), source: 'settlement', label: `settled ${fmtPrice(args.settlementPrice)}` }
  }
  if (args.enteredBid != null && Number.isFinite(args.enteredBid) && args.enteredBid > 0) {
    return { ...none, price: round6(args.enteredBid), source: 'entered', label: `your bid ${fmtPrice(args.enteredBid)}` }
  }
  const est = args.estimate
  if (!est || !est.futures) return none
  const basisSource: 'buyer' | 'assumed' = est.buyerBasis ? 'buyer' : 'assumed'
  const basis = est.buyerBasis ? est.buyerBasis.basis : est.assumedBasis
  const price = round6(est.futures.price + basis)
  const basisText = basisSource === 'buyer'
    ? `${est.buyerName ? `${est.buyerName} basis` : 'buyer basis'} ${fmtBasis(basis)}`
    : `assumed basis ${fmtBasis(basis)}`
  const futuresText = est.futures.isToday
    ? "today's futures"
    : `${est.futures.symbol} ${est.futures.priceDate ? shortDate(est.futures.priceDate) + ' ' : ''}close`
  return {
    price,
    source: 'estimate',
    label: `est. ${fmtPrice(price)} (${futuresText} + ${basisText})`,
    est_futures_price: round6(est.futures.price),
    est_futures_symbol: est.futures.symbol,
    est_basis: round6(basis),
    basisSource,
    usedTodaysFutures: est.futures.isToday,
  }
}

/** The chip for a stored spot row (what the loads list, contract detail and
 *  Unpaid print beside the price). */
export function spotPriceChip(sale: Pick<LoadSale, 'spot_price' | 'spot_price_source' | 'est_futures_price' | 'est_futures_symbol' | 'est_basis'>, buyerName?: string | null): string {
  if (sale.spot_price == null || sale.spot_price_source == null) return 'no price yet'
  const p = fmtPrice(sale.spot_price)
  if (sale.spot_price_source === 'settlement') return `settled ${p}`
  if (sale.spot_price_source === 'entered') return `your bid ${p}`
  if (sale.est_futures_price != null && sale.est_basis != null) {
    const sym = sale.est_futures_symbol ?? 'futures'
    return `est. ${p} (${sym} close + ${buyerName ? `${buyerName} basis` : 'basis'} ${fmtBasis(sale.est_basis)})`
  }
  return `est. ${p}`
}

export type SpotSummary = {
  bushels: number
  /** Σ price × bushels over PRICED rows. */
  revenue: number
  /** Bushel-weighted average over priced rows, null with none priced. */
  avgPrice: number | null
  loadCount: number
  settledCount: number
  enteredCount: number
  estimatedCount: number
  unpricedCount: number
  /** Bushels with no price at all (never estimated) — excluded from avgPrice. */
  unpricedBushels: number
  /** Rows that carry a futures value (estimates): their bushels, weighted
   *  futures and implied basis — null unless EVERY priced row has one. */
  futures: { bushels: number; avgFutures: number; avgBasis: number } | null
  /** "5 of 5 settled" · "4 of 5 settled · est. on 1" · "no loads". */
  statusText: string
}

/** Summarize spot allocations (one crop × year, or one buyer within it). */
export function spotSummary(allocs: ReadonlyArray<SaleAllocation>): SpotSummary {
  let bushels = 0, revenue = 0, pricedBu = 0, unpricedBushels = 0
  let settledCount = 0, enteredCount = 0, estimatedCount = 0, unpricedCount = 0
  let futBu = 0, futW = 0, basisW = 0, futRows = 0, pricedRows = 0
  for (const a of allocs) {
    if (a.saleType !== 'spot') continue
    bushels += a.bushels
    const s = a.sale
    const price = s?.spot_price ?? null
    if (price == null) { unpricedCount++; unpricedBushels += a.bushels; continue }
    pricedRows++
    pricedBu += a.bushels
    revenue += price * a.bushels
    if (s?.spot_price_source === 'settlement') settledCount++
    else if (s?.spot_price_source === 'entered') enteredCount++
    else estimatedCount++
    if (s?.est_futures_price != null) {
      futRows++
      futBu += a.bushels
      futW += s.est_futures_price * a.bushels
      basisW += (price - s.est_futures_price) * a.bushels
    }
  }
  const loadCount = allocs.filter((a) => a.saleType === 'spot').length
  const avgPrice = pricedBu > 0 ? round6(revenue / pricedBu) : null
  const futures = pricedRows > 0 && futRows === pricedRows && futBu > 0
    ? { bushels: futBu, avgFutures: round6(futW / futBu), avgBasis: round6(basisW / futBu) }
    : null
  const parts: string[] = []
  if (loadCount === 0) parts.push('no loads')
  else {
    parts.push(`${settledCount} of ${loadCount} settled`)
    if (estimatedCount > 0) parts.push(`est. on ${estimatedCount}`)
    if (enteredCount > 0) parts.push(`your bid on ${enteredCount}`)
    if (unpricedCount > 0) parts.push(`${unpricedCount} unpriced`)
  }
  return {
    bushels, revenue, avgPrice, loadCount, settledCount, enteredCount, estimatedCount, unpricedCount, unpricedBushels, futures,
    statusText: parts.join(' · '),
  }
}

export function fmtPrice(n: number): string {
  return `$${n.toFixed(2)}`
}
function fmtBasis(n: number): string {
  const sign = n >= 0 ? '+' : '−'
  return `${sign}${Math.abs(n).toFixed(2)}`
}
function shortDate(iso: string): string {
  const d = parseISODate(iso)
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : iso
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
