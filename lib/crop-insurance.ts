// Crop insurance indemnity engine — pure math for individual MPCI policies
// (RP / RP-HPE / YP) plus SCO and ECO area-band endorsements. No I/O: the
// report and settings pages pass already-fetched values in, so every number on
// screen is reproducible and the What-If tool just re-runs these functions with
// different yield / price assumptions.
//
// All amounts are ESTIMATES until RMA sets the final harvest price and county
// yields after harvest. The UI labels them as such.

import { buildContractSymbol, type Commodity } from '@/lib/hedging'
import { cropToCommodity } from '@/lib/contracts'
import { DEFAULT_SCO_TRIGGER } from '@/lib/program-config'
import type { HarvestPriceEstimate } from '@/lib/types'

export const PLAN_TYPES = ['RP', 'RP_HPE', 'YP'] as const
export type PlanType = (typeof PLAN_TYPES)[number]

export const UNIT_STRUCTURES = ['enterprise', 'basic', 'optional'] as const
export type UnitStructure = (typeof UNIT_STRUCTURES)[number]

export const PLAN_TYPE_LABEL: Record<PlanType, string> = {
  RP: 'Revenue Protection (RP)',
  RP_HPE: 'RP — Harvest Price Exclusion',
  YP: 'Yield Protection (YP)',
}

export const PLAN_TYPE_SHORT: Record<PlanType, string> = {
  RP: 'RP',
  RP_HPE: 'RP-HPE',
  YP: 'YP',
}

export const UNIT_STRUCTURE_LABEL: Record<UnitStructure, string> = {
  enterprise: 'Enterprise (all acres of a crop in a county)',
  basic: 'Basic (by FSA farm number)',
  optional: 'Optional (by FSA farm number + section)',
}

export const ECO_TRIGGER_LEVELS = [0.9, 0.95] as const

// Irrigated vs dryland practice. Stored on the policy; SCO/ECO inherit it from
// the parent. 'non_irrigated' is the default (dryland), matching fields/plantings.
export const PRACTICES = ['irrigated', 'non_irrigated'] as const
export type Practice = (typeof PRACTICES)[number]
export const PRACTICE_LABEL: Record<Practice, string> = {
  irrigated: 'Irrigated',
  non_irrigated: 'Dryland',
}
export const PRACTICE_SHORT: Record<Practice, string> = {
  irrigated: 'Irr',
  non_irrigated: 'Dry',
}

// The futures delivery month whose price discovery period sets each crop's
// RMA harvest price (corn/soy in October, Chicago wheat in August/September).
const HARVEST_MONTH_ABBR: Record<Commodity, string> = {
  Corn: 'DEC',
  Soybeans: 'NOV',
  'Chicago Wheat': 'SEP',
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// The RMA projected (spring) price for a crop + crop year, read from the
// harvest_price_estimates table (price_type = 'projected'). RMA announces these
// each February; the operator enters/edits them under Settings → Crop Insurance.
// Returns the most recently dated projected row for that crop/year, or null when
// none is on file. Replaces the old hard-coded PROJECTED_PRICES_2026 map.
export function projectedPriceFromEstimates(
  estimates: readonly HarvestPriceEstimate[],
  cropId: string,
  cropYear: number,
): number | null {
  let best: HarvestPriceEstimate | null = null
  for (const e of estimates) {
    if (e.crop_id !== cropId || e.crop_year !== cropYear || e.price_type !== 'projected') continue
    if (best == null || e.price_date > best.price_date) best = e
  }
  return best ? Number(best.price) : null
}

// The Barchart futures symbol whose current price estimates the harvest price,
// e.g. Corn 2026 -> "ZCZ26". null when the crop has no traded-futures mapping.
export function harvestContractSymbol(cropName: string | null | undefined, cropYear: number): string | null {
  const c = cropToCommodity(cropName)
  if (!c) return null
  const yy = String(cropYear % 100).padStart(2, '0')
  const sym = buildContractSymbol(c, `${HARVEST_MONTH_ABBR[c]} ${yy}`)
  return sym || null
}

// A human label for the harvest contract, e.g. "DEC 26 Corn".
export function harvestContractLabel(cropName: string | null | undefined, cropYear: number): string | null {
  const c = cropToCommodity(cropName)
  if (!c) return null
  const yy = String(cropYear % 100).padStart(2, '0')
  const display = c === 'Chicago Wheat' ? 'Wheat' : c
  return `${HARVEST_MONTH_ABBR[c]} ${yy} ${display}`
}

// ---------- Premium helpers ----------

// Producer-paid premium for the base policy. Prefer the stored total; fall back
// to per-acre × acres so a partially-filled policy still totals.
export function policyPremium(p: {
  total_premium: number | null
  premium_per_acre: number | null
  insured_acres: number | null
}): number {
  if (p.total_premium != null) return Number(p.total_premium)
  if (p.premium_per_acre != null && p.insured_acres != null) {
    return round2(Number(p.premium_per_acre) * Number(p.insured_acres))
  }
  return 0
}

// Endorsement premium (SCO or ECO): stored total, else per-acre × insured acres.
export function endorsementPremium(
  e: { total_premium: number | null; premium_per_acre: number | null },
  insuredAcres: number,
): number {
  if (e.total_premium != null) return Number(e.total_premium)
  if (e.premium_per_acre != null) return round2(Number(e.premium_per_acre) * insuredAcres)
  return 0
}

// ---------- Base policy indemnity ----------

export type PolicyInputs = {
  planType: PlanType
  coverageLevel: number
  aphYield: number
  projectedPrice: number
  harvestPrice: number // final if known, else running estimate
  insuredAcres: number
  actualYield: number // producer's actual/expected yield, bu/ac
}

export type IndemnityResult = {
  // The price the guarantee is valued at: MAX(projected, harvest) for RP and the
  // YP shortfall valuation; projected only for RP-HPE.
  guaranteePrice: number
  // Revenue (or, for YP, production-value) guarantee in dollars.
  revenueGuarantee: number
  // Expected revenue at the actual/assumed yield and harvest price.
  expectedRevenue: number
  indemnity: number
  // Yield-protection intermediates (undefined for RP / RP-HPE).
  productionGuaranteeBu?: number
  actualProductionBu?: number
  indemnityBushels?: number
}

// The price used to value a policy's guarantee. RP and YP both look up to the
// harvest price (RP for revenue, YP for valuing the bushel shortfall); RP-HPE
// is fixed at the projected price.
export function guaranteePriceFor(planType: PlanType, projectedPrice: number, harvestPrice: number): number {
  if (planType === 'RP_HPE') return projectedPrice
  return Math.max(projectedPrice, harvestPrice)
}

export function computeIndemnity(inp: PolicyInputs): IndemnityResult {
  const { planType, coverageLevel, aphYield, projectedPrice, harvestPrice, insuredAcres, actualYield } = inp
  const gp = guaranteePriceFor(planType, projectedPrice, harvestPrice)

  if (planType === 'YP') {
    const productionGuaranteeBu = aphYield * coverageLevel * insuredAcres
    const actualProductionBu = actualYield * insuredAcres
    const indemnityBushels = Math.max(0, productionGuaranteeBu - actualProductionBu)
    const indemnity = indemnityBushels * gp
    return {
      guaranteePrice: gp,
      revenueGuarantee: round2(aphYield * coverageLevel * gp * insuredAcres),
      expectedRevenue: round2(actualYield * harvestPrice * insuredAcres),
      indemnity: round2(indemnity),
      productionGuaranteeBu: round2(productionGuaranteeBu),
      actualProductionBu: round2(actualProductionBu),
      indemnityBushels: round2(indemnityBushels),
    }
  }

  // RP and RP-HPE: revenue guarantee vs actual revenue.
  const revenueGuarantee = aphYield * coverageLevel * gp * insuredAcres
  const actualRevenue = actualYield * harvestPrice * insuredAcres
  const indemnity = Math.max(0, revenueGuarantee - actualRevenue)
  return {
    guaranteePrice: gp,
    revenueGuarantee: round2(revenueGuarantee),
    expectedRevenue: round2(actualRevenue),
    indemnity: round2(indemnity),
  }
}

// ---------- SCO / ECO area-band endorsements ----------

export type BandInputs = {
  // The lower edge of the covered band (SCO: the policy coverage level; ECO: 0.86).
  lowerLevel: number
  // The upper trigger (SCO: 0.86; ECO: 0.90 or 0.95).
  upperTrigger: number
  expectedCountyYield: number
  // County yield assumed from the producer's yield and a relative-performance %.
  estimatedCountyYield: number
  // Price used to value the band: the policy's guarantee price.
  guaranteePrice: number
  harvestPrice: number
  aphYield: number
  insuredAcres: number
  // RP-based plans use a county REVENUE ratio; YP uses a county YIELD ratio.
  revenueBased: boolean
}

export type BandResult = {
  ratio: number // county revenue (or yield) ratio vs expected
  paymentFactor: number
  paymentLimit: number
  indemnity: number
  bandWidth: number
}

// Generic area-band indemnity, shared by SCO and ECO. The band pays from the
// upper trigger down to the lower level, scaled by how far the county ratio
// falls below the trigger.
export function computeBandIndemnity(inp: BandInputs): BandResult {
  const bandWidth = inp.upperTrigger - inp.lowerLevel
  const paymentLimit = bandWidth > 0 ? bandWidth * inp.aphYield * inp.guaranteePrice * inp.insuredAcres : 0

  let ratio: number
  if (inp.revenueBased) {
    const expectedCountyRevenue = inp.expectedCountyYield * inp.guaranteePrice
    const actualCountyRevenue = inp.estimatedCountyYield * inp.harvestPrice
    ratio = expectedCountyRevenue > 0 ? actualCountyRevenue / expectedCountyRevenue : 0
  } else {
    ratio = inp.expectedCountyYield > 0 ? inp.estimatedCountyYield / inp.expectedCountyYield : 0
  }

  let paymentFactor = 0
  let indemnity = 0
  if (bandWidth > 0 && ratio < inp.upperTrigger) {
    paymentFactor = Math.min(inp.upperTrigger - ratio, bandWidth)
    indemnity = (paymentFactor / bandWidth) * paymentLimit
  }
  return {
    ratio: round6(ratio),
    paymentFactor: round6(paymentFactor),
    paymentLimit: round2(paymentLimit),
    indemnity: round2(indemnity),
    bandWidth: round6(bandWidth),
  }
}

// Estimated county yield from the producer's yield and the relative-performance
// assumption (e.g. county typically -10% of producer -> factor 0.90).
export function estimatedCountyYield(actualYield: number, assumptionPct: number | null | undefined): number {
  return actualYield * (1 + (Number(assumptionPct ?? 0)) / 100)
}

export type ScoEcoInputs = {
  expectedCountyYield: number
  countyYieldAssumptionPct: number | null
  trigger: number // SCO: 0.86; ECO: 0.90/0.95
  lowerLevel: number // SCO: policy coverage level; ECO: 0.86
}

// SCO indemnity for a policy + the producer's assumed yield.
export function computeScoIndemnity(base: PolicyInputs, sco: ScoEcoInputs): BandResult {
  const gp = guaranteePriceFor(base.planType, base.projectedPrice, base.harvestPrice)
  return computeBandIndemnity({
    lowerLevel: sco.lowerLevel,
    upperTrigger: sco.trigger,
    expectedCountyYield: sco.expectedCountyYield,
    estimatedCountyYield: estimatedCountyYield(base.actualYield, sco.countyYieldAssumptionPct),
    guaranteePrice: gp,
    harvestPrice: base.harvestPrice,
    aphYield: base.aphYield,
    insuredAcres: base.insuredAcres,
    revenueBased: base.planType !== 'YP',
  })
}

// ECO indemnity for a policy + the producer's assumed yield. The ECO band
// always starts at the SCO trigger (0.86) regardless of the policy level.
export function computeEcoIndemnity(base: PolicyInputs, eco: ScoEcoInputs): BandResult {
  const gp = guaranteePriceFor(base.planType, base.projectedPrice, base.harvestPrice)
  return computeBandIndemnity({
    lowerLevel: eco.lowerLevel,
    upperTrigger: eco.trigger,
    expectedCountyYield: eco.expectedCountyYield,
    estimatedCountyYield: estimatedCountyYield(base.actualYield, eco.countyYieldAssumptionPct),
    guaranteePrice: gp,
    harvestPrice: base.harvestPrice,
    aphYield: base.aphYield,
    insuredAcres: base.insuredAcres,
    revenueBased: base.planType !== 'YP',
  })
}

// ---------- Combined per-policy result ----------

export type PolicyComputation = {
  base: IndemnityResult
  sco: BandResult | null
  eco: BandResult | null
  totalIndemnity: number
  premiumPaid: number
  netPnl: number // totalIndemnity - premiumPaid
}

export type ScoConfig = {
  coverageTrigger: number
  expectedCountyYield: number
  countyYieldAssumptionPct: number | null
  premiumPerAcre: number | null
  totalPremium: number | null
}
export type EcoConfig = {
  ecoTriggerLevel: number
  expectedCountyYield: number
  countyYieldAssumptionPct: number | null
  premiumPerAcre: number | null
  totalPremium: number | null
}

// Full computation for one policy at a given assumed yield + harvest price,
// including SCO/ECO bands and the net insurance P&L.
export function computePolicy(args: {
  base: PolicyInputs
  basePremium: number
  sco: ScoConfig | null
  eco: EcoConfig | null
  // The SCO trigger for this crop year (from program_year_config). Only used as
  // the ECO band's lower edge when there's no SCO endorsement to take it from.
  scoTriggerDefault?: number
}): PolicyComputation {
  const base = computeIndemnity(args.base)

  let scoResult: BandResult | null = null
  let scoPremium = 0
  if (args.sco) {
    scoResult = computeScoIndemnity(args.base, {
      expectedCountyYield: args.sco.expectedCountyYield,
      countyYieldAssumptionPct: args.sco.countyYieldAssumptionPct,
      trigger: args.sco.coverageTrigger,
      lowerLevel: args.base.coverageLevel,
    })
    scoPremium = endorsementPremium(
      { total_premium: args.sco.totalPremium, premium_per_acre: args.sco.premiumPerAcre },
      args.base.insuredAcres,
    )
  }

  let ecoResult: BandResult | null = null
  let ecoPremium = 0
  if (args.eco) {
    ecoResult = computeEcoIndemnity(args.base, {
      expectedCountyYield: args.eco.expectedCountyYield,
      countyYieldAssumptionPct: args.eco.countyYieldAssumptionPct,
      trigger: args.eco.ecoTriggerLevel,
      lowerLevel: args.sco?.coverageTrigger ?? args.scoTriggerDefault ?? DEFAULT_SCO_TRIGGER,
    })
    ecoPremium = endorsementPremium(
      { total_premium: args.eco.totalPremium, premium_per_acre: args.eco.premiumPerAcre },
      args.base.insuredAcres,
    )
  }

  const totalIndemnity = round2(base.indemnity + (scoResult?.indemnity ?? 0) + (ecoResult?.indemnity ?? 0))
  const premiumPaid = round2(args.basePremium + scoPremium + ecoPremium)
  return {
    base,
    sco: scoResult,
    eco: ecoResult,
    totalIndemnity,
    premiumPaid,
    netPnl: round2(totalIndemnity - premiumPaid),
  }
}

// ---------- Acreage coverage check (reconcile insured vs planted) ----------
//
// Verifies that every planted acre is covered by a policy at the correct
// practice, and that insured acres line up with planted acres. Pure: the UI
// pulls planted acres from field_plantings (by county/practice) and insured
// acres from the policies, and passes them in.

export type CoverageStatus =
  | 'matched'             // insured ≈ planted (within tolerance)
  | 'under_insured'       // insured < planted beyond tolerance (uncovered acres)
  | 'over_reported'       // insured > planted beyond tolerance (review)
  | 'no_policy'           // planted acres with no matching policy (uninsured)
  | 'insured_not_planted' // a policy exists but no plantings (reverse gap)

export type CoveragePlantingInput = { cropId: string; countyId: string | null; practice: Practice; plantedAcres: number }
export type CoveragePolicyInput = { cropId: string; countyId: string | null; practice: Practice; insuredAcres: number }

export type CoverageRow = {
  cropId: string
  countyId: string | null
  practice: Practice
  plantedAcres: number
  insuredAcres: number
  policyCount: number
  variance: number // insuredAcres − plantedAcres
  tolerance: number
  status: CoverageStatus
}

export type CoverageSummary = {
  totalPlanted: number
  totalInsured: number
  // Planted acres carrying no policy + the shortfall on under-insured rows.
  uninsuredAcres: number
  flaggedCount: number // rows not 'matched'
}

// Trivial-rounding tolerance: the greater of 0.5 acres or 1% of planted acres.
export function acreageTolerance(plantedAcres: number): number {
  return Math.max(0.5, plantedAcres * 0.01)
}

const covKey = (cropId: string, countyId: string | null, practice: Practice) => `${cropId}|${countyId ?? ''}|${practice}`

export function reconcileAcreage(args: {
  plantings: readonly CoveragePlantingInput[]
  policies: readonly CoveragePolicyInput[]
}): { rows: CoverageRow[]; insuredNotPlanted: CoverageRow[]; summary: CoverageSummary } {
  // Aggregate planted acres per crop × county × practice.
  const planted = new Map<string, CoveragePlantingInput>()
  for (const p of args.plantings) {
    if (!(p.plantedAcres > 0)) continue
    const k = covKey(p.cropId, p.countyId, p.practice)
    const cur = planted.get(k)
    if (cur) cur.plantedAcres += p.plantedAcres
    else planted.set(k, { ...p })
  }
  // Aggregate insured acres + policy count per crop × county × practice (sums
  // across multiple optional-unit policies for the same combination).
  const insured = new Map<string, { input: CoveragePolicyInput; insuredAcres: number; count: number }>()
  for (const p of args.policies) {
    const k = covKey(p.cropId, p.countyId, p.practice)
    const cur = insured.get(k)
    if (cur) { cur.insuredAcres += p.insuredAcres; cur.count++ }
    else insured.set(k, { input: { ...p }, insuredAcres: p.insuredAcres, count: 1 })
  }

  const rows: CoverageRow[] = []
  for (const [k, pl] of planted) {
    const ins = insured.get(k)
    const insuredAcres = ins?.insuredAcres ?? 0
    const policyCount = ins?.count ?? 0
    const tol = acreageTolerance(pl.plantedAcres)
    let status: CoverageStatus
    if (policyCount === 0) status = 'no_policy'
    else if (insuredAcres < pl.plantedAcres - tol) status = 'under_insured'
    else if (insuredAcres > pl.plantedAcres + tol) status = 'over_reported'
    else status = 'matched'
    rows.push({
      cropId: pl.cropId, countyId: pl.countyId, practice: pl.practice,
      plantedAcres: round2(pl.plantedAcres), insuredAcres: round2(insuredAcres), policyCount,
      variance: round2(insuredAcres - pl.plantedAcres), tolerance: round2(tol), status,
    })
  }

  // Reverse gap: insured combinations with no plantings this year.
  const insuredNotPlanted: CoverageRow[] = []
  for (const [k, ins] of insured) {
    if (planted.has(k)) continue
    insuredNotPlanted.push({
      cropId: ins.input.cropId, countyId: ins.input.countyId, practice: ins.input.practice,
      plantedAcres: 0, insuredAcres: round2(ins.insuredAcres), policyCount: ins.count,
      variance: round2(ins.insuredAcres), tolerance: 0, status: 'insured_not_planted',
    })
  }

  let totalPlanted = 0, totalInsured = 0, uninsuredAcres = 0, flaggedCount = 0
  for (const r of rows) {
    totalPlanted += r.plantedAcres
    totalInsured += r.insuredAcres
    if (r.status === 'no_policy') uninsuredAcres += r.plantedAcres
    else if (r.status === 'under_insured') uninsuredAcres += r.plantedAcres - r.insuredAcres
    if (r.status !== 'matched') flaggedCount++
  }

  return {
    rows,
    insuredNotPlanted,
    summary: {
      totalPlanted: round2(totalPlanted),
      totalInsured: round2(totalInsured),
      uninsuredAcres: round2(uninsuredAcres),
      flaggedCount,
    },
  }
}

// ---------- Sensitivity ----------

export type SensitivityPoint = {
  yieldPct: number // -20 .. +20
  actualYield: number
  totalIndemnity: number
  netPnl: number
}

// Recompute total indemnity across a ±range of yields (default ±20% in 5%
// steps) holding everything else constant — drives the per-policy "what if my
// yield is higher/lower?" table.
export function sensitivityTable(args: {
  base: PolicyInputs
  basePremium: number
  sco: ScoConfig | null
  eco: EcoConfig | null
  range?: number
  step?: number
}): SensitivityPoint[] {
  const range = args.range ?? 20
  const step = args.step ?? 5
  const baseYield = args.base.actualYield
  const points: SensitivityPoint[] = []
  for (let pct = -range; pct <= range + 1e-9; pct += step) {
    const actualYield = baseYield * (1 + pct / 100)
    const comp = computePolicy({
      base: { ...args.base, actualYield },
      basePremium: args.basePremium,
      sco: args.sco,
      eco: args.eco,
    })
    points.push({
      yieldPct: Math.round(pct),
      actualYield: round2(actualYield),
      totalIndemnity: comp.totalIndemnity,
      netPnl: comp.netPnl,
    })
  }
  return points
}
