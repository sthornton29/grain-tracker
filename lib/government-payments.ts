// Government payment engine — pure math for ARC/PLC projections plus the seed
// cotton MYA conversion and payment-limit helpers. No I/O: the settings page and
// the reports pass already-fetched rows in. All projections are ESTIMATES; FSA
// determines actual payments (and any limit reductions) after the marketing year.

import { cropToCommodity } from '@/lib/contracts'
import { buildContractSymbol, contractMonthOptions, type Commodity } from '@/lib/hedging'
import {
  DEFAULT_SEQUESTRATION_PCT,
  DEFAULT_ERP_CAP_PCT,
  DEFAULT_ARC_IC_PAYMENT_FACTOR,
  defaultArcGuaranteePct,
  defaultArcPaymentCapPct,
  defaultErpOlympicFactor,
  OBBBA_FIRST_YEAR,
} from '@/lib/program-config'
import type {
  ArcBenchmarkData, ArcPlcElection, ArcPlcElectionType, ArcPlcPayment, ArcPlcPriceData,
  CoveredCommodity, FarmBaseAcres,
} from '@/lib/types'

// The 85% base-acre payment factor applies to ARC-CO and PLC gross payments
// (ARC-IC uses 65%). The OBBBA parameters (ARC guarantee/cap %, ERP factors)
// and the sequestration % are per-crop-year values; they come from
// program_year_config (see lib/program-config.ts), and callers pass the
// resolved values into the compute functions below.
export const PAYMENT_FACTOR = 0.85

// Seed cotton weight shares (lint vs cottonseed) for the MYA conversion.
export const LINT_SHARE = 0.43
export const COTTONSEED_SHARE = 0.57

export const ELECTION_LABEL: Record<ArcPlcElectionType, string> = {
  PLC: 'PLC',
  ARC_CO: 'ARC-CO',
  ARC_IC: 'ARC-IC',
}

// Common program names for the "Other USDA payments" entry dropdown.
export const COMMON_PROGRAMS = [
  'EQIP', 'CRP', 'CSP', 'ERP', 'WHIP+', 'LFP', 'ELAP', 'NAP', 'ARC/PLC Supplemental', 'Disaster Assistance',
] as const

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// Map a covered-commodity name to a Barchart-traded commodity, or null when we
// have no futures for it (seed cotton, sorghum, oats, barley, peanuts).
export function commodityToTraded(name: string | null | undefined): Commodity | null {
  return cropToCommodity(name)
}

// The nearby futures symbol used to proxy the current price level for a
// commodity's MYA estimate, e.g. Corn -> "ZCH26". null for untraded commodities.
export function nearbyContractSymbol(name: string | null | undefined, from: Date = new Date()): string | null {
  const c = commodityToTraded(name)
  if (!c) return null
  const opts = contractMonthOptions(c, from, 12)
  if (opts.length === 0) return null
  return buildContractSymbol(c, opts[0].label) || null
}

// ---------- Effective Reference Price (ERP) ----------

// 5-year Olympic average: drop the single highest and lowest, average the rest.
// null when there aren't enough values to trim (FSA uses the 5 most recent
// lagged marketing years; we accept ≥3 so partially-entered history still
// yields a number).
export function olympicAverage(values: readonly number[]): number | null {
  if (values.length < 3) return null
  const sorted = [...values].sort((a, b) => a - b)
  const trimmed = sorted.slice(1, -1)
  return trimmed.reduce((s, v) => s + v, 0) / trimmed.length
}

// The OBBBA effective reference price formula:
//   ERP = min(capPct × statutory, max(statutory, olympicFactor × 5-yr Olympic avg MYA))
// i.e. the statutory price is the floor, 88% of the Olympic average can raise
// it, and 115% of statutory caps the escalation. With no Olympic average
// available, the statutory price stands.
export function computeEffectiveReferencePrice(args: {
  statutoryReferencePrice: number
  olympicAvgMya?: number | null
  erpOlympicFactor?: number
  erpCapPct?: number
}): number {
  const stat = args.statutoryReferencePrice
  if (args.olympicAvgMya == null) return stat
  const factor = args.erpOlympicFactor ?? defaultErpOlympicFactor(OBBBA_FIRST_YEAR)
  const cap = args.erpCapPct ?? DEFAULT_ERP_CAP_PCT
  return round6(Math.min(cap * stat, Math.max(stat, factor * args.olympicAvgMya)))
}

// Effective reference price for the year: the FSA-published value stored for
// the year wins; else computed from the Olympic average when provided; else
// the statutory reference price (the floor).
export function effectiveReferencePrice(
  commodity: CoveredCommodity,
  priceData?: ArcPlcPriceData | null,
  opts?: { olympicAvgMya?: number | null; erpOlympicFactor?: number; erpCapPct?: number },
): number {
  if (priceData?.effective_reference_price != null) return Number(priceData.effective_reference_price)
  return computeEffectiveReferencePrice({
    statutoryReferencePrice: Number(commodity.statutory_reference_price),
    olympicAvgMya: opts?.olympicAvgMya ?? null,
    erpOlympicFactor: opts?.erpOlympicFactor,
    erpCapPct: opts?.erpCapPct,
  })
}

// ARC benchmark price with ERP substitution: any year whose MYA is below that
// year's effective reference price counts at the ERP instead, then the 5-yr
// Olympic average is taken. A year with no MYA at all counts at its ERP.
export function arcBenchmarkPriceFromHistory(
  years: ReadonlyArray<{ mya: number | null; erp: number }>,
): number | null {
  if (years.length < 3) return null
  const substituted = years.map((y) => Math.max(y.mya ?? y.erp, y.erp))
  const avg = olympicAverage(substituted)
  return avg == null ? null : round6(avg)
}

// The MYA price to use on a stored row: final > manual override > WASDE
// midpoint > running estimate > null. Deliberately the same ordering as
// resolveMyaPrice (minus the live tier) so pages that pass raw rows into
// projectPayments (Revenue Projections, Cash Flow) agree with the government
// pages, which resolve first via applyMyaResolution.
export function myaPrice(priceData?: ArcPlcPriceData | null): number | null {
  if (priceData?.mya_price_final != null) return Number(priceData.mya_price_final)
  if (priceData?.source === 'manual' && priceData.mya_price_estimate != null) {
    return Number(priceData.mya_price_estimate)
  }
  if (priceData?.wasde_midpoint != null) return Number(priceData.wasde_midpoint)
  if (priceData?.mya_price_estimate != null) return Number(priceData.mya_price_estimate)
  return null
}

// ---------- Shared MYA resolution (Decision Aid + Payment Tracker) ----------
//
// ONE precedence for the MYA price driving every PLC/ARC projection, so the
// two pages always show the same price and the same resulting payments:
//   published final  >  manual override  >  WASDE midpoint  >  estimate (live
//   blended, else the stored estimate)  >  missing.
// The final outranks everything: it is itself operator-entered (Settings), and
// the Settings page stamps source='manual' on EVERY price edit while carrying
// the old estimate forward — so ranking a 'manual' estimate above the final
// would let a stale Barchart number silently beat a just-entered USDA final.
// A manual estimate DOES outrank a live blended estimate — an override
// mid-year must never be displaced by the market. The WASDE midpoint sits at
// the top of the estimate tier: when the operator has typed the current WASDE
// season-average forecast it beats the futures-implied blend. Commodities with
// no traded futures (seed cotton, sorghum, oats, …) are manual-only:
// liveEstimate is ignored.

export type MyaState = 'manual' | 'final' | 'wasde' | 'estimate' | 'missing'

export const MYA_STATE_LABEL: Record<MyaState, string> = {
  manual: 'MYA (manual)',
  final: 'MYA (final)',
  wasde: 'MYA (WASDE)',
  estimate: 'MYA (est.)',
  missing: 'MYA — not set',
}

export type MyaResolution = {
  price: number | null
  state: MyaState
  /** No Barchart futures mapping — the MYA can only ever be entered manually. */
  manualOnly: boolean
  /** For 'estimate': true when the number is the live fetch, false when stored. */
  live: boolean
}

export function resolveMyaPrice(args: {
  commodityName: string | null | undefined
  priceData?: ArcPlcPriceData | null
  liveEstimate?: number | null
}): MyaResolution {
  const manualOnly = !commodityToTraded(args.commodityName)
  const pd = args.priceData
  if (pd?.mya_price_final != null) {
    return { price: Number(pd.mya_price_final), state: 'final', manualOnly, live: false }
  }
  if (pd?.source === 'manual' && pd.mya_price_estimate != null) {
    return { price: Number(pd.mya_price_estimate), state: 'manual', manualOnly, live: false }
  }
  if (pd?.wasde_midpoint != null) {
    return { price: Number(pd.wasde_midpoint), state: 'wasde', manualOnly, live: false }
  }
  if (!manualOnly && args.liveEstimate != null) {
    return { price: Number(args.liveEstimate), state: 'estimate', manualOnly, live: true }
  }
  if (pd?.mya_price_estimate != null) {
    return { price: Number(pd.mya_price_estimate), state: 'estimate', manualOnly, live: false }
  }
  return { price: null, state: 'missing', manualOnly, live: false }
}

// Effective price-data rows for projectPayments(): the shared resolution applied
// to the stored rows + live estimates for one crop year. Each commodity's row
// carries the RESOLVED price where myaPrice() will pick it up, synthetic rows
// are added for commodities with only a live estimate, and other years pass
// through untouched.
export function applyMyaResolution(args: {
  cropYear: number
  commodities: readonly CoveredCommodity[]
  priceData: readonly ArcPlcPriceData[]
  liveEstimates?: ReadonlyMap<string, number>
}): ArcPlcPriceData[] {
  const out = args.priceData.filter((p) => !(p.crop_year === args.cropYear && args.commodities.some((c) => c.id === p.commodity_id)))
  for (const c of args.commodities) {
    const stored = args.priceData.find((p) => p.commodity_id === c.id && p.crop_year === args.cropYear) ?? null
    const r = resolveMyaPrice({ commodityName: c.name, priceData: stored, liveEstimate: args.liveEstimates?.get(c.id) ?? null })
    if (stored == null && r.price == null) continue
    const base: ArcPlcPriceData = stored ?? {
      id: `live-${c.id}`, commodity_id: c.id, crop_year: args.cropYear,
      effective_reference_price: null, mya_price_estimate: null, mya_price_final: null,
      wasde_midpoint: null, mya_note: null,
      source: 'barchart', updated_at: '',
    }
    // A final present on the row already wins inside myaPrice(); otherwise the
    // resolved price rides in the estimate slot (final is null in those states).
    // wasde_midpoint is cleared so myaPrice() can't re-apply it above a manual
    // override that resolveMyaPrice already ranked higher — for a 'wasde'
    // resolution, r.price IS the WASDE value riding the estimate slot.
    out.push({
      ...base,
      mya_price_estimate: r.state === 'final' ? base.mya_price_estimate : r.price,
      wasde_midpoint: null,
    })
  }
  return out
}

// Seed cotton MYA from a lint price ($/lb) and a cottonseed price ($/ton).
export function seedCottonMya(lintPerLb: number, cottonseedPerTon: number): number {
  const cottonseedPerLb = cottonseedPerTon / 2000
  return round6(LINT_SHARE * lintPerLb + COTTONSEED_SHARE * cottonseedPerLb)
}

export type PaymentResult = {
  effectivePrice: number // PLC only: MAX(mya, loan rate)
  paymentRatePerUnit: number
  grossPerAcre: number
  gross: number
  net: number
}

// PLC payment. effective_price floors the MYA at the national loan rate; the
// payment rate is how far the effective reference price sits above it.
export function computePlcPayment(args: {
  effectiveReferencePrice: number
  myaPrice: number
  nationalLoanRate: number
  plcYield: number
  baseAcres: number
  paymentFactor?: number
  sequestrationPct?: number
}): PaymentResult {
  const pf = args.paymentFactor ?? PAYMENT_FACTOR
  const seq = args.sequestrationPct ?? DEFAULT_SEQUESTRATION_PCT
  const effectivePrice = Math.max(args.myaPrice, args.nationalLoanRate)
  const paymentRate = Math.max(0, args.effectiveReferencePrice - effectivePrice)
  const grossPerAcre = paymentRate * args.plcYield
  const gross = grossPerAcre * args.baseAcres
  const net = gross * pf * (1 - seq)
  return {
    effectivePrice: round6(effectivePrice),
    paymentRatePerUnit: round6(paymentRate),
    grossPerAcre: round2(grossPerAcre),
    gross: round2(gross),
    net: round2(net),
  }
}

// ---------- ARC-CO county-revenue engine ----------

export type ArcCoEngineResult = PaymentResult & {
  benchmarkRevenue: number // benchmark price × benchmark county yield, $/acre
  guarantee: number // guaranteePct × benchmark revenue, $/acre
  actualRevenue: number // actual county yield × max(MYA, loan rate), $/acre
  maxRatePerAcre: number // capPct × benchmark revenue — the payment-rate cap
  capped: boolean // true when the revenue shortfall exceeded the cap
}

// The real ARC-CO calculation (OBBBA parameters passed in; 2025+ defaults):
//   benchmark_revenue = benchmark_price × benchmark_county_yield
//   guarantee         = guaranteePct (90%) × benchmark_revenue
//   actual_revenue    = actual_county_yield × max(MYA, national loan rate)
//   rate/acre         = min(max(0, guarantee − actual_revenue), capPct (12%) × benchmark_revenue)
//   payment           = rate × base_acres × paymentFactor (85%), less sequestration
export function computeArcCoPayment(args: {
  benchmarkPrice: number
  benchmarkYield: number
  myaPrice: number
  actualCountyYield: number
  nationalLoanRate?: number
  baseAcres: number
  guaranteePct?: number
  capPct?: number
  paymentFactor?: number
  sequestrationPct?: number
}): ArcCoEngineResult {
  const pf = args.paymentFactor ?? PAYMENT_FACTOR
  const seq = args.sequestrationPct ?? DEFAULT_SEQUESTRATION_PCT
  const guaranteePct = args.guaranteePct ?? defaultArcGuaranteePct(OBBBA_FIRST_YEAR)
  const capPct = args.capPct ?? defaultArcPaymentCapPct(OBBBA_FIRST_YEAR)
  const effectivePrice = Math.max(args.myaPrice, args.nationalLoanRate ?? 0)
  const benchmarkRevenue = args.benchmarkPrice * args.benchmarkYield
  const guarantee = guaranteePct * benchmarkRevenue
  const actualRevenue = args.actualCountyYield * effectivePrice
  const shortfall = Math.max(0, guarantee - actualRevenue)
  const maxRatePerAcre = capPct * benchmarkRevenue
  const ratePerAcre = Math.min(shortfall, maxRatePerAcre)
  const gross = ratePerAcre * args.baseAcres
  const net = gross * pf * (1 - seq)
  return {
    effectivePrice: round6(effectivePrice),
    paymentRatePerUnit: round6(ratePerAcre),
    grossPerAcre: round2(ratePerAcre),
    gross: round2(gross),
    net: round2(net),
    benchmarkRevenue: round2(benchmarkRevenue),
    guarantee: round2(guarantee),
    actualRevenue: round2(actualRevenue),
    maxRatePerAcre: round2(maxRatePerAcre),
    capped: shortfall > maxRatePerAcre,
  }
}

// Fallback ARC payment from a user-entered projected rate per base acre — for
// counties with no benchmark data yet, and for ARC-IC (which FSA computes from
// individual farm revenue we don't model).
export function computeArcCoFlatPayment(args: {
  projectedRatePerAcre: number
  baseAcres: number
  paymentFactor?: number
  sequestrationPct?: number
}): PaymentResult {
  const pf = args.paymentFactor ?? PAYMENT_FACTOR
  const seq = args.sequestrationPct ?? DEFAULT_SEQUESTRATION_PCT
  const gross = args.projectedRatePerAcre * args.baseAcres
  const net = gross * pf * (1 - seq)
  return {
    effectivePrice: 0,
    paymentRatePerUnit: round6(args.projectedRatePerAcre),
    grossPerAcre: round2(args.projectedRatePerAcre),
    gross: round2(gross),
    net: round2(net),
  }
}

// Resolve the benchmark row for a commodity × year × county: a county-specific
// row (case-insensitive) wins over the county-null default row.
export function resolveArcBenchmark(args: {
  commodityId: string
  cropYear: number
  county: string | null | undefined
  benchmarks: readonly ArcBenchmarkData[]
}): ArcBenchmarkData | null {
  const rows = args.benchmarks.filter(
    (b) => b.commodity_id === args.commodityId && b.crop_year === args.cropYear,
  )
  if (rows.length === 0) return null
  const county = args.county?.trim().toLowerCase()
  if (county) {
    const exact = rows.find((b) => b.county?.trim().toLowerCase() === county)
    if (exact) return exact
  }
  return rows.find((b) => b.county == null || b.county.trim() === '') ?? null
}

// The county-yield expectation applied to a benchmark yield: actual county
// yield = benchmark × (1 + pct/100). Kept in one place so the slider, the
// absolute-yield input, and the engine all agree.
export function expectedCountyYield(benchmarkYield: number, vsBenchmarkPct: number): number {
  return round2(benchmarkYield * (1 + vsBenchmarkPct / 100))
}

// ARC/PLC for a crop year is paid in October of the following year. Returns an
// ISO date string (Oct 1 of crop_year + 1).
export function expectedArcPlcDate(cropYear: number): string {
  return `${cropYear + 1}-10-01`
}

// Per-entity payment limit total = eligible persons × per-person limit.
export function paymentLimitTotal(eligiblePersons: number, perPersonLimit: number): number {
  return round2(eligiblePersons * perPersonLimit)
}

// ---------- Per farm × commodity projection ----------

// How an ARC-CO number was produced: the county-revenue engine (benchmark data
// available) or the flat user-entered $/acre fallback.
export type ArcMethod = 'engine' | 'flat'

// The engine's visible drivers, surfaced on the Decision Aid / Tracker.
export type ArcCoDetail = {
  county: string | null
  benchmarkPrice: number
  benchmarkYield: number
  countyYieldVsBenchmarkPct: number
  actualCountyYield: number
  benchmarkRevenue: number
  guarantee: number
  actualRevenue: number
  maxRatePerAcre: number
  capped: boolean
  guaranteePct: number
  capPct: number
}

export type CommodityPaymentResult = {
  election: ArcPlcElectionType
  effectiveReferencePrice: number
  myaPrice: number | null
  effectivePrice: number | null // PLC only
  paymentRatePerUnit: number
  grossPerAcre: number
  gross: number
  net: number
  // false when PLC has no MYA price yet, or ARC has neither benchmark data nor
  // a projected flat rate entered.
  computable: boolean
  // ARC elections only: which path produced the number, and (engine only) the
  // drivers behind it.
  arcMethod: ArcMethod | null
  arcDetail: ArcCoDetail | null
}

// Project the net payment for one farm × commodity at its election. PLC is
// computed from price data. ARC-CO runs the county-revenue engine when
// benchmark price + yield + an MYA are available; otherwise (and for ARC-IC,
// whose individual-farm revenue we don't model) it falls back to the
// user-entered projected rate per acre.
export function computeCommodityPayment(args: {
  commodity: CoveredCommodity
  baseAcres: number
  plcYield: number
  election: ArcPlcElectionType
  priceData?: ArcPlcPriceData | null
  arcRatePerAcre?: number | null
  // The resolved benchmark row for this commodity × year × county (see
  // resolveArcBenchmark); null → flat fallback.
  benchmark?: ArcBenchmarkData | null
  paymentFactor?: number
  sequestrationPct?: number
  arcGuaranteePct?: number
  arcPaymentCapPct?: number
  arcIcPaymentFactor?: number
}): CommodityPaymentResult {
  const effRef = effectiveReferencePrice(args.commodity, args.priceData)
  if (args.election === 'PLC') {
    const mya = myaPrice(args.priceData)
    if (mya == null) {
      return { election: args.election, effectiveReferencePrice: effRef, myaPrice: null, effectivePrice: null, paymentRatePerUnit: 0, grossPerAcre: 0, gross: 0, net: 0, computable: false, arcMethod: null, arcDetail: null }
    }
    const r = computePlcPayment({
      effectiveReferencePrice: effRef,
      myaPrice: mya,
      nationalLoanRate: Number(args.commodity.national_loan_rate),
      plcYield: args.baseAcres > 0 ? args.plcYield : 0,
      baseAcres: args.baseAcres,
      paymentFactor: args.paymentFactor,
      sequestrationPct: args.sequestrationPct,
    })
    return {
      election: args.election, effectiveReferencePrice: effRef, myaPrice: mya, effectivePrice: r.effectivePrice,
      paymentRatePerUnit: r.paymentRatePerUnit, grossPerAcre: r.grossPerAcre, gross: r.gross, net: r.net,
      computable: true, arcMethod: null, arcDetail: null,
    }
  }

  const mya = myaPrice(args.priceData)

  // ARC-CO with benchmark data → the county-revenue engine.
  if (
    args.election === 'ARC_CO' &&
    args.benchmark?.benchmark_price != null &&
    args.benchmark?.benchmark_yield != null &&
    mya != null
  ) {
    const benchmarkPrice = Number(args.benchmark.benchmark_price)
    const benchmarkYield = Number(args.benchmark.benchmark_yield)
    const vsPct = Number(args.benchmark.county_yield_vs_benchmark_pct ?? 0)
    const actualCountyYield = expectedCountyYield(benchmarkYield, vsPct)
    const r = computeArcCoPayment({
      benchmarkPrice,
      benchmarkYield,
      myaPrice: mya,
      actualCountyYield,
      nationalLoanRate: Number(args.commodity.national_loan_rate),
      baseAcres: args.baseAcres,
      guaranteePct: args.arcGuaranteePct,
      capPct: args.arcPaymentCapPct,
      paymentFactor: args.paymentFactor,
      sequestrationPct: args.sequestrationPct,
    })
    return {
      election: args.election, effectiveReferencePrice: effRef, myaPrice: mya, effectivePrice: null,
      paymentRatePerUnit: r.paymentRatePerUnit, grossPerAcre: r.grossPerAcre, gross: r.gross, net: r.net,
      computable: true,
      arcMethod: 'engine',
      arcDetail: {
        county: args.benchmark.county,
        benchmarkPrice,
        benchmarkYield,
        countyYieldVsBenchmarkPct: vsPct,
        actualCountyYield,
        benchmarkRevenue: r.benchmarkRevenue,
        guarantee: r.guarantee,
        actualRevenue: r.actualRevenue,
        maxRatePerAcre: r.maxRatePerAcre,
        capped: r.capped,
        guaranteePct: args.arcGuaranteePct ?? defaultArcGuaranteePct(OBBBA_FIRST_YEAR),
        capPct: args.arcPaymentCapPct ?? defaultArcPaymentCapPct(OBBBA_FIRST_YEAR),
      },
    }
  }

  // ARC-CO without benchmark data, and ARC-IC: flat user-entered rate. ARC-IC
  // pays on 65% of base acres rather than 85%.
  const rate = args.arcRatePerAcre
  const pf = args.election === 'ARC_IC'
    ? (args.arcIcPaymentFactor ?? DEFAULT_ARC_IC_PAYMENT_FACTOR)
    : args.paymentFactor
  const r = computeArcCoFlatPayment({
    projectedRatePerAcre: rate ?? 0,
    baseAcres: args.baseAcres,
    paymentFactor: pf,
    sequestrationPct: args.sequestrationPct,
  })
  return {
    election: args.election, effectiveReferencePrice: effRef, myaPrice: mya, effectivePrice: null,
    paymentRatePerUnit: r.paymentRatePerUnit, grossPerAcre: r.grossPerAcre, gross: r.gross, net: r.net,
    computable: rate != null, arcMethod: 'flat', arcDetail: null,
  }
}

// ---------- Whole-operation projection ----------

export type ProjectedPayment = {
  farmId: string
  commodityId: string
  election: ArcPlcElectionType
  baseAcres: number
  plcYield: number
  arcRatePerAcre: number | null
  result: CommodityPaymentResult
}

// Project every farm × commodity base-acre record for a crop year, resolving
// the election, price data, ARC-CO benchmark data (matched to the farm's
// county), and (for the fallback) the stored projected flat rate. PLC defaults
// when no election row exists. Reused by the decision aid, tracker, Revenue
// Projections, and Cash Flow — callers that don't pass benchmarks/farms simply
// keep the flat-rate fallback behavior.
export function projectPayments(args: {
  cropYear: number
  baseAcres: FarmBaseAcres[]
  commodities: CoveredCommodity[]
  elections: ArcPlcElection[]
  priceData: ArcPlcPriceData[]
  payments: ArcPlcPayment[]
  // ARC-CO benchmark rows + farm counties; both needed for the engine path.
  benchmarks?: ArcBenchmarkData[]
  farms?: Array<{ id: string; county?: string | null }>
  // Per-year parameters (from program_year_config). Defaults to built-ins
  // when omitted.
  sequestrationPct?: number
  paymentFactor?: number
  arcGuaranteePct?: number
  arcPaymentCapPct?: number
  arcIcPaymentFactor?: number
}): ProjectedPayment[] {
  const commodityById = new Map(args.commodities.map((c) => [c.id, c]))
  const countyByFarm = new Map((args.farms ?? []).map((f) => [f.id, f.county ?? null]))
  const out: ProjectedPayment[] = []
  for (const b of args.baseAcres) {
    // Unassigned (generic) base never generates a payment.
    if (b.is_unassigned || !b.commodity_id) continue
    const commodity = commodityById.get(b.commodity_id)
    if (!commodity) continue
    const election = args.elections.find((e) => e.farm_id === b.farm_id && e.commodity_id === b.commodity_id && e.crop_year === args.cropYear)?.election ?? 'PLC'
    const pd = args.priceData.find((p) => p.commodity_id === b.commodity_id && p.crop_year === args.cropYear) ?? null
    const payRow = args.payments.find((p) => p.farm_id === b.farm_id && p.commodity_id === b.commodity_id && p.crop_year === args.cropYear)
    const arcRate = election !== 'PLC' && payRow ? Number(payRow.payment_rate_per_unit) : null
    const benchmark = args.benchmarks
      ? resolveArcBenchmark({
          commodityId: b.commodity_id,
          cropYear: args.cropYear,
          county: countyByFarm.get(b.farm_id) ?? null,
          benchmarks: args.benchmarks,
        })
      : null
    const result = computeCommodityPayment({
      commodity, baseAcres: Number(b.base_acres), plcYield: Number(b.plc_yield), election, priceData: pd, arcRatePerAcre: arcRate,
      benchmark,
      sequestrationPct: args.sequestrationPct,
      paymentFactor: args.paymentFactor,
      arcGuaranteePct: args.arcGuaranteePct,
      arcPaymentCapPct: args.arcPaymentCapPct,
      arcIcPaymentFactor: args.arcIcPaymentFactor,
    })
    out.push({ farmId: b.farm_id, commodityId: b.commodity_id, election, baseAcres: Number(b.base_acres), plcYield: Number(b.plc_yield), arcRatePerAcre: arcRate, result })
  }
  return out
}
