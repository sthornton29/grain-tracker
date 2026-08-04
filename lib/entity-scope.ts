// Shared entity scoping for the financial reports — the ONE interpretation of
// "entity selected" (Season Summary, Marketing, Revenue Projections, Income
// Sensitivity, Cash Flow), so the pages can't diverge and the Revenue-
// Projections − Marketing reconciliation identity survives filtering.
//
// What narrows to the entity:
//   * acreage / plantings / production — fields on farms with farms.entity_id =
//     the selected entity (and their loads/yields, via the field-keyed
//     aggregates);
//   * crop insurance policies, contracts, futures/options — rows whose OWN
//     entity_id matches (rows with no entity_id drop out under a filter, the
//     same strict rule the Contracts page and Hedging Summary already use);
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

import type { CottonPhysicalInputs } from '@/lib/cotton-sales'

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
  /** Entity-keyed rows (contracts, futures, options, insurance policies,
   *  cotton marketing rows): strict entity_id match. */
  byEntity<T extends { entity_id: string | null }>(rows: readonly T[]): T[]
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

  return {
    entityId,
    active,
    fieldIds,
    farmIds,
    plantings: (rows) => (active ? rows.filter((r) => fieldIds!.has(r.field_id)) : [...rows]),
    byEntity: (rows) => (active ? rows.filter((r) => r.entity_id === entityId) : [...rows]),
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
