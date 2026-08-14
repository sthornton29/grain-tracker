// The REAL importer configs (lib/import-configs.ts) under the blank-cell
// contract: for every importer, a minimal file with every optional column
// present but BLANK imports cleanly — blanks are omitted from the write so
// database defaults apply, and only the required natural keys can fail a row.
// This is the fixture suite the farms share-rent failure (blank share_rent
// cell → NOT NULL violation) escaped through.
//
// Also pins the plantings specifics: blank Total_Planted_Acres defaults to
// the FIELD's total acres (overridable by typing a value), the preview
// annotation for that default, and two crops on one field/year landing as
// two distinct plantings (never a dedupe collision).

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { autoMapHeaders, runImport, type ImportConfig } from './csv'
import {
  STATIC_IMPORT_CONFIGS,
  contractsImportConfig,
  farmsImportConfig,
  plantingsImportConfig,
} from './import-configs'

type Rec = Record<string, unknown>

// Same chainable stub as lib/csv.test.ts (only the call shapes runImport uses).
function makeFakeClient(tables: Record<string, Rec[]>) {
  const inserted: Record<string, Rec[]> = {}
  const updates: Array<{ table: string; patch: Rec; id: unknown }> = []
  let idSeq = 0

  function from(table: string) {
    return {
      select(_cols: string) {
        void _cols
        return Promise.resolve({ data: tables[table] ?? [], error: null })
      },
      insert(payload: Rec | Rec[]) {
        const list = Array.isArray(payload) ? payload : [payload]
        inserted[table] = (inserted[table] ?? []).concat(list)
        const assigned = list.map(() => ({ id: `${table}-new-${++idSeq}` }))
        return {
          select(_idCol: string) {
            void _idCol
            const thenable: any = Promise.resolve({ data: assigned, error: null })
            thenable.single = () => Promise.resolve({ data: assigned[0] ?? null, error: null })
            return thenable
          },
          then(onFulfilled: any, onRejected: any) {
            return Promise.resolve({ data: assigned, error: null }).then(onFulfilled, onRejected)
          },
        }
      },
      update(patch: Rec) {
        return {
          eq(_col: string, id: unknown) {
            void _col
            updates.push({ table, patch, id })
            return Promise.resolve({ error: null })
          },
        }
      },
    }
  }
  return { client: { from } as unknown as SupabaseClient, inserted, updates }
}

// Headers straight from the config (label ?? key), one data row keyed by
// column key — unlisted columns are blank cells.
function fileFor(config: ImportConfig, row: Record<string, string>) {
  const headers = config.columns.map((c) => c.label ?? c.key)
  const cells = config.columns.map((c) => row[c.key] ?? '')
  const mapping = autoMapHeaders(headers, config.columns)
  return { headers, rows: [cells], mapping }
}

async function runOne(config: ImportConfig, tables: Record<string, Rec[]>, row: Record<string, string>) {
  const { client, inserted, updates } = makeFakeClient(tables)
  const { headers, rows, mapping } = fileFor(config, row)
  const res = await runImport(client, config, rows, headers, mapping, { mode: 'sync' })
  return { res, inserted, updates }
}

const ONE_ENTITY = [{ id: 'ent-1', name: 'Op LLC' }]

describe('blank optional columns import cleanly (every importer)', () => {
  // Static configs: just the required natural key, everything else blank.
  const staticCases: Array<{ name: keyof typeof STATIC_IMPORT_CONFIGS; tables: Record<string, Rec[]>; row: Record<string, string> }> = [
    { name: 'fields', tables: { fields: [], farms: [] }, row: { name_or_number: 'North 40' } },
    { name: 'bins', tables: { bins: [], bin_sites: [], crops: [] }, row: { name_or_number: 'Bin 1' } },
    { name: 'buyers', tables: { buyers: [], delivery_locations: [] }, row: { name: 'ADM' } },
    { name: 'landowners', tables: { landowners: [] }, row: { name: 'Jones Family' } },
    { name: 'entities', tables: { entities: [] }, row: { name: 'Op LLC' } },
    { name: 'crops', tables: { crops: [] }, row: { name: 'Corn' } },
    { name: 'trucks', tables: { trucks: [] }, row: { name_or_number: 'Kenworth 1' } },
  ]

  for (const c of staticCases) {
    it(`${c.name}: a row with every optional column blank adds with no failures`, async () => {
      const config = STATIC_IMPORT_CONFIGS[c.name]()
      const { res, inserted } = await runOne(config, c.tables, c.row)
      expect(res.failed).toEqual([])
      expect(res.added).toBe(1)
      const saved = inserted[config.tableName][0]
      // No optional key may land as an explicit null — blanks are omitted so
      // the database default applies.
      for (const [k, v] of Object.entries(saved)) {
        expect(v, `${c.name}.${k} must not be an explicit null`).not.toBeNull()
      }
    })
  }

  it('crops: blank harvest_category takes the config default (fall)', async () => {
    const { inserted } = await runOne(STATIC_IMPORT_CONFIGS.crops(), { crops: [] }, { name: 'Corn' })
    expect(inserted.crops[0].harvest_category).toBe('fall')
  })

  it('buyers: a blank delivery_locations cell creates zero child rows', async () => {
    const { inserted } = await runOne(STATIC_IMPORT_CONFIGS.buyers(), { buyers: [], delivery_locations: [] }, { name: 'ADM' })
    expect(inserted.delivery_locations).toBeUndefined()
  })

  it('contracts: only contract_number filled — delivery_type defaults, bushels omitted', async () => {
    const config = contractsImportConfig(ONE_ENTITY)
    const { res, inserted } = await runOne(
      config,
      { contracts: [], buyers: [], crops: [], entities: ONE_ENTITY, delivery_locations: [] },
      { contract_number: 'C-100' },
    )
    expect(res.failed).toEqual([])
    const saved = inserted.contracts[0]
    expect(saved.delivery_type).toBe('pickup') // config default
    expect('contracted_bushels' in saved).toBe(false) // DB default 0 applies
    expect(saved.entity_id).toBe('ent-1') // single-entity auto-assign
    expect('buyer_id' in saved).toBe(false)
  })
})

describe('farms importer — the share-rent blank that started this', () => {
  const tables = () => ({ farms: [], entities: ONE_ENTITY, counties: [], landowners: [] })

  it('blank share_rent (and every other optional) imports cleanly — DB default lands false', async () => {
    const { res, inserted } = await runOne(farmsImportConfig(ONE_ENTITY), tables(), { name: 'Home Farm' })
    expect(res.failed).toEqual([])
    expect(res.added).toBe(1)
    const saved = inserted.farms[0]
    expect('is_share_rent' in saved).toBe(false)
    expect('landlord_share_percentage' in saved).toBe(false)
    expect(saved.entity_id).toBe('ent-1')
  })

  it('share_rent yes + pct converts to the real boolean', async () => {
    const { inserted } = await runOne(farmsImportConfig(ONE_ENTITY), tables(), {
      name: 'Home Farm', is_share_rent: 'Yes', landlord_share_percentage: '33.33',
    })
    expect(inserted.farms[0].is_share_rent).toBe(true)
    expect(inserted.farms[0].landlord_share_percentage).toBe(33.33)
  })

  it('share_rent no force-nulls the percentage (DB forbids one without the flag)', async () => {
    const { inserted } = await runOne(farmsImportConfig(ONE_ENTITY), tables(), {
      name: 'Home Farm', is_share_rent: 'no', landlord_share_percentage: '33.33',
    })
    expect(inserted.farms[0].is_share_rent).toBe(false)
    expect(inserted.farms[0].landlord_share_percentage).toBeNull()
  })

  it('share_rent yes WITHOUT a percentage fails the row with a clear reason', async () => {
    const { res } = await runOne(farmsImportConfig(ONE_ENTITY), tables(), {
      name: 'Home Farm', is_share_rent: 'yes',
    })
    expect(res.added).toBe(0)
    expect(res.failed).toEqual([
      { rowIndex: 0, reason: 'share_rent is yes but landlord_share_pct is blank — add the landlord’s share percent' },
    ])
  })
})

describe('plantings importer — field-acres default and multi-crop rows', () => {
  const FIELDS = [
    { id: 'f-1', name_or_number: 'North 40', total_acres: 245, irrigated_acres: 0 },
    { id: 'f-2', name_or_number: 'South Bottom', total_acres: 90, irrigated_acres: 40 },
  ]
  const deps = () => ({
    fields: FIELDS,
    currentYear: 2026,
    varietyOptionsByCrop: new Map<string, string[]>(),
    dismissedPairsByCrop: new Map<string, Set<string>>(),
  })
  const tables = () => ({
    field_plantings: [],
    field_planting_varieties: [],
    fields: FIELDS,
    crops: [{ id: 'c-corn', name: 'Corn' }, { id: 'c-wheat', name: 'Wheat' }, { id: 'c-soy', name: 'Soybean' }],
  })

  it('blank Total_Planted_Acres defaults to the field\'s total acres (dryland follows)', async () => {
    const { res, inserted } = await runOne(plantingsImportConfig(deps()), tables(), {
      field_id: 'North 40', crop_id: 'Corn', season_year: '2026',
    })
    expect(res.failed).toEqual([])
    expect(inserted.field_plantings[0].planted_acres).toBe(245)
    expect(inserted.field_plantings[0].dryland_acres).toBe(245)
    expect(inserted.field_plantings[0].irrigated_acres).toBe(0)
  })

  it('a typed acres value overrides the default', async () => {
    const { inserted } = await runOne(plantingsImportConfig(deps()), tables(), {
      field_id: 'North 40', crop_id: 'Corn', season_year: '2026', planted_acres: '120',
    })
    expect(inserted.field_plantings[0].planted_acres).toBe(120)
    expect(inserted.field_plantings[0].dryland_acres).toBe(120)
  })

  it('two crops on the same field + year land as two distinct plantings', async () => {
    const config = plantingsImportConfig(deps())
    const { client, inserted } = makeFakeClient(tables())
    const headers = config.columns.map((c) => c.label ?? c.key)
    const mapping = autoMapHeaders(headers, config.columns)
    const rowFor = (crop: string, acres: string) =>
      config.columns.map((c) => ({ field_id: 'South Bottom', crop_id: crop, season_year: '2026', planted_acres: acres } as Record<string, string>)[c.key] ?? '')
    const res = await runImport(client, config, [rowFor('Wheat', ''), rowFor('Soybean', '90')], headers, mapping, { mode: 'sync' })
    expect(res.failed).toEqual([])
    expect(res.skipped).toBe(0) // never a dedupe collision — crop is part of the key
    expect(res.added).toBe(2)
    expect(inserted.field_plantings.map((p) => [p.crop_id, p.planted_acres])).toEqual([
      ['c-wheat', 90], // blank acres → the field's full 90
      ['c-soy', 90],   // both crops may claim the full acres (double-crop)
    ])
  })

  it('previewAnnotate flags a blank acres cell with the field-acres default', () => {
    const config = plantingsImportConfig(deps())
    expect(config.previewAnnotate!('planted_acres', { field_id: 'North 40', crop_id: 'Corn', planted_acres: '' }))
      .toEqual({ text: '245 — from field acres', ok: true })
    // No crop → the row would be ignored entirely; no annotation.
    expect(config.previewAnnotate!('planted_acres', { field_id: 'North 40', crop_id: '', planted_acres: '' })).toBeNull()
    // Typed acres → no annotation.
    expect(config.previewAnnotate!('planted_acres', { field_id: 'North 40', crop_id: 'Corn', planted_acres: '120' })).toBeNull()
  })
})
