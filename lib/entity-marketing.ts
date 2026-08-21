// Per-entity marketing rows for the partner API — the Marketing dashboard's
// entity filter, run server-side for ONE farming entity at a time. Pure (no
// I/O): lib/marketing-inputs.ts assembles EntityMarketingInputs once for the
// operation and this module re-attributes them per entity through the SAME
// seam the reports use (lib/entity-scope.ts): the entity's fields narrow the
// plantings / field aggregates / gin receipts; contracts, hedges, and physical
// cotton attribute through scope.attribution (own-name rows whole, marketing-
// agent-held and null-entity rows pro rata by the entity's acre share); the
// operation-wide assumptions and quotes flow down unchanged. The composition
// mirrors app/reports/marketing/page.tsx step for step so the per-entity
// headline equals the number the farmer sees with that entity selected —
// lib/partner-marketing.test.ts asserts that to the cent.

import {
  computeMarketing,
  expectedProductionFromBreakout,
  isCottonCrop,
  segmentAcresByCrop,
  type MarketingRow,
} from '@/lib/marketing'
import { buildEntityScope } from '@/lib/entity-scope'
import { cropsWithCompleteHarvest, type FieldCropAgg } from '@/lib/yields'
import type { CottonPhysicalInputs, CottonPhysicalSummary } from '@/lib/cotton-sales'
import type { Contract, Crop, CropAssumption, FieldPlanting, FuturesPosition, OptionPosition } from '@/lib/types'

export type EntityMarketingInputs = {
  cropYear: number
  crops: readonly Crop[]
  /** The crop year's plantings (unscoped). */
  plantings: readonly FieldPlanting[]
  fields: ReadonlyArray<{ id: string; farm_id: string | null }>
  farms: ReadonlyArray<{ id: string; entity_id: string | null }>
  entities: ReadonlyArray<{ id: string; name: string; entity_role: string | null }>
  contracts: readonly Contract[]
  futures: readonly FuturesPosition[]
  options: readonly OptionPosition[]
  /** The crop year's assumptions (operation-wide — never per entity). */
  assumptions: readonly CropAssumption[]
  doubleCropIds: ReadonlySet<string>
  /** fieldCropAggregates output for the year (unscoped). */
  aggByKey: ReadonlyMap<string, FieldCropAgg>
  ginReceipts: ReadonlyArray<{
    id: string
    field_id: string | null
    farm_id: string | null
    entity_id: string | null
    total_bale_weight: number | string | null
    bales_count: number | null
  }>
  cottonBales: ReadonlyArray<{ gin_receipt_id: string; net_weight_lbs: number | null }>
  /** Physical cotton marketing inputs (044); null when none exist. */
  cottonPhysicalInputs: CottonPhysicalInputs | null
  currentFuturesByCrop: ReadonlyMap<string, number>
}

const num = (v: unknown) => Number(v) || 0

/** The marketing rows for one entity — what the dashboard shows with that
 *  entity selected in its filter. */
export function computeEntityMarketingRows(inputs: EntityMarketingInputs, entityId: string): MarketingRow[] {
  const { cropYear, crops } = inputs
  const scope = buildEntityScope({ entityId, farms: inputs.farms, fields: inputs.fields, entities: inputs.entities })
  const scopedPlantings = scope.plantings(inputs.plantings)
  const attribution = scope.attribution({ plantings: inputs.plantings, crops })
  const scopedContracts = attribution.contracts(inputs.contracts)
  const scopedFutures = attribution.futures(inputs.futures)
  const scopedOptions = attribution.options(inputs.options)

  const segByCrop = segmentAcresByCrop(scopedPlantings, cropYear, new Set(inputs.doubleCropIds))
  const expectedProductionByCrop = expectedProductionFromBreakout(segByCrop, [...inputs.assumptions], cropYear)

  const aggByKey = scope.fieldAgg(inputs.aggByKey)
  const actualProductionByCrop = new Map<string, number>()
  for (const [key, agg] of aggByKey) {
    const cropId = key.split('|')[1]
    if (cropId) actualProductionByCrop.set(cropId, (actualProductionByCrop.get(cropId) ?? 0) + agg.dryBu)
  }

  const cropCompleteKeys = new Set<string>()
  for (const a of inputs.assumptions) if (a.harvest_complete) cropCompleteKeys.add(`${a.crop_id}|${a.crop_year}`)
  const harvestCompleteCropIds = cropsWithCompleteHarvest({ plantings: scopedPlantings, aggByKey, cropYear, cropCompleteKeys })

  // Cotton actuals from the entity's gin receipts (per-bale weights first).
  const balesByReceipt = new Map<string, { lbs: number; count: number }>()
  for (const b of inputs.cottonBales) {
    const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    g.lbs += num(b.net_weight_lbs)
    g.count += 1
    balesByReceipt.set(b.gin_receipt_id, g)
  }
  let lintLbs = 0
  let baleCount = 0
  for (const r of scope.ginReceipts(inputs.ginReceipts)) {
    const fromBales = balesByReceipt.get(r.id)
    lintLbs += fromBales && fromBales.lbs > 0 ? fromBales.lbs : num(r.total_bale_weight)
    baleCount += fromBales && fromBales.count > 0 ? fromBales.count : num(r.bales_count)
  }
  const cottonProductionByCrop = new Map<string, { lintLbs: number; bales: number }>()
  const cottonPhysicalByCrop = new Map<string, CottonPhysicalSummary>()
  const cottonSummary = inputs.cottonPhysicalInputs ? attribution.cottonSummary(inputs.cottonPhysicalInputs) : null
  for (const c of crops) {
    if (!isCottonCrop(c.name)) continue
    cottonProductionByCrop.set(c.id, { lintLbs, bales: baleCount })
    if (cottonSummary) cottonPhysicalByCrop.set(c.id, cottonSummary)
  }

  return computeMarketing({
    cropYear,
    crops: [...crops],
    plantings: scopedPlantings.map((p) => ({ crop_id: p.crop_id, season_year: p.season_year, planted_acres: p.planted_acres })),
    contracts: scopedContracts,
    futures: scopedFutures,
    options: scopedOptions,
    assumptions: [...inputs.assumptions],
    actualProductionByCrop,
    expectedProductionByCrop,
    currentFuturesByCrop: new Map(inputs.currentFuturesByCrop),
    harvestCompleteCropIds,
    cottonProductionByCrop,
    cottonPhysicalByCrop,
  })
}
