// Crop insurance indemnity engine — pure math for individual MPCI policies
// (RP / RP-HPE / YP) plus SCO and ECO area-band endorsements. No I/O: the
// report and settings pages pass already-fetched values in, so every number on
// screen is reproducible and the What-If tool just re-runs these functions with
// different yield / price assumptions.
//
// All amounts are ESTIMATES until RMA sets the final harvest price and county
// yields after harvest. The UI labels them as such.

import { buildContractSymbol, type Commodity } from '@/lib/hedging'
import { cropToHedgeCommodity } from '@/lib/contracts'
import { DEFAULT_SCO_TRIGGER } from '@/lib/program-config'
import { computeBushels } from '@/lib/shrink'
import type {
  HarvestPriceEstimate, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco,
  CropAssumption, FieldPlanting, Crop,
} from '@/lib/types'

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
  // ICE Cotton No. 2 December — RMA upland cotton harvest-price discovery.
  Cotton: 'DEC',
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
  const c = cropToHedgeCommodity(cropName)
  if (!c) return null
  const yy = String(cropYear % 100).padStart(2, '0')
  const sym = buildContractSymbol(c, `${HARVEST_MONTH_ABBR[c]} ${yy}`)
  return sym || null
}

// A human label for the harvest contract, e.g. "DEC 26 Corn".
export function harvestContractLabel(cropName: string | null | undefined, cropYear: number): string | null {
  const c = cropToHedgeCommodity(cropName)
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

// Resolve the entity a policy upload / manual entry belongs to. Crop insurance
// is carried per entity, so every policy from one upload gets one entity:
//   - if the user explicitly chose one, use it;
//   - else a single-entity operation auto-assigns its only entity (the user is
//     never asked to pick);
//   - else fall back to a provided default (e.g. the page's entity filter);
//   - else null (a multi-entity upload with nothing chosen — save is blocked
//     upstream until the user picks).
// Pure so the AI-import and manual flows resolve identically and it's testable.
export function resolveUploadEntityId(args: {
  entities: ReadonlyArray<{ id: string }>
  chosen: string
  fallback?: string
}): string | null {
  if (args.chosen) return args.chosen
  if (args.entities.length === 1) return args.entities[0].id
  return args.fallback || null
}

// ---------- Policy upload dedupe (Already exists / Update available / New) ----------
//
// Classifies one extracted policy row against the existing policy matched on
// entity + crop + county + crop_year + practice + plan_type, the brokerage-
// statement-import pattern:
//   - 'exists': every provided value matches → skip (unchecked, not imported).
//   - 'update': a material field differs → the EXISTING policy is updated in
//     place (never duplicated); `diffs` lists each change for the review UI.
//   - 'new': no match → insert.
// Preserve-existing: a blank extracted value never counts as a difference and
// never overwrites. Endorsements dedupe with their parent: an upload can add
// or correct an SCO/ECO (1:1 upsert on the policy) but never removes one, and
// an endorsement absent from the upload is not a difference.

export type PolicyUploadValues = {
  coverage_level: string
  unit_structure: string
  aph_yield: string
  projected_price: string
  harvest_price: string
  volatility_factor: string
  insured_acres: string
  premium_per_acre: string
  total_premium: string
  premium_subsidy_pct: string
  policy_number: string
  sco_enabled: boolean
  sco_expected_county_yield: string
  sco_premium_per_acre: string
  sco_total_premium: string
  eco_enabled: boolean
  eco_trigger_level: string
  eco_expected_county_yield: string
  eco_premium_per_acre: string
  eco_total_premium: string
}

export type PolicyFieldDiff = { label: string; existing: string; incoming: string }

export function diffPolicyUpload(
  form: PolicyUploadValues,
  existing: CropInsurancePolicy,
  existingSco?: CropInsuranceSco | null,
  existingEco?: CropInsuranceEco | null,
): PolicyFieldDiff[] {
  const diffs: PolicyFieldDiff[] = []
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const numDiff = (label: string, s: string, v: number | null | undefined, fmt: (n: number) => string = String) => {
    if (s.trim() === '' || !Number.isFinite(Number(s))) return // blank never diffs
    const n = Number(s)
    if (v != null && Math.abs(n - Number(v)) < 1e-9) return
    diffs.push({ label, existing: v == null ? '—' : fmt(Number(v)), incoming: fmt(n) })
  }
  const strDiff = (label: string, s: string, v: string | null | undefined) => {
    if (s.trim() === '') return
    if (s.trim().toLowerCase() === (v ?? '').trim().toLowerCase()) return
    diffs.push({ label, existing: v?.trim() || '—', incoming: s.trim() })
  }
  numDiff('Coverage', form.coverage_level, existing.coverage_level, pct)
  strDiff('Unit structure', form.unit_structure, existing.unit_structure)
  numDiff('APH yield', form.aph_yield, existing.aph_yield)
  numDiff('Projected price', form.projected_price, existing.projected_price)
  numDiff('Harvest price', form.harvest_price, existing.harvest_price)
  numDiff('Volatility', form.volatility_factor, existing.volatility_factor)
  numDiff('Insured acres', form.insured_acres, existing.insured_acres)
  numDiff('Premium/ac', form.premium_per_acre, existing.premium_per_acre)
  numDiff('Total premium', form.total_premium, existing.total_premium)
  numDiff('Subsidy %', form.premium_subsidy_pct, existing.premium_subsidy_pct)
  strDiff('Policy #', form.policy_number, existing.policy_number)
  if (form.sco_enabled) {
    if (!existingSco) diffs.push({ label: 'SCO', existing: 'none', incoming: 'added' })
    else {
      numDiff('SCO county yield', form.sco_expected_county_yield, existingSco.expected_county_yield)
      numDiff('SCO premium/ac', form.sco_premium_per_acre, existingSco.premium_per_acre)
      numDiff('SCO total premium', form.sco_total_premium, existingSco.total_premium)
    }
  }
  if (form.eco_enabled) {
    if (!existingEco) diffs.push({ label: 'ECO', existing: 'none', incoming: 'added' })
    else {
      numDiff('ECO trigger', form.eco_trigger_level, existingEco.eco_trigger_level, pct)
      numDiff('ECO county yield', form.eco_expected_county_yield, existingEco.expected_county_yield)
      numDiff('ECO premium/ac', form.eco_premium_per_acre, existingEco.premium_per_acre)
      numDiff('ECO total premium', form.eco_total_premium, existingEco.total_premium)
    }
  }
  return diffs
}

export type PolicyUploadStatus =
  | { kind: 'new'; existing: null; diffs: PolicyFieldDiff[] }
  | { kind: 'exists' | 'update'; existing: CropInsurancePolicy; diffs: PolicyFieldDiff[] }

export function classifyPolicyUpload(
  form: PolicyUploadValues,
  existing: CropInsurancePolicy | null,
  existingSco?: CropInsuranceSco | null,
  existingEco?: CropInsuranceEco | null,
): PolicyUploadStatus {
  if (!existing) return { kind: 'new', existing: null, diffs: [] }
  const diffs = diffPolicyUpload(form, existing, existingSco, existingEco)
  return { kind: diffs.length === 0 ? 'exists' : 'update', existing, diffs }
}

// ---------- Acreage coverage check (reconcile insured vs planted) ----------
//
// Verifies that every planted acre is covered by a policy at the correct
// practice, and that insured acres line up with planted acres. Pure: the UI
// pulls planted acres from field_plantings (by county/practice) and insured
// acres from the policies, and passes them in.

export type CoverageStatus =
  | 'matched'             // insured ≈ planted (within tolerance)
  | 'covered'             // operator attested all planted acres are covered (acre variance suppressed)
  | 'under_insured'       // insured < planted beyond tolerance (uncovered acres)
  | 'over_reported'       // insured > planted beyond tolerance (review)
  | 'no_policy'           // planted acres with no matching policy (uninsured)
  | 'insured_not_planted' // a policy exists but no plantings (reverse gap)

// entityId is optional: when omitted it falls into a single '' group, preserving
// the operation-wide behavior; when supplied, combinations split per entity
// (crop insurance is carried at the entity level).
export type CoveragePlantingInput = { entityId?: string | null; cropId: string; countyId: string | null; practice: Practice; plantedAcres: number }
export type CoveragePolicyInput = {
  entityId?: string | null
  cropId: string
  countyId: string | null
  practice: Practice
  insuredAcres: number
  // Operator attestation (see crop_insurance_policies.covers_all_planted_acres):
  // when any policy in a combination has this set, the combination is treated as
  // fully covered regardless of the insured-vs-planted comparison.
  coversAllPlanted?: boolean
  coverageNote?: string | null
}

export type CoverageRow = {
  entityId: string | null
  cropId: string
  countyId: string | null
  practice: Practice
  plantedAcres: number
  insuredAcres: number
  policyCount: number
  variance: number // insuredAcres − plantedAcres
  tolerance: number
  status: CoverageStatus
  // True when a policy in this combination attests all planted acres are covered.
  coversAllPlanted: boolean
  // The attestation note, if one was recorded.
  coverageNote: string | null
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

const covKey = (entityId: string | null | undefined, cropId: string, countyId: string | null, practice: Practice) =>
  `${entityId ?? ''}|${cropId}|${countyId ?? ''}|${practice}`

export function reconcileAcreage(args: {
  plantings: readonly CoveragePlantingInput[]
  policies: readonly CoveragePolicyInput[]
}): { rows: CoverageRow[]; insuredNotPlanted: CoverageRow[]; summary: CoverageSummary } {
  // Aggregate planted acres per entity × crop × county × practice.
  const planted = new Map<string, CoveragePlantingInput>()
  for (const p of args.plantings) {
    if (!(p.plantedAcres > 0)) continue
    const k = covKey(p.entityId, p.cropId, p.countyId, p.practice)
    const cur = planted.get(k)
    if (cur) cur.plantedAcres += p.plantedAcres
    else planted.set(k, { ...p })
  }
  // Aggregate insured acres + policy count per entity × crop × county × practice
  // (sums across multiple optional-unit policies for the same combination). A
  // combination is "covered" when ANY of its policies attests covers-all-planted;
  // the first such policy's note is surfaced.
  const insured = new Map<string, { input: CoveragePolicyInput; insuredAcres: number; count: number; coversAll: boolean; note: string | null }>()
  for (const p of args.policies) {
    const k = covKey(p.entityId, p.cropId, p.countyId, p.practice)
    const covers = !!p.coversAllPlanted
    const note = (p.coverageNote ?? '').trim() || null
    const cur = insured.get(k)
    if (cur) {
      cur.insuredAcres += p.insuredAcres
      cur.count++
      cur.coversAll = cur.coversAll || covers
      if (covers && !cur.note && note) cur.note = note
    } else {
      insured.set(k, { input: { ...p }, insuredAcres: p.insuredAcres, count: 1, coversAll: covers, note: covers ? note : null })
    }
  }

  const rows: CoverageRow[] = []
  for (const [k, pl] of planted) {
    const ins = insured.get(k)
    const insuredAcres = ins?.insuredAcres ?? 0
    const policyCount = ins?.count ?? 0
    const coversAll = ins?.coversAll ?? false
    const tol = acreageTolerance(pl.plantedAcres)
    let status: CoverageStatus
    // "No policy" is a real exposure the attestation never suppresses; only the
    // acre-mismatch flags (under/over) are overridden by covers-all-planted.
    if (policyCount === 0) status = 'no_policy'
    else if (coversAll) status = 'covered'
    else if (insuredAcres < pl.plantedAcres - tol) status = 'under_insured'
    else if (insuredAcres > pl.plantedAcres + tol) status = 'over_reported'
    else status = 'matched'
    rows.push({
      entityId: pl.entityId ?? null, cropId: pl.cropId, countyId: pl.countyId, practice: pl.practice,
      plantedAcres: round2(pl.plantedAcres), insuredAcres: round2(insuredAcres), policyCount,
      variance: round2(insuredAcres - pl.plantedAcres), tolerance: round2(tol), status,
      coversAllPlanted: coversAll, coverageNote: ins?.note ?? null,
    })
  }

  // Reverse gap: insured combinations with no plantings this year.
  const insuredNotPlanted: CoverageRow[] = []
  for (const [k, ins] of insured) {
    if (planted.has(k)) continue
    insuredNotPlanted.push({
      entityId: ins.input.entityId ?? null, cropId: ins.input.cropId, countyId: ins.input.countyId, practice: ins.input.practice,
      plantedAcres: 0, insuredAcres: round2(ins.insuredAcres), policyCount: ins.count,
      variance: round2(ins.insuredAcres), tolerance: 0, status: 'insured_not_planted',
      coversAllPlanted: ins.coversAll, coverageNote: ins.note,
    })
  }

  let totalPlanted = 0, totalInsured = 0, uninsuredAcres = 0, flaggedCount = 0
  for (const r of rows) {
    totalPlanted += r.plantedAcres
    totalInsured += r.insuredAcres
    if (r.status === 'no_policy') uninsuredAcres += r.plantedAcres
    else if (r.status === 'under_insured') uninsuredAcres += r.plantedAcres - r.insuredAcres
    // 'covered' rows are intentionally not flagged and contribute no uninsured
    // exposure, even when planted > insured.
    if (r.status !== 'matched' && r.status !== 'covered') flaggedCount++
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

// ---------- Indemnity projection (shared by Claims Monitor + Cash Flow) ----------
//
// One source of truth for "what indemnity would these policies pay at our
// current assumptions." The Crop Insurance Claims Monitor and the Cash Flow
// Forecast's safety-net BOTH call projectInsuranceIndemnities so the projected
// crop-insurance dollars reconcile between the two pages. The resolution order
// for the two money-critical inputs is fixed here:
//   yield  : per-policy override → actual per-practice (harvested irr/dry bushels)
//            → per-practice expected (assumptions.expected_yield_irr/_dry, blended
//            fallback; actual once harvest-complete) → mean APH; then × the
//            global yield slider.
//   harvest: per-crop override → RMA-final (policy.harvest_price or a stored
//            harvest_final) → today's live Barchart estimate → most-recent stored
//            harvest_estimate → average projected price.

export type LiveHarvest = { price: number; stale: boolean; priceDate: string | null }
export type HarvestResolution = { price: number; source: 'final' | 'estimate' | 'projected'; stale: boolean; priceDate: string | null }

// Per-practice ACTUAL yield from the planting irrigated/dryland bushel breakout,
// keyed `cropId|practice`. Only where the breakout is entered and acres > 0.
export function practiceActualYieldByCrop(
  plantings: ReadonlyArray<Pick<FieldPlanting, 'crop_id' | 'season_year' | 'irrigated_acres' | 'dryland_acres' | 'irrigated_bushels' | 'dryland_bushels'>>,
  cropYear: number,
): Map<string, number> {
  const agg = new Map<string, { bu: number; ac: number }>()
  const add = (key: string, b: number, a: number) => { const c = agg.get(key) ?? { bu: 0, ac: 0 }; c.bu += b; c.ac += a; agg.set(key, c) }
  for (const p of plantings) {
    if (p.season_year !== cropYear) continue
    if (p.irrigated_bushels != null && Number(p.irrigated_acres) > 0) add(`${p.crop_id}|irrigated`, Number(p.irrigated_bushels), Number(p.irrigated_acres))
    if (p.dryland_bushels != null && Number(p.dryland_acres) > 0) add(`${p.crop_id}|non_irrigated`, Number(p.dryland_bushels), Number(p.dryland_acres))
  }
  const m = new Map<string, number>()
  for (const [k, v] of agg) if (v.ac > 0) m.set(k, v.bu / v.ac)
  return m
}

// Crop-level actual yield = Σ dry bushels (field loads) / Σ planted acres, by
// crop. Shared so both reports derive the post-harvest actual identically.
export function actualYieldByCropFromLoads(args: {
  loads: ReadonlyArray<{ crop_id: string | null; crop_year: number | null; from_type: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null }>
  plantings: ReadonlyArray<{ crop_id: string; season_year: number; planted_acres: number | string | null }>
  crops: ReadonlyArray<Pick<Crop, 'id' | 'base_moisture_pct' | 'base_lb_per_bushel'>>
  cropYear: number
}): Map<string, number> {
  const cropById = new Map(args.crops.map((c) => [c.id, c]))
  const prod = new Map<string, number>()
  for (const l of args.loads) {
    if (l.from_type !== 'field' || !l.crop_id || l.crop_year !== args.cropYear) continue
    const crop = cropById.get(l.crop_id)
    const { dryBushels } = computeBushels({
      netWeightLb: l.net_weight, moisturePct: l.moisture,
      baseMoisturePct: crop?.base_moisture_pct ?? null, baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
      dryBushelsOverride: l.dry_bushels_override,
    })
    if (dryBushels) prod.set(l.crop_id, (prod.get(l.crop_id) ?? 0) + dryBushels)
  }
  const acres = new Map<string, number>()
  for (const p of args.plantings) {
    if (p.season_year !== args.cropYear) continue
    acres.set(p.crop_id, (acres.get(p.crop_id) ?? 0) + Number(p.planted_acres ?? 0))
  }
  const out = new Map<string, number>()
  for (const [cropId, b] of prod) { const a = acres.get(cropId) ?? 0; if (a > 0) out.set(cropId, b / a) }
  return out
}

// Resolve the harvest price per crop: final → live Barchart estimate → most
// recent stored harvest_estimate → average projected. `estimates` must be sorted
// most-recent first (both callers order by price_date desc).
export function resolveHarvestPriceByCrop(args: {
  cropIds: readonly string[]
  cropYear: number
  policies: readonly CropInsurancePolicy[]
  estimates: readonly HarvestPriceEstimate[]
  liveByCrop?: ReadonlyMap<string, LiveHarvest>
}): Map<string, HarvestResolution> {
  const m = new Map<string, HarvestResolution>()
  for (const cropId of args.cropIds) {
    const pols = args.policies.filter((p) => p.crop_id === cropId && p.crop_year === args.cropYear)
    const avgProjected = pols.length > 0 ? pols.reduce((s, p) => s + Number(p.projected_price), 0) / pols.length : 0
    const policyFinal = pols.find((p) => p.harvest_price != null)?.harvest_price
    const storedFinal = args.estimates.find((e) => e.crop_id === cropId && e.crop_year === args.cropYear && e.price_type === 'harvest_final')
    if (policyFinal != null || storedFinal) {
      m.set(cropId, { price: Number(policyFinal ?? storedFinal!.price), source: 'final', stale: false, priceDate: storedFinal?.price_date ?? null })
      continue
    }
    const live = args.liveByCrop?.get(cropId)
    if (live) { m.set(cropId, { price: live.price, source: 'estimate', stale: live.stale, priceDate: live.priceDate }); continue }
    const storedEst = args.estimates.find((e) => e.crop_id === cropId && e.crop_year === args.cropYear && e.price_type === 'harvest_estimate')
    if (storedEst) { m.set(cropId, { price: Number(storedEst.price), source: 'estimate', stale: true, priceDate: storedEst.price_date }); continue }
    m.set(cropId, { price: avgProjected, source: 'projected', stale: false, priceDate: null })
  }
  return m
}

export type ProjectedPolicy = {
  policy: CropInsurancePolicy
  base: PolicyInputs
  sco: ScoConfig | null
  eco: EcoConfig | null
  basePremium: number
  comp: PolicyComputation
  harvest: HarvestResolution
  assumedYield: number
}

// Adapt DB endorsement rows into the compute configs. Exported so composers
// (e.g. lib/income-sensitivity.ts) build policy inputs exactly the same way.
export function scoConfigFrom(s: CropInsuranceSco | undefined): ScoConfig | null {
  if (!s) return null
  return {
    coverageTrigger: Number(s.coverage_trigger),
    expectedCountyYield: Number(s.expected_county_yield),
    countyYieldAssumptionPct: s.county_yield_assumption_pct == null ? 0 : Number(s.county_yield_assumption_pct),
    premiumPerAcre: s.premium_per_acre == null ? null : Number(s.premium_per_acre),
    totalPremium: s.total_premium == null ? null : Number(s.total_premium),
  }
}
export function ecoConfigFrom(e: CropInsuranceEco | undefined): EcoConfig | null {
  if (!e) return null
  return {
    ecoTriggerLevel: Number(e.eco_trigger_level),
    expectedCountyYield: Number(e.expected_county_yield),
    countyYieldAssumptionPct: e.county_yield_assumption_pct == null ? 0 : Number(e.county_yield_assumption_pct),
    premiumPerAcre: e.premium_per_acre == null ? null : Number(e.premium_per_acre),
    totalPremium: e.total_premium == null ? null : Number(e.total_premium),
  }
}

export function projectInsuranceIndemnities(args: {
  cropYear: number
  policies: readonly CropInsurancePolicy[] // already filtered (entity/crop) by the caller
  scos: readonly CropInsuranceSco[]
  ecos: readonly CropInsuranceEco[]
  assumptions: readonly CropAssumption[]
  plantings: ReadonlyArray<Pick<FieldPlanting, 'crop_id' | 'season_year' | 'irrigated_acres' | 'dryland_acres' | 'irrigated_bushels' | 'dryland_bushels'>>
  // Crop-level actual yield by crop_id (from actualYieldByCropFromLoads).
  actualYieldByCrop: ReadonlyMap<string, number>
  harvestEstimates: readonly HarvestPriceEstimate[]
  liveHarvestByCrop?: ReadonlyMap<string, LiveHarvest>
  scoTrigger?: number
  // Optional what-if levers (Claims Monitor); omit for the plain projection.
  globalYieldPct?: number
  yieldOverrideByPolicy?: ReadonlyMap<string, number>
  harvestOverrideByCrop?: ReadonlyMap<string, number>
}): ProjectedPolicy[] {
  const yearPolicies = args.policies.filter((p) => p.crop_year === args.cropYear)
  const cropIds = Array.from(new Set(yearPolicies.map((p) => p.crop_id)))
  const harvestByCrop = resolveHarvestPriceByCrop({
    cropIds, cropYear: args.cropYear, policies: yearPolicies, estimates: args.harvestEstimates, liveByCrop: args.liveHarvestByCrop,
  })
  const practiceActual = practiceActualYieldByCrop(args.plantings, args.cropYear)
  const scoBy = new Map(args.scos.map((s) => [s.policy_id, s]))
  const ecoBy = new Map(args.ecos.map((e) => [e.policy_id, e]))
  const slider = 1 + (args.globalYieldPct ?? 0) / 100

  // Per-practice default (expected breakout / actual / mean APH), respecting
  // harvest_complete (prefer actuals once harvest is in).
  function defaultPracticeYield(cropId: string, practice: Practice): number {
    const a = args.assumptions.find((x) => x.crop_id === cropId && x.crop_year === args.cropYear)
    const blended = a?.expected_yield != null ? Number(a.expected_yield) : null
    const harvestComplete = !!a?.harvest_complete
    const actual = args.actualYieldByCrop.get(cropId) ?? null
    const expectedPractice = practice === 'irrigated'
      ? (a?.expected_yield_irr != null ? Number(a.expected_yield_irr) : blended)
      : (a?.expected_yield_dry != null ? Number(a.expected_yield_dry) : blended)
    if (expectedPractice != null && (!harvestComplete || actual == null)) return expectedPractice
    if (actual != null) return actual
    const pols = yearPolicies.filter((p) => p.crop_id === cropId)
    return pols.length > 0 ? pols.reduce((s, p) => s + Number(p.aph_yield), 0) / pols.length : 0
  }

  return yearPolicies.map((p) => {
    const practice = (p.practice ?? 'non_irrigated') as Practice
    const yOverride = args.yieldOverrideByPolicy?.get(p.id)
    const baseYield = yOverride != null
      ? yOverride
      : (practiceActual.get(`${p.crop_id}|${practice}`)
        ?? defaultPracticeYield(p.crop_id, practice)
        ?? Number(p.aph_yield))
    const assumedYield = baseYield * slider

    const harvest = harvestByCrop.get(p.crop_id) ?? { price: Number(p.projected_price), source: 'projected' as const, stale: false, priceDate: null }
    const hOverride = args.harvestOverrideByCrop?.get(p.crop_id)
    const harvestPrice = hOverride != null ? hOverride : harvest.price

    const base: PolicyInputs = {
      planType: p.plan_type,
      coverageLevel: Number(p.coverage_level),
      aphYield: Number(p.aph_yield),
      projectedPrice: Number(p.projected_price),
      harvestPrice,
      insuredAcres: Number(p.insured_acres),
      actualYield: assumedYield,
    }
    const sco = scoConfigFrom(scoBy.get(p.id))
    const eco = ecoConfigFrom(ecoBy.get(p.id))
    const basePremium = policyPremium(p)
    const comp = computePolicy({ base, basePremium, sco, eco, scoTriggerDefault: args.scoTrigger })
    return { policy: p, base, sco, eco, basePremium, comp, harvest, assumedYield }
  })
}

// Sum of projected total indemnity across a set of projected policies.
export function totalProjectedIndemnity(projected: readonly ProjectedPolicy[]): number {
  return round2(projected.reduce((s, r) => s + r.comp.totalIndemnity, 0))
}
