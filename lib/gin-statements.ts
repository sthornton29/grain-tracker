// Statements of Ginning — the pure rules behind the gin receipt upload
// (2026-10-11):
//
//   * groupStatementPages: the extraction reports the PDF page by page; one
//     PDF can hold several statements back to back (Servico mails 10/10 and
//     10/7 in one envelope). A page starts a new statement when it carries
//     the Producer Totals block, when its header date changes, or when the
//     bale row numbering restarts at 1. Works across chunk boundaries
//     because the pages are merged first (lib/parse-merge) and grouped here.
//   * statementIdentity / synthesizeReceiptNumber: "Gin 40614" is the gin's
//     USDA code, not a statement number. A statement is identified by gin +
//     farm # + field + date + totals unless the gin prints a distinct
//     per-statement number; gin_receipts.receipt_number (the unique key) is
//     synthesized deterministically from that identity.
//   * classifyStatement: new / already saved / update against what is saved.
//   * farmYtdCheck: the gin's Farm Year-To-Date column against the sum of
//     the statements Turnrow holds — informational, never blocks.

import type { GinFarmYtd, GinReceiptBaleRow, GinReceiptExtraction, GinReceiptLoadLine, GinReceiptPage } from '@/lib/pdf-upload'
import { numberKey } from '@/lib/number-key'

export type StatementBoundary = 'first' | 'totals_block' | 'date_change' | 'rows_restart'

export type GinStatement = {
  /** 1-based pages of the document this statement spans. */
  pages: number[]
  boundary: StatementBoundary
  gin_name: string | null
  gin_address: string | null
  gin_phone: string | null
  /** The gin's USDA gin code ("40614") — identifies the GIN. */
  gin_code: string | null
  /** A distinct per-statement number ONLY when the document prints one. */
  statement_number: string | null
  receipt_date: string | null
  producer: string | null
  farm_number: string | null
  farm_name: string | null
  field: string | null
  crop_year: number | null
  modules_count: number | null
  total_seed_cotton_weight: number | null
  bales_count: number | null
  total_bale_weight: number | null
  avg_bale_weight: number | null
  seed_lbs: number | null
  lint_turnout_pct: number | null
  lint_lbs_per_bale: number | null
  farm_ytd: GinFarmYtd | null
  loads: GinReceiptLoadLine[]
  bales: GinReceiptBaleRow[]
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const str = (v: unknown): string | null => (v == null ? null : String(v).trim() || null)

/** lib/parse-chunked `rebase`: a chunk's 1-based page numbers become
 *  whole-document page numbers; a page the model left unnumbered takes its
 *  position in the chunk. */
export function rebaseGinReceiptPages(part: GinReceiptExtraction, firstPage: number): GinReceiptExtraction {
  const pages = Array.isArray(part?.pages) ? part.pages : []
  return {
    pages: pages.map((p, i) => ({ ...p, page: (num(p.page) ?? i + 1) + firstPage - 1 })),
  }
}

/** "5824 WHEELER" printed as one field → farm # 5824, farm name WHEELER. */
function splitFarm(p: Pick<GinReceiptPage, 'farm_number' | 'farm_name'>): { farm_number: string | null; farm_name: string | null } {
  const n = str(p.farm_number)
  const name = str(p.farm_name)
  if (n || !name) return { farm_number: n, farm_name: name }
  const m = name.match(/^#?\s*(\d{2,7})\s+(.+)$/)
  return m ? { farm_number: m[1], farm_name: m[2].trim() } : { farm_number: null, farm_name: name }
}

/** Group the document's pages into statements. Pure. */
export function groupStatementPages(pagesIn: ReadonlyArray<GinReceiptPage>): GinStatement[] {
  const pages = pagesIn
    .map((p, i) => ({ ...p, page: num(p.page) ?? i + 1 }))
    .sort((a, b) => (a.page as number) - (b.page as number))
  const out: GinStatement[] = []
  let cur: GinStatement | null = null
  let curBaleRows = 0
  const start = (p: GinReceiptPage, boundary: StatementBoundary): GinStatement => {
    const farm = splitFarm(p)
    const s: GinStatement = {
      pages: [p.page as number], boundary,
      gin_name: str(p.gin_name), gin_address: str(p.gin_address), gin_phone: str(p.gin_phone),
      gin_code: str(p.gin_code), statement_number: str(p.statement_number),
      receipt_date: str(p.statement_date), producer: str(p.producer),
      farm_number: farm.farm_number, farm_name: farm.farm_name, field: str(p.field), crop_year: num(p.crop_year),
      modules_count: num(p.totals?.modules_count), total_seed_cotton_weight: num(p.totals?.total_seed_cotton_weight),
      bales_count: num(p.totals?.bales_count), total_bale_weight: num(p.totals?.total_bale_weight),
      avg_bale_weight: num(p.totals?.avg_bale_weight), seed_lbs: num(p.totals?.seed_lbs),
      lint_turnout_pct: num(p.totals?.lint_turnout_pct), lint_lbs_per_bale: num(p.totals?.lint_lbs_per_bale),
      farm_ytd: p.farm_ytd ? { modules: num(p.farm_ytd.modules), seed_cotton_lbs: num(p.farm_ytd.seed_cotton_lbs), bales: num(p.farm_ytd.bales), bale_weight: num(p.farm_ytd.bale_weight) } : null,
      loads: [...(p.loads ?? [])], bales: [...(p.bales ?? [])],
    }
    curBaleRows = s.bales.length
    out.push(s)
    return s
  }
  for (const p of pages) {
    const date = str(p.statement_date)
    if (!cur) { cur = start(p, 'first'); continue }
    if (p.has_totals_block === true) { cur = start(p, 'totals_block'); continue }
    if (date && cur.receipt_date && date !== cur.receipt_date) { cur = start(p, 'date_change'); continue }
    if (num(p.bale_row_first) === 1 && curBaleRows > 0) { cur = start(p, 'rows_restart'); continue }
    // A continuation page: fill header blanks, append its rows.
    cur.pages.push(p.page as number)
    const farm = splitFarm(p)
    const fill: Array<[keyof GinStatement, unknown]> = [
      ['gin_name', str(p.gin_name)], ['gin_address', str(p.gin_address)], ['gin_phone', str(p.gin_phone)],
      ['gin_code', str(p.gin_code)], ['statement_number', str(p.statement_number)], ['receipt_date', date],
      ['producer', str(p.producer)], ['farm_number', farm.farm_number], ['farm_name', farm.farm_name], ['field', str(p.field)], ['crop_year', num(p.crop_year)],
    ]
    for (const [k, v] of fill) if (cur[k] == null && v != null) (cur as unknown as Record<string, unknown>)[k] = v
    if (p.totals) {
      for (const k of ['modules_count', 'total_seed_cotton_weight', 'bales_count', 'total_bale_weight', 'avg_bale_weight', 'seed_lbs', 'lint_turnout_pct', 'lint_lbs_per_bale'] as const) {
        if (cur[k] == null && num(p.totals[k]) != null) cur[k] = num(p.totals[k])
      }
    }
    if (!cur.farm_ytd && p.farm_ytd) cur.farm_ytd = { modules: num(p.farm_ytd.modules), seed_cotton_lbs: num(p.farm_ytd.seed_cotton_lbs), bales: num(p.farm_ytd.bales), bale_weight: num(p.farm_ytd.bale_weight) }
    cur.loads.push(...(p.loads ?? []))
    cur.bales.push(...(p.bales ?? []))
    curBaleRows += (p.bales ?? []).length
  }
  // Crop year: the statement date's year when the gin prints none.
  for (const s of out) {
    if (s.crop_year == null && s.receipt_date) {
      const y = Number(s.receipt_date.slice(0, 4))
      if (Number.isFinite(y) && y > 1990) s.crop_year = y
    }
  }
  return out
}

// ---------- identity ----------

export type StatementIdentityInput = {
  gin_code: string | null
  statement_number?: string | null
  farm_number: string | null
  field: string | null
  receipt_date: string | null
  modules_count: number | null
  total_seed_cotton_weight: number | null
  bales_count: number | null
}

const token = (s: string | null | undefined): string => {
  const t = (s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return t || 'NA'
}
const ymd = (iso: string | null | undefined): string => (iso ? iso.replace(/-/g, '').slice(0, 8) : 'NODATE')

/** The duplicate-statement key: a printed statement number (with the gin),
 *  else gin + farm # + field + date + totals. Two statements with different
 *  dates or totals are never duplicates. */
export function statementIdentity(s: StatementIdentityInput): string {
  const gin = numberKey(s.gin_code) ?? 'NA'
  const sn = numberKey(s.statement_number)
  if (sn) return `S|${gin}|${sn}`
  return `T|${gin}|${numberKey(s.farm_number) ?? 'NA'}|${token(s.field)}|${ymd(s.receipt_date)}|${s.modules_count ?? ''}|${s.total_seed_cotton_weight ?? ''}|${s.bales_count ?? ''}`
}

/** gin_receipts.receipt_number for a statement that prints no number:
 *  "40614-20261007-5824-PIVOT-6-183540-160" — deterministic, one per
 *  identity, displayed nowhere (the list shows gin · date · farm/field). */
export function synthesizeReceiptNumber(s: StatementIdentityInput): string {
  const sn = (s.statement_number ?? '').trim()
  if (sn) return sn
  return [numberKey(s.gin_code) ?? 'NA', ymd(s.receipt_date), numberKey(s.farm_number) ?? 'NA', token(s.field), s.modules_count ?? 'NA', s.total_seed_cotton_weight ?? 'NA', s.bales_count ?? 'NA'].join('-')
}

/** True when the stored receipt_number is one synthesizeReceiptNumber made. */
export function isSynthesizedReceiptNumber(receiptNumber: string | null | undefined): boolean {
  return /^[A-Z0-9]+-(\d{8}|NODATE)-[A-Z0-9]+-[A-Z0-9-]+-(\d+|NA)-(\d+|NA)-(\d+|NA)$/.test((receiptNumber ?? '').trim())
}

/** How a receipt is named on screen: "Servico, Inc. · 10/7/2026 · farm 5824 · Pivot" (+ " · #1234" when the gin printed a statement number). */
export function receiptDisplayName(r: { gin_name?: string | null; gin_code?: string | null; receipt_date: string | null; farm_label?: string | null; field_label?: string | null; statement_number?: string | null; receipt_number?: string | null }): string {
  const parts: string[] = []
  parts.push(r.gin_name?.trim() || (r.gin_code ? `Gin ${r.gin_code}` : 'Gin'))
  parts.push(r.receipt_date ? fmtUsDate(r.receipt_date) : 'no date')
  const where = [r.farm_label ? `farm ${r.farm_label}` : null, r.field_label || null].filter(Boolean).join(' · ')
  if (where) parts.push(where)
  const sn = (r.statement_number ?? '').trim() || (r.receipt_number && !isSynthesizedReceiptNumber(r.receipt_number) ? r.receipt_number.trim() : '')
  if (sn) parts.push(`#${sn}`)
  return parts.join(' · ')
}

function fmtUsDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : iso
}

// ---------- classification against saved receipts ----------

export type SavedReceiptLike = {
  id: string
  receipt_number: string
  crop_year: number
  receipt_date: string | null
  gin_code?: string | null
  statement_number?: string | null
  /** The printed farm # / field (093); older rows fall back to the farm's FSA # and the field's name supplied by the caller. */
  printed_farm_number?: string | null
  printed_field?: string | null
  modules_count: number | null
  total_seed_cotton_weight: number | null
  bales_count: number | null
  total_bale_weight: number | null
}

export type ReceiptClassification =
  | { status: 'new' }
  | { status: 'saved'; existingId: string }
  | { status: 'update'; existingId: string; diffs: string[] }

const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString())
const differs = (a: number | null, b: number | null) => a != null && b != null && Math.abs(Number(a) - Number(b)) > 0.5

/** A statement against the receipts saved for its crop year. The identity
 *  (statementIdentity) decides; the synthesized receipt_number is the
 *  fallback for rows saved before the identity columns existed. */
export function classifyStatement(s: StatementIdentityInput & { total_bale_weight: number | null }, saved: ReadonlyArray<SavedReceiptLike>, cropYear: number): ReceiptClassification {
  const id = statementIdentity(s)
  const rn = numberKey(synthesizeReceiptNumber(s))
  const sn = numberKey(s.statement_number)
  const gin = numberKey(s.gin_code)
  for (const r of saved) {
    if (r.crop_year !== cropYear) continue
    const savedIdentity = statementIdentity({
      gin_code: r.gin_code ?? null, statement_number: r.statement_number ?? null, farm_number: r.printed_farm_number ?? null, field: r.printed_field ?? null,
      receipt_date: r.receipt_date, modules_count: r.modules_count, total_seed_cotton_weight: r.total_seed_cotton_weight, bales_count: r.bales_count,
    })
    const sameStatementNumber = sn != null && numberKey(r.statement_number) === sn && (gin == null || numberKey(r.gin_code) == null || numberKey(r.gin_code) === gin)
    const sameReceiptNumber = rn != null && numberKey(r.receipt_number) === rn
    if (savedIdentity !== id && !sameStatementNumber && !sameReceiptNumber) continue
    const diffs: string[] = []
    if (s.receipt_date && r.receipt_date && s.receipt_date !== r.receipt_date) diffs.push(`date ${r.receipt_date} → ${s.receipt_date}`)
    if (s.bales_count != null && r.bales_count != null && Number(s.bales_count) !== Number(r.bales_count)) diffs.push(`bales ${r.bales_count} → ${s.bales_count}`)
    if (differs(r.total_seed_cotton_weight, s.total_seed_cotton_weight)) diffs.push(`seed cotton ${fmt(r.total_seed_cotton_weight)} → ${fmt(s.total_seed_cotton_weight)} lbs`)
    if (differs(r.total_bale_weight, s.total_bale_weight)) diffs.push(`lint ${fmt(r.total_bale_weight)} → ${fmt(s.total_bale_weight)} lbs`)
    return diffs.length > 0 ? { status: 'update', existingId: r.id, diffs } : { status: 'saved', existingId: r.id }
  }
  return { status: 'new' }
}

// ---------- Farm YTD ----------

export type FarmYtdStatus = 'match' | 'short' | 'over' | 'printed_before' | 'none'
export type FarmYtdCheck = {
  status: FarmYtdStatus
  /** The gin's YTD figures. */
  printed: GinFarmYtd | null
  /** Turnrow's sum for the same gin + farm # dated on or before the statement (this statement included). */
  have: GinFarmYtd
  message: string | null
}

export type FarmYtdOther = {
  gin_code: string | null
  farm_number: string | null
  receipt_date: string | null
  modules_count: number | null
  total_seed_cotton_weight: number | null
  bales_count: number | null
  total_bale_weight: number | null
}

/**
 * Compare the statement's Farm YTD against the statements Turnrow holds for
 * the same gin + farm # dated on or before it (saved + the other statements
 * in this upload; the statement itself always counts once). Informational.
 * When the YTD prints BELOW the statement's own totals, the gin printed it
 * before this statement posted — the check is skipped with a muted note.
 */
export function farmYtdCheck(s: FarmYtdOther & { farm_ytd: GinFarmYtd | null }, others: ReadonlyArray<FarmYtdOther>): FarmYtdCheck {
  const have: GinFarmYtd = { modules: s.modules_count ?? 0, seed_cotton_lbs: s.total_seed_cotton_weight ?? 0, bales: s.bales_count ?? 0, bale_weight: s.total_bale_weight ?? 0 }
  const y = s.farm_ytd
  if (!y || (y.modules == null && y.seed_cotton_lbs == null && y.bales == null && y.bale_weight == null)) return { status: 'none', printed: y ?? null, have, message: null }
  const below = (ytd: number | null, own: number | null) => ytd != null && own != null && Number(ytd) < Number(own) - 0.5
  if (below(y.modules, s.modules_count) || below(y.seed_cotton_lbs, s.total_seed_cotton_weight) || below(y.bales, s.bales_count) || below(y.bale_weight, s.total_bale_weight)) {
    return { status: 'printed_before', printed: y, have, message: 'Gin YTD was printed before this statement posted.' }
  }
  const gin = numberKey(s.gin_code)
  const farm = numberKey(s.farm_number)
  for (const o of others) {
    if (numberKey(o.gin_code) !== gin || numberKey(o.farm_number) !== farm) continue
    if (s.receipt_date && o.receipt_date && o.receipt_date > s.receipt_date) continue
    have.modules = (have.modules ?? 0) + (o.modules_count ?? 0)
    have.seed_cotton_lbs = (have.seed_cotton_lbs ?? 0) + (o.total_seed_cotton_weight ?? 0)
    have.bales = (have.bales ?? 0) + (o.bales_count ?? 0)
    have.bale_weight = (have.bale_weight ?? 0) + (o.total_bale_weight ?? 0)
  }
  const cmp = (ytd: number | null, h: number | null): -1 | 0 | 1 => {
    if (ytd == null || h == null) return 0
    const d = Number(ytd) - Number(h)
    return Math.abs(d) <= 0.5 ? 0 : d > 0 ? 1 : -1
  }
  const signs = [cmp(y.modules, have.modules), cmp(y.seed_cotton_lbs, have.seed_cotton_lbs), cmp(y.bales, have.bales), cmp(y.bale_weight, have.bale_weight)]
  const ginName = s.gin_code ? `Gin ${s.gin_code}` : 'The gin'
  const farmLabel = s.farm_number ? `farm ${s.farm_number}` : 'this farm'
  if (signs.every((x) => x === 0)) return { status: 'match', printed: y, have, message: 'Farm YTD matches your statements.' }
  if (signs.some((x) => x > 0) && !signs.some((x) => x < 0)) {
    return {
      status: 'short', printed: y, have,
      message: `${ginName} shows ${fmt(y.modules)} modules / ${fmt(y.bales)} bales YTD for ${farmLabel}. Turnrow has ${fmt(have.modules)} / ${fmt(have.bales)}. A statement may not be uploaded yet.`,
    }
  }
  return {
    status: 'over', printed: y, have,
    message: `${ginName} shows ${fmt(y.modules)} modules / ${fmt(y.bales)} bales YTD for ${farmLabel}, but Turnrow has ${fmt(have.modules)} / ${fmt(have.bales)}. A statement may be saved twice.`,
  }
}
