// USDA/FSA "Payment Statement" reading (0099) — the pure half.
//
// The statement is a national layout (printed by the FSA National Office for
// every FSA program): a header (county office, payee, statement date, the
// Payment Summary) and then PAYMENT BLOCKS — program title, FSA Payment ID,
// farm number, transaction control number, gross / deductions / net, the
// payment method line ("ACH sent to MARTIN FARM at PNC BANK … account ending
// in 2036 on/about 10/15/2026") — each followed by Notes (program year,
// program name, farm number, "Crop and Payment Amount Detail", the sequester
// sentence, appeal rights). Scan quirks the reader must survive: duplex scans
// store every even page upside down (lib/orientation straightens them before
// anything is sent), a block's header can sit at the bottom of one page with
// its Notes at the top of the next (across a chunk boundary too), and
// trailing blank pages produce nothing.
//
// The model reports the document BLOCK BY BLOCK, in page order, flagging
// fragments: a header whose notes are not on its pages (`notes_present`
// false) and a notes section whose header is not on its pages
// (`header_present` false). stitchBlocks joins them — by FSA Payment ID when
// the fragment carries one, else by page order: a header-less notes fragment
// belongs to the last open block before it (the farm number in the notes
// corroborates). mergeFsaPaymentStatements (the chunk merge) concatenates the
// chunks' blocks in page order and stitches once, so a block split across a
// chunk boundary comes out as ONE line.
//
// Everything here is pure: lib/fsa-payment-statement.test.ts runs the two
// October 2026 statements as synthetic fixtures (lib/fsa-statement-fixture.ts).

import type { FsaProgramCode } from '@/lib/types'

// ---------- the extraction shape (what the prompt asks for) ----------

export type FsaCropAmountExtraction = { crop: string | null; amount: number | null }

export type FsaBlockNotesExtraction = {
  program_year: number | null
  program_name: string | null
  farm_number: string | null
  crop_amounts: FsaCropAmountExtraction[] | null
  /** The sequester percent as printed ("reduced by 5.7 percent" → 5.7). */
  sequester_pct: number | null
  /** The Notes text as printed. */
  text: string | null
}

export type FsaBlockExtraction = {
  /** 1-based page the block STARTS on (rebased to the whole document by lib/parse-chunked). */
  page: number | null
  program_title: string | null
  fsa_payment_id: string | null
  farm_number: string | null
  transaction_control_number: string | null
  gross: number | null
  deductions: number | null
  deduction_detail: Array<{ description: string | null; amount: number | null }> | null
  net: number | null
  payment_method: string | null
  bank_name: string | null
  /** The last four digits only. */
  account_last4: string | null
  payment_date: string | null
  notes: FsaBlockNotesExtraction | null
  /** False when the block's header is not on the pages given (a Notes-only fragment). */
  header_present: boolean | null
  /** False when the block's Notes are not on the pages given (header at a page bottom). */
  notes_present: boolean | null
}

export type FsaPageExtraction = {
  page: number | null
  /** How many "FSA Payment ID:" block headers the page shows (0 for a blank or notes-only page). */
  header_count: number | null
}

export type FsaPaymentStatementExtraction = {
  office_name: string | null
  office_address: string | null
  office_phone: string | null
  payee_name: string | null
  payee_address: string | null
  statement_date: string | null
  summary: { gross: number | null; deductions: number | null; net: number | null } | null
  pages: FsaPageExtraction[] | null
  blocks: FsaBlockExtraction[] | null
}

// ---------- normalization ----------

const money = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
const text = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}
const digits = (v: unknown): string | null => {
  const s = text(v)
  if (!s) return null
  const d = s.replace(/\D+/g, '')
  return d ? d : null
}

/** "10/13/2026", "2026-10-13", "on/about 10/15/2026" → ISO date, else null. */
export function isoDate(v: unknown): string | null {
  const s = text(v)
  if (!s) return null
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s)
  if (us) {
    const y = us[3].length === 2 ? `20${us[3]}` : us[3]
    return `${y}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  }
  return null
}

/** The sequester percent as a FRACTION (5.7 → 0.057; 0.057 stays 0.057). */
export function sequesterFraction(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[%\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return null
  return n > 1 ? Math.round(n * 1e4) / 1e6 : Math.round(n * 1e6) / 1e6
}

/** Program title → the code the app reasons about. */
export function normalizeProgramCode(title: string | null | undefined, programName?: string | null): FsaProgramCode {
  const s = `${title ?? ''} ${programName ?? ''}`.toUpperCase()
  if (/PRICE\s+LOSS/.test(s) || /\bPLC\b/.test(s)) return 'PLC'
  if (/AGRICULTUR\w*\s+RISK|\bARC\b/.test(s)) {
    if (/INDIVIDUAL|\bIC\b/.test(s)) return 'ARC_IC'
    return 'ARC_CO'
  }
  return 'OTHER'
}

export const PROGRAM_CODE_LABEL: Record<FsaProgramCode, string> = {
  PLC: 'PLC', ARC_CO: 'ARC-CO', ARC_IC: 'ARC-IC', OTHER: 'Other program',
}

/** One raw block → a clean block (numbers parsed, dates ISO, last4 digits only). */
export function normalizeBlock(raw: unknown): FsaBlockExtraction {
  const b = (raw ?? {}) as Record<string, unknown>
  const notesRaw = b.notes as Record<string, unknown> | null | undefined
  const notes: FsaBlockNotesExtraction | null = notesRaw && typeof notesRaw === 'object'
    ? {
        program_year: (() => { const n = Number(notesRaw.program_year); return Number.isInteger(n) && n > 1990 && n < 2100 ? n : null })(),
        program_name: text(notesRaw.program_name),
        farm_number: digits(notesRaw.farm_number),
        crop_amounts: Array.isArray(notesRaw.crop_amounts)
          ? (notesRaw.crop_amounts as unknown[]).map((c) => {
              const x = (c ?? {}) as Record<string, unknown>
              return { crop: text(x.crop), amount: money(x.amount) }
            }).filter((c) => c.crop != null || c.amount != null)
          : null,
        sequester_pct: money(notesRaw.sequester_pct),
        text: text(notesRaw.text),
      }
    : null
  const last4 = digits(b.account_last4)
  return {
    page: (() => { const n = Number(b.page); return Number.isInteger(n) && n > 0 ? n : null })(),
    program_title: text(b.program_title),
    fsa_payment_id: digits(b.fsa_payment_id),
    farm_number: digits(b.farm_number),
    transaction_control_number: digits(b.transaction_control_number),
    gross: money(b.gross),
    deductions: money(b.deductions),
    deduction_detail: Array.isArray(b.deduction_detail)
      ? (b.deduction_detail as unknown[]).map((d) => { const x = (d ?? {}) as Record<string, unknown>; return { description: text(x.description), amount: money(x.amount) } }).filter((d) => d.description || d.amount != null)
      : null,
    net: money(b.net),
    payment_method: text(b.payment_method),
    bank_name: text(b.bank_name),
    // Never more than the last four digits, whatever the model returned.
    account_last4: last4 ? last4.slice(-4) : null,
    payment_date: isoDate(b.payment_date),
    notes,
    header_present: b.header_present == null ? null : Boolean(b.header_present),
    notes_present: b.notes_present == null ? null : Boolean(b.notes_present),
  }
}

export function normalizeFsaPaymentStatement(raw: unknown): FsaPaymentStatementExtraction {
  const r = (raw ?? {}) as Record<string, unknown>
  const summary = (r.summary ?? null) as Record<string, unknown> | null
  return {
    office_name: text(r.office_name),
    office_address: text(r.office_address),
    office_phone: text(r.office_phone),
    payee_name: text(r.payee_name),
    payee_address: text(r.payee_address),
    statement_date: isoDate(r.statement_date),
    summary: summary ? { gross: money(summary.gross), deductions: money(summary.deductions), net: money(summary.net) } : null,
    pages: Array.isArray(r.pages)
      ? (r.pages as unknown[]).map((p) => { const x = (p ?? {}) as Record<string, unknown>; const n = Number(x.page); const h = Number(x.header_count); return { page: Number.isInteger(n) && n > 0 ? n : null, header_count: Number.isInteger(h) && h >= 0 ? h : null } })
      : null,
    blocks: Array.isArray(r.blocks) ? (r.blocks as unknown[]).map(normalizeBlock) : null,
  }
}

// ---------- stitching (page and chunk boundaries) ----------

/** A block after stitching: the header's facts + its notes, in page order. */
export type FsaStitchedBlock = FsaBlockExtraction & {
  /** True when the block has its header (an ID, a gross) — a bare notes fragment nothing claimed stays false. */
  complete: boolean
  /** The page the notes were on when they came from a later page. */
  notes_page: number | null
}

/**
 * Join header fragments with their notes. Blocks arrive in page order
 * (chunks concatenated and rebased). Rules, in order:
 *   1. a fragment that carries an FSA Payment ID matching an open header
 *      joins that header;
 *   2. a header-less notes fragment joins the most recent header still
 *      waiting for notes whose farm number matches the fragment's (when
 *      both print one), else the most recent waiting header;
 *   3. a header seen twice (the same FSA Payment ID) keeps the first and
 *      merges any notes the repeat brought.
 * Pure boilerplate continuations (no fields at all) are dropped.
 */
export function stitchBlocks(blocks: ReadonlyArray<FsaBlockExtraction>): FsaStitchedBlock[] {
  const out: FsaStitchedBlock[] = []
  const byId = new Map<string, FsaStitchedBlock>()
  const hasHeader = (b: FsaBlockExtraction) => b.header_present !== false && (b.fsa_payment_id != null || b.gross != null || b.transaction_control_number != null)
  const hasNotes = (b: FsaBlockExtraction) => b.notes != null && (
    (b.notes.crop_amounts?.length ?? 0) > 0 || b.notes.program_year != null || b.notes.farm_number != null || b.notes.program_name != null || b.notes.sequester_pct != null
  )
  const waiting = (): FsaStitchedBlock[] => out.filter((o) => o.complete && !hasNotes(o))
  for (const b of blocks) {
    if (hasHeader(b)) {
      const id = b.fsa_payment_id
      if (id && byId.has(id)) {
        const existing = byId.get(id)!
        if (!hasNotes(existing) && hasNotes(b)) { existing.notes = b.notes; existing.notes_page = b.page }
        continue
      }
      const s: FsaStitchedBlock = { ...b, complete: true, notes_page: hasNotes(b) ? b.page : null }
      out.push(s)
      if (id) byId.set(id, s)
      continue
    }
    if (!hasNotes(b)) continue // boilerplate continuation
    // A notes fragment: by ID when it carries one, else by page order + farm number.
    let target: FsaStitchedBlock | undefined
    if (b.fsa_payment_id && byId.has(b.fsa_payment_id) && !hasNotes(byId.get(b.fsa_payment_id)!)) target = byId.get(b.fsa_payment_id)
    if (!target) {
      const open = waiting()
      const farm = b.notes?.farm_number ?? b.farm_number
      const candidates = open.filter((o) => (b.page == null || o.page == null || o.page <= b.page))
      const pool = candidates.length > 0 ? candidates : open
      target = [...pool].reverse().find((o) => farm == null || o.farm_number == null || o.farm_number === farm) ?? pool[pool.length - 1]
    }
    if (target) {
      target.notes = b.notes
      target.notes_page = b.page
      if (!target.farm_number && b.notes?.farm_number) target.farm_number = b.notes.farm_number
    } else {
      // Nothing to attach to (the header was on a page that failed to read):
      // keep it as an incomplete block so the review can show it.
      out.push({ ...b, complete: false, notes_page: b.page })
    }
  }
  return out
}

/** The chunk merge for lib/parse-chunked: header fields from the first chunk
 *  that has them, blocks concatenated in page order and stitched once. */
export function mergeFsaPaymentStatements(parts: FsaPaymentStatementExtraction[]): FsaPaymentStatementExtraction {
  const first = <V,>(pick: (p: FsaPaymentStatementExtraction) => V | null | undefined): V | null => {
    for (const p of parts) { const v = pick(p); if (v != null) return v }
    return null
  }
  const blocks = parts.flatMap((p) => p.blocks ?? [])
  // Stable by page; blocks without a page keep their arrival order.
  const ordered = blocks.map((b, i) => ({ b, i })).sort((x, y) => ((x.b.page ?? Infinity) - (y.b.page ?? Infinity)) || (x.i - y.i)).map((x) => x.b)
  const pages = parts.flatMap((p) => p.pages ?? [])
  const seenPages = new Set<number>()
  const dedupedPages = pages.filter((p) => { if (p.page == null) return true; if (seenPages.has(p.page)) return false; seenPages.add(p.page); return true })
  return {
    office_name: first((p) => p.office_name), office_address: first((p) => p.office_address), office_phone: first((p) => p.office_phone),
    payee_name: first((p) => p.payee_name), payee_address: first((p) => p.payee_address),
    statement_date: first((p) => p.statement_date),
    summary: first((p) => p.summary),
    pages: dedupedPages,
    blocks: stitchBlocks(ordered),
  }
}

/** Rebase a chunk's page numbers to the whole document (lib/parse-chunked `rebase`). */
export function rebaseFsaPages(part: FsaPaymentStatementExtraction, firstPage: number): FsaPaymentStatementExtraction {
  const shift = (n: number | null) => (n == null ? null : n + firstPage - 1)
  return {
    ...part,
    pages: part.pages?.map((p) => ({ ...p, page: shift(p.page) })) ?? null,
    blocks: part.blocks?.map((b) => ({ ...b, page: shift(b.page) })) ?? null,
  }
}

// ---------- checks ----------

export type StatementCheck = { key: string; label: string; ok: boolean; detail: string }

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const eq = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) < 0.005

export function sumCrops(b: Pick<FsaBlockExtraction, 'notes'>): number | null {
  const rows = b.notes?.crop_amounts ?? null
  if (!rows || rows.length === 0) return null
  return Math.round(rows.reduce((s, c) => s + (c.amount ?? 0), 0) * 100) / 100
}

/** The four code checks shown in review. */
export function checkStatement(x: FsaPaymentStatementExtraction): StatementCheck[] {
  const blocks = (x.blocks ?? []) as FsaStitchedBlock[]
  const complete = blocks.filter((b) => (b as FsaStitchedBlock).complete !== false)
  const checks: StatementCheck[] = []
  // 1. Each block's crop amounts sum to its gross.
  const cropBad = complete.filter((b) => { const s = sumCrops(b); return s != null && b.gross != null && !eq(s, b.gross) })
  const cropMissing = complete.filter((b) => sumCrops(b) == null)
  checks.push({
    key: 'crops', label: 'Crop amounts add up to each block’s gross',
    ok: cropBad.length === 0,
    detail: cropBad.length > 0
      ? cropBad.map((b) => `${PROGRAM_CODE_LABEL[normalizeProgramCode(b.program_title, b.notes?.program_name)]} farm ${b.farm_number ?? '?'}: crops ${usd(sumCrops(b))} vs gross ${usd(b.gross)}`).join('; ')
      : cropMissing.length > 0 ? `${complete.length - cropMissing.length} of ${complete.length} blocks checked (${cropMissing.length} with no crop detail)` : `${complete.length} blocks checked`,
  })
  // 2. Gross − deductions = net per block.
  const netBad = complete.filter((b) => b.gross != null && b.net != null && !eq(b.gross - (b.deductions ?? 0), b.net))
  checks.push({
    key: 'net', label: 'Gross minus deductions equals net on every block',
    ok: netBad.length === 0,
    detail: netBad.length > 0 ? netBad.map((b) => `farm ${b.farm_number ?? '?'}: ${usd(b.gross)} − ${usd(b.deductions ?? 0)} ≠ ${usd(b.net)}`).join('; ') : `${complete.length} blocks checked`,
  })
  // 3. The blocks' nets sum to the statement's net.
  const netSum = Math.round(complete.reduce((s, b) => s + (b.net ?? 0), 0) * 100) / 100
  const stmtNet = x.summary?.net ?? null
  checks.push({
    key: 'total', label: 'Blocks add up to the statement’s net payment',
    ok: stmtNet != null && eq(netSum, stmtNet),
    detail: stmtNet == null ? `blocks total ${usd(netSum)}; no statement net read` : `blocks ${usd(netSum)} vs statement ${usd(stmtNet)}`,
  })
  // 4. The count of blocks read matches the headers found in the page structure.
  const headerCount = (x.pages ?? []).reduce((s, p) => s + (p.header_count ?? 0), 0)
  const pagesKnown = (x.pages ?? []).some((p) => p.header_count != null)
  checks.push({
    key: 'count', label: 'Every payment block on the pages was read',
    ok: !pagesKnown || headerCount === complete.length,
    detail: pagesKnown ? `${complete.length} blocks read, ${headerCount} block headers on the pages` : `${complete.length} blocks read`,
  })
  return checks
}

// ---------- commodity + farm + payee matching ----------

const CROP_ALIASES: Array<[RegExp, string]> = [
  [/SEED\s*COTTON|UPLAND\s*COTTON|^COTTON$/, 'Seed Cotton'],
  [/^CORN$|\bCORN\b/, 'Corn'],
  [/SOYBEAN/, 'Soybeans'],
  [/^WHEAT$|\bWHEAT\b/, 'Wheat'],
  [/CANOLA/, 'Canola'],
  [/SORGHUM|\bMILO\b/, 'Grain Sorghum'],
  [/^OATS?$/, 'Oats'],
  [/BARLEY/, 'Barley'],
  [/PEANUT/, 'Peanuts'],
  [/SESAME/, 'Sesame'],
  [/SUNFLOWER/, 'Sunflowers'],
  [/RICE/, 'Rice'],
  [/CRAMBE/, 'Crambe'],
  [/SAFFLOWER/, 'Safflower'],
  [/FLAX/, 'Flaxseed'],
  [/MUSTARD/, 'Mustard'],
  [/RAPESEED/, 'Rapeseed'],
  [/LENTIL/, 'Lentils'],
  [/CHICKPEA|GARBANZO/, 'Chickpeas'],
  [/DRY\s*PEA/, 'Dry Peas'],
]

/** The covered commodity a printed crop name means, else null. */
export function commodityForCrop<T extends { id: string; name: string }>(raw: string | null | undefined, commodities: ReadonlyArray<T>): T | null {
  const s = (raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
  if (!s) return null
  const canonical = CROP_ALIASES.find(([re]) => re.test(s))?.[1] ?? null
  const byName = (name: string) => commodities.find((c) => c.name.trim().toLowerCase() === name.toLowerCase()) ?? null
  if (canonical) {
    const hit = byName(canonical)
    if (hit) return hit
  }
  return byName(s) ?? commodities.find((c) => c.name.trim().toUpperCase().startsWith(s) || s.startsWith(c.name.trim().toUpperCase())) ?? null
}

export type FarmMatchLike = { id: string; name: string; fsa_number: string | null; county_id: string | null; archived_at?: string | null }

/** "LAWRENCE FSA OFFICE" → "lawrence" (the county the office serves), else null. */
export function officeCountyName(office: string | null | undefined): string | null {
  const s = (office ?? '').trim()
  if (!s) return null
  const m = /^(.*?)\s+(?:COUNTY\s+)?FSA\b/i.exec(s) ?? /^(.*?)\s+COUNTY\b/i.exec(s)
  const name = (m ? m[1] : s).trim().toLowerCase()
  return name || null
}

/**
 * The farm an FSA farm number names: FSA numbers are unique WITHIN a county,
 * so a number that matches farms in several counties resolves to the farm
 * in the office's county; one match anywhere resolves outright; several
 * matches with no office county stay unmatched (ambiguous).
 */
export function matchFarmByFsaNumber(args: {
  fsaNumber: string | null | undefined
  farms: ReadonlyArray<FarmMatchLike>
  officeCountyId?: string | null
}): { farm: FarmMatchLike | null; ambiguous: boolean } {
  const key = digits(args.fsaNumber)
  if (!key) return { farm: null, ambiguous: false }
  const norm = (s: string | null) => (s ?? '').replace(/\D+/g, '').replace(/^0+/, '')
  const hits = args.farms.filter((f) => !f.archived_at && norm(f.fsa_number) === key.replace(/^0+/, ''))
  if (hits.length === 0) return { farm: null, ambiguous: false }
  if (hits.length === 1) return { farm: hits[0], ambiguous: false }
  if (args.officeCountyId) {
    const inCounty = hits.filter((f) => f.county_id === args.officeCountyId)
    if (inCounty.length === 1) return { farm: inCounty[0], ambiguous: false }
  }
  return { farm: null, ambiguous: true }
}

const normEntity = (s: string) => s.toLowerCase().replace(/[.,'’]/g, '').replace(/\b(llc|inc|l\.?l\.?c\.?|co|company|farms?)\b/g, ' ').replace(/\s+/g, ' ').trim()

/** The entity a payee name means (exact name, else the name without LLC / punctuation / "Farm"). */
export function matchPayeeEntity<T extends { id: string; name: string; archived_at?: string | null }>(payee: string | null | undefined, entities: ReadonlyArray<T>): T | null {
  const s = (payee ?? '').trim().toLowerCase()
  if (!s) return null
  const exact = entities.find((e) => e.name.trim().toLowerCase() === s)
  if (exact) return exact
  const n = normEntity(s)
  if (!n) return null
  return entities.find((e) => normEntity(e.name) === n) ?? null
}

// ---------- the review rows + the save plan ----------

export type StatementLineReview = {
  /** Stable key for React (the FSA Payment ID, else page + index). */
  key: string
  block: FsaStitchedBlock
  programCode: FsaProgramCode
  programYear: number | null
  farmNumber: string | null
  farmId: string | null
  farmAmbiguous: boolean
  crops: Array<{ raw: string; amount: number; commodityId: string | null }>
  gross: number
  deductions: number
  net: number
  paymentDate: string | null
  sequesterPct: number | null
  /** The FSA Payment ID is already on file — nothing new to save. */
  alreadyRecorded: boolean
  include: boolean
}

export function buildLineReviews(args: {
  extraction: FsaPaymentStatementExtraction
  farms: ReadonlyArray<FarmMatchLike>
  commodities: ReadonlyArray<{ id: string; name: string }>
  existingPaymentIds: ReadonlySet<string>
  officeCountyId?: string | null
}): StatementLineReview[] {
  const blocks = (args.extraction.blocks ?? []) as FsaStitchedBlock[]
  return blocks.map((b, i) => {
    const farmNumber = b.farm_number ?? b.notes?.farm_number ?? null
    const match = matchFarmByFsaNumber({ fsaNumber: farmNumber, farms: args.farms, officeCountyId: args.officeCountyId })
    const alreadyRecorded = b.fsa_payment_id != null && args.existingPaymentIds.has(b.fsa_payment_id)
    return {
      key: b.fsa_payment_id ?? `p${b.page ?? 0}-${i}`,
      block: b,
      programCode: normalizeProgramCode(b.program_title, b.notes?.program_name),
      programYear: b.notes?.program_year ?? null,
      farmNumber,
      farmId: match.farm?.id ?? null,
      farmAmbiguous: match.ambiguous,
      crops: (b.notes?.crop_amounts ?? []).filter((c) => c.amount != null).map((c) => ({
        raw: c.crop ?? '', amount: c.amount as number, commodityId: commodityForCrop(c.crop, args.commodities)?.id ?? null,
      })),
      gross: b.gross ?? sumCrops(b) ?? b.net ?? 0,
      deductions: b.deductions ?? 0,
      net: b.net ?? ((b.gross ?? sumCrops(b) ?? 0) - (b.deductions ?? 0)),
      paymentDate: b.payment_date,
      sequesterPct: sequesterFraction(b.notes?.sequester_pct),
      alreadyRecorded,
      include: !alreadyRecorded && b.complete !== false,
    }
  })
}

export type StatementSavePlan = {
  statement: {
    statement_date: string
    office_name: string | null
    office_address: string | null
    office_phone: string | null
    payee_name: string
    payee_address: string | null
    payee_entity_id: string | null
    gross_payment: number
    deductions: number
    net_payment: number
    page_count: number | null
  }
  lines: Array<{
    review: StatementLineReview
    row: {
      fsa_payment_id: string
      transaction_control_number: string | null
      program_code: FsaProgramCode
      program_name_raw: string
      program_year: number | null
      farm_id: string | null
      fsa_farm_number: string | null
      gross_payment: number
      deductions: number
      deduction_detail: Array<{ description: string; amount: number }> | null
      net_payment: number
      payment_method: string | null
      bank_name: string | null
      account_last4: string | null
      payment_date: string | null
      sequester_pct: number | null
      notes: string | null
      page_number: number | null
    }
    crops: Array<{ commodity_id: string | null; raw_crop: string; amount: number }>
    /** Non-ARC/PLC programs land as other_government_payments too. */
    otherPayment: { program_name: string; crop_year: number; amount: number; payment_date: string | null; farm_id: string | null; entity_id: string | null } | null
  }>
  /** Lines skipped because their FSA Payment ID is already on file. */
  alreadyRecorded: StatementLineReview[]
  /** Lines skipped for lack of an FSA Payment ID (cannot be deduped) or because the user unticked them. */
  skipped: StatementLineReview[]
  /** Plain-English blockers (nothing saves while any exist). */
  blockers: string[]
}

export function planStatementSave(args: {
  extraction: FsaPaymentStatementExtraction
  reviews: ReadonlyArray<StatementLineReview>
  payeeEntityId: string | null
  pageCount: number | null
}): StatementSavePlan {
  const x = args.extraction
  const blockers: string[] = []
  if (!x.statement_date) blockers.push('The statement date could not be read.')
  if (!x.payee_name) blockers.push('The payee name could not be read.')
  const included = args.reviews.filter((r) => r.include && !r.alreadyRecorded)
  const seen = new Set<string>()
  const lines: StatementSavePlan['lines'] = []
  const skipped: StatementLineReview[] = []
  for (const r of included) {
    const id = r.block.fsa_payment_id
    if (!id || seen.has(id)) { skipped.push(r); continue }
    seen.add(id)
    const isArcPlc = r.programCode !== 'OTHER'
    const programName = r.block.notes?.program_name ?? r.block.program_title ?? 'FSA program'
    lines.push({
      review: r,
      row: {
        fsa_payment_id: id,
        transaction_control_number: r.block.transaction_control_number,
        program_code: r.programCode,
        program_name_raw: r.block.program_title ?? programName,
        program_year: r.programYear,
        farm_id: r.farmId,
        fsa_farm_number: r.farmNumber,
        gross_payment: r.gross,
        deductions: r.deductions,
        deduction_detail: r.block.deduction_detail?.filter((d) => d.description || d.amount != null).map((d) => ({ description: d.description ?? '', amount: d.amount ?? 0 })) ?? null,
        net_payment: r.net,
        payment_method: r.block.payment_method,
        bank_name: r.block.bank_name,
        account_last4: r.block.account_last4,
        payment_date: r.paymentDate,
        sequester_pct: r.sequesterPct,
        notes: r.block.notes?.text ?? null,
        page_number: r.block.page,
      },
      crops: r.crops.map((c) => ({ commodity_id: c.commodityId, raw_crop: c.raw, amount: c.amount })),
      otherPayment: isArcPlc ? null : {
        program_name: programName,
        crop_year: Number((r.paymentDate ?? x.statement_date ?? '').slice(0, 4)) || new Date().getFullYear(),
        amount: r.net,
        payment_date: r.paymentDate ?? x.statement_date,
        farm_id: r.farmId,
        entity_id: args.payeeEntityId,
      },
    })
  }
  for (const r of args.reviews) if (!r.include && !r.alreadyRecorded) skipped.push(r)
  const gross = x.summary?.gross ?? Math.round(args.reviews.reduce((s, r) => s + r.gross, 0) * 100) / 100
  const net = x.summary?.net ?? Math.round(args.reviews.reduce((s, r) => s + r.net, 0) * 100) / 100
  return {
    statement: {
      statement_date: x.statement_date ?? '',
      office_name: x.office_name, office_address: x.office_address, office_phone: x.office_phone,
      payee_name: x.payee_name ?? '', payee_address: x.payee_address, payee_entity_id: args.payeeEntityId,
      gross_payment: gross, deductions: x.summary?.deductions ?? Math.round((gross - net) * 100) / 100, net_payment: net,
      page_count: args.pageCount,
    },
    lines,
    alreadyRecorded: args.reviews.filter((r) => r.alreadyRecorded),
    skipped,
    blockers,
  }
}

/** The one sentence for the payee tie-in ("This statement paid MARTIN FARM for program year 2025 on 23 farms. Turnrow has View Celeste / Two Seasons."). */
export function payeeNoticeText(args: { payeeName: string; programYear: number; farmCount: number; turnrowEntityNames: string[] }): string {
  const have = args.turnrowEntityNames.length > 0 ? args.turnrowEntityNames.join(' / ') : 'no payee'
  return `This statement paid ${args.payeeName} for program year ${args.programYear} on ${args.farmCount} farm${args.farmCount === 1 ? '' : 's'}. Turnrow has ${have}.`
}

/** Totals a review can quote: by program and by commodity. */
export function reviewTotals(reviews: ReadonlyArray<StatementLineReview>, commodities: ReadonlyArray<{ id: string; name: string }>) {
  const byProgram = new Map<FsaProgramCode, number>()
  const byCommodity = new Map<string, number>()
  let net = 0
  for (const r of reviews) {
    net += r.net
    byProgram.set(r.programCode, Math.round(((byProgram.get(r.programCode) ?? 0) + r.net) * 100) / 100)
    for (const c of r.crops) {
      const k = c.commodityId ? commodities.find((x) => x.id === c.commodityId)?.name ?? c.raw : c.raw
      byCommodity.set(k, Math.round(((byCommodity.get(k) ?? 0) + c.amount) * 100) / 100)
    }
  }
  return { net: Math.round(net * 100) / 100, byProgram, byCommodity, farms: new Set(reviews.map((r) => r.farmNumber).filter(Boolean)).size }
}
