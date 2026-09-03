// Grain Dryer Math — the /reports/dryer-math calculator's pure engine.
// Everything here is unit-tested with hand-worked numbers.
//
// Units and conventions:
//   * consumption is per BUSHEL-POINT (one bushel dried one moisture point),
//     stored in the fuel's OWN unit — gal for LP, ccf (100 cf) for NG —
//     converted between fuels by BTU parity: propane 91,500 BTU/gal, natural
//     gas 1,020 BTU/cf (1 gal LP ≈ 89.7 cf ≈ 0.897 ccf);
//   * THE COST OF DRYING TO BASE IS FUEL + FAN ELECTRICITY + DRYER
//     DEPRECIATION. The water above base moisture is unsellable either way:
//     deliver wet and the buyer's shrink table takes it off the ticket; dry
//     it and it goes up the stack. The counterfactual is identical, so the
//     weight lost reaching base is NOT a cost of drying — it is reported
//     (shrinkPct) as the physical reality, never summed into totalPerBu;
//   * DEPRECIATION applies FLAT PER BUSHEL DRIED (the extension convention:
//     dryer investment ÷ useful life ÷ bushels dried per year ≈ 4¢/bu), not
//     per point — a bushel that goes through the dryer carries the full
//     figure whether it lost two points or ten; a bushel at/below base that
//     never ran carries none. Repairs and interest can be folded in by
//     raising the figure (full ownership costing). The org's figure lives in
//     dryer_settings (079);
//   * overdrying (below the crop's base moisture) IS a cost: every point past
//     base gives away sellable weight (1.183%/pt × the grain price) AND burns
//     fuel removing points nobody pays for — so the grain price is only
//     needed for the below-base rows;
//   * the dry-it-or-haul-it-wet comparison (080) models the elevator's REAL
//     two-step treatment: it SHRINKS the bushels to its base at ITS factor
//     (1.4%/pt typical, vs the 1.183%/pt of physical water) and then CHARGES
//     drying on what is left. The physical water cancels both sides (it is
//     gone whether you or they dry it), so per wet bushel at moisture M:
//       haul it wet = schedule charge (¢/pt × points, or %-of-price × points
//                     × price) + EXCESS shrink = max(0, factor − 1.183) ×
//                     points × grain price
//       dry it      = fuel + fan (+ depreciation by the toggle — an owned
//                     dryer's depreciation is sunk whether or not this load
//                     runs through it, so the marginal call may prefer OFF).
//     A %-of-price charge standing alone (no shrink line, no factor) is the
//     ISU-style BUNDLED discount that already embodies the shrink — applied
//     alone. The grain price prices the excess shrink, so the comparison
//     needs one.

import {
  moistureTerms,
  ruleCentsPerBu,
  scheduleShrinkPctAt,
  type MoistureTerms,
  type ScheduleRuleShape,
} from '@/lib/discount-schedules'

export const LP_BTU_PER_GAL = 91_500
export const NG_BTU_PER_CF = 1_020
/** Physical weight-shrink per moisture point, percent (no handling factor). */
export const SHRINK_PCT_PER_POINT = 1.183
/** Default electric rate when none is entered, $/kWh. */
export const DEFAULT_ELECTRIC_RATE = 0.12
/** Default dryer depreciation, ¢ per bushel dried (flat, not per point):
 *  ≈ $300,000 ÷ 15 yr ÷ 500,000 bu/yr. */
export const DEFAULT_DEPRECIATION_CENTS_PER_BU = 4.0

export type DryerFuel = 'lp' | 'ng'

/** Gallons of LP → the BTU-equivalent ccf (100 cf) of natural gas. */
export function lpGalToNgCcf(gal: number): number {
  return (gal * LP_BTU_PER_GAL) / NG_BTU_PER_CF / 100
}

/** ccf of natural gas → BTU-equivalent gallons of LP. */
export function ngCcfToLpGal(ccf: number): number {
  return (ccf * 100 * NG_BTU_PER_CF) / LP_BTU_PER_GAL
}

/** A catalog preset (gal LP per bu-pt) expressed in a dryer's fuel unit. */
export function presetFuelPerBuPt(galLpPerBuPt: number, fuel: DryerFuel): number {
  return fuel === 'lp' ? galLpPerBuPt : lpGalToNgCcf(galLpPerBuPt)
}

export type DryerSpec = {
  fuel: DryerFuel
  /** Per bu-pt in the fuel's own unit (gal or ccf). */
  fuelPerBuPt: number
  /** Optional fan/auger electricity per bu-pt. */
  fanKwhPerBuPt?: number | null
}

export type DryingRates = {
  /** $/gal for LP, $/ccf for NG — whichever matches the dryer's fuel. */
  fuelPrice: number
  /** $/kWh (DEFAULT_ELECTRIC_RATE when omitted). */
  electricRate?: number | null
  /** Dryer depreciation, ¢ per bushel DRIED — flat, not per point
   *  (DEFAULT_DEPRECIATION_CENTS_PER_BU when omitted; 0 to exclude). */
  depreciationCentsPerBu?: number | null
}
/** @deprecated name — the rates carry more than fuel now. */
export type FuelPrices = DryingRates

/** The org's depreciation figure in $/bu (the default when unset). */
export function depreciationPerBuDollars(rates: DryingRates): number {
  const c = rates.depreciationCentsPerBu
  const cents = c == null || !Number.isFinite(Number(c)) || Number(c) < 0 ? DEFAULT_DEPRECIATION_CENTS_PER_BU : Number(c)
  return cents / 100
}

/**
 * The derivation helper / mini-calculator: dryer investment ÷ useful life ÷
 * bushels dried per year, in ¢/bu — e.g. $300,000 ÷ 15 yr ÷ 500,000 bu ≈ 4¢.
 * Null when any input is missing or non-positive.
 */
export function depreciationCentsPerBu(args: {
  investment: number | string | null | undefined
  usefulLifeYears: number | string | null | undefined
  bushelsDriedPerYear: number | string | null | undefined
}): number | null {
  const raw = [args.investment, args.usefulLifeYears, args.bushelsDriedPerYear]
  if (raw.some((v) => v == null || v === '')) return null
  const [inv, life, bu] = raw.map(Number)
  if (![inv, life, bu].every((n) => Number.isFinite(n)) || inv < 0 || life <= 0 || bu <= 0) return null
  return (inv / life / bu) * 100
}

/** Energy cost per bushel-POINT: fuel + fan electricity, $/bu-pt. */
export function energyCostPerBuPt(dryer: DryerSpec, prices: DryingRates): number {
  const fuel = dryer.fuelPerBuPt * prices.fuelPrice
  const fan = (dryer.fanKwhPerBuPt ?? 0) * (prices.electricRate ?? DEFAULT_ELECTRIC_RATE)
  return fuel + fan
}

export type DryingCost = {
  points: number
  /** Fuel $/bu (burner only). */
  fuelPerBu: number
  /** Fan electricity $/bu. */
  fanPerBu: number
  /** fuel + fan, $/bu. */
  energyPerBu: number
  /** Energy $/bu-pt (fuel + fan). */
  energyPerBuPt: number
  /** Dryer depreciation, $/bu — the flat per-bushel-dried figure on every
   *  bushel that actually runs through the dryer (0 at/below base). */
  depreciationPerBu: number
  /** INFORMATIONAL: weight lost reaching base, % of the wet weight. Happens
   *  whether you dry it or the buyer's shrink table takes it — not a cost of
   *  drying, and never part of totalPerBu. */
  shrinkPct: number
  /** INFORMATIONAL: that weight valued at the grain price, $/bu — what the
   *  buyer's shrink table would take off the ticket. Null without a price. */
  shrinkValuePerBu: number | null
  /** THE cost of drying to base = fuel + fan + depreciation, $/bu. Shrink
   *  is excluded on purpose (see the header note). */
  totalPerBu: number
}

/** Cost of drying from `moisture` down to `baseMoisture` (0 points when
 *  already at/below base — and then no depreciation either: the bushel never
 *  ran). The grain price is optional — it only values the informational
 *  shrink figure, never the cost. */
export function dryingCost(
  moisture: number,
  baseMoisture: number,
  dryer: DryerSpec,
  prices: DryingRates,
  grainPrice?: number | null,
): DryingCost {
  const points = Math.max(0, moisture - baseMoisture)
  const fuelPerBu = points * dryer.fuelPerBuPt * prices.fuelPrice
  const fanPerBu = points * (dryer.fanKwhPerBuPt ?? 0) * (prices.electricRate ?? DEFAULT_ELECTRIC_RATE)
  const energyPerBu = fuelPerBu + fanPerBu
  const depreciationPerBu = points > 0 ? depreciationPerBuDollars(prices) : 0
  const shrinkPct = points * SHRINK_PCT_PER_POINT
  const shrinkValuePerBu = grainPrice != null && grainPrice > 0 ? (shrinkPct / 100) * grainPrice : null
  return {
    points,
    fuelPerBu,
    fanPerBu,
    energyPerBu,
    energyPerBuPt: energyCostPerBuPt(dryer, prices),
    depreciationPerBu,
    shrinkPct,
    shrinkValuePerBu,
    totalPerBu: energyPerBu + depreciationPerBu,
  }
}

export type OverdryingCost = {
  /** Points dried BELOW base. */
  pointsOver: number
  /** Sellable weight given away, % (pointsOver × 1.183%). */
  lostVolumePct: number
  /** Sellable volume given away: pointsOver × 1.183% × price, $/bu. */
  lostVolumePerBu: number
  /** The fuel + fan spent removing those unpaid points, $/bu. */
  extraEnergyPerBu: number
  /** The combined cost of overdrying, $/bu. */
  totalPerBu: number
}

/** What stopping BELOW base costs: drying to `finalMoisture` < base gives
 *  away weight nobody pays for AND burns fuel doing it. This is the one
 *  place the grain price is a genuine input. Depreciation does not enter:
 *  the bushel already carried it reaching base — going past base is the
 *  marginal cost of the extra points only. */
export function overdryingCost(
  finalMoisture: number,
  baseMoisture: number,
  dryer: DryerSpec,
  prices: DryingRates,
  grainPrice: number,
): OverdryingCost {
  const pointsOver = Math.max(0, baseMoisture - finalMoisture)
  const lostVolumePct = pointsOver * SHRINK_PCT_PER_POINT
  const lostVolumePerBu = (lostVolumePct / 100) * grainPrice
  const extraEnergyPerBu = pointsOver * energyCostPerBuPt(dryer, prices)
  return { pointsOver, lostVolumePct, lostVolumePerBu, extraEnergyPerBu, totalPerBu: lostVolumePerBu + extraEnergyPerBu }
}

// ---------- the "dry it or haul it wet" comparison ----------

/** The "haul it wet" side, itemized — what the elevator's two-step treatment
 *  costs per wet bushel at this moisture. */
export type BuyerSide = {
  /** Points over the SCHEDULE's base (its own base_value; the crop base when
   *  the sheet states none). */
  pointsPastBase: number
  /** The schedule's price/drying charge, ¢/bu (¢/pt × points, %-of-price ×
   *  points × price, or a tier walk). Null when a %-of-price rule has no
   *  price to work with. */
  chargeCents: number | null
  chargeBasis: MoistureTerms['chargeBasis']
  /** The buyer's TOTAL shrink at this moisture, % of the wet weight (their
   *  factor × points); null when bundled. */
  shrinkPct: number | null
  /** The part of that shrink beyond the physical water (1.183%/pt) —
   *  sellable grain the buyer keeps, % of the wet weight. 0 when bundled. */
  excessShrinkPct: number
  /** That excess valued at the grain price, ¢/bu; null without a price. */
  excessShrinkCents: number | null
  shrinkFactorPctPerPoint: number | null
  /** 1.4% stood in — the sheet doesn't state a factor. */
  shrinkFactorAssumed: boolean
  /** The %-of-price discount that already embodies the shrink — applied
   *  alone, no excess-shrink add-on. */
  bundled: boolean
  /** charge + excess shrink (or the bundled discount alone), ¢/bu. */
  totalCents: number | null
}

export type WetVsDryVerdict = {
  /** The cost of hauling it wet per the buyer's sheet, ¢/bu — the charge
   *  plus the excess shrink (or the bundled discount). Null when the
   *  schedule prices no moisture or the grain price is missing. */
  buyerCents: number | null
  buyer: BuyerSide | null
  /** Why buyerCents is null. */
  reason: 'no_moisture_rule' | 'needs_price' | null
  /** Your own cost of drying those points, ¢/bu — fuel + fan, plus
   *  depreciation unless the toggle excludes it. The physical water is gone
   *  either way, so it is on neither side. */
  dryCents: number
  /** Whether depreciation is inside dryCents (the toggle; default on). */
  depreciationIncluded: boolean
  cheaper: 'dry' | 'haul_wet' | 'even' | null
}

/** The elevator's two-step treatment vs your dryer. `grainPrice` prices the
 *  buyer's excess shrink (and any %-of-price rule) — the comparison needs
 *  one unless the sheet's factor is exactly the physical 1.183 and its
 *  charge is in ¢/bu. `includeDepreciation` (default true) keeps the dryer's
 *  depreciation on your side; an owned dryer's depreciation is sunk whether
 *  or not this load runs through it, so for the marginal decision a user
 *  may prefer it off. */
export function wetVsDry(
  moisture: number,
  baseMoisture: number,
  dryer: DryerSpec,
  prices: DryingRates,
  grainPrice: number | null,
  scheduleRules: ReadonlyArray<ScheduleRuleShape>,
  opts?: { includeDepreciation?: boolean },
): WetVsDryVerdict {
  const includeDepreciation = opts?.includeDepreciation !== false
  const own = dryingCost(moisture, baseMoisture, dryer, prices, grainPrice)
  const dryCents = (includeDepreciation ? own.totalPerBu : own.energyPerBu) * 100
  const terms = moistureTerms(scheduleRules)
  if (!terms.hasMoistureRules) {
    return { buyerCents: null, buyer: null, reason: 'no_moisture_rule', dryCents, depreciationIncluded: includeDepreciation, cheaper: null }
  }
  const price = grainPrice != null && grainPrice > 0 ? grainPrice : null
  const schedBase = terms.baseMoisture ?? baseMoisture
  const pointsPastBase = Math.max(0, moisture - schedBase)

  // Step 2 — the charge on what is left, walked by the rule engine.
  const needsPriceForCharge = terms.chargeRules.some((r) => r.basis !== 'cents_per_bu')
  let chargeCents: number | null = needsPriceForCharge && price == null ? null : 0
  if (chargeCents != null) {
    for (const rule of terms.chargeRules) chargeCents += ruleCentsPerBu(rule, moisture, price ?? 0) ?? 0
  }

  // Step 1 — the shrink beyond physical water: sellable grain they keep.
  const shrinkPct = scheduleShrinkPctAt(terms, moisture, baseMoisture)
  const excessShrinkPct = terms.bundled || shrinkPct == null
    ? 0
    : Math.max(0, shrinkPct - SHRINK_PCT_PER_POINT * pointsPastBase)
  const excessShrinkCents = excessShrinkPct === 0 ? 0 : price != null ? (excessShrinkPct / 100) * price * 100 : null

  const totalCents = chargeCents != null && excessShrinkCents != null ? chargeCents + excessShrinkCents : null
  const buyer: BuyerSide = {
    pointsPastBase,
    chargeCents,
    chargeBasis: terms.chargeBasis,
    shrinkPct,
    excessShrinkPct,
    excessShrinkCents,
    shrinkFactorPctPerPoint: terms.shrinkFactorPctPerPoint,
    shrinkFactorAssumed: terms.shrinkFactorAssumed,
    bundled: terms.bundled,
    totalCents,
  }
  if (totalCents == null) {
    return { buyerCents: null, buyer, reason: 'needs_price', dryCents, depreciationIncluded: includeDepreciation, cheaper: null }
  }
  const diff = dryCents - totalCents
  return {
    buyerCents: totalCents,
    buyer,
    reason: null,
    dryCents,
    depreciationIncluded: includeDepreciation,
    cheaper: Math.abs(diff) < 0.05 ? 'even' : diff < 0 ? 'dry' : 'haul_wet',
  }
}

// ---------- calibrate from records ----------

export type Calibration = {
  /** YOUR consumption per bushel-point, in the fuel's own unit. */
  fuelPerBuPt: number | null
  /** Total bushel-points the records represent. */
  buPoints: number
}

/** Last season's totals → the operation's own per-bu-pt figure:
 *  fuel used ÷ (bushels dried × average points removed). */
export function calibrateFromRecords(args: {
  totalFuel: number
  bushelsDried: number
  avgPointsRemoved: number
}): Calibration {
  const buPoints = args.bushelsDried * args.avgPointsRemoved
  if (!(buPoints > 0) || !(args.totalFuel > 0)) return { fuelPerBuPt: null, buPoints: Math.max(0, buPoints) }
  return { fuelPerBuPt: args.totalFuel / buPoints, buPoints }
}

// ---------- the table ----------

/** Half-point moisture rows from a floor below base up to 28%. Rows below
 *  base are the overdrying rows ("dried to X%"); rows above are incoming
 *  wet grain dried to base. */
export function moistureRows(baseMoisture: number, opts?: { min?: number; max?: number }): number[] {
  const min = opts?.min ?? Math.max(10, Math.floor((baseMoisture - 3) * 2) / 2)
  const max = opts?.max ?? 28
  const out: number[] = []
  for (let m = min; m <= max + 1e-9; m += 0.5) out.push(Math.round(m * 10) / 10)
  return out
}
