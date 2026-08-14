// RMA Price Discovery — crop insurance projected/harvest prices from RMA's
// public OData service (CCZero data), the authoritative source the Barchart
// discovery-contract estimate only approximates:
//
//   https://public-rma.fpac.usda.gov/apps/PriceDiscovery/Services/
//     RevenuePriceDataService.svc/RevenuePrices
//       ?$filter=CommodityYear eq {y} and CommodityCode eq '{c}'
//               and StateCode eq '{s}'
//
// Atom XML entries carry, per commodity year × commodity × type × practice ×
// STATE × sales-closing date: ProjectedPrice + ProjectedPriceStatus +
// discovery window dates, HarvestPrice + HarvestPriceStatus + window dates,
// and ApprovedPriceVolatilityPercent. Statuses are verbatim
// 'Yet To Start' | 'In Discovery' | 'Released' — during a window the price
// field holds the RUNNING average to date, after 'Released' the final.
//
// The windows genuinely differ BY STATE (the Commodity Exchange Price
// Provisions key offers per state — Alabama corn discovers Jan 15–Feb 14
// where Illinois runs Feb 1–28), so everything here stays state-keyed and
// the discovery periods come from the data, never from hard-coded dates.
//
// Architecture is the deterministic-source pattern of lib/fsa-benchmark-file
// and the NASS lookups: this module is PURE (parse + classify + tier
// resolution, unit-tested); the fetch/cache live in
// app/api/rma-price-discovery/route.ts over the rma_price_cache table (064).
// If RMA ever retires the .svc endpoint, the designated fallback source is
// the ADM Price dataset (actuarial_data_master pipe-delimited files on RMA's
// public download site) — same fields, same cache; the tiering already
// degrades to the Barchart estimate whenever RMA data is unavailable.

// ---------------------------------------------------------------------------
// Commodity / state keying
// ---------------------------------------------------------------------------

/** App crop name → RMA commodity code. Names run through the same loose
 *  matching the rest of the app uses for crop names. */
export const RMA_COMMODITY_CODES: ReadonlyArray<{ code: string; match: RegExp; label: string }> = [
  { code: '0041', match: /corn/i, label: 'Corn' },
  { code: '0081', match: /soy/i, label: 'Soybeans' },
  { code: '0011', match: /wheat/i, label: 'Wheat' },
  { code: '0021', match: /cotton/i, label: 'Cotton' },
  { code: '0051', match: /sorghum|milo/i, label: 'Grain Sorghum' },
  { code: '0091', match: /barley/i, label: 'Barley' },
  { code: '0015', match: /canola|rapeseed/i, label: 'Canola' },
  { code: '0016', match: /oat/i, label: 'Oats' },
  { code: '0075', match: /peanut/i, label: 'Peanuts' },
  { code: '0018', match: /rice/i, label: 'Rice' },
  { code: '0078', match: /sunflower/i, label: 'Sunflowers' },
]

export function rmaCommodityCode(cropName: string | null | undefined): string | null {
  if (!cropName) return null
  return RMA_COMMODITY_CODES.find((c) => c.match.test(cropName))?.code ?? null
}

/** 2-letter state → 2-digit FIPS (RMA StateCode). Only states with RMA
 *  revenue-price commodities. */
export const STATE_FIPS: Readonly<Record<string, string>> = {
  AL: '01', AZ: '04', AR: '05', CA: '06', CO: '08', DE: '10', FL: '12', GA: '13',
  ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', MD: '24',
  MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NM: '35', NY: '36',
  NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
  NJ: '34', NV: '32', ME: '23', MA: '25', NH: '33', VT: '50', CT: '09', RI: '44',
}

export function stateFips(stateCode: string | null | undefined): string | null {
  if (!stateCode) return null
  return STATE_FIPS[stateCode.trim().toUpperCase()] ?? null
}

// ---------------------------------------------------------------------------
// Atom response parsing (defensive — the FSA-workbook lesson: unexpected
// shapes surface as loud, specific errors, never silent wrong numbers).
// ---------------------------------------------------------------------------

export type RmaWindowStatus = 'yet_to_start' | 'in_discovery' | 'released'

export type RmaPriceRow = {
  commodityYear: number
  commodityCode: string
  commodityName: string
  stateCode: string
  stateName: string
  typeCode: number
  typeName: string
  practiceCode: number
  practiceName: string
  salesClosingDate: string | null // YYYY-MM-DD
  projectedPrice: number | null
  projectedStatus: RmaWindowStatus | null
  projectedBeginDate: string | null
  projectedEndDate: string | null
  harvestPrice: number | null
  harvestStatus: RmaWindowStatus | null
  harvestBeginDate: string | null
  harvestEndDate: string | null
  volatility: number | null
  /** The offer's BASE CONTRACT per window, straight from the CEPP-keyed data —
   *  Barchart-compatible market symbols (Alabama corn = 'ZCU26', September;
   *  never assume the Midwest DEC contract). */
  projectedExchangeCode: string | null
  projectedMarketSymbol: string | null
  harvestExchangeCode: string | null
  harvestMarketSymbol: string | null
}

const STATUS_MAP: Record<string, RmaWindowStatus> = {
  'yet to start': 'yet_to_start',
  'in discovery': 'in_discovery',
  'released': 'released',
}

function parseStatus(raw: string | null): RmaWindowStatus | null {
  if (!raw) return null
  return STATUS_MAP[raw.trim().toLowerCase()] ?? null
}

function tagValue(entryXml: string, tag: string): string | null {
  // OData Atom properties look like <d:ProjectedPrice m:type="Edm.Decimal">4.42</d:ProjectedPrice>
  // or self-closed with m:null="true" when absent.
  const m = entryXml.match(new RegExp(`<d:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</d:${tag}>`))
  if (!m) return null
  const v = m[1].trim()
  return v.length > 0 ? v : null
}

const toNum = (v: string | null): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const toDate = (v: string | null): string | null => {
  if (!v) return null
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** Parse the RevenuePrices Atom feed. Throws with a specific message when the
 *  document isn't the shape we expect (so the route can log it and callers
 *  fall back to the Barchart tier). */
export function parseRmaRevenuePrices(xml: string): RmaPriceRow[] {
  if (!/<feed[\s>]/.test(xml)) {
    throw new Error('RMA Price Discovery returned a non-Atom response (service shape may have changed).')
  }
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? []
  const rows: RmaPriceRow[] = []
  for (const e of entries) {
    const commodityYear = toNum(tagValue(e, 'CommodityYear'))
    const commodityCode = tagValue(e, 'CommodityCode')
    const stateCode = tagValue(e, 'StateCode')
    if (commodityYear == null || !commodityCode || !stateCode) {
      throw new Error('RMA Price Discovery entry is missing its commodity/state key (layout change?).')
    }
    rows.push({
      commodityYear,
      commodityCode,
      commodityName: tagValue(e, 'CommodityName') ?? commodityCode,
      stateCode,
      stateName: tagValue(e, 'StateName') ?? stateCode,
      typeCode: toNum(tagValue(e, 'TypeCode')) ?? 0,
      typeName: tagValue(e, 'TypeName') ?? '',
      practiceCode: toNum(tagValue(e, 'PracticeCode')) ?? 0,
      practiceName: tagValue(e, 'PracticeName') ?? '',
      salesClosingDate: toDate(tagValue(e, 'SalesClosingDateDisplay')?.replace(/(\d+)\/(\d+)\/(\d+)/, (_, mo, d, y) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`) ?? null),
      projectedPrice: toNum(tagValue(e, 'ProjectedPrice')),
      projectedStatus: parseStatus(tagValue(e, 'ProjectedPriceStatus')),
      projectedBeginDate: toDate(tagValue(e, 'ProjectedPriceBeginDate')),
      projectedEndDate: toDate(tagValue(e, 'ProjectedPriceEndDate')),
      harvestPrice: toNum(tagValue(e, 'HarvestPrice')),
      harvestStatus: parseStatus(tagValue(e, 'HarvestPriceStatus')),
      harvestBeginDate: toDate(tagValue(e, 'HarvestPriceBeginDate')),
      harvestEndDate: toDate(tagValue(e, 'HarvestPriceEndDate')),
      volatility: toNum(tagValue(e, 'ApprovedPriceVolatilityPercent')),
      projectedExchangeCode: tagValue(e, 'ProjectedPriceExchangeCode'),
      projectedMarketSymbol: tagValue(e, 'ProjectedPriceMarketSymbolCode'),
      harvestExchangeCode: tagValue(e, 'HarvestPriceExchangeCode'),
      harvestMarketSymbol: tagValue(e, 'HarvestPriceMarketSymbolCode'),
    })
  }
  return rows
}

/** Pick the row that stands for "the" price of a crop × state × year: the
 *  Conventional practice, preferring the catch-all type ("All …"), then the
 *  earliest sales-closing date (the primary offer). Organic and specialty
 *  types exist in the feed but aren't what the app's policies model. */
export function pickPrimaryRow(rows: readonly RmaPriceRow[]): RmaPriceRow | null {
  const conventional = rows.filter((r) => /conventional/i.test(r.practiceName))
  const pool = conventional.length > 0 ? conventional : [...rows]
  if (pool.length === 0) return null
  pool.sort((a, b) => {
    const aAll = /^all\b/i.test(a.typeName) ? 0 : 1
    const bAll = /^all\b/i.test(b.typeName) ? 0 : 1
    if (aAll !== bAll) return aAll - bAll
    return (a.salesClosingDate ?? '9999').localeCompare(b.salesClosingDate ?? '9999')
  })
  return pool[0]
}

// ---------------------------------------------------------------------------
// Window state + labels
// ---------------------------------------------------------------------------

export type DiscoveryWindowState = {
  status: RmaWindowStatus
  /** 1-based day within the window and the window's length, while in
   *  discovery (both null otherwise). */
  dayOfWindow: number | null
  windowDays: number | null
}

const DAY_MS = 86_400_000
const dayCount = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS) + 1

/** Classify a window from its status + dates. The STATUS is authoritative
 *  (RMA sets it); dates only compute the day-N-of-M progress label, clamped
 *  into the window so clock skew can't produce day 0 or day M+1. */
export function windowState(args: {
  status: RmaWindowStatus | null
  beginDate: string | null
  endDate: string | null
  today?: string // YYYY-MM-DD, injectable for tests
}): DiscoveryWindowState | null {
  if (!args.status) return null
  if (args.status !== 'in_discovery' || !args.beginDate || !args.endDate) {
    return { status: args.status, dayOfWindow: null, windowDays: null }
  }
  const today = args.today ?? new Date().toISOString().slice(0, 10)
  const windowDays = dayCount(args.beginDate, args.endDate)
  const raw = dayCount(args.beginDate, today)
  return {
    status: 'in_discovery',
    dayOfWindow: Math.min(Math.max(raw, 1), windowDays),
    windowDays,
  }
}

const fmtMDY = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${m}/${d}/${y}`
}

/** The source label rendered beside a price, per tier. */
export function rmaSourceLabel(args: {
  status: RmaWindowStatus
  endDate?: string | null
  dayOfWindow?: number | null
  windowDays?: number | null
  asOf?: string | null // YYYY-MM-DD the cache row was fetched
}): string {
  if (args.status === 'released') return 'RMA final'
  if (args.status === 'in_discovery') {
    const through = args.asOf ? ` through ${fmtMDY(args.asOf)}` : ''
    const day = args.dayOfWindow != null && args.windowDays != null ? ` (day ${args.dayOfWindow} of ${args.windowDays})` : ''
    return `RMA discovery avg${through}${day}`
  }
  return 'RMA window not started'
}

// ---------------------------------------------------------------------------
// Tiered resolution — RMA final > RMA running > manual > Barchart estimate,
// with one deliberate inversion: an RMA FINAL outranks a manual entry (the
// published number is the fact), surfaced as a notice, never silently.
// ---------------------------------------------------------------------------

export type ResolvedInsurancePrice = {
  price: number
  source: 'rma_final' | 'rma_discovery' | 'manual' | 'estimate'
  label: string
  /** Set when an RMA final supersedes a manual entry — the UI shows
   *  "RMA published $X — replaces your manual $Y" with a keep-mine escape. */
  supersededManual: number | null
}

export function resolveTieredPrice(args: {
  rma: { price: number | null; status: RmaWindowStatus | null; label: string } | null
  /** The user's manual entry, when one exists. */
  manual: number | null
  /** True when the user explicitly chose to keep their manual entry over a
   *  published RMA final ("keep mine"). */
  keepManual?: boolean
  /** The Barchart discovery-contract estimate (today's behavior). */
  estimate: number | null
  estimateLabel?: string
}): ResolvedInsurancePrice | null {
  const rmaPrice = args.rma?.price ?? null
  const rmaStatus = args.rma?.status ?? null

  if (rmaStatus === 'released' && rmaPrice != null) {
    if (args.manual != null && args.keepManual) {
      return { price: args.manual, source: 'manual', label: 'manual (RMA final available)', supersededManual: null }
    }
    return {
      price: rmaPrice,
      source: 'rma_final',
      label: args.rma!.label,
      supersededManual: args.manual != null && args.manual !== rmaPrice ? args.manual : null,
    }
  }
  // Below the final tier a manual entry wins (it outranks every estimate).
  if (args.manual != null) {
    return { price: args.manual, source: 'manual', label: 'manual', supersededManual: null }
  }
  if (rmaStatus === 'in_discovery' && rmaPrice != null) {
    return { price: rmaPrice, source: 'rma_discovery', label: args.rma!.label, supersededManual: null }
  }
  if (args.estimate != null) {
    return { price: args.estimate, source: 'estimate', label: args.estimateLabel ?? 'estimate', supersededManual: null }
  }
  return null
}

// ---------------------------------------------------------------------------
// Cache staleness — daily during an open window, weekly otherwise.
// ---------------------------------------------------------------------------

export const RMA_REFRESH_IN_DISCOVERY_MS = 24 * 60 * 60 * 1000
export const RMA_REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000

export function rmaCacheIsStale(args: {
  fetchedAt: string // ISO timestamp
  projectedStatus: RmaWindowStatus | null
  harvestStatus: RmaWindowStatus | null
  now?: number
}): boolean {
  const now = args.now ?? Date.now()
  const age = now - Date.parse(args.fetchedAt)
  const anyOpen = args.projectedStatus === 'in_discovery' || args.harvestStatus === 'in_discovery'
  // 'yet_to_start' also refreshes on the daily cadence near-window so the flip
  // to in-discovery is seen promptly; fully released rows are immutable facts
  // and only refresh weekly as a shape check.
  const anyPending = args.projectedStatus === 'yet_to_start' || args.harvestStatus === 'yet_to_start'
  return age > (anyOpen || anyPending ? RMA_REFRESH_IN_DISCOVERY_MS : RMA_REFRESH_IDLE_MS)
}

/** One crop × state lookup result as the API route returns it (the type lives
 *  here so pure row-model code never imports from a route file). */
export type RmaLookupResult = {
  crop_id: string
  state_code: string // 2-letter
  commodity_code: string
  projected_price: number | null
  projected_status: RmaWindowStatus | null
  projected_begin_date: string | null
  projected_end_date: string | null
  projected_label: string | null
  harvest_price: number | null
  harvest_status: RmaWindowStatus | null
  harvest_begin_date: string | null
  harvest_end_date: string | null
  harvest_label: string | null
  volatility: number | null
  fetched_at: string
  projected_market_symbol: string | null
  harvest_market_symbol: string | null
  harvest_exchange_code: string | null
  offer_identity: string | null
  no_offer?: boolean
}

/** The harvest price's phase, from the RMA window status. No status (no offer
 *  / RMA unreachable) reads as pre-window: the estimate tier applies. */
export type HarvestPhase = 'pre' | 'in' | 'post'
export function harvestPhase(status: RmaWindowStatus | null | undefined): HarvestPhase {
  if (status === 'in_discovery') return 'in'
  if (status === 'released') return 'post'
  return 'pre'
}

/** Non-destructive refresh: fetch-validate-THEN-swap. A failed, malformed, or
 *  suspiciously-empty response keeps the previous results and reports why —
 *  a refresh must never blank the window. `partial` merges by crop × state
 *  (per-row refresh) instead of swapping the whole set. */
export function mergeRmaResults(
  prev: readonly RmaLookupResult[],
  incoming: unknown,
  opts?: { partial?: boolean },
): { results: RmaLookupResult[]; error: string | null; note: string | null } {
  const data = (incoming as { data?: { results?: unknown; note?: unknown } } | null)?.data
  const note = typeof data?.note === 'string' ? data.note : null
  const raw = data?.results
  if (!Array.isArray(raw)) {
    return { results: [...prev], error: 'Refresh failed — the RMA lookup returned no usable data.', note }
  }
  const valid = raw.filter((r): r is RmaLookupResult => {
    const x = r as RmaLookupResult
    return typeof x?.crop_id === 'string' && x.crop_id.length > 0 && typeof x?.state_code === 'string'
  })
  if (opts?.partial) {
    const incomingKeys = new Set(valid.map((r) => `${r.crop_id}|${r.state_code}`))
    if (valid.length === 0) return { results: [...prev], error: 'Refresh failed — no rows came back for this crop.', note }
    return { results: [...prev.filter((r) => !incomingKeys.has(`${r.crop_id}|${r.state_code}`)), ...valid], error: null, note }
  }
  if (valid.length === 0 && prev.length > 0) {
    return { results: [...prev], error: 'Refresh returned no rows — keeping the previous values.', note }
  }
  return { results: valid, error: null, note }
}

/** The offer's identity line for provenance chips:
 *  "AL · All (Non-High Amylose) · Conventional · SCD 2/28/2026". */
export function offerIdentityLabel(r: Pick<RmaPriceRow, 'stateCode' | 'typeName' | 'practiceName' | 'salesClosingDate'> & { stateAbbr?: string }): string {
  const scd = r.salesClosingDate ? `SCD ${fmtMDY(r.salesClosingDate)}` : null
  return [r.stateAbbr ?? r.stateCode, r.typeName, r.practiceName, scd].filter(Boolean).join(' · ')
}

/** The OData query for one crop year × commodity × state. */
export function rmaServiceUrl(args: { commodityYear: number; commodityCode: string; stateFips: string }): string {
  const filter = `CommodityYear eq ${args.commodityYear} and CommodityCode eq '${args.commodityCode}' and StateCode eq '${args.stateFips}'`
  return `https://public-rma.fpac.usda.gov/apps/PriceDiscovery/Services/RevenuePriceDataService.svc/RevenuePrices?$filter=${encodeURIComponent(filter)}`
}
