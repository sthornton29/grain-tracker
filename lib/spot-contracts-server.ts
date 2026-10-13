// The spot contracts + price-later pools for a crop year, fetched and built
// (094, 2026-10-13). One loader for every server-side marketing consumer:
// lib/marketing-inputs.ts (the partner API / Farm Link bundle, service role —
// pass `org`) and the Ask Turnrow tools (the caller's session — RLS scopes,
// `org` omitted). The shaping itself is pure (lib/spot-contracts.ts) so the
// client reports build the same thing from rows they already hold.
//
// A database before 094 (no load_sales table) reads as no sale rows: every
// buyer load with a contract_id is a full contract load, and there are no
// spot contracts or pools — the pre-migration state is tolerated, never an
// error.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { fetchLoadSales } from '@/lib/load-sales'
import { buildSpotInputs, SPOT_LOAD_SELECT, type CropBases, type SpotInputs, type SpotLoadRecord } from '@/lib/spot-contracts'

export type { SpotInputs } from '@/lib/spot-contracts'

type SplitRow = { load_id: string; field_id: string; percentage: number | string | null }

async function allOf<T>(build: Parameters<typeof fetchAllRows>[0]): Promise<T[]> {
  const { data, error } = await fetchAllRows<T>(build)
  if (error) throw new Error(error.message)
  return data
}

/**
 * Load everything the spot builders need for one crop year and build it.
 * `org` scopes every read explicitly (service-role callers MUST pass it);
 * without it the caller's session RLS decides. `crops` may be handed in when
 * the caller already fetched them.
 */
export async function loadSpotInputs(
  supabase: SupabaseClient,
  opts: { org?: string; cropYear: number; crops?: ReadonlyArray<CropBases> },
): Promise<SpotInputs> {
  const org = opts.org
  // One paged, org-scoped (when asked) read per table; `extra` adds the
  // loads' crop-year + destination filters.
  const table = <T,>(name: string, select: string, extra?: Record<string, string | number>) =>
    allOf<T>((f, t) => {
      let q = supabase.from(name).select(select)
      if (org) q = q.eq('org_id', org)
      for (const [col, v] of Object.entries(extra ?? {})) q = q.eq(col, v)
      return q.order('id').range(f, t)
    })
  const [loads, crops, entities, fields, farms] = await Promise.all([
    table<SpotLoadRecord>('loads', SPOT_LOAD_SELECT, { crop_year: opts.cropYear, to_type: 'buyer' }),
    opts.crops ? Promise.resolve([...opts.crops]) : table<CropBases>('crops', 'id, base_moisture_pct, base_lb_per_bushel'),
    table<{ id: string; entity_role: string | null }>('entities', 'id, entity_role'),
    table<{ id: string; farm_id: string | null }>('fields', 'id, farm_id'),
    table<{ id: string; entity_id: string | null }>('farms', 'id, entity_id'),
  ])
  const loadIds = loads.map((l) => l.id)
  const [sales, splits] = await Promise.all([
    fetchLoadSales(supabase, { loadIds, orgId: org }),
    loadIds.length === 0 ? Promise.resolve([] as SplitRow[]) : table<SplitRow>('load_splits', 'load_id, field_id, percentage'),
  ])
  return buildSpotInputs({ loads, sales, crops, entities, fields, farms, splits })
}
