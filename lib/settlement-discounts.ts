// Settlement discount itemization math (074) — pure functions shared by the
// settlement detail page, the upload review, and the Buyer Discount
// Comparison report, so every ¢/bu figure is computed one way.
//
// Conventions:
//   * item amounts are POSITIVE dollars deducted;
//   * ¢/bu figures divide by the settlement's SETTLED (pay) bushels — the
//     bushels the buyer actually priced — so they stack cleanly against the
//     gross → net price walk;
//   * the settlement_lines.discounts total stays authoritative; itemized
//     lines are the breakdown and are CHECKED against it (sumCheck), never
//     substituted for it.

export const DISCOUNT_CATEGORIES = [
  'moisture_shrink',
  'drying',
  'test_weight',
  'damage',
  'heat_damage',
  'foreign_material',
  'dockage',
  'splits',
  'sprout',
  'musty_sour',
  // 086 — NOT quality discounts (see isQualityDiscount): promotion
  // assessments and non-quality service charges, listed outside "discounts".
  'checkoff',
  'fee',
  'other',
] as const

export type DiscountCategory = (typeof DISCOUNT_CATEGORIES)[number]

// Farmer-facing labels — plain grain-desk language.
export const DISCOUNT_CATEGORY_LABELS: Record<DiscountCategory, string> = {
  moisture_shrink: 'Moisture shrink',
  drying: 'Drying',
  test_weight: 'Test weight',
  damage: 'Damage',
  heat_damage: 'Heat damage',
  foreign_material: 'Foreign material',
  dockage: 'Dockage',
  splits: 'Splits',
  sprout: 'Sprout damage',
  musty_sour: 'Musty / sour',
  checkoff: 'Checkoff',
  fee: 'Fees',
  other: 'Other',
}

/** Categories that are NOT quality discounts: money the buyer withheld for
 *  a promotion program or a service, not for the grain's condition. They
 *  stay out of the quality-discount total, the buyer discount comparison and
 *  the lost-revenue math, and show as their own lines on the price walk. */
export const NON_QUALITY_CATEGORIES = ['checkoff', 'fee'] as const satisfies readonly DiscountCategory[]

export function isQualityDiscount(category: string | null | undefined): boolean {
  const c = coerceDiscountCategory(category)
  return !(NON_QUALITY_CATEGORIES as readonly string[]).includes(c)
}

export function isDiscountCategory(s: string | null | undefined): s is DiscountCategory {
  return s != null && (DISCOUNT_CATEGORIES as readonly string[]).includes(s)
}

/** Best-effort mapping of a free-text category (AI output, hand entry) onto
 *  the enum; anything unrecognized lands in 'other'. Synonyms the model or a
 *  hand entry might use for the 086 categories are folded in. */
export function coerceDiscountCategory(s: string | null | undefined): DiscountCategory {
  const v = (s ?? '').trim().toLowerCase().replace(/[\s/-]+/g, '_')
  if (isDiscountCategory(v)) return v
  if (v === 'check_off' || v === 'checkoff_assessment' || v === 'assessment' || v === 'promotion') return 'checkoff'
  if (v === 'fees' || v === 'service_fee' || v === 'service_charge' || v === 'charge') return 'fee'
  return 'other'
}

// The wording buyers use for checkoff (every state/national program, the
// boards and commissions that collect it, Bunge's I02 legend code) and for
// non-quality service charges (Bunge's I11). A quality word anywhere keeps a
// line OUT of these buckets — "moisture assessment" is a moisture discount.
const CHECKOFF_WORDS = /(check[- ]?off|promotion|assessment|research (and|&) promotion|(soybean|corn|wheat|cotton|sorghum|grain|canola|sesame) (board|commission|council|promotion)|\bboard\b|\bcommission\b|\bcouncil\b|\bI02\b)/i
const FEE_WORDS = /(vehicle inspection|inspection fee|grading fee|grade fee|unload(ing)? fee|administrative|admin(istration)? fee|service (charge|fee)|handling (charge|fee)|processing fee|scale fee|probe fee|\bI11\b)/i
const QUALITY_WORDS = /(moisture|test ?weight|\btw\b|damage|foreign|\bfm\b|dockage|shrink|dry(ing)?|splits|sprout|musty|sour|heat|protein|oil|color)/i

/** Classify a deduction by its printed wording: 'checkoff', 'fee', or null
 *  (a quality discount / unknown — leave the extracted category alone). */
export function classifyDeductionDescription(description: string | null | undefined): 'checkoff' | 'fee' | null {
  const d = (description ?? '').trim()
  if (!d) return null
  if (CHECKOFF_WORDS.test(d) && !/(moisture|test ?weight|damage|foreign|dockage|shrink)/i.test(d)) return 'checkoff'
  if (FEE_WORDS.test(d) && !QUALITY_WORDS.test(d)) return 'fee'
  return null
}

export type DeductionKind = 'price' | 'weight'

/** 'weight' only when the extraction/user explicitly says so — everything
 *  else (including pre-075 rows with no kind) is a price deduction. */
export function coerceDeductionKind(s: string | null | undefined): DeductionKind {
  return s === 'weight' ? 'weight' : 'price'
}

export type DiscountItemLike = {
  category: string
  amount: number | string | null
  /** 075: 'price' (dollars off the check) vs 'weight' (an itemized volume
   *  deduction — informational, never summed as dollars). Absent = price. */
  deduction_kind?: string | null
}

const num = (v: number | string | null | undefined): number => {
  if (v == null || v === '') return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Dollars → ¢/bu on the settled bushels. Null when there are no bushels. */
export function centsPerBu(amountDollars: number, settledBu: number): number | null {
  if (!(settledBu > 0)) return null
  return (amountDollars / settledBu) * 100
}

/** Sum the itemized PRICE lines and compare with the settlement's stated
 *  discount total (Σ settlement_lines.discounts). Weight-kind items (075)
 *  are volume deductions — they were never dollars off the check, so they
 *  stay out of the sum. Flags a mismatch beyond a cent-level tolerance:
 *  $0.50 or 0.5% of the stated total, whichever is larger — real statements
 *  round each line, so exact equality is too strict. */
export function sumCheck(
  items: ReadonlyArray<DiscountItemLike>,
  statedTotalDollars: number,
): { itemizedTotal: number; delta: number; mismatch: boolean } {
  const priceItems = items.filter((i) => coerceDeductionKind(i.deduction_kind) === 'price')
  const itemizedTotal = priceItems.reduce((s, i) => s + num(i.amount), 0)
  const delta = itemizedTotal - statedTotalDollars
  const tolerance = Math.max(0.5, Math.abs(statedTotalDollars) * 0.005)
  // No price itemization at all isn't a "mismatch" — nothing to check.
  const mismatch = priceItems.length > 0 && Math.abs(delta) > tolerance
  return { itemizedTotal, delta, mismatch }
}

export type NormalizedDiscountItem = {
  category: DiscountCategory
  description: string | null
  amount: number
  rate_note: string | null
  quantity_basis: string | null
  deduction_kind: DeductionKind
}

/** Pin an extraction's (or hand-entered) discount lines to the storage
 *  shape: category coerced to the enum (unknowns → 'other', never guessed
 *  into a real category), kind coerced ('weight' only when stated), amount
 *  numeric, empty strings → null. */
export function normalizeExtractedDiscountItems(
  raw: ReadonlyArray<{
    category?: string | null
    description?: string | null
    amount?: number | string | null
    rate_note?: string | null
    quantity_basis?: string | null
    deduction_kind?: string | null
  }> | null | undefined,
): NormalizedDiscountItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((i) => {
    // Checkoff / fees are recognized from the wording under EVERY label the
    // model might have used — an 'other' (or a mis-filed quality category)
    // whose description says checkoff is checkoff; never the reverse.
    const extracted = coerceDiscountCategory(i.category)
    const byWording = classifyDeductionDescription(i.description)
    const category = byWording ?? extracted
    return {
      category,
      description: (i.description ?? '').trim() || null,
      amount: num(i.amount),
      rate_note: (i.rate_note ?? '').trim() || null,
      quantity_basis: (i.quantity_basis ?? '').trim() || null,
      deduction_kind: coerceDeductionKind(i.deduction_kind),
    }
  })
}

export type DetailedPriceWalk = PriceWalk & {
  /** Quality discounts only (price-kind, non-checkoff/fee), ¢/bu. */
  qualityCentsPerBu: number | null
  checkoffCentsPerBu: number | null
  feeCentsPerBu: number | null
  qualityDollars: number
  checkoffDollars: number
  feeDollars: number
}

/** The price walk with checkoff and fees split out from quality discounts
 *  (086): gross → less quality discounts → less checkoff → less fees → net.
 *  `discountTotal` stays the statement's stated total (all deductions). */
export function detailedPriceWalk(args: {
  grossRevenue: number
  discountTotal: number
  settledBu: number
  items: ReadonlyArray<DiscountItemLike>
}): DetailedPriceWalk {
  const base = effectivePriceWalk(args)
  let checkoff = 0, fee = 0, quality = 0
  for (const i of args.items) {
    if (coerceDeductionKind(i.deduction_kind) !== 'price') continue
    const c = coerceDiscountCategory(i.category)
    if (c === 'checkoff') checkoff += num(i.amount)
    else if (c === 'fee') fee += num(i.amount)
    else quality += num(i.amount)
  }
  return {
    ...base,
    qualityDollars: quality,
    checkoffDollars: checkoff,
    feeDollars: fee,
    qualityCentsPerBu: centsPerBu(quality, args.settledBu),
    checkoffCentsPerBu: centsPerBu(checkoff, args.settledBu),
    feeCentsPerBu: centsPerBu(fee, args.settledBu),
  }
}

/** Dollars per category across a settlement's items. */
export function categoryTotals(
  items: ReadonlyArray<DiscountItemLike>,
): Map<DiscountCategory, number> {
  const out = new Map<DiscountCategory, number>()
  for (const i of items) {
    const c = coerceDiscountCategory(i.category)
    out.set(c, (out.get(c) ?? 0) + num(i.amount))
  }
  return out
}

export type PriceWalk = {
  /** Gross price before any discounts, $/bu. */
  grossPerBu: number | null
  /** Total discounts, ¢/bu (positive = deducted). */
  discountCentsPerBu: number | null
  /** Net (settled) price, $/bu. Equals gross − discounts/100 by construction. */
  netPerBu: number | null
}

/** The effective price walk: gross $/bu → less discounts ¢/bu → net $/bu. */
export function effectivePriceWalk(args: {
  grossRevenue: number
  discountTotal: number
  settledBu: number
}): PriceWalk {
  if (!(args.settledBu > 0)) {
    return { grossPerBu: null, discountCentsPerBu: null, netPerBu: null }
  }
  const grossPerBu = args.grossRevenue / args.settledBu
  const discountCentsPerBu = (args.discountTotal / args.settledBu) * 100
  const netPerBu = (args.grossRevenue - args.discountTotal) / args.settledBu
  return { grossPerBu, discountCentsPerBu, netPerBu }
}

export type ExcessShrink = {
  /** Our FSA-standard dry bushels minus the buyer's pay bushels. Positive =
   *  the buyer paid on FEWER bushels than standard shrink allows (a cost). */
  bu: number
  /** That bushel gap at the settlement's net price, dollars. */
  dollars: number
  /** The same cost spread over the settled bushels, ¢/bu — comparable with
   *  the price discounts it doesn't show up in. */
  centsPerBu: number | null
}

/** "Weight deduction beyond standard shrink": the buyer's pay-bushels vs our
 *  FSA-standard dry bushels (lib/shrink.ts computeBushels), monetized at the
 *  settlement price. A buyer whose scale/shrink takes more bushels than the
 *  FSA formula shows a positive cost here even when their PRICE discounts
 *  look mild — that's the whole point of surfacing it. */
export function excessShrink(args: {
  ourDryBu: number
  settledBu: number
  pricePerBu: number
}): ExcessShrink {
  const bu = args.ourDryBu - args.settledBu
  const dollars = bu * args.pricePerBu
  return {
    bu,
    dollars,
    centsPerBu: centsPerBu(dollars, args.settledBu),
  }
}
