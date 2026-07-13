// Hedging helpers — futures contract symbols, month codes, fractional-cent
// price parsing, and P&L math. Pure functions, no I/O, so they're reused by
// the dashboard, the position forms, and the statement-import flow.

export const COMMODITIES = ['Corn', 'Soybeans', 'Chicago Wheat', 'Cotton'] as const
export type Commodity = (typeof COMMODITIES)[number]
export type Side = 'long' | 'short'

// All CBOT grains we trade are 5,000-bu contracts. Kept as a constant for pure
// math; the commodity_specs table holds the authoritative copy for display.
export const CONTRACT_SIZE_BU = 5000

// Canonical per-commodity spec, mirroring the commodity_specs seed in
// supabase/018_hedging.sql. symbol = futures root, contractMonths = allowed
// delivery-month codes.
export const COMMODITY_SPECS: Record<
  Commodity,
  { symbol: string; contractSizeBu: number; contractMonths: string[] }
> = {
  Corn: { symbol: 'ZC', contractSizeBu: 5000, contractMonths: ['H', 'K', 'N', 'U', 'Z'] },
  Soybeans: { symbol: 'ZS', contractSizeBu: 5000, contractMonths: ['F', 'H', 'K', 'N', 'Q', 'U', 'X'] },
  'Chicago Wheat': { symbol: 'ZW', contractSizeBu: 5000, contractMonths: ['H', 'K', 'N', 'U', 'Z'] },
  // ICE Cotton No. 2 — 50,000 lbs, priced in CENTS/lb (72.65), tick 0.01¢ =
  // $5. December is the new-crop benchmark. contractSizeBu holds LBS.
  Cotton: { symbol: 'CT', contractSizeBu: 50000, contractMonths: ['H', 'K', 'N', 'V', 'Z'] },
}

// The unit a commodity's contract size is measured in (display only).
export function contractUnit(commodity: Commodity | string | null | undefined): 'bu' | 'lbs' {
  return commodity === 'Cotton' ? 'lbs' : 'bu'
}

// Futures P&L size per 1.00 of PRICE: grains are quoted in $/bu so a 1.00
// move is worth the full contract size; cotton is quoted in ¢/lb so a 1.00
// move (1¢) is worth size ÷ 100 = $500/contract. Pass this as contractSizeBu
// into the P&L helpers so (open − close) × contracts × size stays correct.
export function pnlSizeFor(commodity: Commodity | string | null | undefined): number {
  const size = COMMODITY_SPECS[commodity as Commodity]?.contractSizeBu ?? CONTRACT_SIZE_BU
  return commodity === 'Cotton' ? size / 100 : size
}

// Contract quantity in the commodity's own unit (bu for grains, lbs for cotton).
export function quantityFor(commodity: Commodity | string | null | undefined, numContracts: number): number {
  return numContracts * (COMMODITY_SPECS[commodity as Commodity]?.contractSizeBu ?? CONTRACT_SIZE_BU)
}
export function fmtQuantity(commodity: Commodity | string | null | undefined, numContracts: number): string {
  return `${quantityFor(commodity, numContracts).toLocaleString()} ${contractUnit(commodity)}`
}

// The ONE place Barchart quote magnitudes normalize: grains quote in cents/bu
// and the app stores $/bu (÷100); ICE Cotton (CT…) quotes ARE the app's unit
// (¢/lb, e.g. 72.65) and pass through unchanged.
export function normalizeBarchartPrice(symbol: string, raw: number): number {
  if (symbol.toUpperCase().startsWith('CT')) return Math.round(raw * 1e4) / 1e4
  return Math.round((raw / 100) * 1e6) / 1e6
}

// Price display: grains in $/bu; cotton in ¢/lb as quoted (72.65¢).
export function fmtCommodityPrice(commodity: Commodity | string | null | undefined, n: number | null | undefined): string {
  if (n == null) return '—'
  if (commodity === 'Cotton') return `${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}¢`
  return fmtPrice(n)
}

// Futures month codes. Index 1..12 = Jan..Dec.
const MONTH_CODE_BY_NUM: Record<number, string> = {
  1: 'F', 2: 'G', 3: 'H', 4: 'J', 5: 'K', 6: 'M',
  7: 'N', 8: 'Q', 9: 'U', 10: 'V', 11: 'X', 12: 'Z',
}
const MONTH_ABBR_BY_NUM: Record<number, string> = {
  1: 'JAN', 2: 'FEB', 3: 'MAR', 4: 'APR', 5: 'MAY', 6: 'JUN',
  7: 'JUL', 8: 'AUG', 9: 'SEP', 10: 'OCT', 11: 'NOV', 12: 'DEC',
}
const MONTH_NUM_BY_ABBR: Record<string, number> = Object.fromEntries(
  Object.entries(MONTH_ABBR_BY_NUM).map(([num, abbr]) => [abbr, Number(num)]),
)

export function monthCodeFor(monthNum: number): string {
  return MONTH_CODE_BY_NUM[monthNum] ?? ''
}

export type ParsedMonth = {
  abbr: string // 'DEC'
  monthNum: number // 12
  code: string // 'Z'
  year2: number // 26
  year4: number // 2026
}

// Parse a contract-month label like "DEC 26" or "JUL 2027" into its parts.
export function parseContractMonth(s: string | null | undefined): ParsedMonth | null {
  if (!s) return null
  const m = s.trim().toUpperCase().match(/^([A-Z]{3})\s+(\d{2,4})$/)
  if (!m) return null
  const abbr = m[1]
  const monthNum = MONTH_NUM_BY_ABBR[abbr]
  if (!monthNum) return null
  const raw = parseInt(m[2], 10)
  const year4 = raw < 100 ? 2000 + raw : raw
  return { abbr, monthNum, code: monthCodeFor(monthNum), year2: year4 % 100, year4 }
}

// Build the futures contract symbol, e.g. Corn + "DEC 26" -> "ZCZ26".
export function buildContractSymbol(commodity: Commodity | string, contractMonth: string): string {
  const spec = COMMODITY_SPECS[commodity as Commodity]
  const p = parseContractMonth(contractMonth)
  if (!spec || !p) return ''
  return `${spec.symbol}${p.code}${String(p.year2).padStart(2, '0')}`
}

export type ContractMonthOption = {
  label: string // 'DEC 26'
  monthNum: number
  year: number
  code: string
}

// Available contract months for a commodity over the next `monthsAhead` months,
// chronologically ordered. Only months in the commodity's delivery cycle and at
// or after the current month are returned.
export function contractMonthOptions(
  commodity: Commodity | string,
  from: Date = new Date(),
  monthsAhead = 24,
): ContractMonthOption[] {
  const spec = COMMODITY_SPECS[commodity as Commodity]
  if (!spec) return []
  const allowed = new Set(spec.contractMonths)
  const out: ContractMonthOption[] = []
  const start = new Date(from.getFullYear(), from.getMonth(), 1)
  for (let i = 0; i <= monthsAhead; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    const monthNum = d.getMonth() + 1
    const code = monthCodeFor(monthNum)
    if (!allowed.has(code)) continue
    const year = d.getFullYear()
    out.push({ label: `${MONTH_ABBR_BY_NUM[monthNum]} ${String(year % 100).padStart(2, '0')}`, monthNum, year, code })
  }
  return out
}

// A chronological sort key for a contract-month label, for ordering positions.
export function contractMonthSortKey(contractMonth: string): number {
  const p = parseContractMonth(contractMonth)
  if (!p) return Number.MAX_SAFE_INTEGER
  return p.year4 * 100 + p.monthNum
}

// Parse a grain price that may be entered as a plain decimal ("4.9325") or in
// the trade convention of dollars-and-fractional-cents ("4.93 1/4" = 4.9325,
// "11.43 1/2" = 11.435). The fraction is a fraction of one cent: n/d cents =
// (n/d) * $0.01. Returns null if it can't be parsed.
export function parsePrice(input: string | null | undefined): number | null {
  if (input == null) return null
  const s = String(input).trim()
  if (s === '') return null
  // "<base> <num>/<den>"
  const withFrac = s.match(/^(-?\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/)
  if (withFrac) {
    const base = parseFloat(withFrac[1])
    const num = parseInt(withFrac[2], 10)
    const den = parseInt(withFrac[3], 10)
    if (!den) return null
    return roundPrice(base + (num / den) * 0.01)
  }
  // bare "<num>/<den>" fractional cents
  const bareFrac = s.match(/^(\d+)\/(\d+)$/)
  if (bareFrac) {
    const den = parseInt(bareFrac[2], 10)
    if (!den) return null
    return roundPrice((parseInt(bareFrac[1], 10) / den) * 0.01)
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Prices carry up to 6 decimals in the DB; clamp float noise from the fraction
// math (e.g. 4.93 + 0.0025).
export function roundPrice(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// Two extractions of the same fill can disagree by a fractional-parse hair —
// one run reads "6.67 3/4" as 6.6775, another drops or rounds the fraction.
// When matching statement rows to stored positions, prices within half a cent
// (two quarter-cent ticks) are the same fill. Exact float equality is too
// brittle for AI-extracted prices and re-flags existing positions as new.
export const PRICE_MATCH_EPSILON = 0.005

export function pricesMatch(
  a: number | null | undefined,
  b: number | null | undefined,
  epsilon = PRICE_MATCH_EPSILON,
): boolean {
  if (a == null || b == null) return false
  return Math.abs(a - b) <= epsilon
}

// Normalize a price that may arrive as a number (the usual extraction shape)
// or as a fractional string ("7.00 1/4"). EVERY price that enters a
// statement-import comparison — extracted or stored — must pass through this
// one function so the import path and the stored-position path can't drift.
export function coercePrice(v: number | string | null | undefined): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? roundPrice(v) : null
  return parsePrice(v)
}

export function bushelsFor(numContracts: number, contractSizeBu = CONTRACT_SIZE_BU): number {
  return numContracts * contractSizeBu
}

// Mark-to-market P&L on an open position. SHORT gains when price falls; LONG
// gains when price rises.
export function unrealizedPnl(args: {
  side: Side
  tradePrice: number
  currentPrice: number | null | undefined
  numContracts: number
  contractSizeBu?: number
}): number | null {
  const { side, tradePrice, currentPrice, numContracts } = args
  if (currentPrice == null) return null
  const size = args.contractSizeBu ?? CONTRACT_SIZE_BU
  const perBu = side === 'short' ? tradePrice - currentPrice : currentPrice - tradePrice
  return perBu * numContracts * size
}

// Realized P&L when a position is closed. Returns gross (before commissions)
// and net (gross minus total open+close commissions).
export function realizedPnl(args: {
  side: Side
  tradePrice: number
  closePrice: number
  numContracts: number
  contractSizeBu?: number
  commission?: number // total open + close commission/fees
}): { gross: number; net: number } {
  const { side, tradePrice, closePrice, numContracts } = args
  const size = args.contractSizeBu ?? CONTRACT_SIZE_BU
  const perBu = side === 'short' ? tradePrice - closePrice : closePrice - tradePrice
  const gross = perBu * numContracts * size
  const net = gross - (args.commission ?? 0)
  return { gross: Math.round(gross * 100) / 100, net: Math.round(net * 100) / 100 }
}

// ---------- Closed offset groups (Purchase & Sale) ----------
//
// A brokerage statement closes one or more OPENING lots against a single
// closing transaction and prints ONE "GROSS PROFIT/LOSS" total for the whole
// offset group. That printed total is a GROUP total — it must NEVER be attached
// to an individual lot, or the gain gets multiplied when several lots close
// together (three corn lots that net $71,875 would each show $71,875 → a bogus
// $215,625). Instead we compute realized P&L PER LOT from the lot's own open
// price and the shared close price, and consult the statement's printed total
// only as a reconciliation check (see reconcileClosedGroup).

export type ClosedGroupLot = {
  open_date: string
  open_price: number
  contracts: number
}

export type ClosedGroup = {
  commodity: Commodity
  contract_month: string
  side: Side
  close_date: string
  close_price: number
  lots: ClosedGroupLot[]
  contractSizeBu?: number
}

export type ExpandedClosedLot = {
  commodity: Commodity
  contract_month: string
  side: Side
  open_date: string
  open_price: number
  close_date: string
  close_price: number
  contracts: number
  realized_pnl: number // GROSS, computed for THIS lot only
}

// Expand a closed offset group into one closed position per opening lot, each
// carrying its own open price/contracts, the shared close price/date, and its
// individually-computed realized P&L:
//   short: (open - close) * contracts * size
//   long:  (close - open) * contracts * size
// The statement's reported group total is deliberately NOT consulted here.
export function expandClosedGroup(group: ClosedGroup): ExpandedClosedLot[] {
  const size = group.contractSizeBu ?? CONTRACT_SIZE_BU
  return group.lots.map((lot) => ({
    commodity: group.commodity,
    contract_month: group.contract_month,
    side: group.side,
    open_date: lot.open_date,
    open_price: lot.open_price,
    close_date: group.close_date,
    close_price: group.close_price,
    contracts: lot.contracts,
    realized_pnl: realizedPnl({
      side: group.side,
      tradePrice: lot.open_price,
      closePrice: group.close_price,
      numContracts: lot.contracts,
      contractSizeBu: size,
    }).gross,
  }))
}

export type GroupReconciliation = {
  computedTotal: number // sum of the per-lot realized P&L
  reportedTotal: number | null // the statement's GROSS PROFIT/LOSS for the group
  hasReportedTotal: boolean
  diff: number | null // computedTotal - reportedTotal (null when nothing to compare)
  matches: boolean // |diff| <= tolerance, or true when there's no reported total
  // computed == -(reported) within tolerance: the signature of an inverted
  // side (short read as long or vice versa), not a math error. The UI offers a
  // one-click side flip instead of the generic mismatch warning.
  signFlipSuspected: boolean
}

// Reconcile the sum of per-lot realized P&L against the statement's reported
// group total. A difference beyond `tolerance` dollars should be surfaced to
// the user before saving; the normal case ties out and is just confirmed. When
// the statement has no reported total there's nothing to check, so it "matches".
export function reconcileClosedGroup(
  lots: Array<{ realized_pnl: number }>,
  reportedTotal: number | null | undefined,
  tolerance = 1,
): GroupReconciliation {
  const computedTotal = Math.round(lots.reduce((s, l) => s + l.realized_pnl, 0) * 100) / 100
  if (reportedTotal == null) {
    return { computedTotal, reportedTotal: null, hasReportedTotal: false, diff: null, matches: true, signFlipSuspected: false }
  }
  const diff = Math.round((computedTotal - reportedTotal) * 100) / 100
  const matches = Math.abs(diff) <= tolerance
  const signFlipSuspected =
    !matches &&
    Math.abs(computedTotal) > tolerance &&
    Math.abs(Math.round((computedTotal + reportedTotal) * 100) / 100) <= tolerance
  return { computedTotal, reportedTotal, hasReportedTotal: true, diff, matches, signFlipSuspected }
}

// ---------- Options ----------

export type OptionType = 'call' | 'put'
export type OptionSide = 'buy' | 'sell'

// Parse a value with an optional whole + fraction part, e.g. "15 1/2" -> 15.5,
// "15.5" -> 15.5, "15" -> 15. Used for option premiums quoted in cents/bu,
// where the fraction is a fraction of a cent added directly (1/2 = 0.5¢).
export function parseFractional(input: string | null | undefined): number | null {
  if (input == null) return null
  const s = String(input).trim()
  if (s === '') return null
  const withFrac = s.match(/^(-?\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/)
  if (withFrac) {
    const den = parseInt(withFrac[3], 10)
    if (!den) return null
    return parseFloat(withFrac[1]) + parseInt(withFrac[2], 10) / den
  }
  const bareFrac = s.match(/^(\d+)\/(\d+)$/)
  if (bareFrac) {
    const den = parseInt(bareFrac[2], 10)
    if (!den) return null
    return parseInt(bareFrac[1], 10) / den
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Total premium dollars: cents/bu / 100 * contracts * bu/contract.
export function optionPremiumTotal(
  premiumCents: number,
  numContracts: number,
  contractSizeBu = CONTRACT_SIZE_BU,
): number {
  return Math.round((premiumCents / 100) * numContracts * contractSizeBu * 100) / 100
}

// Mark-to-market P&L on an open option from a current premium in cents/bu. A
// bought option gains when the premium rises; a written (sold) one gains when
// it falls. null when no current value is known.
export function optionUnrealizedPnl(args: {
  side: OptionSide
  premiumCents: number
  currentCents: number | null | undefined
  numContracts: number
  contractSizeBu?: number
}): number | null {
  if (args.currentCents == null) return null
  const size = args.contractSizeBu ?? CONTRACT_SIZE_BU
  const perBu = args.side === 'buy' ? args.currentCents - args.premiumCents : args.premiumCents - args.currentCents
  return Math.round((perBu / 100) * args.numContracts * size * 100) / 100
}

// Realized P&L when an option is offset (traded back) at a closing premium,
// net of commissions.
export function optionOffsetPnl(args: {
  side: OptionSide
  premiumCents: number
  closeCents: number
  numContracts: number
  contractSizeBu?: number
  commission?: number
}): number {
  const size = args.contractSizeBu ?? CONTRACT_SIZE_BU
  const perBu = args.side === 'buy' ? args.closeCents - args.premiumCents : args.premiumCents - args.closeCents
  const gross = (perBu / 100) * args.numContracts * size
  return Math.round((gross - (args.commission ?? 0)) * 100) / 100
}

// Realized P&L when an option expires worthless or is exercised: the whole
// premium is a cost (bought) or income (sold), net of commissions.
export function optionFullPremiumPnl(args: {
  side: OptionSide
  premiumCents: number
  numContracts: number
  contractSizeBu?: number
  commission?: number
}): number {
  const total = optionPremiumTotal(args.premiumCents, args.numContracts, args.contractSizeBu)
  const signed = args.side === 'buy' ? -total : total
  return Math.round((signed - (args.commission ?? 0)) * 100) / 100
}

// The futures side an exercised/assigned option converts into:
//   buy put -> short, buy call -> long, sell put -> long, sell call -> short.
export function exerciseFuturesSide(optionType: OptionType, optionSide: OptionSide): Side {
  if (optionType === 'put') return optionSide === 'buy' ? 'short' : 'long'
  return optionSide === 'buy' ? 'long' : 'short'
}

export function fmtCents(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 })}¢`
}

// Normalize an option type / side parsed from a statement.
export function normalizeOptionType(raw: string | null | undefined): OptionType | null {
  const s = (raw ?? '').trim().toLowerCase()
  if (s.includes('put')) return 'put'
  if (s.includes('call')) return 'call'
  return null
}

// Normalize a commodity name from a brokerage statement to our canonical form.
// Returns null for commodities we don't track (e.g. COTTON).
export function normalizeCommodity(raw: string | null | undefined): Commodity | null {
  if (!raw) return null
  const s = raw.trim().toUpperCase()
  if (s.includes('CORN')) return 'Corn'
  if (s.includes('SOYBEAN') || s === 'BEANS' || s === 'SOY') return 'Soybeans'
  if (s.includes('WHEAT')) return 'Chicago Wheat' // we only trade Chicago/SRW
  if (s.includes('COTTON') && !s.includes('SEED')) return 'Cotton' // ICE Cotton No. 2; seed cotton is not the lint contract
  return null
}

// Format a price as dollars-per-bushel with up to 4 decimals (grain quotes go
// to quarter-cents).
export function fmtPrice(n: number | null | undefined): string {
  if (n == null) return '—'
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

// Format a P&L dollar amount with sign and thousands separators.
export function fmtPnl(n: number | null | undefined): string {
  if (n == null) return '—'
  const v = Number(n)
  const sign = v < 0 ? '-' : ''
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
