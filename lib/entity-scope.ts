// Shared entity scoping for the financial reports — the ONE interpretation of
// "entity selected" (Season Summary, Marketing, Revenue Projections, Income
// Sensitivity, Cash Flow), so the pages can't diverge and the Revenue-
// Projections − Marketing reconciliation identity survives filtering.
//
// What narrows to the entity:
//   * acreage / plantings / production — fields on farms with farms.entity_id =
//     the selected entity (and their loads/yields, via the field-keyed
//     aggregates);
//   * crop insurance policies — rows whose OWN entity_id matches (policies are
//     genuinely carried per entity);
//   * contracts / futures / options — via attribution() below. Grain contracts
//     are NOT reliably entity-keyed in this operation (the contract form's
//     entity is optional and most rows are null), so a null-entity contract is
//     OPERATION-LEVEL: it prices the operation's grain, and under an entity
//     filter it attributes pro-rata by the entity's share of that crop's
//     planted acres for the contract's crop year (same bushel prices — only
//     the bushels scale). A contract that DOES carry an entity_id counts
//     wholly toward that entity and never enters the pro-rata pool. Dropping
//     null-entity rows (the old strict rule) zeroed out every filtered
//     entity's sales while production stayed — huge false losses;
//   * government payments — ARC/PLC by the farm's entity; other USDA payments
//     by their farm's entity when farm-linked, else their own entity_id (the
//     Payment Tracker's attribution).
//
// What does NOT narrow: the operation-wide assumptions (per-category yields &
// costs, assumed basis/futures). Those are entered once for the whole operation
// and flow down unchanged — the scope only narrows the acres/production/
// policies/payments they are applied to. There is no per-entity assumption
// store and none should be created.
//
// With entityId === '' (All entities) every filter is the identity function, so
// the unfiltered numbers are structurally guaranteed to match today's.

import { cropToHedgeCommodity } from '@/lib/contracts'
import type { CottonPhysicalInputs } from '@/lib/cotton-sales'

// Attribution of marketing positions (contracts / futures / options) to an
// entity. Built from the plantings + crops the caller already has:
//   * a row whose entity_id matches the scope counts WHOLE;
//   * a row keyed to a DIFFERENT entity is dropped;
//   * a null-entity row is operation-level and scales by the entity's share of
//     the crop's (or hedge commodity's) planted acres for that crop year —
//     prices per bushel are untouched, so the entity view shows the same avg
//     price / buildup as the all-entities report, and the per-entity bushels
//     sum back to the operation total.
// With no active filter every method is an exact pass-through.
export type EntityAttribution = {
  /** Entity share (0..1) of a crop's planted acres for a crop year. */
  shareForCrop(cropId: string | null, cropYear: number | null): number
  /** Same, aggregated across the crops that hedge in this commodity. */
  shareForCommodity(commodity: string | null, cropYear: number | null): number
  /** The factor a contract's bushels/dollars carry under this filter:
   *  1 (own entity or unfiltered), 0 (other entity / no acreage), or the
   *  pro-rata acre share (operation-level row). */
  shareForContract(c: { entity_id: string | null; crop_id: string | null; crop_year: number | null }): number
  contracts<T extends { entity_id: string | null; crop_id: string | null; crop_year: number | null; contracted_bushels: number | string }>(rows: readonly T[]): T[]
  futures<T extends { entity_id: string | null; commodity: string; crop_year: number; num_contracts: number; realized_pnl: number | null; commission: number }>(rows: readonly T[]): T[]
  options<T extends { entity_id: string | null; commodity: string; crop_year: number; num_contracts: number; realized_pnl: number | null; premium_total: number }>(rows: readonly T[]): T[]
}

export type EntityScope = {
  entityId: string
  /** False for '' (All entities) — every method is then a pass-through. */
  active: boolean
  /** Fields on the entity's farms; null when inactive (= no field filter). */
  fieldIds: ReadonlySet<string> | null
  /** The entity's farms; null when inactive. */
  farmIds: ReadonlySet<string> | null
  /** Field-keyed rows (plantings, load splits): keep the entity's fields. */
  plantings<T extends { field_id: string }>(rows: readonly T[]): T[]
  /** Strictly entity-keyed rows (insurance policies, cotton marketing rows):
   *  own entity_id match. NOT for grain contracts/futures/options — those are
   *  often operation-level (null entity) and go through attribution(). */
  byEntity<T extends { entity_id: string | null }>(rows: readonly T[]): T[]
  /** Marketing-position attribution (contracts / futures / options) — see
   *  EntityAttribution. Pass the SAME plantings/crops the report computes
   *  acreage from, so shares line up with the acres on screen. */
  attribution(args: {
    plantings: ReadonlyArray<{ field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null }>
    crops: ReadonlyArray<{ id: string; name: string }>
  }): EntityAttribution
  /** Farm-keyed rows (base acres, elections, stored ARC/PLC payments). */
  byFarm<T extends { farm_id: string }>(rows: readonly T[]): T[]
  /** True when the farm belongs to the entity (projected-payment filtering). */
  farmInEntity(farmId: string | null | undefined): boolean
  /** Other USDA payments: farm's entity when farm-linked, else entity_id. */
  otherPayments<T extends { entity_id: string | null; farm_id: string | null }>(rows: readonly T[]): T[]
  /** Filter a `${fieldId}|…`-keyed aggregate map (fieldCropAggregates output)
   *  down to the entity's fields. */
  fieldAgg<V>(agg: ReadonlyMap<string, V>): Map<string, V>
  /** Gin receipts: own entity_id, else farm's entity, else field→farm entity. */
  ginReceipts<T extends { entity_id: string | null; farm_id: string | null; field_id: string | null }>(rows: readonly T[]): T[]
  /** Physical-cotton marketing inputs: the four entity-keyed row sets narrow;
   *  bales/grades/dispositions ride along (they scope via the receipts above). */
  cottonInputs(inputs: CottonPhysicalInputs): CottonPhysicalInputs
}

export function buildEntityScope(args: {
  entityId: string
  farms: ReadonlyArray<{ id: string; entity_id: string | null }>
  fields?: ReadonlyArray<{ id: string; farm_id: string | null }>
}): EntityScope {
  const { entityId, farms, fields = [] } = args
  const active = entityId !== ''

  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const farmIds = active
    ? new Set(farms.filter((f) => f.entity_id === entityId).map((f) => f.id))
    : null
  const fieldIds = active
    ? new Set(fields.filter((f) => f.farm_id != null && farmIds!.has(f.farm_id)).map((f) => f.id))
    : null

  const farmInEntity = (farmId: string | null | undefined): boolean =>
    !active || (farmId != null && farmIds!.has(farmId))

  function attribution(args: {
    plantings: ReadonlyArray<{ field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null }>
    crops: ReadonlyArray<{ id: string; name: string }>
  }): EntityAttribution {
    // Acres per crop|year and commodity|year — total vs on the entity's fields.
    const totalByCrop = new Map<string, number>()
    const mineByCrop = new Map<string, number>()
    const totalByCommodity = new Map<string, number>()
    const mineByCommodity = new Map<string, number>()
    if (active) {
      const commodityByCrop = new Map(args.crops.map((c) => [c.id, cropToHedgeCommodity(c.name)]))
      for (const p of args.plantings) {
        const acres = Number(p.planted_acres ?? 0) || 0
        if (acres <= 0) continue
        const cropKey = `${p.crop_id}|${p.season_year}`
        totalByCrop.set(cropKey, (totalByCrop.get(cropKey) ?? 0) + acres)
        const commodity = commodityByCrop.get(p.crop_id)
        const commodityKey = commodity ? `${commodity}|${p.season_year}` : null
        if (commodityKey) totalByCommodity.set(commodityKey, (totalByCommodity.get(commodityKey) ?? 0) + acres)
        if (fieldIds!.has(p.field_id)) {
          mineByCrop.set(cropKey, (mineByCrop.get(cropKey) ?? 0) + acres)
          if (commodityKey) mineByCommodity.set(commodityKey, (mineByCommodity.get(commodityKey) ?? 0) + acres)
        }
      }
    }
    const shareOf = (mine: Map<string, number>, total: Map<string, number>, key: string | null): number => {
      if (!active) return 1
      if (key == null) return 0
      const t = total.get(key) ?? 0
      return t > 0 ? (mine.get(key) ?? 0) / t : 0
    }
    const shareForCrop = (cropId: string | null, cropYear: number | null) =>
      shareOf(mineByCrop, totalByCrop, cropId != null && cropYear != null ? `${cropId}|${cropYear}` : null)
    const shareForCommodity = (commodity: string | null, cropYear: number | null) =>
      shareOf(mineByCommodity, totalByCommodity, commodity != null && cropYear != null ? `${commodity}|${cropYear}` : null)
    // Explicitly-keyed rows: whole for the own entity, gone for another's.
    // Operation-level (null entity) rows: the pro-rata acre share.
    const factor = (rowEntity: string | null, share: () => number): number => {
      if (!active) return 1
      if (rowEntity != null) return rowEntity === entityId ? 1 : 0
      return share()
    }
    return {
      shareForCrop,
      shareForCommodity,
      shareForContract: (c) => factor(c.entity_id, () => shareForCrop(c.crop_id, c.crop_year)),
      contracts: (rows) => {
        if (!active) return [...rows]
        const out: typeof rows[number][] = []
        for (const c of rows) {
          const f = factor(c.entity_id, () => shareForCrop(c.crop_id, c.crop_year))
          if (f <= 0) continue
          out.push(f === 1 ? c : { ...c, contracted_bushels: Number(c.contracted_bushels ?? 0) * f })
        }
        return out
      },
      futures: (rows) => {
        if (!active) return [...rows]
        const out: typeof rows[number][] = []
        for (const p of rows) {
          const f = factor(p.entity_id, () => shareForCommodity(p.commodity, p.crop_year))
          if (f <= 0) continue
          out.push(f === 1 ? p : {
            ...p,
            num_contracts: Number(p.num_contracts) * f,
            realized_pnl: p.realized_pnl != null ? Number(p.realized_pnl) * f : null,
            commission: Number(p.commission ?? 0) * f,
          })
        }
        return out
      },
      options: (rows) => {
        if (!active) return [...rows]
        const out: typeof rows[number][] = []
        for (const o of rows) {
          const f = factor(o.entity_id, () => shareForCommodity(o.commodity, o.crop_year))
          if (f <= 0) continue
          out.push(f === 1 ? o : {
            ...o,
            num_contracts: Number(o.num_contracts) * f,
            realized_pnl: o.realized_pnl != null ? Number(o.realized_pnl) * f : null,
            premium_total: Number(o.premium_total ?? 0) * f,
          })
        }
        return out
      },
    }
  }

  return {
    entityId,
    active,
    fieldIds,
    farmIds,
    plantings: (rows) => (active ? rows.filter((r) => fieldIds!.has(r.field_id)) : [...rows]),
    byEntity: (rows) => (active ? rows.filter((r) => r.entity_id === entityId) : [...rows]),
    attribution,
    byFarm: (rows) => (active ? rows.filter((r) => farmIds!.has(r.farm_id)) : [...rows]),
    farmInEntity,
    otherPayments: (rows) =>
      active
        ? rows.filter((r) => (r.farm_id != null ? farmEntity.get(r.farm_id) === entityId : r.entity_id === entityId))
        : [...rows],
    fieldAgg: <V,>(agg: ReadonlyMap<string, V>) => {
      if (!active) return new Map(agg)
      const out = new Map<string, V>()
      for (const [key, v] of agg) if (fieldIds!.has(key.split('|')[0])) out.set(key, v)
      return out
    },
    ginReceipts: (rows) =>
      active
        ? rows.filter((r) => {
            if (r.entity_id != null) return r.entity_id === entityId
            if (r.farm_id != null) return farmEntity.get(r.farm_id) === entityId
            if (r.field_id != null) return fieldIds!.has(r.field_id)
            return false
          })
        : [...rows],
    cottonInputs: (inputs) =>
      active
        ? {
            ...inputs,
            contracts: inputs.contracts.filter((c) => c.entity_id === entityId),
            loans: inputs.loans.filter((l) => l.entity_id === entityId),
            ldps: inputs.ldps.filter((l) => l.entity_id === entityId),
            fees: inputs.fees.filter((f) => f.entity_id === entityId),
          }
        : inputs,
  }
}
