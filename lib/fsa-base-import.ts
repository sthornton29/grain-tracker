// Pure merge logic for the FSA base-acres AI import.
//
// FSA documents naturally repeat a farm × commodity: the same commodity on
// multiple tracts of one farm, existing-base + newly-allocated-base lines
// (Base Allocation Summary), a farm spanning page batches, or duplicate AI
// extraction. farm_base_acres is unique on (farm_id, commodity_id), and a
// single upsert batch containing two rows on one key fails with Postgres's
// "ON CONFLICT DO UPDATE command cannot affect row a second time" — so
// duplicate lines are merged here BEFORE they reach the review screen, and
// planBaseAcreSaves re-checks the final batch as a backstop against
// duplicates the user re-creates while editing.

export type FsaMergeLine = {
  /**
   * Commodity identity within one farm (matched commodity id, else the
   * normalized extracted name). '' = unresolved — such lines never merge.
   */
  key: string
  /** Unassigned/generic base is a distinct record from assigned base of the same name. */
  isUnassigned: boolean
  baseAcres: number | null
  plcYield: number | null
  election: string // '' when none
}

export type FsaMergedLine<T extends FsaMergeLine> = {
  baseAcres: number | null
  plcYield: number | null
  election: string
  /** Every source line that fed this row (exact duplicates included). Length 1 = untouched. */
  sources: T[]
  /** Describes a value-changing merge; null for single lines and exact re-reads. */
  mergeNote: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const acresFmt = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(round2(n)))

// Election is farm × commodity level on FSA documents (never per tract), so it
// is NOT part of the identity signature: two lines equal in acres + yield are
// re-reads of the same document line even if one read missed the election.
const valueSig = (l: { baseAcres: number | null; plcYield: number | null }) =>
  `${l.baseAcres ?? 'null'}|${l.plcYield ?? 'null'}`

/**
 * Collapse one farm's extracted commodity lines to one line per
 * (commodity, is_unassigned) key. Exact duplicates (same acres + yield)
 * keep one silently; differing lines are real components — FSA base is
 * farm-level — so acres sum and PLC yield is the acres-weighted average,
 * with a note recording the composition.
 */
export function mergeFsaLines<T extends FsaMergeLine>(lines: T[]): FsaMergedLine<T>[] {
  const groups = new Map<string, T[]>()
  lines.forEach((l, i) => {
    const k = l.key === '' ? `?|${i}` : `${l.isUnassigned ? 'U' : 'A'}|${l.key}`
    const g = groups.get(k)
    if (g) g.push(l)
    else groups.set(k, [l])
  })
  return Array.from(groups.values()).map((group) => {
    const distinct: T[] = []
    for (const l of group) if (!distinct.some((d) => valueSig(d) === valueSig(l))) distinct.push(l)
    const election = group.map((l) => l.election).find((e) => e !== '') ?? ''
    if (distinct.length === 1) {
      const l = distinct[0]
      return { baseAcres: l.baseAcres, plcYield: l.plcYield, election, sources: group, mergeNote: null }
    }
    const withAcres = distinct.filter((l) => l.baseAcres != null)
    const baseAcres = withAcres.length ? round2(withAcres.reduce((s, l) => s + (l.baseAcres ?? 0), 0)) : null
    const withYield = distinct.filter((l) => l.plcYield != null)
    let plcYield: number | null = null
    if (withYield.length) {
      const weight = withYield.reduce((s, l) => s + (l.baseAcres ?? 0), 0)
      plcYield = round2(
        weight > 0
          ? withYield.reduce((s, l) => s + (l.plcYield ?? 0) * (l.baseAcres ?? 0), 0) / weight
          : withYield.reduce((s, l) => s + (l.plcYield ?? 0), 0) / withYield.length,
      )
    }
    const mergeNote = `Merged ${distinct.length} lines from upload: ${distinct
      .map((l) => (l.baseAcres == null ? '?' : acresFmt(l.baseAcres)))
      .join(' + ')} ac`
    return { baseAcres, plcYield, election, sources: group, mergeNote }
  })
}

export type BaseAcreUpsertRow = {
  farm_id: string
  commodity_id: string
  base_acres: number
  plc_yield: number
}

export type BaseAcreConflict = {
  farm_id: string
  commodity_id: string
  count: number
  /** The distinct conflicting base-acre values, in input order. */
  acres: number[]
}

/**
 * Final backstop over the exact batch headed for
 * `upsert(..., { onConflict: 'farm_id,commodity_id' })`: rows sharing a
 * conflict key with identical values collapse to one; rows sharing a key with
 * DIFFERING values (only possible when the user hand-edits two review rows
 * onto the same commodity) are returned as conflicts for a plain-English
 * error instead of the raw Postgres one. `rows` is guaranteed free of
 * duplicate (farm_id, commodity_id) keys.
 */
export function planBaseAcreSaves<T extends BaseAcreUpsertRow>(rows: T[]): { rows: T[]; conflicts: BaseAcreConflict[] } {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const k = `${r.farm_id}|${r.commodity_id}`
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  const out: T[] = []
  const conflicts: BaseAcreConflict[] = []
  for (const group of Array.from(groups.values())) {
    const distinct: T[] = []
    for (const r of group) {
      if (!distinct.some((d) => d.base_acres === r.base_acres && d.plc_yield === r.plc_yield)) distinct.push(r)
    }
    if (distinct.length === 1) out.push(distinct[0])
    else {
      conflicts.push({
        farm_id: group[0].farm_id,
        commodity_id: group[0].commodity_id,
        count: group.length,
        acres: distinct.map((r) => r.base_acres),
      })
    }
  }
  return { rows: out, conflicts }
}

/** "Farm 1234 — Corn appears 2× with conflicting values (120.0 ac vs 95.0 ac)." */
export function describeBaseAcreConflict(c: BaseAcreConflict, farmName: string, commodityName: string): string {
  return `${farmName} — ${commodityName} appears ${c.count}× with conflicting values (${c.acres
    .map((a) => `${acresFmt(a)} ac`)
    .join(' vs ')})`
}
