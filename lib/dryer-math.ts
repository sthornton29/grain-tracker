// Grain Dryer Math — the /reports/dryer-math calculator's pure engine.
// Everything here is unit-tested with hand-worked numbers.
//
// Units and conventions:
//   * consumption is per BUSHEL-POINT (one bushel dried one moisture point),
//     stored in the fuel's OWN unit — gal for LP, ccf (100 cf) for NG —
//     converted between fuels by BTU parity: propane 91,500 BTU/gal, natural
//     gas 1,020 BTU/cf (1 gal LP ≈ 89.7 cf ≈ 0.897 ccf);
//   * shrink is the PHYSICAL weight loss of removing water, at the standard
//     1.183%/point handling-free shrink factor, valued at the grain price —
//     shown separately so total cost of drying = fuel (+ fan) + shrink;
//   * overdrying (below the crop's base moisture) costs lost sellable volume
//     (the same 1.183%/pt × price) PLUS the fuel spent removing points
//     nobody pays for;
//   * the underdrying comparison prices "haul it wet" from the buyer's
//     discount schedule (lib/discount-schedules.ts does the tier walk) next
//     to "dry it yourself."

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

export type FuelPrices = {
  /** $/gal for LP, $/ccf for NG — whichever matches the dryer's fuel. */
  fuelPrice: number
  /** $/kWh (DEFAULT_ELECTRIC_RATE when omitted). */
  electricRate?: number | null
}

/** Energy cost per bushel-POINT: fuel + fan electricity, $/bu-pt. */
export function energyCostPerBuPt(dryer: DryerSpec, prices: FuelPrices): number {
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
  /** Physical shrink: weight lost drying to base, % of the wet weight. */
  shrinkPct: number
  /** That shrink valued at the grain price, $/bu. */
  shrinkValuePerBu: number
  /** energy + shrink — the whole cost of taking the water out, $/bu. */
  totalPerBu: number
}

/** Cost of drying from `moisture` down to `baseMoisture` (0 points when
 *  already at/below base). */
export function dryingCost(
  moisture: number,
  baseMoisture: number,
  dryer: DryerSpec,
  prices: FuelPrices,
  grainPrice: number,
): DryingCost {
  const points = Math.max(0, moisture - baseMoisture)
  const fuelPerBu = points * dryer.fuelPerBuPt * prices.fuelPrice
  const fanPerBu = points * (dryer.fanKwhPerBuPt ?? 0) * (prices.electricRate ?? DEFAULT_ELECTRIC_RATE)
  const energyPerBu = fuelPerBu + fanPerBu
  const shrinkPct = points * SHRINK_PCT_PER_POINT
  const shrinkValuePerBu = (shrinkPct / 100) * grainPrice
  return {
    points,
    fuelPerBu,
    fanPerBu,
    energyPerBu,
    energyPerBuPt: energyCostPerBuPt(dryer, prices),
    shrinkPct,
    shrinkValuePerBu,
    totalPerBu: energyPerBu + shrinkValuePerBu,
  }
}

export type OverdryingCost = {
  /** Points dried BELOW base. */
  pointsOver: number
  /** Sellable volume given away: pointsOver × 1.183% × price, $/bu. */
  lostVolumePerBu: number
  /** The fuel + fan spent removing those unpaid points, $/bu. */
  extraEnergyPerBu: number
  /** The combined cost of overdrying, $/bu. */
  totalPerBu: number
}

/** What stopping BELOW base costs: drying to `finalMoisture` < base gives
 *  away weight nobody pays for AND burns fuel doing it. */
export function overdryingCost(
  finalMoisture: number,
  baseMoisture: number,
  dryer: DryerSpec,
  prices: FuelPrices,
  grainPrice: number,
): OverdryingCost {
  const pointsOver = Math.max(0, baseMoisture - finalMoisture)
  const lostVolumePerBu = pointsOver * (SHRINK_PCT_PER_POINT / 100) * grainPrice
  const extraEnergyPerBu = pointsOver * energyCostPerBuPt(dryer, prices)
  return { pointsOver, lostVolumePerBu, extraEnergyPerBu, totalPerBu: lostVolumePerBu + extraEnergyPerBu }
}

// ---------- the "dry it or haul it wet" comparison ----------

export type WetVsDryVerdict = {
  /** The buyer's schedule discount at this moisture, ¢/bu (moisture-measured
   *  factors only — the tier walk runs in code). Null = no applicable rule. */
  buyerCents: number | null
  /** Your own total cost of drying those points, ¢/bu (energy + shrink). */
  dryCents: number
  cheaper: 'dry' | 'haul_wet' | 'even' | null
}

export function wetVsDry(
  moisture: number,
  baseMoisture: number,
  dryer: DryerSpec,
  prices: FuelPrices,
  grainPrice: number,
  scheduleRules: ReadonlyArray<ScheduleRuleShape>,
): WetVsDryVerdict {
  const own = dryingCost(moisture, baseMoisture, dryer, prices, grainPrice)
  const dryCents = own.totalPerBu * 100
  let buyerCents: number | null = null
  for (const rule of scheduleRules) {
    if (factorMeasurement(rule.factor) !== 'moisture') continue
    const cents = ruleCentsPerBu(rule, moisture, grainPrice)
    if (cents == null) continue
    buyerCents = (buyerCents ?? 0) + cents
  }
  if (buyerCents == null) return { buyerCents, dryCents, cheaper: null }
  const diff = dryCents - buyerCents
  return {
    buyerCents,
    dryCents,
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
