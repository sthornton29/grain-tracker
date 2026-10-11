// Gin receipt load matching (2026-10-11) — a Statement of Ginning's load
// table against the Seed Cotton Loads saved for the same org and crop year.
// Pure; the review screen renders the rows.
//
//   Tier 1 KEY      — the one cotton number key (lib/number-key): the module
//                     ticket's "031633" and the statement's "31633" are one
//                     load. Weights corroborate: net (and gross/tare when
//                     both sides print them) within 20 lbs (Servico weighs
//                     in 20 lb steps) is "matched"; further apart is still
//                     linked by number — the number is the identity — but
//                     amber: "Net differs: ticket 31,230 vs statement 31,320."
//                     Two saved loads sharing the key → never auto-linked
//                     (merge them first). A load already on another saved
//                     receipt → flagged, never double-linked.
//   Tier 2 SUGGEST  — no key match (a tick mark read as a digit: "316411"):
//                     a saved load of the crop year on no receipt with the
//                     SAME net AND the same gross or tare (exact — weight is
//                     the identity here), preferring the receipt's farm/field. One candidate → "Possibly 031641
//                     (same 29,580 lbs net)" with a Link button, never
//                     auto-linked; several → listed, no default; none →
//                     "Create load".

import type { GinReceiptLoadLine } from '@/lib/pdf-upload'
import { numberKey } from '@/lib/number-key'

/** Servico's scale reads in 20 lb steps. */
export const WEIGHT_TOLERANCE_LBS = 20

export type MatchableLoad = {
  id: string
  load_number: string
  crop_year: number
  net_weight: number | null
  gross_weight: number | null
  tare_weight: number | null
  farm_id: string | null
  field_id: string | null
}

export type LineMatchStatus =
  | 'matched'          // tier 1, weights agree (or no weights to compare)
  | 'weight_differs'   // tier 1, linked by number, weights disagree (amber)
  | 'ambiguous'        // two saved loads share the key — not linked
  | 'on_other_receipt' // key match, but the load is on another saved receipt — not linked
  | 'suggested'        // no key match; one weight candidate — Link button
  | 'suggested_many'   // no key match; several weight candidates — pick one
  | 'new'              // nothing saved answers — Create load
  | 'duplicate_line'   // the same number earlier in this statement's table
  | 'blank'            // no load number read

export type LineMatch = {
  index: number
  line: GinReceiptLoadLine
  key: string | null
  status: LineMatchStatus
  /** The load this line links to (tier 1, or a suggestion the user accepted). */
  load: MatchableLoad | null
  /** Tier 2 candidates / the ambiguous pair. */
  candidates: MatchableLoad[]
  note: string | null
  /** Amber / red rows that the footer counts as "need review". */
  needsReview: boolean
  /** Set when the row's net differs from the saved load's by more than the tolerance. */
  netDiffLbs: number | null
}

export type MatchOptions = {
  cropYear: number
  /** Saved load id → the receipt it is already on (its display label). */
  onReceipt?: ReadonlyMap<string, string>
  /** When re-scanning a saved receipt, its own links do not count as "another receipt". */
  thisReceiptId?: string | null
  /** Receipt id per saved load id, to honor thisReceiptId. */
  receiptIdByLoad?: ReadonlyMap<string, string>
  /** The receipt's farm/field, preferred when several loads share a weight. */
  farmId?: string | null
  fieldId?: string | null
  /** Suggestions the user accepted: line index → load id. */
  linked?: ReadonlyMap<number, string>
}

const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString())
const close = (a: number | null | undefined, b: number | null | undefined, tol = WEIGHT_TOLERANCE_LBS) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol

const same = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Number(a) === Number(b)

/** Both sides print it and it is further apart than the tolerance. */
const apart = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && !close(a, b)

function weightNote(line: GinReceiptLoadLine, load: MatchableLoad): { note: string | null; netDiff: number | null } {
  if (apart(load.net_weight, line.net)) {
    const d = Math.abs(Number(line.net) - Number(load.net_weight))
    return { note: `Net differs: ticket ${fmt(load.net_weight)} vs statement ${fmt(line.net)} (differs by ${fmt(d)} lbs).`, netDiff: d }
  }
  if (apart(load.gross_weight, line.gross)) return { note: `Gross differs: ticket ${fmt(load.gross_weight)} vs statement ${fmt(line.gross)}.`, netDiff: null }
  if (apart(load.tare_weight, line.tare)) return { note: `Tare differs: ticket ${fmt(load.tare_weight)} vs statement ${fmt(line.tare)}.`, netDiff: null }
  return { note: null, netDiff: null }
}

export function matchStatementLoads(lines: ReadonlyArray<GinReceiptLoadLine>, saved: ReadonlyArray<MatchableLoad>, opts: MatchOptions): LineMatch[] {
  const year = saved.filter((l) => l.crop_year === opts.cropYear)
  const byKey = new Map<string, MatchableLoad[]>()
  for (const l of year) {
    const k = numberKey(l.load_number)
    if (!k) continue
    const arr = byKey.get(k) ?? []
    arr.push(l)
    byKey.set(k, arr)
  }
  const otherReceiptLabel = (l: MatchableLoad): string | null => {
    const label = opts.onReceipt?.get(l.id)
    if (!label) return null
    if (opts.thisReceiptId && opts.receiptIdByLoad?.get(l.id) === opts.thisReceiptId) return null
    return label
  }
  const byId = new Map(year.map((l) => [l.id, l]))

  // Pass 1: tier 1 by key (and the user's accepted links), so tier 2 never
  // suggests a load another line already owns.
  const rows: LineMatch[] = []
  const seenKeys = new Set<string>()
  const taken = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const key = numberKey(line.load_number)
    const base: LineMatch = { index: i, line, key, status: 'blank', load: null, candidates: [], note: null, needsReview: false, netDiffLbs: null }
    if (!key) { rows.push({ ...base, status: 'blank', note: 'No load number read on this line.', needsReview: true }); continue }
    if (seenKeys.has(key)) { rows.push({ ...base, status: 'duplicate_line', note: `Load ${line.load_number} is repeated in the statement's load table.`, needsReview: true }); continue }
    seenKeys.add(key)
    const accepted = opts.linked?.get(i)
    const acceptedLoad = accepted ? byId.get(accepted) ?? null : null
    const hits = byKey.get(key) ?? []
    const target = acceptedLoad ?? (hits.length === 1 ? hits[0] : null)
    if (!acceptedLoad && hits.length > 1) {
      rows.push({ ...base, status: 'ambiguous', candidates: hits, needsReview: true,
        note: `Two saved loads share number ${key} (${hits.map((h) => h.load_number).join(' and ')}). Merge them on Seed Cotton Loads, then re-check.` })
      continue
    }
    if (target) {
      const other = otherReceiptLabel(target)
      if (other && !acceptedLoad) {
        rows.push({ ...base, status: 'on_other_receipt', candidates: [target], needsReview: true, note: `Load ${target.load_number} is already on receipt ${other}.` })
        continue
      }
      taken.add(target.id)
      const w = weightNote(line, target)
      const linkedNote = acceptedLoad ? `Linked to ${target.load_number} by you.` : null
      rows.push({
        ...base, load: target,
        status: w.note ? 'weight_differs' : 'matched',
        note: [linkedNote, w.note].filter(Boolean).join(' ') || null,
        needsReview: !!w.note, netDiffLbs: w.netDiff,
      })
      continue
    }
    rows.push(base) // tier 2 below
  }

  // Pass 2: suggestions for the unmatched rows.
  for (const r of rows) {
    if (r.status !== 'blank' || r.key == null || r.load) continue
    // (status 'blank' with a key = still open from pass 1)
    const line = r.line
    const free = year.filter((l) => !taken.has(l.id) && !otherReceiptLabel(l) && !(opts.onReceipt?.get(l.id)))
    // Weight is the IDENTITY here, so it must be the same printed figure —
    // the 20 lb tolerance is for corroborating a number match, not for
    // finding one (29,580 and 29,600 are two different loads on this scale).
    let cands = line.net != null
      ? free.filter((l) => same(l.net_weight, line.net) && (same(l.gross_weight, line.gross) || same(l.tare_weight, line.tare)))
      : []
    if (cands.length > 1 && (opts.farmId || opts.fieldId)) {
      const same = cands.filter((l) => (!opts.farmId || l.farm_id === opts.farmId) && (!opts.fieldId || l.field_id === opts.fieldId))
      if (same.length > 0) cands = same
    }
    if (cands.length === 1) {
      r.status = 'suggested'; r.candidates = cands; r.needsReview = true
      r.note = `Possibly ${cands[0].load_number} (same ${fmt(cands[0].net_weight)} lbs net).`
    } else if (cands.length > 1) {
      r.status = 'suggested_many'; r.candidates = cands; r.needsReview = true
      r.note = `${cands.length} saved loads weigh ${fmt(line.net)} lbs net: ${cands.map((c) => c.load_number).join(', ')}. Pick one or create a load.`
    } else {
      r.status = 'new'; r.needsReview = false
      r.note = 'Not in Seed Cotton Loads.'
    }
  }
  return rows
}

/** "22 of 22 loads matched · 0 need review · 0 new." Linked rows count as
 *  matched (weight_differs included — the number is the identity). */
export function matchSummary(rows: ReadonlyArray<LineMatch>): { total: number; matched: number; review: number; fresh: number; text: string } {
  const total = rows.length
  const matched = rows.filter((r) => r.load != null).length
  const fresh = rows.filter((r) => r.status === 'new').length
  const review = rows.filter((r) => r.load == null && r.status !== 'new').length + rows.filter((r) => r.status === 'weight_differs').length
  return { total, matched, review, fresh, text: `${matched} of ${total} load${total === 1 ? '' : 's'} matched · ${review} need${review === 1 ? 's' : ''} review · ${fresh} new.` }
}

/** The one farm + field every linked load shares, else null. */
export function farmFieldFromMatches(rows: ReadonlyArray<LineMatch>): { farmId: string | null; fieldId: string | null; count: number } | null {
  const linked = rows.map((r) => r.load).filter((l): l is MatchableLoad => l != null)
  if (linked.length === 0) return null
  const farms = new Set(linked.map((l) => l.farm_id ?? ''))
  const fields = new Set(linked.map((l) => l.field_id ?? ''))
  if (farms.size !== 1 || fields.size !== 1) return null
  const [farmId] = [...farms]
  const [fieldId] = [...fields]
  if (!farmId && !fieldId) return null
  return { farmId: farmId || null, fieldId: fieldId || null, count: linked.length }
}

/** Create-missing-inline is offered only for a line nothing saved answers
 *  to (status 'new'). A key match — any spelling — is never a new load. */
export function canCreateLoad(row: LineMatch): boolean {
  return row.status === 'new' && row.key != null
}

/** The printed farm # / field against the matched loads' farm + field:
 *  null when they agree (or nothing to compare), else the flag text. */
export function printedVsMatchedNote(args: { printedFarmNumber: string | null; printedField: string | null; matchedFarmFsa: string | null; matchedFieldName: string | null }): string | null {
  const notes: string[] = []
  if (args.printedFarmNumber && args.matchedFarmFsa && numberKey(args.printedFarmNumber) !== numberKey(args.matchedFarmFsa)) {
    notes.push(`the statement prints farm #${args.printedFarmNumber} but the matched loads are on farm #${args.matchedFarmFsa}`)
  }
  if (args.printedField && args.matchedFieldName && args.printedField.trim().toUpperCase() !== args.matchedFieldName.trim().toUpperCase()) {
    notes.push(`the statement prints field "${args.printedField}" but the matched loads are on "${args.matchedFieldName}"`)
  }
  return notes.length > 0 ? `Check the farm and field: ${notes.join('; ')}.` : null
}
