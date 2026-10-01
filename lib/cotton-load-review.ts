// Seed cotton module-list review — the pure rules behind the upload screen:
//
//   * collapseExtractedLoads: the same load number on two pages of one scan
//     is ONE load (digits compared, leading zeros ignored). The first page
//     is its ticket, the other an extra page; weights that differ between
//     the two pages are flagged for a look.
//   * classifyAgainstSaved: a load number already saved for the crop year is
//     "saved" (nothing to do) or "update" (the scan carries different
//     weights / dates / rolls — the policy-upload pattern), else "new".
//   * reviewRolls: the printed rolls vs a handwritten correction — never
//     silently picked; the user taps "Use N".
//   * pbiReview / receiptClassification: the gin-receipt side — a PBI
//     repeated in the bale list, a PBI already on another receipt this crop
//     year, and a receipt number already saved.

import type { CottonLoadExtraction } from '@/lib/pdf-upload'

/** Digits only, leading zeros dropped: "031627" and "31627" are one load. */
export function loadNumberKey(n: string | null | undefined): string {
  const d = (n ?? '').replace(/\D+/g, '').replace(/^0+(?=\d)/, '')
  if (d) return d
  return (n ?? '').trim().toUpperCase()
}

export type ReviewLoad = CottonLoadExtraction & {
  /** 1-based pages of the scan this load appeared on (first = the ticket). */
  pages: number[]
  /** Set when a second page carried different weights or dates. */
  pageConflict: string | null
}

const weightsDiffer = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) > 0.5

/** One row per load number; later pages fold into the first. */
export function collapseExtractedLoads(loads: ReadonlyArray<CottonLoadExtraction>): ReviewLoad[] {
  const out: ReviewLoad[] = []
  const byKey = new Map<string, ReviewLoad>()
  loads.forEach((l, i) => {
    const page = l.page != null && Number.isFinite(Number(l.page)) ? Number(l.page) : i + 1
    const key = loadNumberKey(l.load_number)
    const prev = key ? byKey.get(key) : undefined
    if (!prev) {
      const row: ReviewLoad = { ...l, pages: [page], pageConflict: null }
      out.push(row)
      if (key) byKey.set(key, row)
      return
    }
    if (!prev.pages.includes(page)) prev.pages.push(page)
    const conflicts: string[] = []
    if (weightsDiffer(prev.net_weight, l.net_weight)) conflicts.push(`net ${fmt(prev.net_weight)} vs ${fmt(l.net_weight)} lbs`)
    else if (weightsDiffer(prev.gross_weight, l.gross_weight) || weightsDiffer(prev.tare_weight, l.tare_weight)) conflicts.push('gross / tare differ')
    if (prev.delivered_date && l.delivered_date && prev.delivered_date !== l.delivered_date) conflicts.push(`delivered ${prev.delivered_date} vs ${l.delivered_date}`)
    if (prev.rolls != null && l.rolls != null && Number(prev.rolls) !== Number(l.rolls)) conflicts.push(`rolls ${prev.rolls} vs ${l.rolls}`)
    if (conflicts.length > 0) prev.pageConflict = [prev.pageConflict, ...conflicts].filter(Boolean).join('; ')
    // Fill blanks from the later page; never overwrite what the first said.
    for (const k of ['producer', 'farm_number', 'field', 'picked_date', 'delivered_date', 'truck', 'gross_weight', 'tare_weight', 'net_weight', 'rolls', 'crop_year', 'handwritten_rolls', 'handwritten_note', 'sequence_mark'] as const) {
      if (prev[k] == null && l[k] != null) (prev as Record<string, unknown>)[k] = l[k]
    }
  })
  return out
}

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString()
}

export type SavedCottonLoad = {
  id: string
  load_number: string
  crop_year: number
  net_weight: number | null
  gross_weight: number | null
  tare_weight: number | null
  picked_date: string | null
  delivered_date: string | null
  rolls: number | null
}

export type FieldDiff = { field: 'net_weight' | 'gross_weight' | 'tare_weight' | 'picked_date' | 'delivered_date' | 'rolls'; label: string; saved: string; scanned: string }

export type LoadClassification =
  | { status: 'new' }
  | { status: 'saved'; existing: SavedCottonLoad }
  | { status: 'update'; existing: SavedCottonLoad; diffs: FieldDiff[] }

/** Compare a scanned load with what is saved for the same number this crop
 *  year. Only fields the scan actually carries count as a difference. */
export function classifyAgainstSaved(
  scanned: Pick<CottonLoadExtraction, 'load_number' | 'net_weight' | 'gross_weight' | 'tare_weight' | 'picked_date' | 'delivered_date' | 'rolls'>,
  saved: ReadonlyArray<SavedCottonLoad>,
  cropYear: number,
): LoadClassification {
  const key = loadNumberKey(scanned.load_number)
  if (!key) return { status: 'new' }
  const existing = saved.find((s) => s.crop_year === cropYear && loadNumberKey(s.load_number) === key)
  if (!existing) return { status: 'new' }
  const diffs: FieldDiff[] = []
  const num = (field: FieldDiff['field'], label: string, a: number | null | undefined, b: number | null | undefined) => {
    if (b == null) return
    if (a == null || Math.abs(Number(a) - Number(b)) > 0.5) diffs.push({ field, label, saved: fmt(a), scanned: fmt(b) })
  }
  const date = (field: FieldDiff['field'], label: string, a: string | null, b: string | null | undefined) => {
    if (!b) return
    if (!a || a !== b) diffs.push({ field, label, saved: a ?? '—', scanned: b })
  }
  num('net_weight', 'Net lbs', existing.net_weight, scanned.net_weight)
  num('gross_weight', 'Gross lbs', existing.gross_weight, scanned.gross_weight)
  num('tare_weight', 'Tare lbs', existing.tare_weight, scanned.tare_weight)
  date('picked_date', 'Picked', existing.picked_date, scanned.picked_date)
  date('delivered_date', 'Delivered', existing.delivered_date, scanned.delivered_date)
  if (scanned.rolls != null && (existing.rolls == null || Number(existing.rolls) !== Number(scanned.rolls))) diffs.push({ field: 'rolls', label: 'Rolls', saved: existing.rolls != null ? String(existing.rolls) : '—', scanned: String(scanned.rolls) })
  return diffs.length > 0 ? { status: 'update', existing, diffs } : { status: 'saved', existing }
}

/** The footer line: "3 already saved · 1 update · 11 new". */
export function classificationSummary(rows: ReadonlyArray<{ status: LoadClassification['status'] }>): { saved: number; update: number; fresh: number; text: string } {
  const saved = rows.filter((r) => r.status === 'saved').length
  const update = rows.filter((r) => r.status === 'update').length
  const fresh = rows.filter((r) => r.status === 'new').length
  return { saved, update, fresh, text: `${saved} already saved · ${update} update${update === 1 ? '' : 's'} · ${fresh} new` }
}

export type RollsReview = {
  /** The printed count (null when the ticket prints none). */
  printed: number | null
  /** A handwritten count that differs from the printed one, else null. */
  handwritten: number | null
  note: string | null
  /** The chip text when a handwritten count differs: "handwritten: 3 rolls (busted roll, 3 on TRK #21)". */
  chip: string | null
}

/** Printed vs handwritten rolls. A circled / hash-numbered sequence mark is
 *  never a roll count. The caller shows the chip and lets the user tap
 *  "Use N" — this never picks for them. */
export function reviewRolls(l: Pick<CottonLoadExtraction, 'rolls' | 'handwritten_rolls' | 'handwritten_note' | 'sequence_mark'>): RollsReview {
  const printed = l.rolls != null && Number.isFinite(Number(l.rolls)) ? Math.round(Number(l.rolls)) : null
  const hand = l.handwritten_rolls != null && Number.isFinite(Number(l.handwritten_rolls)) ? Math.round(Number(l.handwritten_rolls)) : null
  const note = (l.handwritten_note ?? '').trim() || null
  const differs = hand != null && hand !== printed
  return {
    printed,
    handwritten: differs ? hand : null,
    note,
    chip: differs ? `handwritten: ${hand} roll${hand === 1 ? '' : 's'}${note ? ` (${note.toLowerCase()})` : ''}` : null,
  }
}

// ---------- gin receipt side ----------

export type BaleReviewRow<T> = {
  bale: T
  pbi: string
  /** Default-excluded reasons; empty = included. */
  flags: string[]
}

export function normalizePbiKey(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^0+/, '')
}

/** Flag bales repeated within the list and bales already on another receipt
 *  this crop year (named). Flagged bales are excluded by default. */
export function pbiReview<T extends { pbi_number: string | null }>(
  bales: ReadonlyArray<T>,
  existing: ReadonlyArray<{ pbi_number: string; crop_year: number; receipt_number: string | null }>,
  cropYear: number,
): BaleReviewRow<T>[] {
  const seen = new Set<string>()
  const onReceipt = new Map<string, string>()
  for (const e of existing) if (e.crop_year === cropYear) onReceipt.set(normalizePbiKey(e.pbi_number), e.receipt_number ?? 'another receipt')
  return bales.map((b) => {
    const pbi = normalizePbiKey(b.pbi_number)
    const flags: string[] = []
    if (pbi) {
      if (seen.has(pbi)) flags.push('repeated in this bale list')
      seen.add(pbi)
      const r = onReceipt.get(pbi)
      if (r) flags.push(`already on receipt #${r}`)
    }
    return { bale: b, pbi, flags }
  })
}

export type ReceiptClassification =
  | { status: 'new' }
  | { status: 'saved'; existingId: string }
  | { status: 'update'; existingId: string; diffs: string[] }

export function receiptClassification(
  scanned: { receipt_number: string | null; receipt_date?: string | null; bales_count?: number | null; total_seed_cotton_weight?: number | null; total_bale_weight?: number | null },
  saved: ReadonlyArray<{ id: string; receipt_number: string; crop_year: number; receipt_date: string | null; bales_count: number | null; total_seed_cotton_weight: number | null; total_bale_weight: number | null }>,
  cropYear: number,
): ReceiptClassification {
  const key = loadNumberKey(scanned.receipt_number)
  if (!key) return { status: 'new' }
  const existing = saved.find((s) => s.crop_year === cropYear && loadNumberKey(s.receipt_number) === key)
  if (!existing) return { status: 'new' }
  const diffs: string[] = []
  if (scanned.receipt_date && existing.receipt_date && scanned.receipt_date !== existing.receipt_date) diffs.push(`date ${existing.receipt_date} → ${scanned.receipt_date}`)
  if (scanned.bales_count != null && existing.bales_count != null && Number(scanned.bales_count) !== Number(existing.bales_count)) diffs.push(`bales ${existing.bales_count} → ${scanned.bales_count}`)
  if (scanned.total_seed_cotton_weight != null && existing.total_seed_cotton_weight != null && weightsDiffer(existing.total_seed_cotton_weight, scanned.total_seed_cotton_weight)) diffs.push(`seed cotton ${fmt(existing.total_seed_cotton_weight)} → ${fmt(scanned.total_seed_cotton_weight)} lbs`)
  if (scanned.total_bale_weight != null && existing.total_bale_weight != null && weightsDiffer(existing.total_bale_weight, scanned.total_bale_weight)) diffs.push(`lint ${fmt(existing.total_bale_weight)} → ${fmt(scanned.total_bale_weight)} lbs`)
  return diffs.length > 0 ? { status: 'update', existingId: existing.id, diffs } : { status: 'saved', existingId: existing.id }
}
