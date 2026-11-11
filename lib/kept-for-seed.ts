// Grain kept back for seed (0105, 2026-11-10): Turnrow Farm's saved seed lot
// takes bushels of a crop year at the year's average price as next year's
// seed. The marketing engine counts them as SOLD at that price: each row is
// a fully priced flat-cash sale entering through the spot seam
// (lib/spot-contracts.ts buildSpotInputs), the same path a spot sale takes,
// so the bushels leave "unsold" and their value is in the blended revenue
// once. Pure; tested in lib/kept-for-seed.test.ts.

import type { Contract } from '@/lib/types'

export const KEPT_FOR_SEED_ID_PREFIX = 'kept-seed:'

export type KeptForSeedRow = {
  id: string
  crop_id: string
  crop_year: number
  entity_id: string | null
  bushels: number | string
  price_per_bu: number | string
  kept_on: string
  reference: string
  label: string | null
}

export const KEPT_FOR_SEED_SELECT = 'id, crop_id, crop_year, entity_id, bushels, price_per_bu, kept_on, reference, label'

const round2 = (n: number) => Math.round(n * 100) / 100

export function keptForSeedContractId(row: Pick<KeptForSeedRow, 'id'>): string {
  return `${KEPT_FOR_SEED_ID_PREFIX}${row.id}`
}

export function toKeptForSeedContract(row: KeptForSeedRow): Contract & { source_label: string; virtual: 'kept_for_seed' } {
  const bu = Number(row.bushels)
  const price = Number(row.price_per_bu)
  return {
    id: keptForSeedContractId(row),
    contract_number: 'KEPT FOR SEED',
    buyer_id: null,
    crop_id: row.crop_id,
    entity_id: row.entity_id,
    crop_year: Number(row.crop_year),
    contracted_bushels: round2(bu),
    price_per_bushel: price,
    notes: row.label,
    delivery_type: 'delivered',
    delivery_location_id: null,
    delivery_start_date: null,
    delivery_end_date: null,
    completed_at: row.kept_on,
    date_sold: row.kept_on,
    contract_kind: 'grain',
    created_at: '',
    contract_month: null,
    contract_type: 'forward',
    futures_price: null,
    basis: null,
    cash_price: price,
    service_fee: 0,
    futures_set_date: null,
    basis_set_date: null,
    pricing_status: 'fully_priced',
    source_label: `Kept for seed${row.label ? ` (${row.label})` : ''}`,
    virtual: 'kept_for_seed',
  }
}

/** The kept-for-seed rows of a crop year as marketing contracts (rows with no bushels left out). */
export function keptForSeedContracts(rows: ReadonlyArray<KeptForSeedRow>, cropYear?: number): Array<ReturnType<typeof toKeptForSeedContract>> {
  return rows.filter((r) => Number(r.bushels) > 0 && (cropYear == null || Number(r.crop_year) === cropYear)).map(toKeptForSeedContract)
}

/** Bushels and dollars kept for seed per crop, for the settled figures the farm link reports. */
export function keptForSeedByCrop(rows: ReadonlyArray<KeptForSeedRow>, cropYear: number): Map<string, { quantity: number; revenue: number }> {
  const out = new Map<string, { quantity: number; revenue: number }>()
  for (const r of rows) {
    if (Number(r.crop_year) !== cropYear) continue
    const cur = out.get(r.crop_id) ?? { quantity: 0, revenue: 0 }
    cur.quantity += Number(r.bushels)
    cur.revenue += Number(r.bushels) * Number(r.price_per_bu)
    out.set(r.crop_id, cur)
  }
  return out
}
