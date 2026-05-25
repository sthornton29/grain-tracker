// Hedging helpers — futures contract symbols, month codes, fractional-cent
// price parsing, and P&L math. Pure functions, no I/O, so they're reused by
// the dashboard, the position forms, and the statement-import flow.

export const COMMODITIES = ['Corn', 'Soybeans', 'Chicago Wheat'] as const
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

// Normalize a commodity name from a brokerage statement to our canonical form.
// Returns null for commodities we don't track (e.g. COTTON).
export function normalizeCommodity(raw: string | null | undefined): Commodity | null {
  if (!raw) return null
  const s = raw.trim().toUpperCase()
  if (s.includes('CORN')) return 'Corn'
  if (s.includes('SOYBEAN') || s === 'BEANS' || s === 'SOY') return 'Soybeans'
  if (s.includes('WHEAT')) return 'Chicago Wheat' // we only trade Chicago/SRW
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
