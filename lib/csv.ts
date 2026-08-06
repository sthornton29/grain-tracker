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
  /**
   * Lookup-only column: its value participates in resolution (e.g. as an fk
   * scopeKey — the farms import's state column disambiguating counties) but
   * is NEVER written to the table. Stripped after derive() runs.
   */
  virtual?: boolean
  /** Foreign key: look up an id in another table by matching a column. */
  fk?: {
    table: string
    /** Column on the FK table to match against. */
    matchColumn: string
    /**
     * If set, the FK lookup is composite — it also filters by the payload
     * value of `scopeKey` on the row being imported (e.g. delivery_location_id
     * is scoped by the resolved buyer_id; county_id by the state column).
     * Scope values compare trimmed + case-insensitively.
     */
    scopeKey?: string
    /**
     * With scopeKey: a value in THIS column with no scope value fails the row
     * (scopeMissingError) instead of silently resolving to null — counties
     * must never match on name alone (a bare "Lawrence" is ambiguous).
     */
    scopeRequired?: boolean
    scopeMissingError?: string
    /**
     * Normalizer applied to BOTH sides of the match-column comparison (e.g.
     * normalizeCountyName so "Lawrence County" ≡ "LAWRENCE" ≡ "Lawrence").
     * Defaults to trim + lowercase.
     */
    normalizeMatch?: (value: string) => string
    /**
     * Synonyms: lowercased incoming value → the canonical value to match on.
     * e.g. { soybeans: 'Soybean', beans: 'Soybean' } so a CSV "Soybeans" maps to
     * the "Soybean" crop.
     */
    aliases?: Record<string, string>
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
    /** When set, the cell may list several values separated by any of these
     *  characters (newlines always split too) — each becomes its own child row.
     *  e.g. ",;" lets "P2089, DKC65-95" create two variety rows. */
    splitOn?: string
    /** When set, an inline "name:amount" (or "name=amount") puts the amount into
     *  this child column — e.g. a variety's acres in "P2089:70". */
    amountColumn?: string
  }
}

/** Content for a styled, two-sheet Excel import template. */
export type ImportTemplate = {
  /** Title shown across the top of the Instructions sheet. */
  title: string
  /** Overview paragraphs explaining the import at a high level. */
  overview?: string[]
  /** Per-column guidance, keyed by ColumnSpec.key (shown in a Columns table). */
  help?: Record<string, string>
  /** Short tips/gotchas highlighted under the column table. */
  tips?: string[]
  /** Worked example rows, each aligned to the column order, shown for reference. */
  examples?: string[][]
  /**
   * Rows to pre-fill on the Data sheet, each keyed by ColumnSpec.key (e.g. one
   * row per existing field carrying its name and the current year). Columns not
   * listed are left blank for the user to complete. Pair with
   * ImportConfig.ignoreRowIfOnly so untouched pre-filled rows are ignored.
   */
  dataRows?: Array<Record<string, string>>
}

/**
 * Resolution of a child column's values against existing names (the variety
 * pipeline): the importer preview resolves each incoming value per scope
 * (e.g. per crop) into matched / possible-match / new via
 * lib/variety-resolution, blocks the import until possible matches are
 * decided, and rewrites values through runImport's childValueTransform.
 */
export type ChildResolution = {
  /** Column key (must be a `child` column) whose values get resolved. */
  columnKey: string
  /** Column key whose FK id scopes the existing-name set (e.g. crop_id). */
  scopeKey: string
  /** What the values are, for UI copy (e.g. "variety"). */
  noun: string
  /** Existing names keyed by the scope column's FK id. */
  loadExisting: (supabase: SupabaseClient) => Promise<Map<string, string[]>>
  /** Optional "keep both" dismissals keyed by the scope FK id — sets of
   *  dismissalKey() pairs that must never re-flag as possible matches. */
  loadDismissed?: (supabase: SupabaseClient) => Promise<Map<string, Set<string>>>
}

export type ImportConfig = {
  tableName: string
  columns: ColumnSpec[]
  /** One or more DB column names that together identify a row for dedup. */
  uniqueKey: string | string[]
  /** Optional friendly label for the importer panel title. */
  title?: string
  /** Optional note shown in the importer panel (e.g. how to format a column). */
  note?: string
  /**
   * Optional rich template content. When present, the importer offers a styled
   * two-sheet Excel template (an Instructions sheet + a Data sheet) instead of a
   * plain CSV header file. See downloadExcelTemplate in lib/import-template.
   */
  template?: ImportTemplate
  /**
   * Column keys that the template pre-fills (e.g. ['field_id', 'season_year']).
   * A data row whose only non-empty cells are these columns is ignored on
   * import, so untouched pre-filled rows don't create or change anything.
   */
  ignoreRowIfOnly?: string[]
  /**
   * Optional post-processing: given a row's resolved values, return extra/derived
   * columns to write (e.g. dryland_acres = planted - irrigated). On a sync update
   * it receives the existing row overlaid with the changed values, so derived
   * fields stay consistent with whatever was actually provided.
   */
  derive?: (row: Record<string, unknown>) => Record<string, unknown>
  /** When set, the importer runs this child column's values through the
   *  name-resolution pipeline before saving (see ChildResolution). */
  resolution?: ChildResolution
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

// Parse a child-relation cell into one or more child rows. With splitOn the cell
// is split into pieces (newlines always split too); with amountColumn an inline
// "name:amount" / "name=amount" puts the amount into that column.
function parseChildCell(raw: string, child: NonNullable<ColumnSpec['child']>): AnyRow[] {
  const s = raw.trim()
  if (s === '') return []
  const pieces = child.splitOn
    ? s.split(new RegExp(`[${child.splitOn}\\r\\n]+`)).map((p) => p.trim()).filter((p) => p !== '')
    : [s]
  const out: AnyRow[] = []
  for (const piece of pieces) {
    let name = piece
    let amount: number | null = null
    if (child.amountColumn) {
      const m = piece.match(/^(.+?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*$/)
      if (m) { name = m[1].trim(); amount = Number(m[2]) }
    }
    name = name.trim()
    if (name === '') continue
    const row: AnyRow = { [child.valueColumn]: name }
    if (child.amountColumn && amount != null && Number.isFinite(amount)) row[child.amountColumn] = amount
    out.push(row)
  }
  return out
}

export type ChildValueRow = { rowIndex: number; scope: string; names: string[] }

/**
 * Pure preview-side extraction for ChildResolution: each data row's child-column
 * names (amounts stripped) plus its scope cell value (aliases applied, e.g.
 * "soybeans" → "Soybean"). Skips rows the import itself would ignore
 * (ignoreRowIfOnly), so the resolution summary reflects what will actually save.
 */
export function extractChildValues(
  config: ImportConfig,
  csvRows: string[][],
  headers: string[],
  mapping: Record<string, string>,
): ChildValueRow[] {
  const res = config.resolution
  if (!res) return []
  const col = config.columns.find((c) => c.key === res.columnKey)
  const scopeCol = config.columns.find((c) => c.key === res.scopeKey)
  if (!col?.child) return []

  const headerIndex = new Map<string, number>()
  headers.forEach((h, i) => headerIndex.set(h, i))
  const cellFor = (row: string[], key: string): string => {
    const csvHeader = mapping[key]
    const idx = csvHeader ? headerIndex.get(csvHeader) ?? -1 : -1
    return idx >= 0 ? (row[idx] ?? '') : ''
  }

  const ignoreOnly = config.ignoreRowIfOnly ?? []
  const out: ChildValueRow[] = []
  for (let i = 0; i < csvRows.length; i++) {
    const csvRow = csvRows[i]
    if (ignoreOnly.length > 0) {
      let hasExtra = false
      for (const c of config.columns) {
        if (ignoreOnly.includes(c.key)) continue
        if (cellFor(csvRow, c.key).trim() !== '') { hasExtra = true; break }
      }
      if (!hasExtra) continue
    }
    const names = parseChildCell(cellFor(csvRow, res.columnKey), col.child)
      .map((r) => String(r[col.child!.valueColumn] ?? ''))
      .filter((n) => n !== '')
    if (names.length === 0) continue
    const scopeRaw = cellFor(csvRow, res.scopeKey).trim()
    const scope = scopeCol?.fk?.aliases?.[scopeRaw.toLowerCase()] ?? scopeRaw
    out.push({ rowIndex: i, scope, names })
  }
  return out
}

export async function runImport(
  supabase: SupabaseClient,
  config: ImportConfig,
  csvRows: string[][],
  headers: string[],
  mapping: Record<string, string>,
  opts: {
    mode: ImportMode
    /** Rewrite a child column's value before insert (the variety-resolution
     *  pipeline maps each incoming spelling to its resolved canonical name). */
    childValueTransform?: (columnKey: string, value: string, rowIndex: number) => string
  }
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
  // Virtual columns are lookup-only — they don't exist on the target table.
  const mainKeys = config.columns.filter((c) => !c.child && !c.virtual).map((c) => c.key)
  const selectCols = Array.from(new Set(['id', ...uniqueKeys, ...mainKeys]))
  const existingRes = await supabase.from(config.tableName).select(selectCols.join(','))
  if (existingRes.error) throw new Error(`Could not read ${config.tableName}: ${existingRes.error.message}`)
  const existing = ((existingRes.data as unknown) as AnyRow[]) || []
  const existingByKey = new Map<string, AnyRow>()
  for (const r of existing) existingByKey.set(uniqueKeys.map((k) => normValue(r[k])).join('|'), r)

  // Existing child rows per child table, grouped by parent id — so sync mode
  // can ADD child values a matched row doesn't carry yet (e.g. a variety the
  // planting is missing). Existing child rows are never modified or removed.
  const existingChildrenByParent = new Map<string, Map<string, AnyRow[]>>()
  for (const col of config.columns) {
    const ch = col.child
    if (!ch || existingChildrenByParent.has(ch.table)) continue
    const res = await supabase.from(ch.table).select('*')
    if (res.error) throw new Error(`Could not read ${ch.table}: ${res.error.message}`)
    const byParent = new Map<string, AnyRow[]>()
    for (const r of ((res.data as unknown) as AnyRow[]) || []) {
      const pid = String(r[ch.parentKey] ?? '')
      if (!pid) continue
      const list = byParent.get(pid) ?? []
      list.push(r)
      byParent.set(pid, list)
    }
    existingChildrenByParent.set(ch.table, byParent)
  }

  const headerIndex = new Map<string, number>()
  headers.forEach((h, i) => headerIndex.set(h, i))

  type ChildValue = { table: string; parentKey: string; valueColumn: string; row: AnyRow }
  const failed: ImportResult['failed'] = []
  const toInsert: AnyRow[] = []
  const toInsertChildren: ChildValue[][] = []
  const toInsertCsvRow: number[] = []
  const toUpdate: Array<{ id: string; patch: AnyRow; rowIndex: number; childAdds: ChildValue[] }> = []
  const seenKeys = new Set<string>()
  let skipped = 0
  let unchanged = 0

  const ignoreOnly = config.ignoreRowIfOnly ?? []
  for (let i = 0; i < csvRows.length; i++) {
    const csvRow = csvRows[i]
    // Ignore rows that carry only pre-filled seed values (e.g. a template row
    // with just the field name + season year the user never completed). They
    // shouldn't create or touch anything, and shouldn't be reported as errors.
    if (ignoreOnly.length > 0) {
      let hasExtra = false
      for (const col of config.columns) {
        if (ignoreOnly.includes(col.key)) continue
        const csvHeader = mapping[col.key]
        const idx = csvHeader ? headerIndex.get(csvHeader) ?? -1 : -1
        if (idx >= 0 && (csvRow[idx] ?? '').trim() !== '') { hasExtra = true; break }
      }
      if (!hasExtra) continue
    }
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
          const matchVal = col.fk.aliases?.[value.toLowerCase()] ?? value
          const norm = col.fk.normalizeMatch ?? ((s: string) => s.trim().toLowerCase())
          const lookupRows = fkTables.get(col.fk.table) || []
          let candidates = lookupRows.filter(
            (r) => norm(String(r[col.fk!.matchColumn] ?? '')) === norm(matchVal)
          )
          let scopeStr: string | null = null
          if (col.fk.scopeKey) {
            const scopeVal = payload[col.fk.scopeKey]
            scopeStr = scopeVal == null ? '' : String(scopeVal).trim()
            if (scopeStr === '') {
              if (col.fk.scopeRequired) {
                throw new Error(col.fk.scopeMissingError ?? `${col.label ?? col.key} "${value}" needs a ${col.fk.scopeKey} value`)
              }
              // Legacy composite FKs: can't resolve without the scope value.
              payload[col.key] = null
              continue
            }
            candidates = candidates.filter(
              (r) => String(r[col.fk!.scopeKey!] ?? '').trim().toLowerCase() === scopeStr!.toLowerCase()
            )
          }
          if (candidates.length === 0) {
            throw new Error(`${col.label ?? col.key} "${value}"${scopeStr ? ` (${scopeStr})` : ''} not found`)
          }
          if (candidates.length > 1) {
            throw new Error(`${col.label ?? col.key} "${value}"${scopeStr ? ` (${scopeStr})` : ''} matches multiple rows`)
          }
          payload[col.key] = candidates[0].id
          provided.add(col.key)
        } else {
          const v = coerceValue(raw, col)
          if (col.required && (v === null || v === '')) throw new Error(`${col.label ?? col.key} is required`)
          if (col.child) {
            const child = col.child
            const parsed = parseChildCell(raw, child)
            if (opts.childValueTransform) {
              for (const childRow of parsed) {
                const v = childRow[child.valueColumn]
                if (typeof v === 'string') childRow[child.valueColumn] = opts.childValueTransform(col.key, v, i)
              }
            }
            // Coalesce values that resolved to the same name (e.g. two format
            // variants of one variety in the same cell), summing amounts so a
            // single row can't create its own duplicates.
            const byValue = new Map<string, AnyRow>()
            for (const childRow of parsed) {
              const valueKey = normValue(childRow[child.valueColumn])
              const prior = byValue.get(valueKey)
              if (!prior) { byValue.set(valueKey, childRow); continue }
              if (child.amountColumn) {
                const a = prior[child.amountColumn]
                const b = childRow[child.amountColumn]
                if (a != null || b != null) prior[child.amountColumn] = (Number(a) || 0) + (Number(b) || 0)
              }
            }
            for (const childRow of byValue.values()) {
              children.push({ table: child.table, parentKey: child.parentKey, valueColumn: child.valueColumn, row: childRow })
            }
          } else {
            payload[col.key] = v
            if (hasRaw) provided.add(col.key)
          }
        }
      }

      // Derived columns (e.g. dryland = planted - irrigated) for the insert path.
      if (config.derive) Object.assign(payload, config.derive(payload))

      // Lookup-only columns did their job (fk scoping) — never write them.
      for (const col of config.columns) {
        if (col.virtual) { delete payload[col.key]; provided.delete(col.key) }
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
        // Child values (varieties) the matched row doesn't already carry are
        // ADDED on sync — a row identical except for its child values is an
        // update, never "unchanged". Values compare post-resolution (the
        // transform already mapped format variants onto stored spellings), so
        // an already-present variety never duplicates.
        const childAdds = children.filter((ch) => {
          const have = existingChildrenByParent.get(ch.table)?.get(String(existingRow.id)) ?? []
          return !have.some((h) => normValue(h[ch.valueColumn]) === normValue(ch.row[ch.valueColumn]))
        })
        if (Object.keys(patch).length === 0 && childAdds.length === 0) { unchanged++; continue }
        // Recompute derived columns from the existing row overlaid with the
        // changes, so e.g. dryland tracks a changed planted/irrigated.
        if (Object.keys(patch).length > 0 && config.derive) Object.assign(patch, config.derive({ ...existingRow, ...patch }))
        toUpdate.push({ id: String(existingRow.id), patch, rowIndex: i, childAdds })
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
        list.push({ [ch.parentKey]: pid, ...ch.row })
        childRows.set(ch.table, list)
      }
    }
    for (const [table, rows] of childRows) {
      if (rows.length === 0) continue
      const { error: cErr } = await supabase.from(table).insert(rows)
      if (cErr) failed.push({ rowIndex: -1, reason: `${table}: ${cErr.message}` })
    }
  }

  // ---- Updates (sync mode): patch changed columns and add missing child
  // rows (a variety-only change carries an empty patch — children still land). ----
  let updated = 0
  for (const u of toUpdate) {
    if (Object.keys(u.patch).length > 0) {
      const { error } = await supabase.from(config.tableName).update(u.patch).eq('id', u.id)
      if (error) { failed.push({ rowIndex: u.rowIndex, reason: error.message }); continue }
    }
    let ok = true
    for (const ch of u.childAdds) {
      const { error: cErr } = await supabase.from(ch.table).insert({ [ch.parentKey]: u.id, ...ch.row })
      if (cErr) { failed.push({ rowIndex: u.rowIndex, reason: `${ch.table}: ${cErr.message}` }); ok = false }
    }
    if (ok) updated++
  }

  return { added, updated, unchanged, skipped, failed }
}

function normValue(v: unknown): string {
  if (v == null) return ''
  return String(v).trim().toLowerCase()
}
