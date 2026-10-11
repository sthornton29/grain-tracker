// The ONE number key for cotton (2026-10-11) — load numbers, receipt /
// statement numbers, and bale PBIs are compared through these two functions
// and nowhere else. Stored values are never rewritten: a load keeps the
// number its module ticket printed ("031633"); only the COMPARISON ignores
// what a gin or a scanner adds or drops.
//
//   numberKey("031633") = numberKey("31633") = numberKey(" 31633 -") = "31633"
//   pbiKey("0179122") = pbiKey("179122") = "179122"
//
// The SQL twin `cotton_number_key(text)` (supabase/093) mirrors numberKey
// step for step; verify_migrations.sql carries the parity list, and
// lib/number-key.test.ts pins the same cases on this side.

/** Leading zeros off a digit run, "000" → "0". Shared with the grain ticket
 *  normalizer (lib/ticket-matching), which applies it to purely numeric
 *  tickets only — grain behavior is unchanged. */
export function stripLeadingZeros(s: string): string {
  return s.replace(/^0+(?=\d)/, '')
}

/**
 * The cotton number key:
 *   1. trim, uppercase, remove internal whitespace ("31 633" → "31633");
 *   2. strip leading and trailing punctuation — a tick mark read as a
 *      character ("31632," "31637_" "31633 -") never changes the number;
 *   3. strip leading zeros ("031633" → "31633"; "000" → "0");
 *   4. empty → null.
 * INTERNAL dashes stay ("988-1" is not "9881" — the ticketTails no-glue rule).
 * Letters stay, so "A0012" keeps its zeros: they are not leading.
 */
export function numberKey(raw: string | null | undefined): string | null {
  if (raw == null) return null
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '')
  s = s.replace(/^[^A-Z0-9]+/, '').replace(/[^A-Z0-9]+$/, '')
  if (!s) return null
  if (/^0+$/.test(s)) return '0'
  return s.replace(/^0+/, '')
}

/** Two raw numbers name the same thing under the cotton key. Blank never
 *  matches anything, not even another blank. */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = numberKey(a)
  return ka != null && ka === numberKey(b)
}

// ---------- PBIs ----------

/** USDA's Permanent Bale Identification tag is 12 digits: the 5-digit gin
 *  code followed by a 7-digit bale number. Gins print the bale number alone
 *  on their statements ("179122"); classing files and warehouse lists may
 *  carry the full tag ("406140179122"). */
export const PBI_FULL_DIGITS = 12
export const GIN_CODE_DIGITS = 5

/** Digits only, leading zeros stripped; no digits → null. */
export function pbiKey(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const d = String(raw).replace(/\D/g, '')
  if (!d) return null
  return d.replace(/^0+(?=\d)/, '')
}

const digitsOf = (raw: string | null | undefined) => (raw == null ? '' : String(raw).replace(/\D/g, ''))
const ginCodeKey = (ginCode: string | null | undefined) => {
  const d = digitsOf(ginCode)
  return d ? d.padStart(GIN_CODE_DIGITS, '0') : null
}

/**
 * Every key a PBI answers to: its own key, plus — ONLY when it is the full
 * 12-digit tag and its first five digits are the given gin code — the key
 * of its 7-digit bale number. A 5-digit prefix is never stripped without a
 * gin code match. Index saved bales under all their keys and look an
 * incoming number up under all of its keys: the two sides match when the
 * key sets intersect.
 */
export function pbiKeys(raw: string | null | undefined, ginCode?: string | null): string[] {
  const own = pbiKey(raw)
  if (own == null) return []
  const out = [own]
  const d = digitsOf(raw)
  const gin = ginCodeKey(ginCode)
  if (gin && d.length === PBI_FULL_DIGITS && d.slice(0, GIN_CODE_DIGITS) === gin) {
    const tail = pbiKey(d.slice(GIN_CODE_DIGITS))
    if (tail != null && !out.includes(tail)) out.push(tail)
  }
  return out
}

/** Two PBIs name the same bale: equal keys, or one is the full tag for the
 *  given gin and its bale number equals the other. */
export function pbiMatches(a: string | null | undefined, b: string | null | undefined, ginCode?: string | null): boolean {
  const ka = pbiKeys(a, ginCode)
  if (ka.length === 0) return false
  const kb = new Set(pbiKeys(b, ginCode))
  return ka.some((k) => kb.has(k))
}

/** The gin code a PBI carries when it is the full 12-digit tag, else null. */
export function pbiGinCode(raw: string | null | undefined): string | null {
  const d = digitsOf(raw)
  return d.length === PBI_FULL_DIGITS ? d.slice(0, GIN_CODE_DIGITS) : null
}
