// Loose name matching for AI-extracted values that need to map to existing
// reference rows (buyers, crops, trucks, fields, bins). "ADM Grain" must match
// "ADM"; "Yield Master 22" must match "Yieldmaster 22". We strip non-letter
// noise, lowercase, then score by token overlap with a substring tie-breaker.

function norm(s: string | null | undefined): string {
  if (!s) return ''
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function tokens(s: string): string[] {
  return norm(s).split(/\s+/).filter(Boolean)
}

function score(needle: string, hay: string): number {
  const n = norm(needle)
  const h = norm(hay)
  if (!n || !h) return 0
  if (n === h) return 1000
  if (h.includes(n) || n.includes(h)) return 500 + Math.min(n.length, h.length)
  const nt = new Set(tokens(needle))
  const ht = new Set(tokens(hay))
  let overlap = 0
  for (const t of nt) if (ht.has(t)) overlap++
  if (overlap === 0) return 0
  // Boost when the needle's first token matches the hay's first token
  // (handles "ADM Grain Co" → "ADM").
  const firstMatch = tokens(needle)[0] === tokens(hay)[0] ? 50 : 0
  return overlap * 100 + firstMatch
}

export type FuzzyOptions = {
  minScore?: number
}

// Returns the best match's id (or `extractId` result), or null when no
// candidate scores above the threshold. Pass `extractName` to read the
// candidate's name from a custom field.
export function findBestMatch<T>(
  needle: string | null | undefined,
  candidates: T[],
  extractName: (c: T) => string,
  opts: FuzzyOptions = {},
): T | null {
  if (!needle) return null
  const min = opts.minScore ?? 100
  let best: T | null = null
  let bestScore = -1
  for (const c of candidates) {
    const s = score(needle, extractName(c))
    if (s > bestScore) {
      best = c
      bestScore = s
    }
  }
  if (bestScore < min) return null
  return best
}
