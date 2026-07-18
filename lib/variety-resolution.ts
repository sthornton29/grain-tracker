// Variety-name resolution shared by every planting import path (the AI document
// upload and the CSV/Excel importer). Varieties in this app are the distinct
// strings stored on field_planting_varieties.variety, scoped per crop through
// the planting — so resolution means canonicalizing an incoming spelling
// against the crop's existing names:
//
//   - Format variants ("DG 3644 B3XF" / "DG3644B3XF" / "dg 3644-b3xf") are the
//     SAME variety: auto-link to the stored spelling.
//   - Close-but-different names are flagged as a possible match and the user
//     decides. Never auto-merge on similarity — variety names are dense with
//     meaning ("DG 3644" and "DG 3646" are different products).
//   - Genuinely new names are created on save (their first spelling becomes
//     the canonical one).
//
// Everything in this file is pure so it can be unit-tested and reused by the
// duplicate-cleanup screen in Settings → Varieties.

/** Matching key: uppercase with spaces, hyphens, and periods stripped, so
 *  "DG 3644 B3XF", "DG3644B3XF", and "dg 3644-b3xf" all compare equal. */
export function varietyKey(name: string | null | undefined): string {
  if (!name) return ''
  return name.toUpperCase().replace(/\s+/g, ' ').trim().replace(/[\s\-.]/g, '')
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[n]
}

const NEAR_EDIT_DISTANCE = 2
// Substring/tail rules need some substance to compare on; a 1-3 char fragment
// would flag against half the catalog.
const MIN_FRAGMENT_LEN = 4

/** The portion of a key from its first digit on ("DYNAGRO3644B3XF" → "3644B3XF").
 *  Seed names carry their identity in the number+trait tail; the letters in
 *  front are usually just the brand, spelled long or short. */
function digitTail(key: string): string {
  const m = key.match(/\d.*$/)
  return m ? m[0] : ''
}

/** Are two DIFFERENT normalized keys close enough to flag as a possible match?
 *  (Equal keys are an exact match, handled before this.) */
export function keysNear(a: string, b: string): boolean {
  if (!a || !b || a === b) return false
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length >= MIN_FRAGMENT_LEN && longer.includes(shorter)) return true
  const ta = digitTail(a)
  if (ta.length >= MIN_FRAGMENT_LEN && ta === digitTail(b)) return true
  if (Math.abs(a.length - b.length) > NEAR_EDIT_DISTANCE) return false
  return editDistance(a, b) <= NEAR_EDIT_DISTANCE
}

export type VarietyResolution =
  | { status: 'matched'; canonical: string }
  | { status: 'possible'; candidates: string[] }
  | { status: 'new' }

/** Resolve one incoming name against the crop's existing variety names. */
export function resolveVarietyName(raw: string, existingNames: string[]): VarietyResolution {
  const key = varietyKey(raw)
  if (!key) return { status: 'new' }
  const exact = existingNames.find((n) => varietyKey(n) === key)
  if (exact !== undefined) return { status: 'matched', canonical: exact }
  const candidates = existingNames.filter((n) => keysNear(key, varietyKey(n)))
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
export function buildVarietyPlan(refs: VarietyNameRef[], existingNames: string[]): VarietyPlan {
  const items: VarietyPlanItem[] = []
  const byKey = new Map<string, VarietyPlanItem>()
  for (const ref of refs) {
    const name = (ref.name ?? '').trim()
    const key = varietyKey(name)
    if (!key) continue
    let item = byKey.get(key)
    if (!item) {
      item = { key, name, spellings: [name], rowIndexes: [], resolution: resolveVarietyName(name, existingNames) }
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

/** Suspected duplicate groups within one crop: names whose keys are equal or
 *  near each other, clustered transitively. Groups of one are dropped. Each
 *  group is sorted most-used first (the natural canonical pick), and groups
 *  are sorted by total usage. */
export function findSimilarVarietyGroups(usages: VarietyUsage[]): VarietyUsage[][] {
  const keys = usages.map((u) => varietyKey(u.name))
  const parent = usages.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (i: number, j: number) => { parent[find(i)] = find(j) }
  for (let i = 0; i < usages.length; i++) {
    for (let j = i + 1; j < usages.length; j++) {
      if (keys[i] === keys[j] || keysNear(keys[i], keys[j])) union(i, j)
    }
  }
  const groups = new Map<number, VarietyUsage[]>()
  for (let i = 0; i < usages.length; i++) {
    const root = find(i)
    const list = groups.get(root) ?? []
    list.push(usages[i])
    groups.set(root, list)
  }
  const total = (g: VarietyUsage[]) => g.reduce((s, u) => s + u.plantings, 0)
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort((a, b) => b.plantings - a.plantings || a.name.localeCompare(b.name)))
    .sort((a, b) => total(b) - total(a))
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

/** Plan a merge of a duplicate group's field_planting_varieties rows into one
 *  canonical name. Every planting keeps exactly one row (preferring one that
 *  already carries the canonical spelling), with acres/bushels summed across
 *  the planting's rows in the group. */
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
