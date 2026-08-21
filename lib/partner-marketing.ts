// Pure payload builders for the partner API's lease-projection endpoints
// (072): /marketing-prices and /projected-yields, plus the share-scope gate
// they share. Pure (no I/O) so the response SHAPES are unit-testable — the
// leak-proofing lives here: a marketing-prices record carries ONE aggregate
// price per crop and nothing else (no components, no priced/unpriced split,
// no bushels, no costs), so the tenant's marketing position cannot be
// reconstructed from what leaves the server. The route handlers and the
// farmer-facing /settings/shares preview both call these builders, which is
// what guarantees the farmer sees exactly what the landowner sees.

import { headlineAvgPrice, isCottonCrop, type MarketingRow } from '@/lib/marketing'
import {
  harvestStatusOf,
  practiceOf,
  resolvePracticeBreakout,
  type ExclusionReason,
  type FieldCropAgg,
} from '@/lib/yields'

// ---------------------------------------------------------------------------
// Share-scope gate
// ---------------------------------------------------------------------------

export type ProjectionScope = 'projected_prices' | 'projected_yields'

export type ShareScopeFlags = {
  sharesProjectedPrices: boolean
  sharesProjectedYields: boolean
}

/** The 403 body for a share token whose scope is off, or null when allowed.
 *  A full-org token (share = null) is never gated. The body names the scope
 *  so consumers can show which toggle the farmer would need to turn on. */
export function shareScopeError(
  share: ShareScopeFlags | null,
  scope: ProjectionScope,
): { error: string; code: 'not_in_share_scope'; scope: ProjectionScope } | null {
  if (share == null) return null
  const allowed = scope === 'projected_prices' ? share.sharesProjectedPrices : share.sharesProjectedYields
  if (allowed) return null
  return {
    error:
      scope === 'projected_prices'
        ? 'This share does not include projected prices.'
        : 'This share does not include projected yields.',
    code: 'not_in_share_scope',
    scope,
  }
}

// ---------------------------------------------------------------------------
// Marketing prices — one aggregate number per crop
// ---------------------------------------------------------------------------

export type MarketingPriceRecord = {
  crop: string
  crop_year: number
  /** Grains price in $/bu; cotton in ¢/lb (the marketing rows' native units). */
  unit: 'usd_per_bu' | 'cents_per_lb'
  /** The operation's projected average price — the Marketing dashboard's
   *  headline number (priced production at its prices, unpriced at the
   *  standing assumptions, realized hedge P&L counted once). Null when no
   *  price is computable yet. */
  projected_avg_price: number | null
  /** True once the tenant marked the crop year's physical sales complete —
   *  the price is then the actual final average, no longer a projection. */
  is_final: boolean
  as_of: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function buildMarketingPriceRecords(args: {
  rows: readonly MarketingRow[]
  cropYear: number
  /** crop_year_sales_status rows for the year (missing table ⇒ pass []). */
  salesStatus: ReadonlyArray<{ crop_id: string; physical_sales_complete: boolean }>
  /** Crops the consumer may see (share tokens: crops planted on the share's
   *  fields). Null = no restriction (full-org tokens). */
  allowedCropIds: ReadonlySet<string> | null
  asOf: string
}): MarketingPriceRecord[] {
  const finalByCrop = new Set(
    args.salesStatus.filter((s) => s.physical_sales_complete).map((s) => s.crop_id),
  )
  const out: MarketingPriceRecord[] = []
  for (const row of args.rows) {
    if (args.allowedCropIds != null && !args.allowedCropIds.has(row.cropId)) continue
    const price = headlineAvgPrice(row)
    out.push({
      crop: row.cropName,
      crop_year: args.cropYear,
      unit: row.unit === 'lbs' ? 'cents_per_lb' : 'usd_per_bu',
      projected_avg_price: price != null ? round2(price) : null,
      is_final: finalByCrop.has(row.cropId),
      as_of: args.asOf,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Marketing prices per FARMING entity — the same one-number-per-crop shape,
// keyed by the entity that farms the shared ground
// ---------------------------------------------------------------------------

export type EntityMarketingPriceRecord = MarketingPriceRecord & {
  entity_id: string
  entity_name: string
}

/**
 * One record per (farming entity with shared fields) × (crop planted on that
 * entity's shared fields). The price is the entity's own projected average —
 * the dashboard's headline with that entity selected (own-name marketing
 * whole, agent-held/operation-level positions pro rata by acre share — see
 * lib/entity-marketing.ts). Still ONE aggregate number: no acres, no shares,
 * no components. A crop whose per-entity price isn't computable is omitted
 * rather than guessed (unlike the whole-operation rows, which carry null).
 */
export function buildEntityMarketingPriceRecords(args: {
  entities: ReadonlyArray<{ id: string; name: string; entity_role?: string | null }>
  /** Rows for an entity, computed through the entity attribution seam. */
  rowsForEntity: (entityId: string) => readonly MarketingRow[]
  /** Entity id per shared field (field → farm → entity). Only fields the
   *  consumer may see belong here (share tokens: the share's field set). */
  sharedFieldEntity: ReadonlyMap<string, string | null>
  /** The year's plantings, to find the crops planted on each entity's shared
   *  fields. */
  plantings: ReadonlyArray<{ field_id: string; crop_id: string; season_year: number }>
  cropYear: number
  salesStatus: ReadonlyArray<{ crop_id: string; physical_sales_complete: boolean }>
  asOf: string
}): EntityMarketingPriceRecord[] {
  const finalByCrop = new Set(
    args.salesStatus.filter((s) => s.physical_sales_complete).map((s) => s.crop_id),
  )
  // Crops planted on each entity's SHARED fields this year.
  const cropsByEntity = new Map<string, Set<string>>()
  for (const p of args.plantings) {
    if (p.season_year !== args.cropYear) continue
    const entityId = args.sharedFieldEntity.get(p.field_id)
    if (entityId == null) continue
    let set = cropsByEntity.get(entityId)
    if (!set) cropsByEntity.set(entityId, (set = new Set()))
    set.add(p.crop_id)
  }
  const out: EntityMarketingPriceRecord[] = []
  const entities = [...args.entities]
    .filter((e) => e.entity_role !== 'marketing_agent' && cropsByEntity.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  for (const entity of entities) {
    const allowed = cropsByEntity.get(entity.id)!
    for (const row of args.rowsForEntity(entity.id)) {
      if (!allowed.has(row.cropId)) continue
      const price = headlineAvgPrice(row)
      if (price == null || !Number.isFinite(price)) continue
      out.push({
        entity_id: entity.id,
        entity_name: entity.name,
        crop: row.cropName,
        crop_year: args.cropYear,
        unit: row.unit === 'lbs' ? 'cents_per_lb' : 'usd_per_bu',
        projected_avg_price: round2(price),
        is_final: finalByCrop.has(row.cropId),
        as_of: args.asOf,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Projected yields — per shared field × crop
// ---------------------------------------------------------------------------

export type ProjectedYieldPractice = {
  practice: 'irrigated' | 'dryland'
  acres: number
  yield_per_acre: number
}

export type ProjectedYieldRecord = {
  field_id: string
  field_name: string
  /** The field's operating entity (joins to /fields.entity_id). */
  entity_id: string | null
  crop: string
  crop_year: number
  planted_acres: number
  /** Blended yield over the planting's acres. */
  yield_per_acre: number
  unit: 'bu_per_ac' | 'lbs_per_ac'
  /** 'expected' pre-harvest (crop_assumptions expectation); 'actual' once the
   *  field's harvest is complete and production replaces the expectation. */
  basis: 'expected' | 'actual'
  /** Irrigated/dryland breakout when the planting carries both practices and
   *  the split is knowable; null otherwise. */
  practices: ProjectedYieldPractice[] | null
}

export type ProjectedYieldPlanting = {
  id: string
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number | string | null
  irrigated_acres: number | string | null
  dryland_acres: number | string | null
  irrigated_bushels: number | string | null
  dryland_bushels: number | string | null
  yield_breakout_entered: boolean | null
}

export type ProjectedYieldAssumption = {
  crop_id: string
  crop_year: number
  expected_yield: number | null
  expected_yield_irr: number | null
  expected_yield_dry: number | null
  expected_yield_dc_irr: number | null
  expected_yield_dc_dry: number | null
}

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0)
const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * One record per planting on an allowed field. Expectation mirrors
 * expectedProductionFromBreakout (lib/marketing.ts) one level down — per
 * planting instead of per crop, each practice yield falling back to the
 * blended expected_yield (double-crop variants when the planting is in
 * doubleCropIds) — so the field rows sum exactly to the crop-level expected
 * production the marketing engine uses. A crop×year with no expectation set
 * is omitted (there is nothing to project). Once the planting's harvest is
 * complete AND production is recorded, actuals replace the expectation
 * (the engine's production precedence) and the row flags basis:'actual';
 * the actual practice split comes from resolvePracticeBreakout — the single
 * shared resolver — and is omitted when it can't be derived.
 */
export function buildProjectedYieldRecords(args: {
  cropYear: number
  plantings: readonly ProjectedYieldPlanting[]
  fields: ReadonlyArray<{ id: string; name_or_number: string }>
  crops: ReadonlyArray<{ id: string; name: string }>
  assumptions: readonly ProjectedYieldAssumption[]
  /** Planting ids classified double-crop (lib/plantings.ts buildDoubleCropSet). */
  doubleCropIds: ReadonlySet<string>
  /** fieldCropAggregates output (grain actuals). */
  aggByKey: Map<string, FieldCropAgg>
  /** Lint lbs per field for the year (gin receipts) — cotton actuals. */
  cottonLbsByField: Map<string, number>
  /** analyzeYields exclusions + crop-level harvest_complete keys, for
   *  harvestStatusOf. */
  excluded: Map<string, ExclusionReason>
  cropCompleteKeys: ReadonlySet<string>
  /** Fields the consumer may see (share tokens: the share's field set).
   *  Null = no restriction (full-org tokens). */
  allowedFieldIds: ReadonlySet<string> | null
  /** Operating entity per field (lib/partner-api.ts fieldEntityMap). Absent
   *  ⇒ entity_id null on every row. */
  fieldEntity?: ReadonlyMap<string, string | null>
}): ProjectedYieldRecord[] {
  const fieldById = new Map(args.fields.map((f) => [f.id, f]))
  const entityOf = (fieldId: string) => args.fieldEntity?.get(fieldId) ?? null
  const cropById = new Map(args.crops.map((c) => [c.id, c]))
  const out: ProjectedYieldRecord[] = []

  for (const p of args.plantings) {
    if (p.season_year !== args.cropYear) continue
    if (args.allowedFieldIds != null && !args.allowedFieldIds.has(p.field_id)) continue
    const field = fieldById.get(p.field_id)
    const crop = cropById.get(p.crop_id)
    if (!field || !crop) continue

    const cotton = isCottonCrop(crop.name)
    const plantedAcres = num(p.planted_acres)
    const irrAcres = num(p.irrigated_acres)
    const dryAcres = num(p.dryland_acres)
    const acresBase = plantedAcres > 0 ? plantedAcres : irrAcres + dryAcres
    if (acresBase <= 0) continue

    const agg = args.aggByKey.get(`${p.field_id}|${p.crop_id}|${p.season_year}`)
    const complete = harvestStatusOf(p, args.excluded, args.cropCompleteKeys) === 'complete'
    const actualUnits = cotton ? (args.cottonLbsByField.get(p.field_id) ?? 0) : (agg?.dryBu ?? 0)

    if (complete && actualUnits > 0) {
      // Actual production replaces the expectation (engine precedence).
      let practices: ProjectedYieldPractice[] | null = null
      if (!cotton && practiceOf(p) === 'mixed') {
        const b = resolvePracticeBreakout(p, agg)
        if (b.source != null && b.irrigatedBushels != null && b.drylandBushels != null && irrAcres > 0 && dryAcres > 0) {
          practices = [
            { practice: 'irrigated', acres: irrAcres, yield_per_acre: round1(Number(b.irrigatedBushels) / irrAcres) },
            { practice: 'dryland', acres: dryAcres, yield_per_acre: round1(Number(b.drylandBushels) / dryAcres) },
          ]
        }
      }
      out.push({
        field_id: p.field_id,
        field_name: field.name_or_number,
        entity_id: entityOf(p.field_id),
        crop: crop.name,
        crop_year: args.cropYear,
        planted_acres: acresBase,
        yield_per_acre: round1(actualUnits / acresBase),
        unit: cotton ? 'lbs_per_ac' : 'bu_per_ac',
        basis: 'actual',
        practices,
      })
      continue
    }

    // Pre-harvest expectation from the crop's standing assumptions.
    const a = args.assumptions.find((x) => x.crop_id === p.crop_id && x.crop_year === args.cropYear)
    const blended = a?.expected_yield ?? null
    const dc = args.doubleCropIds.has(p.id)
    const yIrr = (dc ? a?.expected_yield_dc_irr : a?.expected_yield_irr) ?? blended
    const yDry = (dc ? a?.expected_yield_dc_dry : a?.expected_yield_dry) ?? blended
    if (yIrr == null && yDry == null) continue // no expectation set for this crop

    const expectedUnits = (yIrr ?? 0) * irrAcres + (yDry ?? 0) * dryAcres
    const practices: ProjectedYieldPractice[] | null =
      practiceOf(p) === 'mixed'
        ? [
            { practice: 'irrigated', acres: irrAcres, yield_per_acre: round1(yIrr ?? 0) },
            { practice: 'dryland', acres: dryAcres, yield_per_acre: round1(yDry ?? 0) },
          ]
        : null
    out.push({
      field_id: p.field_id,
      field_name: field.name_or_number,
      entity_id: entityOf(p.field_id),
      crop: crop.name,
      crop_year: args.cropYear,
      planted_acres: acresBase,
      yield_per_acre: round1(expectedUnits / acresBase),
      unit: cotton ? 'lbs_per_ac' : 'bu_per_ac',
      basis: 'expected',
      practices,
    })
  }

  return out.sort((x, y) => x.field_name.localeCompare(y.field_name) || x.crop.localeCompare(y.crop))
}
