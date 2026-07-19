// Variety-name resolution shared by every planting import path (the AI document
// upload and the CSV/Excel importer). Varieties in this app are the distinct
// strings stored on field_planting_varieties.variety, scoped per crop through
// the planting — so resolution means canonicalizing an incoming spelling
// against the crop's existing names:
//
//   - Format variants ("DG 3644 B3XF" / "DG3644B3XF" / "dg 3644-b3xf") are the
//     SAME variety: auto-link to the stored spelling.
//   - Brand-prefix variants of the SAME product ("68-35" vs "DK 68-35") are
//     flagged as a possible match and the user decides. Never auto-merge.
//   - Everything else is a different product. Seed names are
//     [brand prefix][number][trait tail] and the number+tail IS the product
//     identity — "DK 65-95" vs "DK 68-35", "47XF2" vs "47XF6", "DP 2131" vs
//     "DP 2239" are all distinct and must NEVER be offered as merge/match
//     candidates, no matter how close they look character-wise.
//
// A "keep both" decision (variety_match_dismissals) permanently silences a
// candidate pair for its crop — both here and on the cleanup page.
//
// Everything in this file is pure so it can be unit-tested and reused by the
// duplicate-cleanup screen in Settings → Varieties.

/** Matching key: uppercase with spaces, hyphens, and periods stripped, so
 *  "DG 3644 B3XF", "DG3644B3XF", and "dg 3644-b3xf" all compare equal. */
export function varietyKey(name: string | null | undefined): string {
  if (!name) return ''
  return name.toUpperCase().replace(/\s+/g, ' ').trim().replace(/[\s\-.]/g, '')
}

/** The portion of a key from its first digit on ("DYNAGRO3644B3XF" → "3644B3XF").
 *  Everything before the first digit is the brand prefix (spelled long or
 *  short); everything from the first digit on — numbers AND trait letters — is
 *  the product identity. Empty for digitless names. */
export function numericCore(key: string): string {
  const m = key.match(/\d.*$/)
  return m ? m[0] : ''
}

/** Are two DIFFERENT normalized keys the same product spelled differently?
 *  (Equal keys are an exact match, handled before this.) True ONLY when the
 *  numeric cores are identical — i.e. the full normalized strings differ in
 *  nothing but the presence/spelling of the alpha brand prefix. Any difference
 *  in a digit or trait letter means different products: never a candidate. */
export function keysNear(a: string, b: string): boolean {
  if (!a || !b || a === b) return false
  const core = numericCore(a)
  return core !== '' && core === numericCore(b)
}

/** Order-insensitive identity for a candidate pair of normalized keys — the
 *  value stored in variety_match_dismissals (key_a <= key_b) and checked by
 *  both the cleanup page and import-time flagging. */
export function dismissalKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

export type VarietyResolution =
  | { status: 'matched'; canonical: string }
  | { status: 'possible'; candidates: string[] }
  | { status: 'new' }

/** Resolve one incoming name against the crop's existing variety names.
 *  `dismissed` holds dismissalKey() pairs the user has declared "different
 *  varieties" — those candidates are never offered again. */
export function resolveVarietyName(
  raw: string,
  existingNames: string[],
  dismissed?: ReadonlySet<string>,
): VarietyResolution {
  const key = varietyKey(raw)
  if (!key) return { status: 'new' }
  const exact = existingNames.find((n) => varietyKey(n) === key)
  if (exact !== undefined) return { status: 'matched', canonical: exact }
  const candidates = existingNames.filter((n) => {
    const nk = varietyKey(n)
    return keysNear(key, nk) && !dismissed?.has(dismissalKey(key, nk))
  })
  if (candidates.length > 0) return { status: 'possible', candidates }
  return { status: 'new' }
}

// ---------- File-level plan (one import's worth of names, one crop) ----------

export type VarietyNameRef = { rowIndex: number; name: string }

export type VarietyPlanItem = {
  key: string
  /** First-seen spelling in the file — the creation name for new groups, so
   *  format variants across rows collapse to ONE created variety. */
  name: string
  /** Distinct raw spellings that collapsed into this group. */
  spellings: string[]
  rowIndexes: number[]
  resolution: VarietyResolution
}

export type VarietyPlan = {
  items: VarietyPlanItem[]
  matched: number
  possible: number
  created: number
}

/** Group an import's variety mentions by normalized key (within-file collapse),
 *  then resolve each group once against the crop's existing names. */
export function buildVarietyPlan(
  refs: VarietyNameRef[],
  existingNames: string[],
  dismissed?: ReadonlySet<string>,
): VarietyPlan {
  const items: VarietyPlanItem[] = []
  const byKey = new Map<string, VarietyPlanItem>()
  for (const ref of refs) {
    const name = (ref.name ?? '').trim()
    const key = varietyKey(name)
    if (!key) continue
    let item = byKey.get(key)
    if (!item) {
      item = { key, name, spellings: [name], rowIndexes: [], resolution: resolveVarietyName(name, existingNames, dismissed) }
      byKey.set(key, item)
      items.push(item)
    } else if (!item.spellings.includes(name)) {
      item.spellings.push(name)
    }
    item.rowIndexes.push(ref.rowIndex)
  }
  let matched = 0
  let possible = 0
  let created = 0
  for (const item of items) {
    if (item.resolution.status === 'matched') matched++
    else if (item.resolution.status === 'possible') possible++
    else created++
  }
  return { items, matched, possible, created }
}

/** The user's call on a possible-match group: link to an existing name, or
 *  create as new (optionally under an edited name). Also carries an edited
 *  name for plain new groups. */
export type VarietyDecision = { useExisting: string | null; newName?: string }

/** Final stored name for a plan item. Returns null while a possible-match
 *  group is undecided — callers must block saving until every group resolves. */
export function resolvedName(item: VarietyPlanItem, decision?: VarietyDecision): string | null {
  if (item.resolution.status === 'matched') return item.resolution.canonical
  if (item.resolution.status === 'possible') {
    if (!decision) return null
    if (decision.useExisting != null) return decision.useExisting
    return (decision.newName ?? '').trim() || item.name
  }
  return (decision?.newName ?? '').trim() || item.name
}

// ---------- Duplicate cleanup (Settings → Varieties) ----------

export type VarietyUsage = { name: string; plantings: number }

export type VarietyPair = {
  /** More-used spelling first — the natural survivor default. */
  a: VarietyUsage
  b: VarietyUsage
  /** True when the two spellings normalize to the SAME key (pure format
   *  variants); false for brand-prefix variants (same numeric core). */
  exact: boolean
}

/** Suspected duplicate PAIRS within one crop: two stored spellings whose keys
 *  are equal (format variants) or share an identical numeric core (brand-prefix
 *  variants). Each pair is its own decision — there is no transitive grouping.
 *  Pairs the user already dismissed ("different varieties — keep both") are
 *  excluded. Sorted by combined usage, most-used first. */
export function findSimilarVarietyPairs(
  usages: VarietyUsage[],
  dismissed?: ReadonlySet<string>,
): VarietyPair[] {
  const keys = usages.map((u) => varietyKey(u.name))
  const pairs: VarietyPair[] = []
  for (let i = 0; i < usages.length; i++) {
    for (let j = i + 1; j < usages.length; j++) {
      if (!keys[i] || !keys[j]) continue
      const exact = keys[i] === keys[j]
      if (!exact && !keysNear(keys[i], keys[j])) continue
      if (dismissed?.has(dismissalKey(keys[i], keys[j]))) continue
      const [a, b] =
        usages[j].plantings > usages[i].plantings ? [usages[j], usages[i]] : [usages[i], usages[j]]
      pairs.push({ a, b, exact })
    }
  }
  return pairs.sort(
    (x, y) => (y.a.plantings + y.b.plantings) - (x.a.plantings + x.b.plantings) || x.a.name.localeCompare(y.a.name),
  )
}

export type VarietyRowRef = {
  id: string
  plantingId: string
  name: string
  acres: number
  bushels: number | null
}

export type VarietyMergePlan = {
  /** Surviving row per planting, renamed to the canonical spelling with the
   *  group's combined acres/bushels for that planting. */
  updates: Array<{ id: string; variety: string; acres: number; bushels: number | null }>
  /** Now-redundant rows (a planting that recorded two spellings keeps one). */
  deletes: string[]
  affectedPlantings: number
}

/** Plan a merge of a confirmed duplicate pair's field_planting_varieties rows
 *  into one canonical name. Every planting keeps exactly one row (preferring
 *  one that already carries the canonical spelling), with acres/bushels summed
 *  across the planting's rows in the group. */
export function buildVarietyMergePlan(rows: VarietyRowRef[], canonical: string): VarietyMergePlan {
  const byPlanting = new Map<string, VarietyRowRef[]>()
  for (const r of rows) {
    const list = byPlanting.get(r.plantingId) ?? []
    list.push(r)
    byPlanting.set(r.plantingId, list)
  }
  const updates: VarietyMergePlan['updates'] = []
  const deletes: string[] = []
  let affectedPlantings = 0
  for (const group of byPlanting.values()) {
    const keep = group.find((r) => r.name === canonical) ?? group[0]
    const others = group.filter((r) => r !== keep)
    if (keep.name === canonical && others.length === 0) continue
    const acres = group.reduce((s, r) => s + (Number(r.acres) || 0), 0)
    const bushelVals = group
      .map((r) => r.bushels)
      .filter((b): b is number => b != null && Number.isFinite(Number(b)))
      .map(Number)
    const bushels = bushelVals.length > 0 ? bushelVals.reduce((s, b) => s + b, 0) : null
    updates.push({ id: keep.id, variety: canonical, acres, bushels })
    deletes.push(...others.map((r) => r.id))
    affectedPlantings++
  }
  return { updates, deletes, affectedPlantings }
}
