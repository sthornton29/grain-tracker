// Buyer discount schedules (074) — the pure rule engine.
//
// A schedule is a buyer's posted discount sheet for one crop, effective from a
// date; its rules describe, per quality factor, how the charge is computed
// from a load's measurement (moisture %, test weight lb, damage %):
//
//   * basis 'cents_per_bu'      — a price discount in ¢/bu;
//   * basis 'weight_shrink_pct' — a % of weight shrunk off (monetized at the
//                                 settlement price to compare in ¢/bu);
//   * basis 'pct_of_price'      — a % taken off the price.
//
// A rule is either LINEAR (rate_per_unit per point/lb past base_value) or
// TIERED (bracket table). Tier brackets carry the measurement range and the
// printed rate: "54.0–54.9 = 4¢, 53.0–53.9 = 8¢, 52.0–52.9 = 16¢". Two tier
// semantics exist on real sheets:
//   * bracket (cumulative=false): the bracket the load falls in IS the whole
//     charge (54.2 lb → 4¢);
//   * tier walk (cumulative=true): charges STACK as the grain falls through
//     successive tiers — every bracket passed or entered adds its rate
//     (52.5 lb under the same sheet → 4 + 8 + 16 = 28¢).
//
// MOISTURE is two-step at a real elevator (080): the buyer SHRINKS the
// bushels to its base at ITS factor (shrink_factor_pct_per_point — 1.4% is
// the industry default when the sheet is silent) and then CHARGES drying on
// what is left (a ¢/bu-per-point or %-of-price-per-point rule). moistureTerms
// reads a schedule's moisture rules into that model for the Dryer Math
// dry-vs-haul comparison; a %-of-price charge standing alone (no shrink
// line, no factor) is the ISU-style BUNDLED discount that already embodies
// the shrink.
//
// Used by the Ask Turnrow schedule tools, the dryer comparison, and the
// expected-vs-actual audit (apply the schedule in force at the settlement
// date to each settled load's known moisture/TW, compare with what was
// charged). Everything here is unit-tested with hand-worked numbers.

import { coerceDiscountCategory, type DiscountCategory } from '@/lib/settlement-discounts'

export type RuleBasis = 'weight_shrink_pct' | 'cents_per_bu' | 'pct_of_price'

export type ScheduleTier = { from: number; to: number; rate: number }

export type ScheduleRuleShape = {
  factor: DiscountCategory
  basis: RuleBasis
  /** Threshold where charges begin (15 → 15% moisture, 54 → 54 lb TW). */
  base_value: number | null
  /** 'above' charges as the measurement rises past base (moisture, damage);
   *  'below' as it falls (test weight). */
  direction: 'above' | 'below'
  /** Linear rules: charge per unit past base, in basis units per point/lb. */
  rate_per_unit: number | null
  /** Tier brackets in measurement order; empty for linear rules. */
  tiers: ScheduleTier[]
  /** True = tier-walk (stacking) semantics; false = bracket semantics. */
  cumulative: boolean
  /** Measurement at/past which the buyer rejects. */
  rejection_at: number | null
  note?: string | null
  /** Moisture rules only (080): the % of weight the buyer shrinks per point
   *  over base_value. Null = not stated on the sheet (the comparison assumes
   *  ASSUMED_SHRINK_FACTOR_PCT_PER_POINT and says so). */
  shrink_factor_pct_per_point?: number | null
}

/** The industry-standard shrink factor a schedule is assumed to use when it
 *  doesn't state one, % of weight per point of moisture. */
export const ASSUMED_SHRINK_FACTOR_PCT_PER_POINT = 1.4

/** A stored rule row (buyer_discount_schedule_rules, any select) → the
 *  engine's shape. Tolerates numeric strings and the 080 column being absent. */
export function shapeStoredRule(r: {
  factor: string
  basis: string
  base_value: number | string | null
  direction: string
  rate_per_unit: number | string | null
  tiers: unknown
  cumulative: boolean | null
  rejection_at: number | string | null
  note?: string | null
  shrink_factor_pct_per_point?: number | string | null
}): ScheduleRuleShape {
  return {
    factor: coerceDiscountCategory(r.factor),
    basis: (r.basis === 'weight_shrink_pct' || r.basis === 'pct_of_price' ? r.basis : 'cents_per_bu') as RuleBasis,
    base_value: toNum(r.base_value),
    direction: r.direction === 'below' ? 'below' : 'above',
    rate_per_unit: toNum(r.rate_per_unit),
    tiers: parseTiers(r.tiers),
    cumulative: r.cumulative === true,
    rejection_at: toNum(r.rejection_at),
    note: r.note ?? null,
    shrink_factor_pct_per_point: toNum(r.shrink_factor_pct_per_point),
  }
}

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Parse a stored tiers jsonb value into a clean bracket list. */
export function parseTiers(raw: unknown): ScheduleTier[] {
  if (!Array.isArray(raw)) return []
  const out: ScheduleTier[] = []
  for (const t of raw) {
    const from = toNum((t as { from?: unknown })?.from)
    const to = toNum((t as { to?: unknown })?.to)
    const rate = toNum((t as { rate?: unknown })?.rate)
    if (from == null || to == null || rate == null) continue
    out.push({ from, to, rate })
  }
  return out
}

/** How far past the rule's threshold the measurement is, in the discount
 *  direction. 0 when at/inside the threshold or when either side is missing. */
export function unitsPastBase(rule: Pick<ScheduleRuleShape, 'base_value' | 'direction'>, value: number | null): number {
  if (value == null || rule.base_value == null) return 0
  return rule.direction === 'below'
    ? Math.max(0, rule.base_value - value)
    : Math.max(0, value - rule.base_value)
}

// A bracket is ENTERED when the measurement falls inside its range, and
// PASSED when the measurement is beyond the whole range in the discount
// direction (lighter than a TW bracket / wetter than a moisture bracket).
function bracketState(tier: ScheduleTier, direction: 'above' | 'below', value: number): 'before' | 'in' | 'past' {
  const lo = Math.min(tier.from, tier.to)
  const hi = Math.max(tier.from, tier.to)
  if (value >= lo && value <= hi) return 'in'
  if (direction === 'below') return value < lo ? 'past' : 'before'
  return value > hi ? 'past' : 'before'
}

/** The rule's raw charge in ITS OWN basis units (¢/bu, shrink %, or % of
 *  price). Null when the measurement is missing; 0 when inside the threshold. */
export function ruleRawCharge(rule: ScheduleRuleShape, value: number | null): number | null {
  if (value == null) return null
  if (rule.tiers.length > 0) {
    let charge = 0
    let deepestPast: ScheduleTier | null = null
    let entered: ScheduleTier | null = null
    for (const t of rule.tiers) {
      const state = bracketState(t, rule.direction, value)
      if (state === 'in') { entered = t; if (rule.cumulative) charge += t.rate }
      if (state === 'past') { deepestPast = t; if (rule.cumulative) charge += t.rate }
    }
    if (rule.cumulative) return charge
    // Bracket semantics: the bracket the value falls in; beyond every bracket,
    // the deepest (most severe) printed rate still applies.
    if (entered) return entered.rate
    if (deepestPast) return deepestPast.rate
    return 0
  }
  const past = unitsPastBase(rule, value)
  if (past === 0) return 0
  return past * (rule.rate_per_unit ?? 0)
}

/** The rule's charge monetized to ¢/bu (weight-shrink and %-of-price rules
 *  need the settlement's $/bu price). Null when the measurement is missing. */
export function ruleCentsPerBu(rule: ScheduleRuleShape, value: number | null, pricePerBu: number): number | null {
  const raw = ruleRawCharge(rule, value)
  if (raw == null) return null
  switch (rule.basis) {
    case 'cents_per_bu':
      return raw
    case 'weight_shrink_pct':
    case 'pct_of_price':
      // raw is a percent; a 1% weight shrink and a 1% price cut cost the same
      // ¢/bu at a given price: price × 1% × 100¢.
      return (raw / 100) * pricePerBu * 100
  }
}

/** True when the measurement is at/past the rule's stated rejection point. */
export function isRejected(rule: ScheduleRuleShape, value: number | null): boolean {
  if (value == null || rule.rejection_at == null) return false
  return rule.direction === 'below' ? value <= rule.rejection_at : value >= rule.rejection_at
}

// ---------- schedule-in-force selection ----------

export type ScheduleLike = {
  id: string
  buyer_id: string
  crop_id: string
  effective_date: string
}

/** The schedule governing a settlement: the buyer+crop schedule with the
 *  NEWEST effective_date on or before the settlement date. Schedules dated
 *  after the settlement never apply (they weren't in force yet). */
export function scheduleInForce<T extends ScheduleLike>(
  schedules: ReadonlyArray<T>,
  buyerId: string,
  cropId: string,
  onDate: string,
): T | null {
  let best: T | null = null
  for (const s of schedules) {
    if (s.buyer_id !== buyerId || s.crop_id !== cropId) continue
    if (s.effective_date > onDate) continue
    if (!best || s.effective_date > best.effective_date) best = s
  }
  return best
}

// ---------- expected vs actual ----------

export type LoadQuality = {
  bu: number
  moisture: number | null
  testWeight: number | null
}

/** Which measurement a factor reads. Damage/FM factors aren't measured on our
 *  loads, so the audit can only model moisture- and TW-driven factors. */
export function factorMeasurement(factor: DiscountCategory): 'moisture' | 'test_weight' | null {
  if (factor === 'moisture_shrink' || factor === 'drying') return 'moisture'
  if (factor === 'test_weight') return 'test_weight'
  return null
}

/** Expected discount DOLLARS for a set of settled loads under a schedule's
 *  rules, per factor — Σ over loads of (rule ¢/bu at the load's measurement)
 *  × the load's bushels ÷ 100. Loads missing the measurement contribute
 *  nothing (they can't be modeled, and pretending otherwise would inflate
 *  variance flags). */
export function expectedDiscountDollars(
  rules: ReadonlyArray<ScheduleRuleShape>,
  loads: ReadonlyArray<LoadQuality>,
  pricePerBu: number,
): Map<DiscountCategory, number> {
  const out = new Map<DiscountCategory, number>()
  for (const rule of rules) {
    const which = factorMeasurement(rule.factor)
    if (!which) continue
    let dollars = 0
    for (const l of loads) {
      const value = which === 'moisture' ? l.moisture : l.testWeight
      const cents = ruleCentsPerBu(rule, value, pricePerBu)
      if (cents == null) continue
      dollars += (cents / 100) * l.bu
    }
    out.set(rule.factor, (out.get(rule.factor) ?? 0) + dollars)
  }
  return out
}

export type VarianceVerdict = {
  varianceCents: number
  /** True when the buyer charged MATERIALLY more than their own published
   *  schedule predicts: over by more than 2¢/bu AND more than 25% of the
   *  expected charge. Undercharges never flag. */
  flagged: boolean
}

export function varianceVerdict(expectedCents: number, actualCents: number): VarianceVerdict {
  const varianceCents = actualCents - expectedCents
  const flagged = varianceCents > Math.max(2, expectedCents * 0.25)
  return { varianceCents, flagged }
}

// ---------- display ----------

/** One-line plain-language summary of a rule for the side-by-side schedule
 *  table ("4¢/8¢/16¢ per lb under 54", "1.4% shrink per point over 15%"). */
export function summarizeRule(rule: ScheduleRuleShape): string {
  const unit = rule.direction === 'below' ? 'under' : 'over'
  const baseTxt = rule.base_value != null ? `${rule.base_value}` : '—'
  const suffix = rule.factor === 'test_weight' ? ' lb' : '%'
  const rej = rule.rejection_at != null ? ` · reject at ${rule.rejection_at}${suffix}` : ''
  if (rule.tiers.length > 0) {
    const rates = rule.tiers.map((t) => `${t.rate}${rule.basis === 'cents_per_bu' ? '¢' : '%'}`).join('/')
    const how = rule.cumulative ? 'stacking' : 'per bracket'
    return `${rates} ${how}, ${unit} ${baseTxt}${suffix}${rej}`
  }
  const rate = rule.rate_per_unit ?? 0
  const rateTxt = rule.basis === 'cents_per_bu'
    ? `${rate}¢/bu`
    : rule.basis === 'weight_shrink_pct'
      ? `${rate}% shrink`
      : `${rate}% of price`
  const per = rule.factor === 'test_weight' ? 'lb' : 'point'
  return `${rateTxt} per ${per} ${unit} ${baseTxt}${suffix}${rej}`
}

// ---------- the schedule's moisture terms (080) ----------

export type MoistureTerms = {
  /** True when the schedule prices moisture at all. */
  hasMoistureRules: boolean
  /** The schedule's OWN base moisture (its moisture rules' base_value);
   *  null when no rule states one. */
  baseMoisture: number | null
  /** The price/drying charge rules — ¢/bu or %-of-price basis. */
  chargeRules: ScheduleRuleShape[]
  chargeBasis: 'cents_per_bu_per_point' | 'pct_of_price_per_point' | 'mixed' | null
  /** The separate shrink line(s) — weight_shrink_pct basis — when printed. */
  shrinkRules: ScheduleRuleShape[]
  /** The shrink factor the comparison uses, % per point: an explicit
   *  shrink_factor_pct_per_point, else a linear shrink line's rate, else the
   *  1.4% assumption. Null when the discount is bundled. */
  shrinkFactorPctPerPoint: number | null
  /** True when nothing on file states the factor and 1.4% stands in —
   *  "assumed — verify against the schedule". */
  shrinkFactorAssumed: boolean
  /** True when a %-of-price charge stands alone (no shrink line, no explicit
   *  factor): the bundled moisture discount already embodies the shrink, so
   *  it applies by itself. */
  bundled: boolean
}

export function moistureTerms(rules: ReadonlyArray<ScheduleRuleShape>): MoistureTerms {
  const moisture = rules.filter((r) => factorMeasurement(r.factor) === 'moisture')
  const shrinkRules = moisture.filter((r) => r.basis === 'weight_shrink_pct')
  const chargeRules = moisture.filter((r) => r.basis !== 'weight_shrink_pct')
  const explicit = moisture.map((r) => r.shrink_factor_pct_per_point).find((v) => v != null && Number.isFinite(v) && v >= 0) ?? null
  const linearShrink = shrinkRules.find((r) => r.tiers.length === 0 && r.rate_per_unit != null)?.rate_per_unit ?? null
  const chargeBasis = chargeRules.length === 0
    ? null
    : chargeRules.every((r) => r.basis === 'cents_per_bu')
      ? 'cents_per_bu_per_point'
      : chargeRules.every((r) => r.basis === 'pct_of_price')
        ? 'pct_of_price_per_point'
        : 'mixed'
  const bundled = chargeBasis === 'pct_of_price_per_point' && shrinkRules.length === 0 && explicit == null
  const shrinkFactorPctPerPoint = bundled ? null : explicit ?? linearShrink ?? (shrinkRules.length > 0 ? null : ASSUMED_SHRINK_FACTOR_PCT_PER_POINT)
  return {
    hasMoistureRules: moisture.length > 0,
    baseMoisture: chargeRules[0]?.base_value ?? shrinkRules[0]?.base_value ?? null,
    chargeRules,
    chargeBasis,
    shrinkRules,
    shrinkFactorPctPerPoint,
    shrinkFactorAssumed: !bundled && explicit == null && linearShrink == null && shrinkRules.length === 0 && moisture.length > 0,
    bundled,
  }
}

/** The TOTAL weight shrink the schedule takes at `moisture`, % of the wet
 *  weight: the factor × points over the schedule's base, or a printed
 *  (possibly tiered) shrink line walked by the rule engine. Null when the
 *  discount is bundled (no separable shrink) or nothing prices moisture. */
export function scheduleShrinkPctAt(terms: MoistureTerms, moisture: number, fallbackBase: number | null): number | null {
  if (!terms.hasMoistureRules || terms.bundled) return null
  const base = terms.baseMoisture ?? fallbackBase
  if (base == null) return null
  const points = Math.max(0, moisture - base)
  if (terms.shrinkFactorPctPerPoint != null) return terms.shrinkFactorPctPerPoint * points
  // A tiered shrink line: the engine walks it.
  const tiered = terms.shrinkRules.find((r) => r.tiers.length > 0)
  if (tiered) return ruleRawCharge(tiered, moisture) ?? 0
  return ASSUMED_SHRINK_FACTOR_PCT_PER_POINT * points
}

/** Plain-language line for a schedule's moisture terms ("base 15% · 1.4%
 *  shrink/pt (assumed) · 3.5¢/pt drying"). */
export function summarizeMoistureTerms(terms: MoistureTerms): string {
  if (!terms.hasMoistureRules) return 'no moisture rule'
  const parts: string[] = []
  if (terms.baseMoisture != null) parts.push(`base ${terms.baseMoisture}%`)
  if (terms.bundled) {
    parts.push(`${terms.chargeRules.map((r) => r.tiers.length > 0 ? summarizeRule(r) : `${r.rate_per_unit ?? 0}% of price/pt`).join(' + ')} (bundled — shrink included)`)
    return parts.join(' · ')
  }
  if (terms.shrinkFactorPctPerPoint != null) {
    parts.push(`${terms.shrinkFactorPctPerPoint}% shrink/pt${terms.shrinkFactorAssumed ? ' (assumed — verify against the schedule)' : ''}`)
  } else if (terms.shrinkRules.length > 0) {
    parts.push(summarizeRule(terms.shrinkRules[0]))
  }
  for (const r of terms.chargeRules) {
    parts.push(r.tiers.length > 0
      ? summarizeRule(r)
      : r.basis === 'cents_per_bu' ? `${r.rate_per_unit ?? 0}¢/pt drying` : `${r.rate_per_unit ?? 0}% of price/pt drying`)
  }
  return parts.join(' · ')
}
