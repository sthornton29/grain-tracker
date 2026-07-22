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

// ---------- Breakout grid (scenario-less redesign) ----------
//
// The Assumptions panel mirrors the Marketing Dashboard editor: per crop, an
// Overall row plus up to four fixed breakout rows (Full-season/Double-crop ×
// Irrigated/Dryland; DC rows only for crops designated double-crop). The grid
// maps onto budget_lines — the Overall row is the practice-null/cropping-null
// line (the blended fallback), each breakout row is the line for that
// practice × cropping. A blank breakout yield/cost cell falls back to the
// Overall row, the marketing-editor semantics. Output rows are the breakout
// lines with acres > 0, else the Overall line alone.

export type BreakoutKey = 'fs_irr' | 'fs_dry' | 'dc_irr' | 'dc_dry'
export const BREAKOUT_ORDER: readonly BreakoutKey[] = ['fs_irr', 'fs_dry', 'dc_irr', 'dc_dry']
export const BREAKOUT_LABEL: Record<BreakoutKey, string> = {
  fs_irr: 'Full-season · Irrigated',
  fs_dry: 'Full-season · Dryland',
  dc_irr: 'Double-crop · Irrigated',
  dc_dry: 'Double-crop · Dryland',
}

/** The rows a crop's grid offers: non-DC crops get the two full-season rows
 *  (labeled plain Irrigated/Dryland by the UI), DC-designated crops all four. */
export function breakoutKeysFor(isDoubleCropCrop: boolean): readonly BreakoutKey[] {
  return isDoubleCropCrop ? BREAKOUT_ORDER : (['fs_irr', 'fs_dry'] as const)
}

export function breakoutFields(key: BreakoutKey): { practice: 'irrigated' | 'non_irrigated'; cropping: 'double_crop' | null } {
  return {
    practice: key === 'fs_irr' || key === 'dc_irr' ? 'irrigated' : 'non_irrigated',
    cropping: key === 'dc_irr' || key === 'dc_dry' ? 'double_crop' : null,
  }
}

/** Which grid row a stored line belongs to. Blended full-season → 'overall';
 *  a legacy blended double-crop line folds to dc_dry (the common DC practice,
 *  matching the seed convention). */
export function breakoutKeyOf(line: { practice: BudgetPractice; cropping: BudgetCropping }): BreakoutKey | 'overall' {
  if (line.cropping === 'double_crop') return line.practice === 'irrigated' ? 'dc_irr' : 'dc_dry'
  if (line.practice === 'irrigated') return 'fs_irr'
  if (line.practice === 'non_irrigated') return 'fs_dry'
  return 'overall'
}

type GridLine = Pick<BudgetLine, 'id' | 'practice' | 'cropping' | 'acres' | 'yield_per_acre' | 'cost_per_acre'>

export type CropBudgetGrid<L extends GridLine = GridLine> = {
  overall: L | null
  byKey: Partial<Record<BreakoutKey, L>>
}

/** One crop's lines → the grid. First line per cell wins; duplicates for the
 *  same cell (shouldn't exist) are ignored. */
export function gridFromLines<L extends GridLine>(lines: readonly L[]): CropBudgetGrid<L> {
  const g: CropBudgetGrid<L> = { overall: null, byKey: {} }
  for (const l of lines) {
    const k = breakoutKeyOf(l)
    if (k === 'overall') g.overall = g.overall ?? l
    else g.byKey[k] = g.byKey[k] ?? l
  }
  return g
}

export type EffectiveBudgetRow<L extends GridLine = GridLine> = {
  key: BreakoutKey | 'overall'
  line: L
  acres: number | null
  /** The line's own value, else inherited from the Overall row. */
  yieldPerAcre: number | null
  costPerAcre: number | null
  inheritedYield: boolean
  inheritedCost: boolean
}

/** The rows that actually drive output/totals: every breakout line with
 *  acres > 0 (blank yield/cost inheriting the Overall row), else the Overall
 *  line alone. `keys` bounds which breakout cells are considered — pass the
 *  union of the crop's designated keys and any keys present in the data so a
 *  legacy line never silently drops out. */
export function effectiveBudgetRows<L extends GridLine>(
  grid: CropBudgetGrid<L>,
  keys: readonly BreakoutKey[],
): EffectiveBudgetRow<L>[] {
  const o = grid.overall
  const active = keys
    .map((k) => ({ key: k as BreakoutKey | 'overall', line: grid.byKey[k] }))
    .filter((x): x is { key: BreakoutKey; line: L } => x.line != null && Number(x.line.acres ?? 0) > 0)
  if (active.length === 0) {
    if (!o) return []
    return [{
      key: 'overall', line: o,
      acres: o.acres != null ? Number(o.acres) : null,
      yieldPerAcre: o.yield_per_acre != null ? Number(o.yield_per_acre) : null,
      costPerAcre: o.cost_per_acre != null ? Number(o.cost_per_acre) : null,
      inheritedYield: false, inheritedCost: false,
    }]
  }
  return active.map(({ key, line }) => {
    const ownYield = line.yield_per_acre != null ? Number(line.yield_per_acre) : null
    const ownCost = line.cost_per_acre != null ? Number(line.cost_per_acre) : null
    const fallYield = o?.yield_per_acre != null ? Number(o.yield_per_acre) : null
    const fallCost = o?.cost_per_acre != null ? Number(o.cost_per_acre) : null
    return {
      key, line,
      acres: Number(line.acres),
      yieldPerAcre: ownYield ?? fallYield,
      costPerAcre: ownCost ?? fallCost,
      inheritedYield: ownYield == null && fallYield != null,
      inheritedCost: ownCost == null && fallCost != null,
    }
  })
}

export type GridCellField = 'acres' | 'yield' | 'cost'
const GRID_FIELD_COL: Record<GridCellField, 'acres' | 'yield_per_acre' | 'cost_per_acre'> = {
  acres: 'acres', yield: 'yield_per_acre', cost: 'cost_per_acre',
}

export type GridCellPlan =
  | { op: 'noop' }
  | { op: 'update'; id: string; patch: Partial<Pick<BudgetLine, 'acres' | 'yield_per_acre' | 'cost_per_acre'>> }
  | { op: 'insert'; values: Pick<BudgetLine, 'practice' | 'cropping' | 'acres' | 'yield_per_acre' | 'cost_per_acre'> }

/** Commit one grid cell. An existing line updates in place; typing into an
 *  empty row inserts its line with the OTHER fields taken from the seeds
 *  (yield/cost) so the row starts on its derivation chips. */
export function gridCellPlan(args: {
  existing: GridLine | null
  key: BreakoutKey | 'overall'
  field: GridCellField
  value: number | null
  seeds: Pick<BudgetSeeds, 'yield' | 'cost'>
}): GridCellPlan {
  const col = GRID_FIELD_COL[args.field]
  if (args.existing) {
    const cur = args.existing[col]
    const same = (cur == null && args.value == null) ||
      (cur != null && args.value != null && Math.abs(Number(cur) - args.value) < 1e-9)
    return same ? { op: 'noop' } : { op: 'update', id: args.existing.id, patch: { [col]: args.value } }
  }
  if (args.value == null) return { op: 'noop' }
  const fields = args.key === 'overall' ? { practice: null, cropping: null } : breakoutFields(args.key)
  return {
    op: 'insert',
    values: {
      practice: fields.practice,
      cropping: fields.cropping,
      acres: args.field === 'acres' ? args.value : null,
      yield_per_acre: args.field === 'yield' ? args.value : args.seeds.yield,
      cost_per_acre: args.field === 'cost' ? args.value : args.seeds.cost,
    },
  }
}

// ---------- Futures price edit-in-place ----------

/** Typing over the live futures number switches the crop to manual mode; the
 *  ↻ control restores the quote (price_mode 'live'). Same underlying
 *  price_mode/manual_price fields as before — this just decides the patch.
 *  `value` is in the STORED unit (¢/lb cotton). Returns null for a no-change
 *  commit (blank while live, or re-typing the live quote verbatim). */
export function priceEditPatch(args: {
  value: number | null // parsed input, stored unit; null = blank
  currentMode: 'live' | 'manual'
  livePrice: number | null
}): Partial<Pick<BudgetLine, 'price_mode' | 'manual_price'>> | null {
  if (args.value == null) {
    // Blanking the price returns the crop to the live quote.
    return args.currentMode === 'live' ? null : { price_mode: 'live' }
  }
  if (args.currentMode === 'live' && args.livePrice != null && Math.abs(args.value - args.livePrice) < 1e-9) {
    return null // typed the quote back — still live
  }
  return { price_mode: 'manual', manual_price: args.value }
}

/** The ↻ "use live price" control. */
export function livePricePatch(): Partial<Pick<BudgetLine, 'price_mode'>> {
  return { price_mode: 'live' }
}

// ---------- Scenario totals ----------

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

// ---------- Blended (by-crop) display view ----------

export type BlendInput = {
  practice: BudgetPractice
  cropping: BudgetCropping
  label: string | null
  acres: number | null
  yield_per_acre: number | null
  cost_per_acre: number | null
  /** The line's computed effective price in the STORED unit ($/bu, ¢/lb
   *  cotton); null when the line has no price yet. */
  effectivePrice?: number | null
}

export type BlendedLine = {
  acres: number | null
  /** Acre-weighted, kept at 4-decimal precision so blended totals match the
   *  sum of the underlying lines exactly — round only at display. */
  yieldPerAcre: number | null
  costPerAcre: number | null
  effectivePrice: number | null
  /** "800 irr + 450 dry" — the underlying lines, for the blended header.
   *  '' for a single-line group (the blend is a pass-through). */
  composition: string
}

const shortDesignation = (l: Pick<BlendInput, 'practice' | 'cropping' | 'label'>): string => {
  const bits: string[] = []
  if (l.practice === 'irrigated') bits.push('irr')
  else if (l.practice === 'non_irrigated') bits.push('dry')
  if (l.cropping === 'double_crop') bits.push('dc')
  if (bits.length === 0 && !l.label) bits.push('blended')
  if (l.label) bits.push(`(${l.label})`)
  return bits.join(' ')
}

/** DISPLAY-TIME blend of one crop's budget lines into a single virtual line:
 *  acres summed, yield/cost/price acre-weighted across the lines that carry
 *  both acres and a value. The underlying lines are untouched — switching the
 *  view back restores them. A single-line group passes through verbatim
 *  (composition ''), so the toggle changes nothing for a one-line crop.
 *  800 ac @ 195 + 450 ac @ 168 → 1,250 ac @ 185.28 (displayed 185.3). */
export function blendBudgetLines(lines: ReadonlyArray<BlendInput>): BlendedLine {
  if (lines.length === 1) {
    const l = lines[0]
    return {
      acres: l.acres != null ? Number(l.acres) : null,
      yieldPerAcre: l.yield_per_acre != null ? Number(l.yield_per_acre) : null,
      costPerAcre: l.cost_per_acre != null ? Number(l.cost_per_acre) : null,
      effectivePrice: l.effectivePrice ?? null,
      composition: '',
    }
  }
  let acres: number | null = null
  for (const l of lines) if (l.acres != null) acres = (acres ?? 0) + Number(l.acres)
  const weighted = (get: (l: BlendInput) => number | null | undefined): number | null => {
    let num = 0
    let den = 0
    for (const l of lines) {
      const v = get(l)
      const a = l.acres != null ? Number(l.acres) : null
      if (v != null && a != null && a > 0) { num += Number(v) * a; den += a }
    }
    return den > 0 ? r2fine(num / den) : null
  }
  const composition = lines
    .map((l) => `${l.acres != null ? Number(l.acres).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} ${shortDesignation(l)}`.trim())
    .join(' + ')
  return {
    acres,
    yieldPerAcre: weighted((l) => l.yield_per_acre),
    costPerAcre: weighted((l) => l.cost_per_acre),
    effectivePrice: weighted((l) => l.effectivePrice),
    composition,
  }
}

