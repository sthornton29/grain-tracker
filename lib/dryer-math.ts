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
//   * the dry-it-or-haul-it-wet comparison prices "haul it wet" from the
//     buyer's discount schedule (lib/discount-schedules.ts does the tier
//     walk) next to "dry it yourself" = fuel + fan (+ depreciation by default;
//     an owned dryer's depreciation is sunk whether or not this load runs
//     through it, so the marginal decision may prefer it OFF — the toggle) —
//     apples to apples, because the buyer's shrink applies in both worlds.

import {
  factorMeasurement,
  ruleCentsPerBu,
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

export type WetVsDryVerdict = {
  /** The buyer's schedule discount at this moisture, ¢/bu (moisture-measured
   *  factors only — the tier walk runs in code). Null = no applicable rule. */
  buyerCents: number | null
  /** Your own cost of drying those points, ¢/bu — fuel + fan, plus
   *  depreciation unless the toggle excludes it. The buyer's shrink applies
   *  whether you dry or haul wet, so it cancels. */
  dryCents: number
  /** Whether depreciation is inside dryCents (the toggle; default on). */
  depreciationIncluded: boolean
  cheaper: 'dry' | 'haul_wet' | 'even' | null
}

/** `grainPrice` is only used to price a schedule rule written as a percent
 *  of price — never to add shrink to your side. `includeDepreciation`
 *  (default true) keeps the dryer's depreciation on your side; an owned
 *  dryer's depreciation is sunk whether or not this load runs through it,
 *  so for the marginal decision a user may prefer it off. */
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
  let buyerCents: number | null = null
  for (const rule of scheduleRules) {
    if (factorMeasurement(rule.factor) !== 'moisture') continue
    const cents = ruleCentsPerBu(rule, moisture, grainPrice ?? 0)
    if (cents == null) continue
    buyerCents = (buyerCents ?? 0) + cents
  }
  if (buyerCents == null) return { buyerCents, dryCents, depreciationIncluded: includeDepreciation, cheaper: null }
  const diff = dryCents - buyerCents
  return {
    buyerCents,
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
