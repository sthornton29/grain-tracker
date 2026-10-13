// Spot contracts + price-later pools from a page's raw rows — the PURE half
// of the assembly every marketing consumer shares (094, 2026-10-13).
//
// The reports (Marketing, Revenue Projections, Income Sensitivity, Cash Flow),
// the partner API's marketing inputs and Ask Turnrow all hold the same raw
// rows — loads with their crop bases, load_sales, load_splits, entities,
// fields, farms — and all need the same two virtual things built from them:
// the spot contracts (one per crop × year, held by the marketing agent) and
// the price-later pools. This module turns those rows into the builders'
// inputs ONE way, so a split load's spot share, a bin load's missing field and
// an org without a marketing agent are handled identically everywhere.
// lib/spot-contracts-server.ts fetches the rows; client pages hand in what
// they already loaded. Tested in lib/spot-contracts-server.test.ts.

import { computeBushels } from '@/lib/shrink'
import type { LoadSale } from '@/lib/load-sales'
import { spotSummary } from '@/lib/spot-price'
import {
  buildPriceLaterPools,
  buildSpotContracts,
  withSpotContracts,
  type PriceLaterPool,
  type SaleSourceLoad,
  type VirtualSpotContract,
} from '@/lib/virtual-contracts'
import type { Contract } from '@/lib/types'

/** The columns a load needs to become a SaleSourceLoad (every consumer's
 *  loads select carries at least these). */
export type SpotLoadRecord = {
  id: string
  date?: string | null
  crop_id: string | null
  crop_year: number | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  from_type?: string | null
  from_field_id?: string | null
  to_type?: string | null
  to_buyer_id?: string | null
  contract_id?: string | null
  ticket_number?: string | null
  buyer_ticket_number?: string | null
}

export const SPOT_LOAD_SELECT =
  'id, date, crop_id, crop_year, net_weight, moisture, dry_bushels_override, from_type, from_field_id, to_type, to_buyer_id, contract_id, ticket_number, buyer_ticket_number'

export type CropBases = { id: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null }

/** Dry bushels with the LOAD's crop bases — the same computeBushels the
 *  contracts page and the load form use, so a sale row's bushels reconcile
 *  to its load everywhere. */
export function loadDryBushels(load: SpotLoadRecord, crop: CropBases | null | undefined): number {
  return computeBushels({
    netWeightLb: load.net_weight,
    moisturePct: load.moisture,
    baseMoisturePct: crop?.base_moisture_pct ?? null,
    baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: load.dry_bushels_override,
  }).dryBushels ?? 0
}

/** Loads → the virtual builders' input (only loads that went to a buyer carry
 *  a sale; bin loads are kept out so an unassigned count never includes them). */
export function toSaleSourceLoads(loads: ReadonlyArray<SpotLoadRecord>, crops: ReadonlyArray<CropBases>): SaleSourceLoad[] {
  const cropById = new Map(crops.map((c) => [c.id, c]))
  const out: SaleSourceLoad[] = []
  for (const l of loads) {
    if (l.to_type !== 'buyer') continue
    out.push({
      id: l.id,
      contract_id: l.contract_id ?? null,
      to_type: 'buyer',
      dryBu: loadDryBushels(l, l.crop_id ? cropById.get(l.crop_id) : null),
      crop_id: l.crop_id,
      crop_year: l.crop_year,
      to_buyer_id: l.to_buyer_id ?? null,
      date: l.date ?? null,
      from_field_id: l.from_field_id ?? null,
      from_type: l.from_type === 'field' || l.from_type === 'bin' ? l.from_type : null,
      ticket_number: l.ticket_number ?? null,
      buyer_ticket_number: l.buyer_ticket_number ?? null,
    })
  }
  return out
}

/** The org's marketing-agent entity (051) — spot is held there. Null when
 *  the org has none (spot then attributes by source field). */
export function marketingAgentEntityId(entities: ReadonlyArray<{ id: string; entity_role?: string | null }>): string | null {
  return entities.find((e) => e.entity_role === 'marketing_agent')?.id ?? null
}

/** field id → entity id, through the farm. */
export function fieldEntityMap(
  fields: ReadonlyArray<{ id: string; farm_id: string | null }>,
  farms: ReadonlyArray<{ id: string; entity_id: string | null }>,
): Map<string, string | null> {
  const farmEntity = new Map(farms.map((f) => [f.id, f.entity_id]))
  const out = new Map<string, string | null>()
  for (const f of fields) out.set(f.id, f.farm_id ? farmEntity.get(f.farm_id) ?? null : null)
  return out
}

/** load id → its split sources as fractions (load_splits.percentage / 100). */
export function splitsByLoad(
  splits: ReadonlyArray<{ load_id: string; field_id: string; percentage?: number | string | null }>,
): Map<string, Array<{ field_id: string; fraction: number }>> {
  const out = new Map<string, Array<{ field_id: string; fraction: number }>>()
  for (const s of splits) {
    const pct = Number(s.percentage)
    if (!Number.isFinite(pct) || pct <= 0) continue
    const arr = out.get(s.load_id) ?? []
    arr.push({ field_id: s.field_id, fraction: pct / 100 })
    out.set(s.load_id, arr)
  }
  return out
}

export type SpotInputs = {
  sales: LoadSale[]
  /** The buyer loads as the seam sees them (dry bushels resolved). */
  sourceLoads: SaleSourceLoad[]
  spots: VirtualSpotContract[]
  pools: PriceLaterPool[]
  /** The org's marketing agent, when it has one. */
  marketingAgentEntityId: string | null
  /** Real contracts + the spot contracts, for any engine consumer. */
  contractsWithSpot<C extends Contract>(contracts: ReadonlyArray<C>): Array<C | ReturnType<typeof withSpotContracts>[number]>
}

export type SpotInputArgs = {
  loads: ReadonlyArray<SpotLoadRecord>
  sales: ReadonlyArray<LoadSale>
  crops: ReadonlyArray<CropBases>
  entities: ReadonlyArray<{ id: string; entity_role?: string | null }>
  fields?: ReadonlyArray<{ id: string; farm_id: string | null }>
  farms?: ReadonlyArray<{ id: string; entity_id: string | null }>
  splits?: ReadonlyArray<{ load_id: string; field_id: string; percentage?: number | string | null }>
}

/** Everything a marketing consumer needs from the sale rows, built one way. */
export function buildSpotInputs(args: SpotInputArgs): SpotInputs {
  const sourceLoads = toSaleSourceLoads(args.loads, args.crops)
  const sales = [...args.sales]
  const agent = marketingAgentEntityId(args.entities)
  const spots = buildSpotContracts({
    loads: sourceLoads,
    sales,
    marketingAgentEntityId: agent,
    fieldEntity: agent ? undefined : fieldEntityMap(args.fields ?? [], args.farms ?? []),
    splitsByLoad: agent ? undefined : splitsByLoad(args.splits ?? []),
  })
  const pools = buildPriceLaterPools(sourceLoads, sales)
  return {
    sales,
    sourceLoads,
    spots,
    pools,
    marketingAgentEntityId: agent,
    contractsWithSpot: (contracts) => withSpotContracts(contracts, spots),
  }
}

/** The empty inputs (a database before 094, or no buyer loads yet). */
export function emptySpotInputs(): SpotInputs {
  return {
    sales: [], sourceLoads: [], spots: [], pools: [], marketingAgentEntityId: null,
    contractsWithSpot: (contracts) => [...contracts],
  }
}

/** A spot contract narrowed to ONE buyer's loads (the Cash Flow buyer
 *  filter) — null when the buyer has none of its loads. */
export function spotForBuyer(spot: VirtualSpotContract, buyerId: string | null | undefined): VirtualSpotContract | null {
  if (!buyerId) return spot
  const rows = spot.rows.filter((r) => r.load.to_buyer_id === buyerId)
  if (rows.length === 0) return null
  const summary = spotSummary(rows.map((r) => r.alloc))
  return {
    ...spot,
    rows,
    bushels: summary.bushels,
    revenue: summary.revenue,
    avgPrice: summary.avgPrice,
    summary,
    buyers: spot.buyers.filter((b) => b.buyerId === buyerId),
    estimated: summary.estimatedCount > 0 || summary.unpricedCount > 0,
  }
}

/** "Spot · Soybean 2026" — the virtual row's name everywhere. */
export function spotContractLabel(spot: Pick<VirtualSpotContract, 'crop_id' | 'crop_year'>, cropName: (id: string) => string | null | undefined): string {
  return `Spot · ${cropName(spot.crop_id) ?? 'Crop'} ${spot.crop_year}`
}

/** "Price later · Soybean 2026 · Bunge". */
export function priceLaterPoolLabel(pool: Pick<PriceLaterPool, 'crop_id' | 'crop_year' | 'buyer_id'>, cropName: (id: string) => string | null | undefined, buyerName: (id: string) => string | null | undefined): string {
  return `Price later · ${cropName(pool.crop_id) ?? 'Crop'} ${pool.crop_year} · ${buyerName(pool.buyer_id) ?? 'Buyer'}`
}
