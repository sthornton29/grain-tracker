import { describe, it, expect } from 'vitest'
import {
  parseCsv,
  autoMapHeaders,
  extractChildValues,
  runImport,
  type ColumnSpec,
  type ImportConfig,
  type ImportResult,
} from '@/lib/csv'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// parseCsv — RFC-4180-ish parser.
//
// Behavior derived from the source:
//  - A BOM at the very start is stripped.
//  - Quoted fields may contain commas and newlines; "" inside quotes is a
//    literal quote.
//  - \r is dropped everywhere (so CRLF behaves like LF).
//  - The first non-empty parsed row becomes `headers` (trimmed); remaining rows
//    are trimmed cell-by-cell and any all-empty row is filtered out.
// ---------------------------------------------------------------------------
describe('parseCsv', () => {
  it('parses a simple two-column file', () => {
    const { headers, rows } = parseCsv('name,acres\nNorth 40,40\nSouth,12')
    expect(headers).toEqual(['name', 'acres'])
    expect(rows).toEqual([
      ['North 40', '40'],
      ['South', '12'],
    ])
  })

  it('keeps commas inside quoted fields', () => {
    // The address field contains a comma that must not split the row.
    const { headers, rows } = parseCsv('name,address\n"Smith, John","100 Main St, Apt 2"')
    expect(headers).toEqual(['name', 'address'])
    expect(rows).toEqual([['Smith, John', '100 Main St, Apt 2']])
  })

  it('keeps newlines inside quoted fields', () => {
    // A quoted field spanning two physical lines is one logical cell.
    const text = 'name,notes\n"North 40","line one\nline two"'
    const { headers, rows } = parseCsv(text)
    expect(headers).toEqual(['name', 'notes'])
    expect(rows).toEqual([['North 40', 'line one\nline two']])
  })

  it('unescapes doubled double-quotes inside a quoted field', () => {
    // "" -> a single literal ".  Input cell: "He said ""hi"""  ->  He said "hi"
    const { headers, rows } = parseCsv('name,quote\nBob,"He said ""hi"""')
    expect(headers).toEqual(['name', 'quote'])
    expect(rows).toEqual([['Bob', 'He said "hi"']])
  })

  it('handles trailing empty fields', () => {
    // Trailing comma -> an empty third cell that is kept (row is not all-empty).
    const { rows } = parseCsv('a,b,c\n1,2,')
    expect(rows).toEqual([['1', '2', '']])
  })

  it('handles a leading empty field', () => {
    const { rows } = parseCsv('a,b,c\n,2,3')
    expect(rows).toEqual([['', '2', '3']])
  })

  it('treats CRLF line endings the same as LF', () => {
    const lf = parseCsv('a,b\n1,2\n3,4')
    const crlf = parseCsv('a,b\r\n1,2\r\n3,4')
    expect(crlf).toEqual(lf)
    expect(crlf.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('drops fully empty data rows but keeps partially filled ones', () => {
    // Row 2 is all-empty (filtered out); row 3 has one value (kept).
    const { rows } = parseCsv('a,b\n1,2\n,\n3,')
    expect(rows).toEqual([
      ['1', '2'],
      ['3', ''],
    ])
  })

  it('strips a leading UTF-8 BOM from the first header', () => {
    const withBom = '﻿name,acres\nNorth,40'
    const { headers, rows } = parseCsv(withBom)
    expect(headers).toEqual(['name', 'acres'])
    expect(rows).toEqual([['North', '40']])
  })

  it('trims surrounding whitespace from headers and cells', () => {
    const { headers, rows } = parseCsv(' name , acres \n  North 40  ,  40  ')
    expect(headers).toEqual(['name', 'acres'])
    expect(rows).toEqual([['North 40', '40']])
  })

  it('handles a final row with no trailing newline', () => {
    const { rows } = parseCsv('a,b\n1,2')
    expect(rows).toEqual([['1', '2']])
  })

  it('returns empty headers and rows for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
  })
})

// ---------------------------------------------------------------------------
// autoMapHeaders — match CSV header strings to column keys.
//
// normHeader lowercases and removes every non-alphanumeric character, so
// "Field / Number", "field_number", "fieldNumber" all normalize to
// "fieldnumber". For each column the candidates are [label, key] (label wins
// because it is checked first via Array.find on the header list... actually the
// find iterates HEADERS and matches against either candidate, so the first
// matching header in file order wins). The result maps key -> the raw CSV
// header string.
// ---------------------------------------------------------------------------
describe('autoMapHeaders', () => {
  const columns: ColumnSpec[] = [
    { key: 'name_or_number', label: 'Field' },
    { key: 'total_acres', label: 'Total Acres' },
    { key: 'county_id' },
  ]

  it('matches case-insensitively and ignoring separators/punctuation', () => {
    const headers = ['FIELD', 'total acres', 'County_ID']
    const map = autoMapHeaders(headers, columns)
    expect(map).toEqual({
      name_or_number: 'FIELD',
      total_acres: 'total acres',
      county_id: 'County_ID',
    })
  })

  it('matches on the column key when no label matches', () => {
    // county_id has no label, so it can only match via its key.
    const map = autoMapHeaders(['county_id'], columns)
    expect(map).toEqual({ county_id: 'county_id' })
  })

  it('matches on the label even when the raw header differs in punctuation', () => {
    const map = autoMapHeaders(['total-acres'], columns)
    expect(map).toEqual({ total_acres: 'total-acres' })
  })

  it('preserves the exact raw header string in the mapping value', () => {
    const map = autoMapHeaders(['  Field  '], [{ key: 'name_or_number', label: 'Field' }])
    // Headers are not pre-trimmed by autoMapHeaders; the raw string is kept as-is.
    expect(map).toEqual({ name_or_number: '  Field  ' })
  })

  it('omits columns that have no matching header', () => {
    const map = autoMapHeaders(['name_or_number'], columns)
    expect(map).toEqual({ name_or_number: 'name_or_number' })
    expect(map.total_acres).toBeUndefined()
    expect(map.county_id).toBeUndefined()
  })

  it('returns an empty map when nothing matches', () => {
    expect(autoMapHeaders(['totally', 'unrelated'], columns)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Fake Supabase client for runImport.
//
// runImport calls supabase.from(table).select(cols) (a thenable / awaited),
// .insert(rows).select('id'), .insert(one).select('id').single(), and
// .update(patch).eq('id', id).  We build a tiny chainable stub:
//   - `tables` seeds existing rows returned by select().
//   - insert() records inserted rows into `inserted[table]` and returns
//     synthetic ids in input order (Supabase preserves order).
//   - update() records patches into `updates[table]`.
// Every leaf is a Promise resolving to { data, error }.
// ---------------------------------------------------------------------------
type Rec = Record<string, unknown>

function makeFakeClient(tables: Record<string, Rec[]>) {
  const inserted: Record<string, Rec[]> = {}
  const updates: Array<{ table: string; patch: Rec; id: unknown }> = []
  let idSeq = 0

  function selectResult(table: string, cols: string) {
    void cols
    const data = tables[table] ?? []
    return Promise.resolve({ data, error: null })
  }

  function from(table: string) {
    return {
      // select() is awaited directly in fetchLookup / existing-rows fetch.
      select(cols: string) {
        return selectResult(table, cols)
      },
      insert(payload: Rec | Rec[]) {
        const list = Array.isArray(payload) ? payload : [payload]
        inserted[table] = (inserted[table] ?? []).concat(list)
        const assigned = list.map(() => ({ id: `${table}-new-${++idSeq}` }))
        return {
          // .insert(...).select('id')  -> awaited, returns all ids (batch path)
          select(_idCol: string) {
            void _idCol
            const thenable: any = Promise.resolve({ data: assigned, error: null })
            // .insert(...).select('id').single() -> single-row insert fallback
            thenable.single = () =>
              Promise.resolve({ data: assigned[0] ?? null, error: null })
            return thenable
          },
          // bare .insert(rows) is awaited for child rows.
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

// A field-planting-ish config exercising a simple FK (crop_id), a composite
// scoped FK (delivery_location_id scoped by buyer_id), aliases, and a numeric
// column. uniqueKey is composite (field + season) to test dedupe.
const cropCol: ColumnSpec = {
  key: 'crop_id',
  label: 'Crop',
  fk: {
    table: 'crops',
    matchColumn: 'name',
    aliases: { soybeans: 'Soybean', beans: 'Soybean' },
  },
}

describe('runImport — FK resolution', () => {
  it('resolves a name to an id via the lookup table', async () => {
    const { client, inserted } = makeFakeClient({
      crops: [
        { id: 'crop-corn', name: 'Corn' },
        { id: 'crop-soy', name: 'Soybean' },
      ],
      plantings: [],
    })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [{ key: 'name_or_number', label: 'Field', required: true }, cropCol],
      uniqueKey: 'name_or_number',
    }
    const headers = ['Field', 'Crop']
    const mapping = autoMapHeaders(headers, config.columns)
    const rows = [['North 40', 'Corn']]

    const res = await runImport(client, config, rows, headers, mapping, { mode: 'add' })
    expect(res.added).toBe(1)
    expect(res.failed).toEqual([])
    expect(inserted.plantings[0].crop_id).toBe('crop-corn')
  })

  it('resolves through aliases (case-insensitive incoming value)', async () => {
    const { client, inserted } = makeFakeClient({
      crops: [{ id: 'crop-soy', name: 'Soybean' }],
      plantings: [],
    })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [{ key: 'name_or_number', label: 'Field', required: true }, cropCol],
      uniqueKey: 'name_or_number',
    }
    const headers = ['Field', 'Crop']
    const mapping = autoMapHeaders(headers, config.columns)
    // "Soybeans" -> alias -> "Soybean" matches the crop row.
    const res = await runImport(client, config, [['North 40', 'Soybeans']], headers, mapping, {
      mode: 'add',
    })
    expect(res.failed).toEqual([])
    expect(inserted.plantings[0].crop_id).toBe('crop-soy')
  })

  it('fails the row when an FK value cannot be resolved', async () => {
    const { client, inserted } = makeFakeClient({
      crops: [{ id: 'crop-corn', name: 'Corn' }],
      plantings: [],
    })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [{ key: 'name_or_number', label: 'Field', required: true }, cropCol],
      uniqueKey: 'name_or_number',
    }
    const headers = ['Field', 'Crop']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(client, config, [['North 40', 'Wheat']], headers, mapping, {
      mode: 'add',
    })
    // Unresolved FK -> the row is recorded as failed, nothing inserted.
    expect(res.added).toBe(0)
    expect(res.failed).toEqual([{ rowIndex: 0, reason: 'Crop "Wheat" not found' }])
    expect(inserted.plantings).toBeUndefined()
  })

  it('fails the row when an FK value matches multiple rows', async () => {
    const { client } = makeFakeClient({
      crops: [
        { id: 'crop-corn-1', name: 'Corn' },
        { id: 'crop-corn-2', name: 'corn' }, // case-insensitive duplicate
      ],
      plantings: [],
    })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [{ key: 'name_or_number', label: 'Field', required: true }, cropCol],
      uniqueKey: 'name_or_number',
    }
    const headers = ['Field', 'Crop']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(client, config, [['North 40', 'Corn']], headers, mapping, {
      mode: 'add',
    })
    expect(res.added).toBe(0)
    expect(res.failed).toEqual([{ rowIndex: 0, reason: 'Crop "Corn" matches multiple rows' }])
  })

  it('sets the FK column to null when the cell is blank and not required', async () => {
    const { client, inserted } = makeFakeClient({
      crops: [{ id: 'crop-corn', name: 'Corn' }],
      plantings: [],
    })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [{ key: 'name_or_number', label: 'Field', required: true }, cropCol],
      uniqueKey: 'name_or_number',
    }
    const headers = ['Field', 'Crop']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(client, config, [['North 40', '']], headers, mapping, {
      mode: 'add',
    })
    expect(res.added).toBe(1)
    expect(inserted.plantings[0].crop_id).toBeNull()
  })

  it('fails the row when a required FK cell is blank', async () => {
    const { client } = makeFakeClient({ crops: [{ id: 'crop-corn', name: 'Corn' }], plantings: [] })
    const requiredCrop: ColumnSpec = { ...cropCol, required: true }
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [{ key: 'name_or_number', label: 'Field' }, requiredCrop],
      uniqueKey: 'name_or_number',
    }
    const headers = ['Field', 'Crop']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(client, config, [['North 40', '']], headers, mapping, {
      mode: 'add',
    })
    expect(res.added).toBe(0)
    expect(res.failed).toEqual([{ rowIndex: 0, reason: 'Crop is required' }])
  })

  it('resolves a composite/scoped FK filtered by the resolved scope key', async () => {
    // delivery_location_id is scoped by the resolved buyer_id: two buyers each
    // own a "Elevator A" location; the scope picks the right one.
    const { client, inserted } = makeFakeClient({
      buyers: [
        { id: 'buyer-1', name: 'Cargill' },
        { id: 'buyer-2', name: 'ADM' },
      ],
      delivery_locations: [
        { id: 'loc-1', name: 'Elevator A', buyer_id: 'buyer-1' },
        { id: 'loc-2', name: 'Elevator A', buyer_id: 'buyer-2' },
      ],
      contracts: [],
    })
    const config: ImportConfig = {
      tableName: 'contracts',
      columns: [
        { key: 'contract_number', label: 'Contract', required: true },
        { key: 'buyer_id', label: 'Buyer', fk: { table: 'buyers', matchColumn: 'name' } },
        {
          key: 'delivery_location_id',
          label: 'Location',
          fk: { table: 'delivery_locations', matchColumn: 'name', scopeKey: 'buyer_id' },
        },
      ],
      uniqueKey: 'contract_number',
    }
    const headers = ['Contract', 'Buyer', 'Location']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(
      client,
      config,
      [['C-100', 'ADM', 'Elevator A']],
      headers,
      mapping,
      { mode: 'add' }
    )
    expect(res.failed).toEqual([])
    // Buyer ADM => buyer-2, so the scoped location must be loc-2 (ADM's).
    expect(inserted.contracts[0].buyer_id).toBe('buyer-2')
    expect(inserted.contracts[0].delivery_location_id).toBe('loc-2')
  })

  it('nulls a scoped FK when the scope value is unresolved', async () => {
    // Buyer is blank -> buyer_id is null -> scoped location cannot resolve and
    // is set to null (no error).
    const { client, inserted } = makeFakeClient({
      buyers: [{ id: 'buyer-1', name: 'Cargill' }],
      delivery_locations: [{ id: 'loc-1', name: 'Elevator A', buyer_id: 'buyer-1' }],
      contracts: [],
    })
    const config: ImportConfig = {
      tableName: 'contracts',
      columns: [
        { key: 'contract_number', label: 'Contract', required: true },
        { key: 'buyer_id', label: 'Buyer', fk: { table: 'buyers', matchColumn: 'name' } },
        {
          key: 'delivery_location_id',
          label: 'Location',
          fk: { table: 'delivery_locations', matchColumn: 'name', scopeKey: 'buyer_id' },
        },
      ],
      uniqueKey: 'contract_number',
    }
    const headers = ['Contract', 'Buyer', 'Location']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(
      client,
      config,
      [['C-100', '', 'Elevator A']],
      headers,
      mapping,
      { mode: 'add' }
    )
    expect(res.failed).toEqual([])
    expect(inserted.contracts[0].buyer_id).toBeNull()
    expect(inserted.contracts[0].delivery_location_id).toBeNull()
  })
})

describe('runImport — dedupe within a file', () => {
  it('handles the first occurrence of a unique key and skips later duplicates', async () => {
    const { client, inserted } = makeFakeClient({ items: [] })
    const config: ImportConfig = {
      tableName: 'items',
      columns: [{ key: 'name', required: true }, { key: 'qty', type: 'number' }],
      uniqueKey: 'name',
    }
    const headers = ['name', 'qty']
    const mapping = autoMapHeaders(headers, config.columns)
    const rows = [
      ['Widget', '1'],
      ['Widget', '2'], // duplicate key -> skipped
      ['Gadget', '3'],
    ]
    const res = await runImport(client, config, rows, headers, mapping, { mode: 'add' })
    expect(res.added).toBe(2)
    expect(res.skipped).toBe(1)
    expect(inserted.items.map((r) => r.name)).toEqual(['Widget', 'Gadget'])
  })

  it('dedupes case-insensitively (normValue lowercases + trims)', async () => {
    const { client } = makeFakeClient({ items: [] })
    const config: ImportConfig = {
      tableName: 'items',
      columns: [{ key: 'name', required: true }],
      uniqueKey: 'name',
    }
    const headers = ['name']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(
      client,
      config,
      [['Widget'], ['  widget  ']],
      headers,
      mapping,
      { mode: 'add' }
    )
    expect(res.added).toBe(1)
    expect(res.skipped).toBe(1)
  })

  it('uses a composite unique key (joined by |)', async () => {
    const { client, inserted } = makeFakeClient({ plantings: [] })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [
        { key: 'field', required: true },
        { key: 'season', type: 'number', required: true },
      ],
      uniqueKey: ['field', 'season'],
    }
    const headers = ['field', 'season']
    const mapping = autoMapHeaders(headers, config.columns)
    const rows = [
      ['North', '2025'],
      ['North', '2026'], // same field, different season -> distinct
      ['North', '2025'], // exact composite dup -> skipped
    ]
    const res = await runImport(client, config, rows, headers, mapping, { mode: 'add' })
    expect(res.added).toBe(2)
    expect(res.skipped).toBe(1)
    expect(inserted.plantings).toHaveLength(2)
  })
})

describe('runImport — add mode vs existing rows', () => {
  it('skips rows that already exist (matched by unique key) in add mode', async () => {
    const { client, inserted } = makeFakeClient({
      items: [{ id: 'item-1', name: 'Widget', qty: 5 }],
    })
    const config: ImportConfig = {
      tableName: 'items',
      columns: [{ key: 'name', required: true }, { key: 'qty', type: 'number' }],
      uniqueKey: 'name',
    }
    const headers = ['name', 'qty']
    const mapping = autoMapHeaders(headers, config.columns)
    const rows = [
      ['Widget', '99'], // exists -> skipped (not updated even though qty differs)
      ['Gadget', '3'], // new -> inserted
    ]
    const res = await runImport(client, config, rows, headers, mapping, { mode: 'add' })
    expect(res.added).toBe(1)
    expect(res.skipped).toBe(1)
    expect(res.updated).toBe(0)
    expect(inserted.items.map((r) => r.name)).toEqual(['Gadget'])
  })
})

describe('runImport — sync mode update semantics', () => {
  const config: ImportConfig = {
    tableName: 'items',
    columns: [
      { key: 'name', required: true },
      { key: 'qty', type: 'number' },
      { key: 'color' },
    ],
    uniqueKey: 'name',
  }
  const headers = ['name', 'qty', 'color']
  const mapping = autoMapHeaders(headers, config.columns)

  it('updates only provided columns whose value changed', async () => {
    const { client, updates } = makeFakeClient({
      items: [{ id: 'item-1', name: 'Widget', qty: 5, color: 'red' }],
    })
    // qty changes 5 -> 7; color provided but unchanged; name is the key.
    const res = await runImport(
      client,
      config,
      [['Widget', '7', 'red']],
      headers,
      mapping,
      { mode: 'sync' }
    )
    expect(res.updated).toBe(1)
    expect(res.unchanged).toBe(0)
    expect(updates).toHaveLength(1)
    // Only the changed column is in the patch; color (unchanged) is excluded,
    // and the unique key (name) is never patched.
    expect(updates[0].patch).toEqual({ qty: 7 })
    expect(updates[0].id).toBe('item-1')
  })

  it('never overwrites a stored value with a blank/missing incoming value', async () => {
    const { client, updates } = makeFakeClient({
      items: [{ id: 'item-1', name: 'Widget', qty: 5, color: 'red' }],
    })
    // qty blank (not provided) -> must not clear stored 5. color changes red->blue.
    const res = await runImport(
      client,
      config,
      [['Widget', '', 'blue']],
      headers,
      mapping,
      { mode: 'sync' }
    )
    expect(res.updated).toBe(1)
    expect(updates[0].patch).toEqual({ color: 'blue' })
    expect(updates[0].patch).not.toHaveProperty('qty')
  })

  it('reports an existing matched row as unchanged when no provided value differs', async () => {
    const { client, updates } = makeFakeClient({
      items: [{ id: 'item-1', name: 'Widget', qty: 5, color: 'red' }],
    })
    // All provided values equal the stored ones -> nothing to patch.
    const res = await runImport(
      client,
      config,
      [['Widget', '5', 'red']],
      headers,
      mapping,
      { mode: 'sync' }
    )
    expect(res.unchanged).toBe(1)
    expect(res.updated).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('inserts a new row in sync mode when no existing match', async () => {
    const { client, inserted } = makeFakeClient({
      items: [{ id: 'item-1', name: 'Widget', qty: 5, color: 'red' }],
    })
    const res = await runImport(
      client,
      config,
      [['Gadget', '3', 'green']],
      headers,
      mapping,
      { mode: 'sync' }
    )
    expect(res.added).toBe(1)
    expect(inserted.items[0].name).toBe('Gadget')
  })
})

describe('runImport — defaults, enums, derived, children, ignoreRowIfOnly', () => {
  it('applies a column default when the cell is blank', async () => {
    const { client, inserted } = makeFakeClient({ items: [] })
    const config: ImportConfig = {
      tableName: 'items',
      columns: [
        { key: 'name', required: true },
        { key: 'status', default: 'active' },
      ],
      uniqueKey: 'name',
    }
    const headers = ['name', 'status']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(client, config, [['Widget', '']], headers, mapping, {
      mode: 'add',
    })
    expect(res.added).toBe(1)
    expect(inserted.items[0].status).toBe('active')
  })

  it('canonicalizes an enum value and fails on an out-of-set value', async () => {
    const { client, inserted } = makeFakeClient({ items: [] })
    const config: ImportConfig = {
      tableName: 'items',
      columns: [
        { key: 'name', required: true },
        { key: 'kind', enum: ['Forward', 'HTA', 'Basis'] },
      ],
      uniqueKey: 'name',
    }
    const headers = ['name', 'kind']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(
      client,
      config,
      [
        ['A', 'forward'], // canonicalized to 'Forward'
        ['B', 'spot'], // not in enum -> failed
      ],
      headers,
      mapping,
      { mode: 'add' }
    )
    expect(inserted.items[0].kind).toBe('Forward')
    expect(res.failed).toEqual([
      { rowIndex: 1, reason: 'kind must be one of: Forward, HTA, Basis' },
    ])
  })

  it('fails a row whose number column is not numeric', async () => {
    const { client } = makeFakeClient({ items: [] })
    const config: ImportConfig = {
      tableName: 'items',
      columns: [{ key: 'name', required: true }, { key: 'qty', type: 'number' }],
      uniqueKey: 'name',
    }
    const headers = ['name', 'qty']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(client, config, [['Widget', 'abc']], headers, mapping, {
      mode: 'add',
    })
    expect(res.added).toBe(0)
    expect(res.failed).toEqual([{ rowIndex: 0, reason: 'qty is not a number' }])
  })

  it('writes derived columns on insert', async () => {
    const { client, inserted } = makeFakeClient({ plantings: [] })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [
        { key: 'name', required: true },
        { key: 'planted', type: 'number' },
        { key: 'irrigated', type: 'number' },
      ],
      uniqueKey: 'name',
      derive: (row) => ({
        dryland: Number(row.planted ?? 0) - Number(row.irrigated ?? 0),
      }),
    }
    const headers = ['name', 'planted', 'irrigated']
    const mapping = autoMapHeaders(headers, config.columns)
    const res = await runImport(
      client,
      config,
      [['North', '100', '40']],
      headers,
      mapping,
      { mode: 'add' }
    )
    expect(res.added).toBe(1)
    expect(inserted.plantings[0].dryland).toBe(60)
  })

  it('recomputes derived columns on a sync update from existing overlaid with changes', async () => {
    const { client, updates } = makeFakeClient({
      plantings: [{ id: 'p-1', name: 'North', planted: 100, irrigated: 40, dryland: 60 }],
    })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [
        { key: 'name', required: true },
        { key: 'planted', type: 'number' },
        { key: 'irrigated', type: 'number' },
        { key: 'dryland', type: 'number' },
      ],
      uniqueKey: 'name',
      derive: (row) => ({
        dryland: Number(row.planted ?? 0) - Number(row.irrigated ?? 0),
      }),
    }
    const headers = ['name', 'planted', 'irrigated']
    const mapping = autoMapHeaders(headers, config.columns)
    // Only planted changes to 120 (irrigated blank, not provided). derive runs on
    // {existing, ...patch} = planted 120, irrigated 40 -> dryland 80.
    const res = await runImport(
      client,
      config,
      [['North', '120', '']],
      headers,
      mapping,
      { mode: 'sync' }
    )
    expect(res.updated).toBe(1)
    expect(updates[0].patch.planted).toBe(120)
    expect(updates[0].patch.dryland).toBe(80)
  })

  it('writes child rows linked to the inserted parent, including split + amount', async () => {
    const { client, inserted } = makeFakeClient({ plantings: [] })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [
        { key: 'name', required: true },
        {
          key: 'varieties',
          child: {
            table: 'planting_varieties',
            valueColumn: 'variety',
            parentKey: 'planting_id',
            splitOn: ',;',
            amountColumn: 'acres',
          },
        },
      ],
      uniqueKey: 'name',
    }
    const headers = ['name', 'varieties']
    const mapping = autoMapHeaders(headers, config.columns)
    // "P2089:70, DKC65-95" -> two child rows; first carries acres 70.
    const res = await runImport(
      client,
      config,
      [['North', 'P2089:70, DKC65-95']],
      headers,
      mapping,
      { mode: 'add' }
    )
    expect(res.added).toBe(1)
    expect(res.failed).toEqual([])
    // The child column is NOT written to the parent table.
    expect(inserted.plantings[0]).not.toHaveProperty('varieties')
    const parentId = inserted.plantings[0].id ?? `plantings-new-1`
    const kids = inserted.planting_varieties
    expect(kids).toHaveLength(2)
    expect(kids[0]).toEqual({ planting_id: 'plantings-new-1', variety: 'P2089', acres: 70 })
    expect(kids[1]).toEqual({ planting_id: 'plantings-new-1', variety: 'DKC65-95' })
    void parentId
  })

  it('rewrites child values via childValueTransform and coalesces same-name rows, summing acres', async () => {
    const { client, inserted } = makeFakeClient({ plantings: [] })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [
        { key: 'name', required: true },
        {
          key: 'varieties',
          child: {
            table: 'planting_varieties',
            valueColumn: 'variety',
            parentKey: 'planting_id',
            splitOn: ',;',
            amountColumn: 'acres',
          },
        },
      ],
      uniqueKey: 'name',
    }
    const headers = ['name', 'varieties']
    const mapping = autoMapHeaders(headers, config.columns)
    // Two format variants of one variety in a single cell: after the transform
    // maps both to the canonical spelling, they must collapse into ONE child
    // row with summed acres — a file can't create its own duplicates.
    const res = await runImport(
      client,
      config,
      [['North', 'DG3644B3XF:40; DG 3644 B3XF:60']],
      headers,
      mapping,
      {
        mode: 'add',
        childValueTransform: (columnKey, value) =>
          columnKey === 'varieties' && value.replace(/[\s\-.]/g, '').toUpperCase() === 'DG3644B3XF'
            ? 'DG 3644 B3XF'
            : value,
      }
    )
    expect(res.added).toBe(1)
    expect(inserted.planting_varieties).toEqual([
      { planting_id: 'plantings-new-1', variety: 'DG 3644 B3XF', acres: 100 },
    ])
  })

  it('extractChildValues reports each row’s child names with its alias-canonicalized scope', () => {
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [
        { key: 'field', required: true },
        { key: 'crop_id', label: 'crop', fk: { table: 'crops', matchColumn: 'name', aliases: { soybeans: 'Soybean' } } },
        {
          key: 'variety',
          child: {
            table: 'planting_varieties',
            valueColumn: 'variety',
            parentKey: 'planting_id',
            splitOn: ',;',
            amountColumn: 'acres',
          },
        },
      ],
      uniqueKey: 'field',
      ignoreRowIfOnly: ['field'],
      resolution: {
        columnKey: 'variety',
        scopeKey: 'crop_id',
        noun: 'variety',
        loadExisting: async () => new Map(),
      },
    }
    const headers = ['field', 'crop', 'variety']
    const mapping = autoMapHeaders(headers, config.columns)
    const out = extractChildValues(
      config,
      [
        ['North', 'Soybeans', 'AG38X8:50; P 31A22:40'], // alias → Soybean; amounts stripped
        ['South', 'Corn', 'P2089'],
        ['West', '', ''], // ignoreRowIfOnly: untouched template row, skipped
      ],
      headers,
      mapping
    )
    expect(out).toEqual([
      { rowIndex: 0, scope: 'Soybean', names: ['AG38X8', 'P 31A22'] },
      { rowIndex: 1, scope: 'Corn', names: ['P2089'] },
    ])
  })

  it('ignores rows whose only non-empty cells are ignoreRowIfOnly columns', async () => {
    const { client, inserted } = makeFakeClient({ plantings: [] })
    const config: ImportConfig = {
      tableName: 'plantings',
      columns: [
        { key: 'field', required: true },
        { key: 'season', type: 'number' },
        { key: 'planted', type: 'number' },
      ],
      uniqueKey: ['field', 'season'],
      ignoreRowIfOnly: ['field', 'season'],
    }
    const headers = ['field', 'season', 'planted']
    const mapping = autoMapHeaders(headers, config.columns)
    const rows = [
      ['North', '2026', ''], // only seed cols -> ignored (no add, no fail)
      ['South', '2026', '50'], // has extra data -> inserted
    ]
    const res = await runImport(client, config, rows, headers, mapping, { mode: 'add' })
    expect(res.added).toBe(1)
    expect(res.failed).toEqual([])
    expect(inserted.plantings.map((r) => r.field)).toEqual(['South'])
  })
})

describe('runImport — result accounting', () => {
  it('returns a fully-shaped ImportResult', async () => {
    const { client } = makeFakeClient({ items: [] })
    const config: ImportConfig = {
      tableName: 'items',
      columns: [{ key: 'name', required: true }],
      uniqueKey: 'name',
    }
    const headers = ['name']
    const mapping = autoMapHeaders(headers, config.columns)
    const res: ImportResult = await runImport(
      client,
      config,
      [['A'], ['B']],
      headers,
      mapping,
      { mode: 'add' }
    )
    expect(res).toEqual({ added: 2, updated: 0, unchanged: 0, skipped: 0, failed: [] })
  })
})
