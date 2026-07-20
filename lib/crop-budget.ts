// Crop Budget Planner engine — pure pre-season budget math for the "what
// should I plant next year" report. Deliberately SIMPLE: a budget line is
// price × yield − cost, nothing else. No contracts, no harvest facts, no
// insurance legs, no government payments — nothing is locked pre-season (the
// in-season version of this analysis is lib/income-sensitivity.ts). Budgets
// are a sandbox: nothing here reads or writes crop_assumptions or actuals.
//
// Units follow the app convention: grains $/bu + bu/ac; cotton prices are
// STORED in ¢/lb (displayed $/lb) + lbs lint/ac — every per-acre dollar
// figure divides cotton cents by 100 exactly once, here.

import { buildContractSymbol, type Commodity } from '@/lib/hedging'
import { cropToHedgeCommodity } from '@/lib/contracts'
import type { BudgetLine, CropAssumption, CropInsurancePolicy } from '@/lib/types'

const r2 = (n: number) => Math.round(n * 100) / 100

export function isCottonName(cropName: string | null | undefined): boolean {
  return cropToHedgeCommodity(cropName) === 'Cotton'
}

// ---------- New-crop benchmark contract for the BUDGET year ----------

// The month a farmer prices NEW-CROP against, per commodity: DEC corn, NOV
// soybeans, JUL Chicago wheat, DEC cotton. (Distinct from the RMA harvest
// price-discovery months in lib/crop-insurance.ts — wheat's new-crop
// benchmark is July, not September.)
const NEW_CROP_MONTH_ABBR: Record<Commodity, string> = {
  Corn: 'DEC',
  Soybeans: 'NOV',
  'Chicago Wheat': 'JUL',
  Cotton: 'DEC',
}

/** Barchart symbol for a crop's new-crop benchmark in the budget year, e.g.
 *  Corn 2027 → "ZCZ27", Soybeans → "ZSX27", Wheat → "ZWN27", Cotton → "CTZ27".
 *  These trade well ahead. null for untraded crops. */
export function budgetContractSymbol(cropName: string | null | undefined, budgetYear: number): string | null {
  const c = cropToHedgeCommodity(cropName)
  if (!c) return null
  const yy = String(budgetYear % 100).padStart(2, '0')
  return buildContractSymbol(c, `${NEW_CROP_MONTH_ABBR[c]} ${yy}`) || null
}

export function budgetContractLabel(cropName: string | null | undefined, budgetYear: number): string | null {
  const c = cropToHedgeCommodity(cropName)
  if (!c) return null
  const display = c === 'Chicago Wheat' ? 'Wheat' : c
  return `${NEW_CROP_MONTH_ABBR[c]} ${String(budgetYear % 100).padStart(2, '0')} ${display}`
}

// ---------- Assumption seeds ----------

export type BudgetPractice = 'irrigated' | 'non_irrigated' | null // null = blended
export type BudgetCropping = 'full_season' | 'double_crop' | null // null = full season

export type AphSeed = { yield: number; policyCount: number; cropYear: number; practice: BudgetPractice }

// practice widened to nullable: the TS type says non-null but older DB rows
// can carry null — the app convention (missing = dryland) applies here too.
type AphPolicy = Pick<CropInsurancePolicy, 'crop_id' | 'crop_year' | 'aph_yield' | 'insured_acres' | 'plan_type'> &
  { practice: CropInsurancePolicy['practice'] | null }

/** Acre-weighted average APH across the MOST RECENT crop year's policies for
 *  a crop (area plans carry no APH and are skipped). With a practice, only
 *  that practice's policies weigh in (a policy without one counts as dryland,
 *  the app convention); blended (null) weights across all practices.
 *  100 ac @ 180 + 50 ac @ 170 → (180×100 + 170×50) ÷ 150 = 176.7. */
export function aphWeightedYield(
  policies: ReadonlyArray<AphPolicy>,
  cropId: string,
  practice: BudgetPractice = null,
): AphSeed | null {
  const mine = policies.filter((p) =>
    p.crop_id === cropId && p.plan_type !== 'ARP' && p.plan_type !== 'AYP' &&
    Number(p.aph_yield) > 0 && Number(p.insured_acres) > 0 &&
    (practice == null || (p.practice ?? 'non_irrigated') === practice))
  if (mine.length === 0) return null
  const latestYear = Math.max(...mine.map((p) => p.crop_year))
  const latest = mine.filter((p) => p.crop_year === latestYear)
  let acres = 0
  let weighted = 0
  for (const p of latest) {
    acres += Number(p.insured_acres)
    weighted += Number(p.aph_yield) * Number(p.insured_acres)
  }
  return { yield: Math.round((weighted / acres) * 10) / 10, policyCount: latest.length, cropYear: latestYear, practice }
}

export type BudgetSeeds = {
  yield: number | null
  /** 'aph' carries the weighting detail for the derivation chip. */
  yieldSource: 'aph' | 'expected' | 'expected_dc' | null
  aph: AphSeed | null
  cost: number | null
  costSource: 'assumption' | 'assumption_dc' | null
}

type AssumptionSeedFields = Pick<CropAssumption,
  'expected_yield' | 'expected_yield_irr' | 'expected_yield_dry' | 'expected_yield_dc_irr' | 'expected_yield_dc_dry' |
  'cost_per_acre' | 'cost_per_acre_irr' | 'cost_per_acre_dry' | 'cost_per_acre_dc_irr' | 'cost_per_acre_dc_dry'>

const numOr = (v: number | null | undefined): number | null => (v == null ? null : Number(v))

/** Practice/cropping-aware seeds for one budget line.
 *  Full season: yield = practice-filtered APH (blended = all practices), else
 *  the assumption's per-practice expected (else blended expected); cost = the
 *  per-practice cost (else blended).
 *  Double crop: APH never seeds (it reflects full-season history, not DC) —
 *  yield/cost come from the assumption's DC breakouts for the practice
 *  (blended DC prefers dryland, the common DC practice), else blank. */
export function budgetSeeds(args: {
  policies: ReadonlyArray<AphPolicy>
  assumption: AssumptionSeedFields | null | undefined
  cropId: string
  practice: BudgetPractice
  cropping: BudgetCropping
}): BudgetSeeds {
  const a = args.assumption
  if (args.cropping === 'double_crop') {
    const dcYield = args.practice === 'irrigated'
      ? numOr(a?.expected_yield_dc_irr)
      : args.practice === 'non_irrigated'
        ? numOr(a?.expected_yield_dc_dry)
        : numOr(a?.expected_yield_dc_dry) ?? numOr(a?.expected_yield_dc_irr)
    const dcCost = args.practice === 'irrigated'
      ? numOr(a?.cost_per_acre_dc_irr)
      : args.practice === 'non_irrigated'
        ? numOr(a?.cost_per_acre_dc_dry)
        : numOr(a?.cost_per_acre_dc_dry) ?? numOr(a?.cost_per_acre_dc_irr)
    return {
      yield: dcYield, yieldSource: dcYield != null ? 'expected_dc' : null, aph: null,
      cost: dcCost, costSource: dcCost != null ? 'assumption_dc' : null,
    }
  }
  const aph = aphWeightedYield(args.policies, args.cropId, args.practice)
  const expected = args.practice === 'irrigated'
    ? numOr(a?.expected_yield_irr) ?? numOr(a?.expected_yield)
    : args.practice === 'non_irrigated'
      ? numOr(a?.expected_yield_dry) ?? numOr(a?.expected_yield)
      : numOr(a?.expected_yield)
  const cost = args.practice === 'irrigated'
    ? numOr(a?.cost_per_acre_irr) ?? numOr(a?.cost_per_acre)
    : args.practice === 'non_irrigated'
      ? numOr(a?.cost_per_acre_dry) ?? numOr(a?.cost_per_acre)
      : numOr(a?.cost_per_acre)
  return {
    yield: aph?.yield ?? expected,
    yieldSource: aph != null ? 'aph' : expected != null ? 'expected' : null,
    aph,
    cost,
    costSource: cost != null ? 'assumption' : null,
  }
}

export const BUDGET_PRACTICE_LABEL: Record<'irrigated' | 'non_irrigated', string> = {
  irrigated: 'Irrigated', non_irrigated: 'Dryland',
}

/** "Irrigated · Double-crop" designation suffix for a line, '' when blended
 *  full-season. */
export function lineDesignation(l: { practice: BudgetPractice; cropping: BudgetCropping }): string {
  const parts: string[] = []
  if (l.practice) parts.push(BUDGET_PRACTICE_LABEL[l.practice])
  if (l.cropping === 'double_crop') parts.push('Double-crop')
  return parts.join(' · ')
}

// ---------- Budget line math ----------

export type BudgetLineMath = {
  /** futures/manual + basis, in the crop's STORED price unit ($/bu, ¢/lb cotton). */
  effectivePrice: number | null
  revenuePerAcre: number | null
  profitPerAcre: number | null
  totalRevenue: number | null
  totalProfit: number | null
  /** cost ÷ yield, in the stored price unit — quoted at the budget yield. */
  breakevenPrice: number | null
  /** cost ÷ effective price (unit-aware) — quoted at the budget price. */
  breakevenYield: number | null
  /** true when price_mode is 'live' but no quote was available. */
  missingPrice: boolean
}

export type BudgetLineInput = Pick<BudgetLine, 'acres' | 'yield_per_acre' | 'price_mode' | 'manual_price' | 'basis' | 'cost_per_acre'>

/** The line's whole story: effective price = (live futures | manual) + basis;
 *  revenue/ac = price × yield (cotton ¢ ÷ 100); profit/ac = revenue − cost.
 *  livePrice is the budget-year benchmark quote in the STORED unit, null when
 *  unavailable. */
export function budgetLineMath(line: BudgetLineInput, livePrice: number | null, isCotton: boolean): BudgetLineMath {
  const base = line.price_mode === 'manual'
    ? (line.manual_price != null ? Number(line.manual_price) : null)
    : livePrice
  const effectivePrice = base != null ? r2fine(base + Number(line.basis ?? 0)) : null
  const yieldV = line.yield_per_acre != null ? Number(line.yield_per_acre) : null
  const cost = line.cost_per_acre != null ? Number(line.cost_per_acre) : null
  const acres = line.acres != null ? Number(line.acres) : null

  const perLbDivisor = isCotton ? 100 : 1
  const revenuePerAcre = effectivePrice != null && yieldV != null ? r2((effectivePrice * yieldV) / perLbDivisor) : null
  const profitPerAcre = revenuePerAcre != null && cost != null ? r2(revenuePerAcre - cost) : null
  return {
    effectivePrice,
    revenuePerAcre,
    profitPerAcre,
    totalRevenue: revenuePerAcre != null && acres != null ? r2(revenuePerAcre * acres) : null,
    totalProfit: profitPerAcre != null && acres != null ? r2(profitPerAcre * acres) : null,
    breakevenPrice: cost != null && yieldV != null && yieldV > 0 ? r2fine((cost * perLbDivisor) / yieldV) : null,
    breakevenYield: cost != null && effectivePrice != null && effectivePrice > 0 ? r2((cost * perLbDivisor) / effectivePrice) : null,
    missingPrice: line.price_mode === 'live' && livePrice == null,
  }
}
const r2fine = (n: number) => Math.round(n * 1e4) / 1e4

// ---------- Scenario totals & comparison ----------

export type ScenarioTotals = {
  totalAcres: number
  totalRevenue: number
  totalProfit: number
  weightedProfitPerAcre: number | null
  /** Lines missing an input (acres/yield/price/cost) and excluded from totals. */
  incompleteLines: number
}

export function scenarioTotals(rows: ReadonlyArray<{ acres: number | null; math: BudgetLineMath }>): ScenarioTotals {
  let totalAcres = 0
  let totalRevenue = 0
  let totalProfit = 0
  let profitAcres = 0
  let incompleteLines = 0
  for (const r of rows) {
    if (r.acres != null && r.acres > 0) totalAcres += Number(r.acres)
    if (r.math.totalRevenue != null) totalRevenue += r.math.totalRevenue
    if (r.math.totalProfit != null && r.acres != null && r.acres > 0) {
      totalProfit += r.math.totalProfit
      profitAcres += Number(r.acres)
    } else {
      incompleteLines++
    }
  }
  return {
    totalAcres: r2(totalAcres),
    totalRevenue: r2(totalRevenue),
    totalProfit: r2(totalProfit),
    weightedProfitPerAcre: profitAcres > 0 ? r2(totalProfit / profitAcres) : null,
    incompleteLines,
  }
}

export type ScenarioCompareRow = {
  key: string // cropId|label|practice|cropping
  cropId: string
  label: string | null
  practice: BudgetPractice
  cropping: BudgetCropping
  aAcres: number | null
  bAcres: number | null
  aProfit: number | null
  bProfit: number | null
  acresDelta: number | null
  profitDelta: number | null
}

type CompareInput = {
  cropId: string
  label: string | null
  practice?: BudgetPractice
  cropping?: BudgetCropping
  acres: number | null
  totalProfit: number | null
}

/** Per-crop(+label+practice+cropping) side-by-side of two scenarios: acres and
 *  total profit with deltas (b − a). "Corn irrigated" and "Corn dryland" stay
 *  separate rows. Lines present in only one scenario show with the other side
 *  null (delta treats a missing side as 0). */
export function compareScenarios(a: ReadonlyArray<CompareInput>, b: ReadonlyArray<CompareInput>): ScenarioCompareRow[] {
  const key = (x: CompareInput) =>
    `${x.cropId}|${(x.label ?? '').trim().toLowerCase()}|${x.practice ?? ''}|${x.cropping === 'double_crop' ? 'dc' : ''}`
  const rows = new Map<string, ScenarioCompareRow>()
  for (const x of a) {
    rows.set(key(x), {
      key: key(x), cropId: x.cropId, label: x.label, practice: x.practice ?? null, cropping: x.cropping ?? null,
      aAcres: x.acres, bAcres: null, aProfit: x.totalProfit, bProfit: null,
      acresDelta: null, profitDelta: null,
    })
  }
  for (const x of b) {
    const cur = rows.get(key(x))
    if (cur) { cur.bAcres = x.acres; cur.bProfit = x.totalProfit }
    else {
      rows.set(key(x), {
        key: key(x), cropId: x.cropId, label: x.label, practice: x.practice ?? null, cropping: x.cropping ?? null,
        aAcres: null, bAcres: x.acres, aProfit: null, bProfit: x.totalProfit,
        acresDelta: null, profitDelta: null,
      })
    }
  }
  for (const r of rows.values()) {
    r.acresDelta = r2((r.bAcres ?? 0) - (r.aAcres ?? 0))
    r.profitDelta = r2((r.bProfit ?? 0) - (r.aProfit ?? 0))
  }
  return Array.from(rows.values())
}

// ---------- The per-line price × yield matrix ----------

export type BudgetMatrixCell = {
  price: number // stored unit ($/bu, ¢/lb cotton)
  yield: number
  revenuePerAcre: number
  profitPerAcre: number | null // null when no cost is set
}

/** Pure budget matrix: every cell is (price + basis already folded into the
 *  axis values) × yield − cost. No caps, no floors, no insurance — the
 *  pre-season picture. Rows = price levels, columns = yield levels. */
export function buildBudgetMatrix(args: {
  priceValues: readonly number[]
  yieldValues: readonly number[]
  costPerAcre: number | null
  isCotton: boolean
}): BudgetMatrixCell[][] {
  const div = args.isCotton ? 100 : 1
  return args.priceValues.map((price) =>
    args.yieldValues.map((y) => {
      const revenuePerAcre = r2((price * y) / div)
      return {
        price,
        yield: y,
        revenuePerAcre,
        profitPerAcre: args.costPerAcre != null ? r2(revenuePerAcre - Number(args.costPerAcre)) : null,
      }
    }),
  )
}

/** Copies for the "Duplicate scenario" workflow: same crops/values, fresh
 *  identity, targeted at the new scenario. Pure — the caller inserts. */
export function duplicateLinesFor(
  lines: readonly BudgetLine[],
  newScenarioId: string,
): Array<Omit<BudgetLine, 'id' | 'created_at'>> {
  return [...lines]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((l) => ({
      scenario_id: newScenarioId,
      crop_id: l.crop_id,
      label: l.label,
      practice: l.practice,
      cropping: l.cropping,
      acres: l.acres,
      yield_per_acre: l.yield_per_acre,
      price_mode: l.price_mode,
      manual_price: l.manual_price,
      basis: l.basis,
      cost_per_acre: l.cost_per_acre,
      sort_order: l.sort_order,
    }))
}
