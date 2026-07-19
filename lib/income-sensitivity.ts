// Income Sensitivity engine — the two-variable (futures price × yield) scenario
// grid behind the Income Sensitivity Report. Pure: callers pass already-fetched
// rows in. Every cell COMPOSES the existing engines rather than re-deriving
// their math:
//   * crop sales revenue  = computeMarketing()'s blended expected revenue, with
//     the scenario production pinned via expectedProductionByCrop and the
//     scenario futures price standing in as the assumed futures on the crop's
//     unpriced bushels. Locked contract/hedge prices, the locked/assumed basis
//     blend, the single-counted realized hedge P&L, and the over-contracting
//     cap all fall out of the engine unchanged.
//   * insurance           = computePolicy() per policy (RP / RP-HPE / YP +
//     SCO/ECO) with the scenario price as the harvest price and the cell's
//     blended yield allocated to each policy's practice. Net of premium.
//   * government payments = a flat caller-supplied $/acre added identically to
//     every cell (payments are decoupled from planted acres, so no per-crop
//     allocation; held constant across cells — they are NOT re-derived from the
//     scenario price).
//
// Yield axis semantics: once harvest has started, bushels from harvest-complete
// fields are FIXED facts and the scenario yield applies only to the remaining
// (unharvested / in-progress) acres:
//   scenario production = fixed harvested bu + scenario yield × remaining acres

import { computeMarketing, type Planting } from '@/lib/marketing'
import type { CottonPhysicalSummary } from '@/lib/cotton-sales'
import {
  computePolicy, policyPremium, scoConfigFrom, ecoConfigFrom, staxConfigFrom, mcoConfigFrom,
  type PolicyInputs, type Practice, type CountyAssumptionLike,
} from '@/lib/crop-insurance'
import { cropToHedgeCommodity } from '@/lib/contracts'
import { analyzeYields, harvestStatusOf, IN_PROGRESS_THRESHOLD, type FieldCropAgg, type HarvestStatus } from '@/lib/yields'
import type {
  Contract, Crop, CropAssumption, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco,
  CropInsuranceStax, CropInsuranceMco,
  FuturesPosition, OptionPosition,
} from '@/lib/types'

// ---------- axes ----------

export type AxisSpec = { center: number; step: number; steps: number }

// The axis values: center ± steps × step, ascending. Non-positive levels are
// dropped (a $0 futures price or negative yield is never a useful scenario).
export function axisValues(spec: AxisSpec): number[] {
  const out: number[] = []
  const steps = Math.max(0, Math.round(spec.steps))
  for (let i = -steps; i <= steps; i++) {
    const v = Math.round((spec.center + i * spec.step) * 1e6) / 1e6
    if (v > 0) out.push(v)
  }
  return out
}

// Sensible default increments per crop. Grains: futures $/bu and yield bu/ac.
// Cotton: the axes are ¢/lb (on CTZ) and lbs of lint/ac, so the steps are
// cotton-sized — 2¢ price moves and 50-lb yield moves. Untraded crops get the
// small-grain defaults.
export function defaultPriceStep(cropName: string | null | undefined): number {
  const c = cropToHedgeCommodity(cropName)
  if (c === 'Cotton') return 2
  return c === 'Soybeans' ? 0.4 : 0.2
}
export function defaultYieldStep(cropName: string | null | undefined): number {
  const c = cropToHedgeCommodity(cropName)
  if (c === 'Cotton') return 50
  return c === 'Corn' ? 10 : 5
}

// Index of the axis value closest to `target` (the "you are here" row/column).
export function closestIndex(values: readonly number[], target: number | null | undefined): number {
  if (target == null || values.length === 0) return -1
  let best = 0
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i
  }
  return best
}

// ---------- harvest split (fixed vs remaining) ----------

export type HarvestSplit = {
  /** Dry bushels from harvest-COMPLETE plantings — fixed in every cell. */
  fixedBu: number
  completedAcres: number
  /** Acres still to sensitize: unharvested + in-progress plantings. */
  remainingAcres: number
  state: 'pre' | 'partial' | 'complete'
}

type SplitPlanting = {
  id: string
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number | string | null
  yield_include_override?: boolean | null
}

// Split each crop's acres into harvested-fact vs still-in-the-field, using the
// same field-level classification as the Yields page (analyzeYields +
// harvestStatusOf). In-progress fields count as REMAINING — their partial
// bushels are replaced by scenario yield × acres, never double-counted.
//
// `aggByKey` MUST already be filtered to the crop year (fieldCropAggregates
// with { cropYear }). Its keys carry the load's CALENDAR year, which can differ
// from season_year (corn hauled out of the field in January), so entries are
// collapsed to field|crop before lookup — no bushels are dropped for spanning
// the calendar boundary.
export function splitHarvestByCrop(args: {
  plantings: readonly SplitPlanting[]
  aggByKey: Map<string, FieldCropAgg>
  cropYear: number
  cropCompleteKeys: ReadonlySet<string>
  now?: Date
}): { byCrop: Map<string, HarvestSplit>; statusByPlanting: Map<string, HarvestStatus> } {
  const aggByFieldCrop = new Map<string, FieldCropAgg>()
  for (const [k, v] of args.aggByKey) {
    const [fieldId, cropId] = k.split('|')
    const ck = `${fieldId}|${cropId}`
    const cur = aggByFieldCrop.get(ck)
    if (cur) {
      cur.dryBu += v.dryBu
      if (v.lastLoadDate != null && (cur.lastLoadDate == null || v.lastLoadDate > cur.lastLoadDate)) cur.lastLoadDate = v.lastLoadDate
    } else {
      aggByFieldCrop.set(ck, { dryBu: v.dryBu, lastLoadDate: v.lastLoadDate })
    }
  }
  const yearPlantings = args.plantings.filter((p) => p.season_year === args.cropYear)
  const analysis = analyzeYields(
    yearPlantings.map((p) => {
      const agg = aggByFieldCrop.get(`${p.field_id}|${p.crop_id}`)
      return {
        id: p.id, cropId: p.crop_id, acres: Number(p.planted_acres ?? 0),
        dryBu: agg?.dryBu ?? 0, lastLoadDate: agg?.lastLoadDate ?? null,
        override: p.yield_include_override ?? null,
      }
    }),
    IN_PROGRESS_THRESHOLD, args.now ?? new Date(),
  )
  const byCrop = new Map<string, HarvestSplit>()
  const statusByPlanting = new Map<string, HarvestStatus>()
  for (const p of yearPlantings) {
    const status = harvestStatusOf(p, analysis.excluded, args.cropCompleteKeys)
    statusByPlanting.set(p.id, status)
    const cur = byCrop.get(p.crop_id) ?? { fixedBu: 0, completedAcres: 0, remainingAcres: 0, state: 'pre' as const }
    const acres = Number(p.planted_acres ?? 0)
    if (status === 'complete') {
      cur.fixedBu += aggByFieldCrop.get(`${p.field_id}|${p.crop_id}`)?.dryBu ?? 0
      cur.completedAcres += acres
    } else {
      cur.remainingAcres += acres
    }
    byCrop.set(p.crop_id, cur)
  }
  const EPS = 0.01
  for (const s of byCrop.values()) {
    s.state = s.remainingAcres <= EPS
      ? (s.fixedBu > 0 ? 'complete' : 'pre')
      : s.fixedBu > 0 ? 'partial' : 'pre'
    // A "complete" crop with no recorded bushels has nothing to hold fixed —
    // treat it as pre-harvest so the yield axis still drives production.
    if (s.state === 'pre' && s.remainingAcres <= EPS) s.remainingAcres = s.completedAcres
  }
  return { byCrop, statusByPlanting }
}

// ---------- scenario cells ----------

export type CropScenarioInputs = {
  crop: Crop
  cropYear: number
  plantedAcres: number
  irrigatedAcres: number
  drylandAcres: number
  /** Dry bushels already in the bin from harvest-complete fields. */
  fixedHarvestedBu: number
  /** Acres the scenario yield applies to (= plantedAcres before any harvest). */
  remainingAcres: number
  /** Pre-filtered to this crop + crop year. */
  contracts: readonly Contract[]
  futures: readonly FuturesPosition[]
  options: readonly OptionPosition[]
  assumption: CropAssumption | undefined
  policies: readonly CropInsurancePolicy[]
  scos: readonly CropInsuranceSco[]
  ecos: readonly CropInsuranceEco[]
  scoTrigger?: number
  /** The RMA FINAL harvest price, once on file. When set, every cell's
   *  insurance uses it instead of the scenario price — post-discovery the
   *  harvest price is a fact, so the price axis moves crop sales only (and
   *  the grid reconciles with the Claims Monitor at the you-are-here cell). */
  finalHarvestPrice?: number | null
  /** Physical cotton marketing summary (cotton crops only). Sold/pool lbs stay
   *  locked at their prices; in-loan lbs FLOOR at the banked CCC loan value —
   *  cells with a scenario ¢/lb below the loan floor flatten there, mirroring
   *  how the RP floor flattens the insurance downside. */
  cottonPhysical?: CottonPhysicalSummary | null
  /** STAX/MCO endorsements (045), keyed to this crop's policies. */
  staxes?: readonly CropInsuranceStax[]
  mcos?: readonly CropInsuranceMco[]
  /** The SHARED county-yield assumption row for this crop (045). */
  countyAssumption?: CountyAssumptionLike | null
  /** County yield scenario mode:
   *  - 'independent' (default): the county estimate is CONSTANT across the
   *    farm-yield axis (RMA expected × (1 + variance)) — the yield axis is the
   *    FARM's yield, and county-triggered legs vary only down the price axis.
   *  - 'with_farm' ("county moves with me", widespread-loss scenario): the
   *    county scales with the cell's blended farm yield, anchored at the axis
   *    center — scenario county = standing estimate × (blended farm yield ÷
   *    expected farm yield). Mid-harvest the blend (fixed + scenario ÷ total
   *    acres) drives the scale, matching how the individual policy blends.
   *  An RMA FINAL county yield on file pins the county either way. */
  countyMode?: 'independent' | 'with_farm'
}

/** The crop's expected blended farm yield (acre-weighted irr/dry breakout,
 *  else the flat expectation) — the anchor for the "moves with me" scale. */
export function expectedBlendedYieldFor(inp: Pick<CropScenarioInputs, 'assumption' | 'irrigatedAcres' | 'drylandAcres'>): number | null {
  const a = inp.assumption
  const blendedExp = a?.expected_yield != null ? Number(a.expected_yield) : null
  const yIrr = a?.expected_yield_irr != null ? Number(a.expected_yield_irr) : blendedExp
  const yDry = a?.expected_yield_dry != null ? Number(a.expected_yield_dry) : blendedExp
  if (yIrr == null || yDry == null) return blendedExp
  const totalAc = inp.irrigatedAcres + inp.drylandAcres
  return totalAc > 0 ? (yIrr * inp.irrigatedAcres + yDry * inp.drylandAcres) / totalAc : blendedExp
}

export type ScenarioCell = {
  price: number
  scenarioYield: number
  /** fixedHarvestedBu + scenarioYield × remainingAcres. */
  production: number
  /** production ÷ plantedAcres — the actual yield the insurance math sees. */
  blendedYield: number
  /** Marketing-engine blended expected revenue at this price/production. */
  cropRevenue: number
  /** Σ per-policy (indemnity − premium) at this price/yield. */
  insuranceNet: number
  /** (cropRevenue + insuranceNet) ÷ plantedAcres + govPerAcre. */
  revenuePerAcre: number
  /** revenuePerAcre − cost/acre; null when no cost is set. */
  profitPerAcre: number | null
}

// Practice-level scenario yield: the blended yield allocated proportionally to
// the expected irr/dry breakout (scale both sides by blended ÷ expected-blend so
// the acre-weighted total re-foots to the blended yield). Without a breakout the
// blended yield applies to both practices.
function practiceYieldFor(inp: CropScenarioInputs, blendedYield: number, practice: Practice): number {
  const a = inp.assumption
  const blendedExp = a?.expected_yield != null ? Number(a.expected_yield) : null
  const yIrr = a?.expected_yield_irr != null ? Number(a.expected_yield_irr) : blendedExp
  const yDry = a?.expected_yield_dry != null ? Number(a.expected_yield_dry) : blendedExp
  if (yIrr == null || yDry == null || yIrr === yDry) return blendedYield
  const totalAc = inp.irrigatedAcres + inp.drylandAcres
  const expectedBlend = totalAc > 0
    ? (yIrr * inp.irrigatedAcres + yDry * inp.drylandAcres) / totalAc
    : blendedExp
  if (expectedBlend == null || expectedBlend <= 0) return blendedYield
  const scale = blendedYield / expectedBlend
  return (practice === 'irrigated' ? yIrr : yDry) * scale
}

export function computeScenarioCell(
  inp: CropScenarioInputs,
  scenarioPrice: number,
  scenarioYield: number,
  opts?: { govPerAcre?: number },
): ScenarioCell {
  const production = inp.fixedHarvestedBu + scenarioYield * inp.remainingAcres
  const blendedYield = inp.plantedAcres > 0 ? production / inp.plantedAcres : 0

  // Crop sales: the marketing engine with (a) production pinned to the scenario
  // and (b) the scenario price standing in as the assumed futures, so unpriced
  // bushels re-price while locked contracts/hedges keep their locked prices.
  const baseAssumption: CropAssumption = inp.assumption ?? {
    id: '', crop_id: inp.crop.id, crop_year: inp.cropYear,
    expected_yield: null, expected_yield_irr: null, expected_yield_dry: null,
    expected_yield_dc_irr: null, expected_yield_dc_dry: null,
    harvest_complete: false, assumed_basis: 0, assumed_futures: null,
    cost_per_acre: null, cost_per_acre_irr: null, cost_per_acre_dry: null,
    cost_per_acre_dc_irr: null, cost_per_acre_dc_dry: null,
    notes: null, created_at: '', updated_at: '',
  }
  const scenarioAssumption: CropAssumption = {
    ...baseAssumption, harvest_complete: false, assumed_futures: scenarioPrice,
  }
  const plantings: Planting[] = [{ crop_id: inp.crop.id, season_year: inp.cropYear, planted_acres: inp.plantedAcres }]
  const row = computeMarketing({
    cropYear: inp.cropYear,
    crops: [inp.crop],
    plantings,
    contracts: [...inp.contracts],
    futures: [...inp.futures],
    options: [...inp.options],
    assumptions: [scenarioAssumption],
    actualProductionByCrop: new Map(),
    expectedProductionByCrop: new Map([[inp.crop.id, production]]),
    cottonPhysicalByCrop: inp.cottonPhysical ? new Map([[inp.crop.id, inp.cottonPhysical]]) : undefined,
  })[0]
  const cropRevenue = row?.blendedRevenue ?? 0

  // Insurance: every policy re-run at the scenario harvest price (the RMA
  // final instead, once on file) and the cell's practice-allocated yield, net
  // of premium. No indemnity math lives here.
  const insuranceHarvestPrice = inp.finalHarvestPrice ?? scenarioPrice
  const scoBy = new Map(inp.scos.map((s) => [s.policy_id, s]))
  const ecoBy = new Map(inp.ecos.map((e) => [e.policy_id, e]))
  const staxBy = new Map((inp.staxes ?? []).map((s) => [s.policy_id, s]))
  const mcoBy = new Map((inp.mcos ?? []).map((m) => [m.policy_id, m]))
  // County scenario scale: 'with_farm' anchors at the axis center — the county
  // moves proportionally with the cell's blended farm yield relative to
  // expected. An RMA final county yield pins the county regardless (the
  // resolve helper ignores the scale when final), so the scale is moot then.
  const expectedBlend = expectedBlendedYieldFor(inp)
  const countyScale = inp.countyMode === 'with_farm' && expectedBlend != null && expectedBlend > 0
    ? blendedYield / expectedBlend
    : 1
  let insuranceNet = 0
  for (const p of inp.policies) {
    const practice = (p.practice ?? 'non_irrigated') as Practice
    const base: PolicyInputs = {
      planType: p.plan_type,
      coverageLevel: Number(p.coverage_level),
      aphYield: Number(p.aph_yield),
      projectedPrice: Number(p.projected_price),
      harvestPrice: insuranceHarvestPrice,
      insuredAcres: Number(p.insured_acres),
      actualYield: practiceYieldFor(inp, blendedYield, practice),
      expectedCountyYield: p.expected_county_yield == null ? null : Number(p.expected_county_yield),
      expectedCountyRevenue: p.expected_county_revenue == null ? null : Number(p.expected_county_revenue),
      protectionFactor: p.protection_factor == null ? null : Number(p.protection_factor),
    }
    const comp = computePolicy({
      base,
      basePremium: policyPremium(p),
      sco: scoConfigFrom(scoBy.get(p.id)),
      eco: ecoConfigFrom(ecoBy.get(p.id)),
      stax: staxConfigFrom(staxBy.get(p.id)),
      mco: mcoConfigFrom(mcoBy.get(p.id)),
      scoTriggerDefault: inp.scoTrigger,
      county: { assumption: inp.countyAssumption ?? null, scale: countyScale },
    })
    insuranceNet += comp.netPnl
  }

  const govPerAcre = opts?.govPerAcre ?? 0
  const revenuePerAcre = (inp.plantedAcres > 0 ? (cropRevenue + insuranceNet) / inp.plantedAcres : 0) + govPerAcre
  const costPerAcre = inp.assumption?.cost_per_acre != null ? Number(inp.assumption.cost_per_acre) : null
  return {
    price: scenarioPrice,
    scenarioYield,
    production,
    blendedYield,
    cropRevenue,
    insuranceNet,
    revenuePerAcre,
    profitPerAcre: costPerAcre != null ? revenuePerAcre - costPerAcre : null,
  }
}

// The full grid: one row per price level, one column per yield level.
export function buildScenarioGrid(
  inp: CropScenarioInputs,
  priceValues: readonly number[],
  yieldValues: readonly number[],
  opts?: { govPerAcre?: number },
): ScenarioCell[][] {
  return priceValues.map((price) => yieldValues.map((y) => computeScenarioCell(inp, price, y, opts)))
}

// The flat government-payment allocation: one $/acre across ALL planted acres,
// added identically to every crop's cells (payments are decoupled from what's
// planted, so no per-commodity allocation).
export function flatGovPerAcre(totalGovPayments: number, totalPlantedAcres: number): number {
  return totalPlantedAcres > 0 ? totalGovPayments / totalPlantedAcres : 0
}
