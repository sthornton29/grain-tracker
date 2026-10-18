// The gin's CSV export of Statements of Ginning (2026-10-18) — the file a
// gin's office system writes out ("GIN RECEIPTS CSV export"): one file, one
// or more statements back to back, each a labelled block rather than a
// table:
//
//   ,Producer:                      ← a statement starts here
//   VIEW CELESTE FARM LLC           ← producer name, then address lines
//   P. O. BOX 356
//   COURTLAND AL 35618
//   256/637-2281,Farm:              ← the phone sits beside the Farm: label
//   7282                            ← the farm number as the gin prints it
//   DUPES FARM                      ← the farm name
//   Field:
//   DRIVEWAYSOUTH
//   Producer Totals,Statement,Farm YTD,Producer YTD
//   Module:,7,10,29                 ← Statement = this statement's totals;
//   Weight:,210560,293780,845160       Farm YTD = the gin's farm year-to-date
//   …
//   Load #,Rolls,Gross,Tare,Net     ← the load table
//   33585,6,64700,31400,33300
//    ,PBI,Date Ginned,Net           ← the bale list
//   1,183211,10/15/2026,477
//
// Pure. The result is the page shape the PDF reader produces (one
// GinReceiptPage per statement, each carrying its totals block), so
// lib/gin-statements groups, identifies and classifies a CSV statement
// exactly like a scanned one — nothing downstream knows the difference.
//
// What the export does NOT print: the gin's name or USDA gin code, a
// statement number, a statement date. The statement date becomes the last
// "Date Ginned" in its bale list (the day its ginning finished); the gin is
// picked on the review card.

import type { GinReceiptBaleRow, GinReceiptLoadLine, GinReceiptPage, GinReceiptTotals, GinFarmYtd } from '@/lib/pdf-upload'
import { splitCsvRows } from '@/lib/csv-rows'

export type GinReceiptCsvResult = {
  pages: GinReceiptPage[]
  /** Per-statement figures that do not add up (load table vs modules /
   *  weight, bale list vs lint) — informational, the review shows them. */
  warnings: string[]
}

/** The file is not this export. The message is the farmer-facing sentence. */
export class GinReceiptCsvError extends Error {}

export const GIN_RECEIPT_CSV_SHAPE = 'A gin receipt CSV has a Producer, Farm and Field block, the Producer Totals, a Load # table and a PBI bale list for each statement.'

const cell = (row: readonly string[], i: number): string => (row[i] ?? '').trim()
/** "Lint Turnout %:" → "lint turnout %", "Load #" → "load #", " PBI " → "pbi". */
const labelOf = (s: string): string => s.trim().toLowerCase().replace(/\s*:\s*$/, '').replace(/\s+/g, ' ')
const labelIndex = (row: readonly string[], ...names: string[]): number => row.findIndex((c) => names.includes(labelOf(c)))

const num = (s: string): number | null => {
  const t = s.replace(/[,%$\s]/g, '')
  if (!t || t === '-') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
const int = (s: string): number | null => { const n = num(s); return n == null ? null : Math.round(n) }

/** "10/15/2026" or "2026-10-15" → "2026-10-15"; anything else → null. */
export function csvDateToIso(s: string): string | null {
  const t = s.trim()
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3])
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** A quick shape check for the upload control: a Producer label and a PBI header. */
export function looksLikeGinReceiptCsv(text: string): boolean {
  const rows = splitCsvRows(text)
  return rows.some((r) => labelIndex(r, 'producer') >= 0) && rows.some((r) => labelIndex(r, 'pbi') >= 0)
}

type Section = 'producer' | 'farm' | 'field' | 'totals' | 'loads' | 'bales'

const TOTALS_KEYS: Record<string, keyof GinReceiptTotals | 'avg_seed'> = {
  'module': 'modules_count', 'modules': 'modules_count',
  'weight': 'total_seed_cotton_weight', 'seed cotton': 'total_seed_cotton_weight', 'seed cotton wt': 'total_seed_cotton_weight',
  'bales': 'bales_count', 'bale': 'bales_count',
  'bale wt': 'total_bale_weight', 'bale weight': 'total_bale_weight', 'lint': 'total_bale_weight', 'lint wt': 'total_bale_weight',
  'avg bale wt': 'avg_bale_weight', 'avg bale weight': 'avg_bale_weight',
  'seed': 'seed_lbs', 'seed lbs': 'seed_lbs', 'cottonseed': 'seed_lbs',
  'avg seed': 'avg_seed',
  'lint turnout %': 'lint_turnout_pct', 'turnout %': 'lint_turnout_pct', 'lint turnout': 'lint_turnout_pct', 'turnout': 'lint_turnout_pct',
  'lint turnout lb/bl': 'lint_lbs_per_bale', 'lint lb/bl': 'lint_lbs_per_bale', 'lint turnout lbs/bale': 'lint_lbs_per_bale',
}
const YTD_KEYS: Partial<Record<keyof GinReceiptTotals, keyof GinFarmYtd>> = {
  modules_count: 'modules', total_seed_cotton_weight: 'seed_cotton_lbs', bales_count: 'bales', total_bale_weight: 'bale_weight',
}

export type GinReceiptCsvOptions = {
  /** The crop year the user is working in. Used when the ginning dates fall
   *  in that year or the January after it (ginning runs past New Year);
   *  otherwise the ginning date's own year wins. */
  cropYear?: number | null
}

/** Parse the whole export. Throws GinReceiptCsvError when the file is not this shape. */
export function parseGinReceiptCsv(text: string, opts: GinReceiptCsvOptions = {}): GinReceiptCsvResult {
  const rows = splitCsvRows(text)
  const starts: number[] = []
  rows.forEach((r, i) => { if (labelIndex(r, 'producer') >= 0) starts.push(i) })
  if (starts.length === 0 || !rows.some((r) => labelIndex(r, 'pbi') >= 0)) {
    throw new GinReceiptCsvError(`This file doesn't look like a gin receipt export. ${GIN_RECEIPT_CSV_SHAPE}`)
  }
  const warnings: string[] = []
  const pages = starts.map((start, k) => parseBlock(rows.slice(start, starts[k + 1] ?? rows.length), k + 1, opts, warnings))
  return { pages, warnings }
}

function parseBlock(rows: string[][], pageNo: number, opts: GinReceiptCsvOptions, warnings: string[]): GinReceiptPage {
  const producerLines: string[] = []
  const farmLines: string[] = []
  const fieldLines: string[] = []
  const totals: GinReceiptTotals = { modules_count: null, total_seed_cotton_weight: null, bales_count: null, total_bale_weight: null, avg_bale_weight: null, seed_lbs: null, lint_turnout_pct: null, lint_lbs_per_bale: null }
  const ytd: GinFarmYtd = { modules: null, seed_cotton_lbs: null, bales: null, bale_weight: null }
  let sawTotals = false
  let sawYtd = false
  const loads: GinReceiptLoadLine[] = []
  const bales: GinReceiptBaleRow[] = []
  const baleIdx: number[] = []
  const ginnedDates: string[] = []

  let section: Section = 'producer'
  // Totals block columns (Statement / Farm YTD), load table and bale list columns.
  let stmtCol = 1, ytdCol = 2
  let loadCols = { load: 0, rolls: 1, gross: 2, tare: 3, net: 4 }
  let baleCols = { idx: 0, pbi: 1, date: 2, net: 3 }

  const nonEmpty = (row: string[], from = 0, to = row.length) => row.slice(from, to).map((c) => c.trim()).filter(Boolean)

  for (const row of rows) {
    if (row.every((c) => c.trim() === '')) continue
    let at: number
    if ((at = labelIndex(row, 'producer')) >= 0) { section = 'producer'; producerLines.push(...nonEmpty(row, at + 1)); continue }
    if ((at = labelIndex(row, 'farm')) >= 0) { producerLines.push(...nonEmpty(row, 0, at)); section = 'farm'; farmLines.push(...nonEmpty(row, at + 1)); continue }
    if ((at = labelIndex(row, 'field')) >= 0) { if (section === 'farm') farmLines.push(...nonEmpty(row, 0, at)); section = 'field'; fieldLines.push(...nonEmpty(row, at + 1)); continue }
    if ((at = labelIndex(row, 'producer totals', 'totals')) >= 0) {
      section = 'totals'
      const s = labelIndex(row, 'statement', 'this statement')
      const y = labelIndex(row, 'farm ytd', 'farm y-t-d', 'farm year to date')
      if (s >= 0) stmtCol = s
      if (y >= 0) ytdCol = y
      continue
    }
    if ((at = labelIndex(row, 'load #', 'load', 'load no', 'load number', 'module #', 'module')) >= 0 && section !== 'producer' && labelIndex(row, 'net', 'net wt') >= 0) {
      section = 'loads'
      const col = (names: string[], dflt: number) => { const i = labelIndex(row, ...names); return i >= 0 ? i : dflt }
      loadCols = { load: at, rolls: col(['rolls', 'rounds'], -1), gross: col(['gross', 'gross wt'], -1), tare: col(['tare', 'tare wt'], -1), net: col(['net', 'net wt'], -1) }
      continue
    }
    if ((at = labelIndex(row, 'pbi', 'pbi #', 'bale', 'bale #', 'tag')) >= 0 && labelIndex(row, 'net', 'net wt', 'weight', 'wt') >= 0) {
      section = 'bales'
      const col = (names: string[], dflt: number) => { const i = labelIndex(row, ...names); return i >= 0 ? i : dflt }
      baleCols = { idx: at > 0 ? 0 : -1, pbi: at, date: col(['date ginned', 'ginned', 'date'], -1), net: col(['net', 'net wt', 'weight', 'wt'], -1) }
      continue
    }
    switch (section) {
      case 'producer': producerLines.push(...nonEmpty(row)); break
      case 'farm': farmLines.push(...nonEmpty(row)); break
      case 'field': fieldLines.push(...nonEmpty(row)); break
      case 'totals': {
        const key = TOTALS_KEYS[labelOf(cell(row, 0))]
        if (!key) break
        sawTotals = true
        if (key === 'avg_seed') break
        const v = key === 'lint_turnout_pct' ? num(cell(row, stmtCol)) : key === 'modules_count' || key === 'bales_count' ? int(cell(row, stmtCol)) : num(cell(row, stmtCol))
        if (v != null) totals[key] = v
        const yk = YTD_KEYS[key]
        if (yk) {
          const yv = yk === 'modules' || yk === 'bales' ? int(cell(row, ytdCol)) : num(cell(row, ytdCol))
          if (yv != null) { ytd[yk] = yv; sawYtd = true }
        }
        break
      }
      case 'loads': {
        const ln = cell(row, loadCols.load)
        if (!ln) break
        const pick = (i: number) => (i >= 0 ? num(cell(row, i)) : null)
        loads.push({ load_number: ln, rolls: pick(loadCols.rolls), gross: pick(loadCols.gross), tare: pick(loadCols.tare), net: pick(loadCols.net) })
        break
      }
      case 'bales': {
        const pbi = cell(row, baleCols.pbi)
        if (!pbi) break
        bales.push({ pbi_number: pbi, net_weight_lbs: baleCols.net >= 0 ? num(cell(row, baleCols.net)) : null })
        const i = baleCols.idx >= 0 ? int(cell(row, baleCols.idx)) : null
        baleIdx.push(i ?? bales.length)
        const d = baleCols.date >= 0 ? csvDateToIso(cell(row, baleCols.date)) : null
        if (d) ginnedDates.push(d)
        break
      }
    }
  }

  // Producer: the name is the first line that is not the phone; the address
  // lines have no home on a receipt and are left behind.
  const producer = producerLines.find((l) => !/\d{3}[\/.-]\s?\d{3}[.-]\d{4}/.test(l)) ?? null
  // Farm: the numeric line is the farm number; the rest is its name.
  const farmNoAt = farmLines.findIndex((l) => /^\d{2,8}$/.test(l))
  const farm_number = farmNoAt >= 0 ? farmLines[farmNoAt] : null
  const farm_name = farmLines.filter((_, i) => i !== farmNoAt).join(' ') || null
  const field = fieldLines.join(' ') || null

  // The statement date: the last day a bale on it was ginned.
  const statement_date = ginnedDates.length > 0 ? ginnedDates.reduce((a, b) => (b > a ? b : a)) : null
  const dateYear = statement_date ? Number(statement_date.slice(0, 4)) : null
  const wanted = opts.cropYear ?? null
  const crop_year = dateYear != null
    ? (wanted != null && (dateYear === wanted || dateYear === wanted + 1) ? wanted : dateYear)
    : wanted

  // Figures that should add up. Informational — the review card shows them.
  const where = [farm_number ? `farm ${farm_number}` : null, field].filter(Boolean).join(' · ') || `statement ${pageNo}`
  const fmt = (n: number) => Math.round(n).toLocaleString()
  if (totals.modules_count != null && loads.length > 0 && loads.length !== totals.modules_count) {
    warnings.push(`${where}: the load table has ${loads.length} line${loads.length === 1 ? '' : 's'} but the totals say ${totals.modules_count} module${totals.modules_count === 1 ? '' : 's'}.`)
  }
  const loadNet = loads.reduce((s, l) => s + (l.net ?? 0), 0)
  if (totals.total_seed_cotton_weight != null && loads.length > 0 && Math.abs(loadNet - totals.total_seed_cotton_weight) > 0.5) {
    warnings.push(`${where}: the load table adds up to ${fmt(loadNet)} lbs seed cotton; the totals say ${fmt(totals.total_seed_cotton_weight)}.`)
  }
  const baleNet = bales.reduce((s, b) => s + (b.net_weight_lbs ?? 0), 0)
  if (totals.total_bale_weight != null && bales.length > 0 && Math.abs(baleNet - totals.total_bale_weight) > 0.5) {
    warnings.push(`${where}: the bale list adds up to ${fmt(baleNet)} lbs lint; the totals say ${fmt(totals.total_bale_weight)}.`)
  }

  return {
    page: pageNo,
    statement_date,
    has_totals_block: sawTotals,
    gin_name: null, gin_address: null, gin_phone: null, gin_code: null,
    statement_number: null,
    producer,
    farm_number, farm_name, field,
    crop_year,
    totals: sawTotals ? totals : null,
    farm_ytd: sawYtd ? ytd : null,
    loads, bales,
    bale_row_first: baleIdx.length > 0 ? Math.min(...baleIdx) : null,
    bale_row_last: baleIdx.length > 0 ? Math.max(...baleIdx) : null,
  }
}
