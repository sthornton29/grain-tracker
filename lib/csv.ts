import type { SupabaseClient } from '@supabase/supabase-js'

// ---------- Parser (RFC 4180-ish) ----------

export type ParsedCsv = { headers: string[]; rows: string[][] }

export function parseCsv(text: string): ParsedCsv {
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length
  while (i < len) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') {
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      i++; continue
    }
    field += c; i++
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }

  const headers = (rows.shift() ?? []).map((h) => h.trim())
  const dataRows = rows
    .map((r) => r.map((v) => v.trim()))
    .filter((r) => r.some((v) => v !== ''))
  return { headers, rows: dataRows }
}

// ---------- Config ----------

export type ColumnType = 'text' | 'number' | 'date'

export type ColumnSpec = {
  /** Database column name. */
  key: string
  /** Friendly label used for header auto-matching (defaults to key). */
  label?: string
  required?: boolean
  type?: ColumnType
  /** Optional default value when the row has no value for this column. */
  default?: string | number | null
  /** Allowed literal values (case-insensitive match, canonicalized to lowercase). */
  enum?: string[]
  /** Foreign key: look up an id in another table by matching a column. */
  fk?: {
    table: string
    /** Column on the FK table to match against. */
    matchColumn: string
    /**
     * If set, the FK lookup is composite — it also filters by the payload
     * value of `scopeKey` on the row being imported (e.g. delivery_location_id
     * is scoped by the resolved buyer_id). Left blank for simple FK.
     */
    scopeKey?: string
  }
  /**
   * Child relation: this column is NOT written to the main table. After the
   * parent row is inserted, a non-empty value is written to a child table,
   * linked by `parentKey` (e.g. a planting's variety → field_planting_varieties).
   * Empty values create no child row.
   */
  child?: {
    table: string
    /** Column on the child table that holds this value (e.g. 'variety'). */
    valueColumn: string
    /** Column on the child table that points back to the parent (e.g. 'planting_id'). */
    parentKey: string
  }
}

export type ImportConfig = {
  tableName: string
  columns: ColumnSpec[]
  /** One or more DB column names that together identify a row for dedup. */
  uniqueKey: string | string[]
  /** Optional friendly label for the importer panel title. */
  title?: string
}

export type ImportResult = {
  /** Rows that didn't match an existing record and were inserted. */
  added: number
  /** Existing rows (matched by unique key) that had a changed value updated. */
  updated: number
  /** Existing rows that matched but had no provided value different from what's stored. */
  unchanged: number
  /** Rows skipped (existing rows in add-only mode, or a duplicate key within the file). */
  skipped: number
  failed: Array<{ rowIndex: number; reason: string }>
}

/** add  = insert new, leave existing untouched (skip them).
 *  sync = insert new, and update existing rows where a provided value changed
 *         (blank/missing incoming values never overwrite stored data). */
export type ImportMode = 'add' | 'sync'

// ---------- Runner ----------

function normHeader(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function autoMapHeaders(headers: string[], columns: ColumnSpec[]): Record<string, string> {
  // key → csv header (exact string from CSV)
  const map: Record<string, string> = {}
  const normalized = headers.map((h) => ({ raw: h, norm: normHeader(h) }))
  for (const col of columns) {
    const candidates = [col.label, col.key].filter(Boolean) as string[]
    const normCandidates = candidates.map(normHeader)
    const hit = normalized.find((h) => normCandidates.includes(h.norm))
    if (hit) map[col.key] = hit.raw
  }
  return map
}

type AnyRow = Record<string, unknown>

async function fetchLookup(
  supabase: SupabaseClient,
  table: string,
  matchColumn: string,
  extraColumns: string[] = []
) {
  const cols = ['id', matchColumn, ...extraColumns].join(',')
  const { data, error } = await supabase.from(table).select(cols)
  if (error) throw new Error(`Could not read ${table}: ${error.message}`)
  return ((data as unknown) as AnyRow[]) || []
}

function coerceValue(raw: string, spec: ColumnSpec): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') {
    if (spec.default !== undefined) return spec.default
    return null
  }
  if (spec.enum) {
    const hit = spec.enum.find((v) => v.toLowerCase() === trimmed.toLowerCase())
    if (!hit) throw new Error(`${spec.label ?? spec.key} must be one of: ${spec.enum.join(', ')}`)
    return hit
  }
  switch (spec.type) {
    case 'number': {
      const n = Number(trimmed)
      if (!Number.isFinite(n)) throw new Error(`${spec.label ?? spec.key} is not a number`)
      return n
    }
    case 'date': {
      // Pass through as-is; Postgres parses ISO and most common forms.
      return trimmed
    }
    default:
      return trimmed
  }
}

export async function runImport(
  supabase: SupabaseClient,
  config: ImportConfig,
  csvRows: string[][],
  headers: string[],
  mapping: Record<string, string>,
  opts: { mode: ImportMode }
): Promise<ImportResult> {
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey]
  const mode = opts.mode

  // Pre-fetch FK lookup tables.
  const fkTables = new Map<string, AnyRow[]>()
  for (const col of config.columns) {
    if (col.fk && !fkTables.has(col.fk.table)) {
      const extra = col.fk.scopeKey ? [col.fk.scopeKey] : []
      fkTables.set(col.fk.table, await fetchLookup(supabase, col.fk.table, col.fk.matchColumn, extra))
    }
  }

  // Pre-fetch existing rows (id + unique keys + importable columns) so we can
  // match by unique key and, in sync mode, detect which fields changed.
  const mainKeys = config.columns.filter((c) => !c.child).map((c) => c.key)
  const selectCols = Array.from(new Set(['id', ...uniqueKeys, ...mainKeys]))
  const existingRes = await supabase.from(config.tableName).select(selectCols.join(','))
  if (existingRes.error) throw new Error(`Could not read ${config.tableName}: ${existingRes.error.message}`)
  const existing = ((existingRes.data as unknown) as AnyRow[]) || []
  const existingByKey = new Map<string, AnyRow>()
  for (const r of existing) existingByKey.set(uniqueKeys.map((k) => normValue(r[k])).join('|'), r)

  const headerIndex = new Map<string, number>()
  headers.forEach((h, i) => headerIndex.set(h, i))

  type ChildValue = { table: string; parentKey: string; valueColumn: string; value: unknown }
  const failed: ImportResult['failed'] = []
  const toInsert: AnyRow[] = []
  const toInsertChildren: ChildValue[][] = []
  const toInsertCsvRow: number[] = []
  const toUpdate: Array<{ id: string; patch: AnyRow; rowIndex: number }> = []
  const seenKeys = new Set<string>()
  let skipped = 0
  let unchanged = 0

  for (let i = 0; i < csvRows.length; i++) {
    const csvRow = csvRows[i]
    try {
      const payload: AnyRow = {}
      const children: ChildValue[] = []
      // Columns whose incoming cell actually had a value. In sync mode only
      // these can update an existing row, so blanks never overwrite stored data.
      const provided = new Set<string>()
      for (const col of config.columns) {
        const csvHeader = mapping[col.key]
        const idx = csvHeader ? headerIndex.get(csvHeader) ?? -1 : -1
        const raw = idx >= 0 ? (csvRow[idx] ?? '') : ''
        const hasRaw = raw.trim() !== ''
        if (col.fk) {
          const value = raw.trim()
          if (!value) {
            if (col.required) throw new Error(`${col.label ?? col.key} is required`)
            payload[col.key] = null
            continue
          }
          const lookupRows = fkTables.get(col.fk.table) || []
          let candidates = lookupRows.filter(
            (r) => String(r[col.fk!.matchColumn] ?? '').toLowerCase() === value.toLowerCase()
          )
          if (col.fk.scopeKey && candidates.length > 0) {
            const scopeVal = payload[col.fk.scopeKey]
            if (scopeVal == null) {
              // Can't resolve without the scope value set.
              payload[col.key] = null
              continue
            }
            candidates = candidates.filter((r) => r[col.fk!.scopeKey!] === scopeVal)
          }
          if (candidates.length === 0) {
            throw new Error(`${col.label ?? col.key} "${value}" not found`)
          }
          if (candidates.length > 1) {
            throw new Error(`${col.label ?? col.key} "${value}" matches multiple rows`)
          }
          payload[col.key] = candidates[0].id
          provided.add(col.key)
        } else {
          const v = coerceValue(raw, col)
          if (col.required && (v === null || v === '')) throw new Error(`${col.label ?? col.key} is required`)
          if (col.child) {
            if (v != null && String(v).trim() !== '') {
              children.push({ table: col.child.table, parentKey: col.child.parentKey, valueColumn: col.child.valueColumn, value: v })
            }
          } else {
            payload[col.key] = v
            if (hasRaw) provided.add(col.key)
          }
        }
      }

      const dedupKey = uniqueKeys.map((k) => normValue(payload[k])).join('|')

      // The same unique key twice in one file: handle the first, skip the rest.
      if (seenKeys.has(dedupKey)) { skipped++; continue }
      seenKeys.add(dedupKey)

      const existingRow = existingByKey.get(dedupKey)
      if (existingRow) {
        if (mode === 'add') { skipped++; continue }
        // sync: patch only the provided columns whose value differs from stored.
        const patch: AnyRow = {}
        for (const key of provided) {
          if (uniqueKeys.includes(key)) continue
          if (normValue(payload[key]) !== normValue(existingRow[key])) patch[key] = payload[key]
        }
        if (Object.keys(patch).length === 0) { unchanged++; continue }
        toUpdate.push({ id: String(existingRow.id), patch, rowIndex: i })
        continue
      }

      toInsert.push(payload)
      toInsertChildren.push(children)
      toInsertCsvRow.push(i)
    } catch (err: any) {
      failed.push({ rowIndex: i, reason: err?.message ?? String(err) })
    }
  }

  let added = 0
  if (toInsert.length > 0) {
    // Each inserted parent's id, aligned with toInsert, so child rows can be
    // linked back. Supabase preserves input order in the returned rows.
    const insertedIds: Array<string | null> = new Array(toInsert.length).fill(null)
    // Insert in a single batch when possible.
    const { data: batchData, error } = await supabase.from(config.tableName).insert(toInsert).select('id')
    if (error) {
      // Fall back to per-row inserts so partial progress still saves.
      for (let j = 0; j < toInsert.length; j++) {
        const { data: oneData, error: e2 } = await supabase.from(config.tableName).insert(toInsert[j]).select('id').single()
        if (e2 || !oneData) {
          failed.push({ rowIndex: toInsertCsvRow[j], reason: e2?.message ?? 'Insert failed' })
        } else {
          insertedIds[j] = (oneData as { id: string }).id
          added++
        }
      }
    } else {
      const ids = (batchData as Array<{ id: string }> | null) ?? []
      for (let j = 0; j < toInsert.length; j++) insertedIds[j] = ids[j]?.id ?? null
      added = toInsert.length
    }

    // Insert child rows (e.g. a planting's variety) for inserted parents.
    const childRows = new Map<string, AnyRow[]>()
    for (let j = 0; j < toInsert.length; j++) {
      const pid = insertedIds[j]
      if (!pid) continue
      for (const ch of toInsertChildren[j]) {
        const list = childRows.get(ch.table) ?? []
        list.push({ [ch.parentKey]: pid, [ch.valueColumn]: ch.value })
        childRows.set(ch.table, list)
      }
    }
    for (const [table, rows] of childRows) {
      if (rows.length === 0) continue
      const { error: cErr } = await supabase.from(table).insert(rows)
      if (cErr) failed.push({ rowIndex: -1, reason: `${table}: ${cErr.message}` })
    }
  }

  // ---- Updates (sync mode): patch only the changed columns of matched rows. ----
  let updated = 0
  for (const u of toUpdate) {
    const { error } = await supabase.from(config.tableName).update(u.patch).eq('id', u.id)
    if (error) failed.push({ rowIndex: u.rowIndex, reason: error.message })
    else updated++
  }

  return { added, updated, unchanged, skipped, failed }
}

function normValue(v: unknown): string {
  if (v == null) return ''
  return String(v).trim().toLowerCase()
}
