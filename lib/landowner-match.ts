// Landowner name matching (089) — ONE normalization, shared by every place a
// landowner name can create a duplicate: the Add form on /settings/landowners,
// the CSV importer, the AI settings-document importer's landowner section, and
// the Turnrow Farm link's sync when it has to answer "unmatched" with Grain's
// closest names. Turnrow Farm normalizes the same way, so both sides reach the
// same verdict on the same pair of names.
//
// A landowner is written down a dozen ways across a lease, a cheque stub, and
// an FSA form: "Smith Family Farms, LLC", "Smith Family Farm LLC",
// "Smith Family Farms", "Estate of J. Smith", "Smith & Sons", "Smith and Sons",
// "Smith/Jones". Those are one landowner, and creating a second record splits
// their rent, their statements, and their share.
//
// Deliberately NOT lib/fuzzy.ts: that one exists for AI-extracted values
// hitting reference tables (buyers, crops, trucks) and scores token overlap
// with a substring bonus. Here the legal suffix IS the noise, and dropping it
// is the whole job — "Smith Farms LLC" and "Smith Farms Inc" must collapse
// together, which a substring scorer will not do.

/** Multi-word noise, stripped before the word list. "Estate of J. Smith" is
 *  how a lease writes "J. Smith" after a death, so it is the same landowner. */
const MULTIWORD_NOISE = [
  'the estate of',
  'estate of',
]

// Deliberately NARROW. Only words that carry no identity at all: the legal
// form, the "Farm(s)" descriptor, and the joining words. Anything that names a
// DIFFERENT legal payee stays: "Mary Smith Trust" is not "Mary Smith", and
// "Smith Family Farms" is not "Smith Farms" — those come back as near matches
// the farmer decides on, never as an automatic same-landowner verdict.
const NOISE_WORDS = new Set([
  'the',
  'farm', 'farms', 'farming',
  'llc', 'lc', 'llp', 'lllp', 'lp', 'ltd', 'plc',
  'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company',
  'and',
])

/** The shared spelling: case folded, `&` and `/` resolved, punctuation gone,
 *  legal and descriptive noise dropped, tokens sorted so "Smith & Jones" and
 *  "Jones and Smith" land together. Returns '' when nothing identifying is
 *  left (a name that is ALL noise, e.g. "The Farm LLC" — such a name keeps its
 *  raw normalization instead, see `landownerNameKey`). */
export function normalizeLandownerName(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = String(raw).toLowerCase()
  // & means and; a slash is a separator, not a character.
  s = s.replace(/&/g, ' and ').replace(/[/\\]/g, ' ')
  // Drop possessives before punctuation goes, so "smith's" is "smith".
  s = s.replace(/(\w)['’]s\b/g, '$1')
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const phrase of MULTIWORD_NOISE) {
    s = s.split(phrase).join(' ')
  }
  s = s.replace(/\s+/g, ' ').trim()
  const kept = s.split(' ').filter((t) => t && !NOISE_WORDS.has(t))
  return kept.sort().join(' ')
}

/** The comparison key. Falls back to the punctuation-only normalization when
 *  stripping noise would leave nothing, so an all-noise name still matches
 *  itself and never collides with every other all-noise name. */
export function landownerNameKey(raw: string | null | undefined): string {
  const stripped = normalizeLandownerName(raw)
  if (stripped) return stripped
  return String(raw ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ')
}

/** True when two names are the same landowner under the shared normalization. */
export function sameLandownerName(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = landownerNameKey(a)
  const kb = landownerNameKey(b)
  return ka !== '' && ka === kb
}

export type LandownerCandidate = { id: string; name: string }

export type LandownerMatch<T extends LandownerCandidate = LandownerCandidate> = {
  candidate: T
  /** 'exact' = the same landowner under the shared normalization (offer Use
   *  existing, preselected). 'near' = worth a look, never auto-applied. */
  kind: 'exact' | 'near'
  score: number
}

/** Token overlap over the normalized keys, as a fraction of the smaller side.
 *  "smith jones" vs "jones smith sons" = 2/2 = 1. */
function overlapScore(a: string, b: string): number {
  const ta = a.split(' ').filter(Boolean)
  const tb = b.split(' ').filter(Boolean)
  if (ta.length === 0 || tb.length === 0) return 0
  const setB = new Set(tb)
  let hit = 0
  for (const t of new Set(ta)) if (setB.has(t)) hit++
  return hit / Math.min(new Set(ta).size, setB.size)
}

/** Existing landowners that might be the one being typed, best first. Exact
 *  keys come first; then names sharing most of their identifying tokens, or
 *  one name contained in the other ("Smith" typed against "Smith Brothers").
 *  Archived and merged-away rows are the caller's to exclude. */
export function findLandownerMatches<T extends LandownerCandidate>(
  name: string | null | undefined,
  candidates: readonly T[],
  opts: { minScore?: number; limit?: number } = {},
): Array<LandownerMatch<T>> {
  const key = landownerNameKey(name)
  if (!key) return []
  const minScore = opts.minScore ?? 0.5
  const out: Array<LandownerMatch<T>> = []
  for (const c of candidates) {
    const ck = landownerNameKey(c.name)
    if (!ck) continue
    if (ck === key) { out.push({ candidate: c, kind: 'exact', score: 1 }); continue }
    let score = overlapScore(key, ck)
    // One name inside the other: "smith" typed against "smith brothers".
    if (score < 1 && (ck.includes(key) || key.includes(ck))) score = Math.max(score, 0.75)
    if (score >= minScore) out.push({ candidate: c, kind: 'near', score })
  }
  out.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'exact' ? -1 : 1) ||
    b.score - a.score ||
    a.candidate.name.localeCompare(b.candidate.name))
  return out.slice(0, opts.limit ?? 5)
}

/** The first exact match, or null — the "Use existing" the UI preselects. */
export function exactLandownerMatch<T extends LandownerCandidate>(
  name: string | null | undefined,
  candidates: readonly T[],
): T | null {
  return findLandownerMatches(name, candidates).find((m) => m.kind === 'exact')?.candidate ?? null
}
