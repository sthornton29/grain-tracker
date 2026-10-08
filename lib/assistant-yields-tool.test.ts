// Ask Turnrow's get_yields against a scripted session client: the question
// "of full-season soybeans harvested so far, how many are Two Seasons vs
// View Celeste?" must come back as an ENTITY split restricted to the
// full-season cohort, with the Yields page's harvest-status math (yield/acre
// over complete fields only; in-progress and unharvested acres listed, not
// averaged). Pins the row shape the model reads.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ASSISTANT_TOOLS, runAssistantTool } from '@/lib/assistant-tools'

type Rows = Record<string, Array<Record<string, unknown>>>

// A session client over fixed rows: eq / is filter, range slices (the paged
// readers stop on an empty page), everything else chains.
function sessionClient(tables: Rows): SupabaseClient {
  const builder = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const b: Record<string, unknown> = {}
    const self = () => b
    for (const m of ['select', 'order', 'limit', 'in', 'gte', 'lte', 'gt', 'lt', 'neq', 'ilike', 'not', 'or', 'filter']) b[m] = self
    b.eq = (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return b }
    b.is = (col: string, val: unknown) => { rows = rows.filter((r) => (r[col] ?? null) === val); return b }
    b.range = (from: number, to: number) => { rows = rows.slice(from, to + 1); return b }
    b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    b.single = async () => ({ data: rows[0] ?? null, error: null })
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve)
    return b
  }
  return { from: (table: string) => builder(table), rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient
}

const SOY = 'crop-soy'
const WHEAT = 'crop-wheat'
const planting = (id: string, field_id: string, crop_id: string, planted_acres: number) =>
  ({ id, field_id, crop_id, season_year: 2026, planted_acres, irrigated_acres: null, dryland_acres: null, yield_include_override: null, archived_at: null })
const load = (id: string, from_field_id: string, dry: number, date = '2026-09-20') =>
  ({ id, date, time: null, crop_id: SOY, crop_year: 2026, from_type: 'field', from_field_id, net_weight: null, moisture: null, dry_bushels_override: dry })

// Two Seasons Farms: field A (100 ac full-season soy, 5,000 bu) and field B
// (50 ac wheat then 50 ac soy behind it — double-crop, 1,500 bu).
// View Celeste Farms: field C (80 ac full-season, 4,000 bu), field D (40 ac,
// a combine entry with harvest_complete = false → in progress, 1,000 bu so
// far), field E (30 ac, nothing hauled → not harvested).
const TABLES: Rows = {
  entities: [
    { id: 'e-ts', name: 'Two Seasons Farms', entity_role: 'farming', archived_at: null },
    { id: 'e-vc', name: 'View Celeste Farms', entity_role: 'farming', archived_at: null },
  ],
  farms: [
    { id: 'f-ts', name: 'Home Place', entity_id: 'e-ts', landowner_id: null, archived_at: null },
    { id: 'f-vc', name: 'River Bottom', entity_id: 'e-vc', landowner_id: null, archived_at: null },
  ],
  fields: [
    { id: 'A', farm_id: 'f-ts', name_or_number: 'A' },
    { id: 'B', farm_id: 'f-ts', name_or_number: 'B' },
    { id: 'C', farm_id: 'f-vc', name_or_number: 'C' },
    { id: 'D', farm_id: 'f-vc', name_or_number: 'D' },
    { id: 'E', farm_id: 'f-vc', name_or_number: 'E' },
  ],
  crops: [
    { id: SOY, name: 'Soybean', base_moisture_pct: 13, base_lb_per_bushel: 60, harvest_category: 'fall', double_crop: true },
    { id: WHEAT, name: 'Wheat', base_moisture_pct: 13.5, base_lb_per_bushel: 60, harvest_category: 'spring', double_crop: false },
  ],
  field_plantings: [
    planting('p-A', 'A', SOY, 100),
    planting('p-Bw', 'B', WHEAT, 50),
    planting('p-B', 'B', SOY, 50),
    planting('p-C', 'C', SOY, 80),
    planting('p-D', 'D', SOY, 40),
    planting('p-E', 'E', SOY, 30),
  ],
  loads: [load('l1', 'A', 5000), load('l2', 'B', 1500), load('l3', 'C', 4000)],
  load_splits: [],
  combine_yield_entries: [
    { id: 'ce-D', field_id: 'D', crop_id: SOY, crop_year: 2026, stated_total_bushels: 1000, adjusted_total_bushels: 1000, adjustment_bu_per_acre: null, destination_bin_id: null, harvest_complete: false, entry_date: '2026-09-25' },
  ],
  landowners: [],
  crop_assumptions: [],
}

const ctx = { role: 'owner' as const, grantedEntityIds: null }
type Side = { planted_acres: number; harvested_acres: number; harvested_dry_bu: number; yield_per_acre: number | null; in_progress_acres: number; not_harvested_acres: number; pct_harvested: number; dry_bu_so_far: number }
type Row = Side & { group: string; crop: string; full_season?: Side; double_crop?: Side }
const run = async (input: Record<string, unknown>) => (await runAssistantTool(sessionClient(TABLES), ctx, 'get_yields', { crop_year: 2026, ...input })) as { rows: Row[]; note: string; cropping: string }

describe('get_yields — entity split of full-season soybeans, the Yields page math', () => {
  it('grouping entity + cropping full_season: one row per entity, double-crop acres left out, in-progress and unharvested acres listed but not averaged', async () => {
    const { rows, cropping } = await run({ grouping: 'entity', crop: 'soy', cropping: 'full_season' })
    expect(cropping).toBe('full_season')
    expect(rows.map((r) => r.group)).toEqual(['Two Seasons Farms', 'View Celeste Farms'])
    const ts = rows[0]
    expect(ts).toMatchObject({ crop: 'Soybean', planted_acres: 100, harvested_acres: 100, harvested_dry_bu: 5000, yield_per_acre: 50, in_progress_acres: 0, not_harvested_acres: 0, pct_harvested: 100, dry_bu_so_far: 5000 })
    const vc = rows[1]
    expect(vc).toMatchObject({ crop: 'Soybean', planted_acres: 150, harvested_acres: 80, harvested_dry_bu: 4000, yield_per_acre: 50, in_progress_acres: 40, not_harvested_acres: 30, pct_harvested: 53, dry_bu_so_far: 5000 })
    // The split still rides along (the crop has both kinds this season) and
    // the double-crop side is empty under the full-season filter.
    expect(ts.full_season).toMatchObject({ harvested_acres: 100, harvested_dry_bu: 5000 })
    expect(ts.double_crop).toMatchObject({ planted_acres: 0, harvested_dry_bu: 0, yield_per_acre: null })
  })

  it('cropping all: the full-season / double-crop sides partition the entity row exactly', async () => {
    const { rows } = await run({ grouping: 'entity', crop: 'soy' })
    const ts = rows.find((r) => r.group === 'Two Seasons Farms')!
    expect(ts).toMatchObject({ planted_acres: 150, harvested_acres: 150, harvested_dry_bu: 6500, yield_per_acre: 43.33 })
    expect(ts.full_season).toMatchObject({ planted_acres: 100, harvested_dry_bu: 5000, yield_per_acre: 50 })
    expect(ts.double_crop).toMatchObject({ planted_acres: 50, harvested_dry_bu: 1500, yield_per_acre: 30 })
    expect(ts.full_season!.harvested_dry_bu + ts.double_crop!.harvested_dry_bu).toBe(ts.harvested_dry_bu)
  })

  it('cropping double_crop: only the entity with soybeans behind wheat', async () => {
    const { rows } = await run({ grouping: 'entity', crop: 'soy', cropping: 'double_crop' })
    expect(rows.map((r) => [r.group, r.harvested_dry_bu])).toEqual([['Two Seasons Farms', 1500]])
  })

  it('a crop with one cropping carries no split; the note states the harvest-status rule', async () => {
    const { rows, note } = await run({ grouping: 'crop' })
    const wheat = rows.find((r) => r.crop === 'Wheat')!
    expect(wheat).toMatchObject({ planted_acres: 50, not_harvested_acres: 50, harvested_dry_bu: 0, yield_per_acre: null })
    expect(wheat.full_season).toBeUndefined()
    expect(note).toMatch(/only fields whose harvest is complete/)
  })

  it('the tool tells the model to pass cropping "full_season" and to use grouping "entity" for entity splits', () => {
    const tool = ASSISTANT_TOOLS.find((t) => t.name === 'get_yields')!
    expect(tool.description).toMatch(/entity \(the operating company/)
    expect(tool.description).toMatch(/pass cropping "full_season"/)
    expect(tool.description).toMatch(/only fields whose harvest is complete/)
  })
})
