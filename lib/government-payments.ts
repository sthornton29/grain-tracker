// Government payment engine — pure math for ARC/PLC projections plus the seed
// cotton MYA conversion and payment-limit helpers. No I/O: the settings page and
// the reports pass already-fetched rows in. All projections are ESTIMATES; FSA
// determines actual payments (and any limit reductions) after the marketing year.

import { cropToCommodity } from '@/lib/contracts'
import { buildContractSymbol, contractMonthOptions, type Commodity } from '@/lib/hedging'
import { DEFAULT_SEQUESTRATION_PCT } from '@/lib/program-config'
import type {
  ArcPlcElection, ArcPlcElectionType, ArcPlcPayment, ArcPlcPriceData, CoveredCommodity, FarmBaseAcres,
} from '@/lib/types'

// The 85% base-acre payment factor applies to ARC and PLC gross payments. The
// sequestration % and the per-person payment limit are per-crop-year values now;
// they come from program_year_config (see lib/program-config.ts), and callers
// pass the resolved sequestration % into the compute functions below.
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

// Effective reference price: the override stored for the year, else the
// statutory reference price (the OBBBA floor).
export function effectiveReferencePrice(commodity: CoveredCommodity, priceData?: ArcPlcPriceData | null): number {
  if (priceData?.effective_reference_price != null) return Number(priceData.effective_reference_price)
  return Number(commodity.statutory_reference_price)
}

// The MYA price to use: the final once published, else the running estimate,
// else null (the user must enter one for untraded commodities).
export function myaPrice(priceData?: ArcPlcPriceData | null): number | null {
  if (priceData?.mya_price_final != null) return Number(priceData.mya_price_final)
  if (priceData?.mya_price_estimate != null) return Number(priceData.mya_price_estimate)
  return null
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

// ARC-CO payment from a user-entered projected rate per base acre (the full
// county-revenue calculation is determined by FSA and not replicated here).
export function computeArcCoPayment(args: {
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

export type CommodityPaymentResult = {
  election: ArcPlcElectionType
  effectiveReferencePrice: number
  myaPrice: number | null
  effectivePrice: number | null // PLC only
  paymentRatePerUnit: number
  grossPerAcre: number
  gross: number
  net: number
  // false when PLC has no MYA price yet, or ARC has no projected rate entered.
  computable: boolean
}

// Project the net payment for one farm × commodity at its election. PLC is
// computed from price data; ARC-CO/ARC-IC use the user-entered projected rate
// per acre (the full county-revenue calc is determined by FSA).
export function computeCommodityPayment(args: {
  commodity: CoveredCommodity
  baseAcres: number
  plcYield: number
  election: ArcPlcElectionType
  priceData?: ArcPlcPriceData | null
  arcRatePerAcre?: number | null
  paymentFactor?: number
  sequestrationPct?: number
}): CommodityPaymentResult {
  const effRef = effectiveReferencePrice(args.commodity, args.priceData)
  if (args.election === 'PLC') {
    const mya = myaPrice(args.priceData)
    if (mya == null) {
      return { election: args.election, effectiveReferencePrice: effRef, myaPrice: null, effectivePrice: null, paymentRatePerUnit: 0, grossPerAcre: 0, gross: 0, net: 0, computable: false }
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
      paymentRatePerUnit: r.paymentRatePerUnit, grossPerAcre: r.grossPerAcre, gross: r.gross, net: r.net, computable: true,
    }
  }
  // ARC-CO / ARC-IC: user-entered projected rate per acre.
  const rate = args.arcRatePerAcre
  const r = computeArcCoPayment({
    projectedRatePerAcre: rate ?? 0,
    baseAcres: args.baseAcres,
    paymentFactor: args.paymentFactor,
    sequestrationPct: args.sequestrationPct,
  })
  return {
    election: args.election, effectiveReferencePrice: effRef, myaPrice: myaPrice(args.priceData), effectivePrice: null,
    paymentRatePerUnit: r.paymentRatePerUnit, grossPerAcre: r.grossPerAcre, gross: r.gross, net: r.net, computable: rate != null,
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

// Project every farm × commodity base-acre record for a crop year, resolving the
// election, price data, and (for ARC) the stored projected rate. PLC defaults
// when no election row exists. Reused by the decision aid, tracker, Revenue
// Projections, and Cash Flow.
export function projectPayments(args: {
  cropYear: number
  baseAcres: FarmBaseAcres[]
  commodities: CoveredCommodity[]
  elections: ArcPlcElection[]
  priceData: ArcPlcPriceData[]
  payments: ArcPlcPayment[]
  // Per-year sequestration % (from program_year_config). Defaults to the
  // built-in value when omitted.
  sequestrationPct?: number
}): ProjectedPayment[] {
  const commodityById = new Map(args.commodities.map((c) => [c.id, c]))
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
    const result = computeCommodityPayment({
      commodity, baseAcres: Number(b.base_acres), plcYield: Number(b.plc_yield), election, priceData: pd, arcRatePerAcre: arcRate,
      sequestrationPct: args.sequestrationPct,
    })
    out.push({ farmId: b.farm_id, commodityId: b.commodity_id, election, baseAcres: Number(b.base_acres), plcYield: Number(b.plc_yield), arcRatePerAcre: arcRate, result })
  }
  return out
}
