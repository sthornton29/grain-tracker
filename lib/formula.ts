// Formula seam for the shared export layer (lib/exports.ts).
//
// An export section can carry FORMULA cells: a small expression tree that
// refers to sections (sheets) and columns BY KEY, never by letter. At write
// time the Excel renderer resolves every reference to a bounded A1 range
// sized to the section's actual rows ('Load Data'!$T$2:$T$1450 — never a
// whole-column or a structured-table reference, so Excel, Google Sheets,
// LibreOffice and Numbers all agree), and the SAME tree evaluates in plain
// TypeScript against the payload's rows, so a test can prove a workbook's
// formulas compute the numbers the app shows. The vocabulary is deliberately
// only what the audit workbooks emit: SUM, SUMIFS, ROUND, IF, IFERROR, ABS,
// the four arithmetic operators and the comparisons IF needs — plus, for the
// Bale Quality workbook (2026-10-20), COUNTIF, COUNTIFS, AVERAGEIFS, AND, OR
// and SUMPRODUCT, and criteria text that carries a comparison (">=3.7",
// "<>", "<26").
//
// Builders (all pure):
//   num(1) / str('Irrigated')              literals
//   cell(section, col, rowIndex)           one cell of a section (0-based row)
//   self(col)                              the same row's cell in column `col`
//   col(section, col)                      the whole data column of a section
//   rows(section, col, r0, r1)             a slice of a column by row index
//   sum(...) sumifs(range, [crit...]) round(x, n) iff(c, a, b) iferror(x, fb)
//   abs(x) add/sub/mul/div, lt/le/eq/ne/gt/ge
//
// `FormulaLayout` (built by lib/exports.ts from the payload) maps section
// keys to sheet names + physical rows + column letters. `toExcelFormula`
// renders; `evaluateFormula` computes against a `FormulaData` view of the
// rows. Blank cells read as 0 in arithmetic and comparisons and as "" in text
// comparisons — the spreadsheet convention — and SUMIFS text criteria match
// case-insensitively, as Excel does.

export type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'cell'; s: string; c: string; r: number }
  | { t: 'self'; c: string }
  | { t: 'col'; s: string; c: string }
  | { t: 'rows'; s: string; c: string; r0: number; r1: number }
  | { t: 'sum'; args: FormulaNode[] }
  | { t: 'sumifs'; sum: RangeNode; crit: Array<{ range: RangeNode; value: FormulaNode }> }
  | { t: 'round'; x: FormulaNode; n: number }
  | { t: 'if'; cond: FormulaNode; a: FormulaNode; b: FormulaNode }
  | { t: 'iferror'; x: FormulaNode; fb: FormulaNode }
  | { t: 'abs'; x: FormulaNode }
  | { t: 'bin'; op: BinOp; a: FormulaNode; b: FormulaNode }
  | { t: 'concat'; args: FormulaNode[] }
  | { t: 'substitute'; x: FormulaNode; from: string; to: string }
  | { t: 'countif'; range: RangeNode; value: FormulaNode }
  | { t: 'countifs'; crit: Array<{ range: RangeNode; value: FormulaNode }> }
  | { t: 'averageifs'; avg: RangeNode; crit: Array<{ range: RangeNode; value: FormulaNode }> }
  | { t: 'and'; args: FormulaNode[] }
  | { t: 'or'; args: FormulaNode[] }
  | { t: 'sumproduct'; ranges: RangeNode[] }

export type RangeNode = Extract<FormulaNode, { t: 'col' | 'rows' }>
export type BinOp = '+' | '-' | '*' | '/' | '<' | '<=' | '=' | '<>' | '>' | '>='

export const num = (v: number): FormulaNode => ({ t: 'num', v })
export const str = (v: string): FormulaNode => ({ t: 'str', v })
export const cell = (s: string, c: string, r: number): FormulaNode => ({ t: 'cell', s, c, r })
export const self = (c: string): FormulaNode => ({ t: 'self', c })
export const col = (s: string, c: string): RangeNode => ({ t: 'col', s, c })
export const rows = (s: string, c: string, r0: number, r1: number): RangeNode => ({ t: 'rows', s, c, r0, r1 })
export const sum = (...args: FormulaNode[]): FormulaNode => ({ t: 'sum', args })
export const sumifs = (sumRange: RangeNode, ...crit: Array<[RangeNode, FormulaNode]>): FormulaNode =>
  ({ t: 'sumifs', sum: sumRange, crit: crit.map(([range, value]) => ({ range, value })) })
export const round = (x: FormulaNode, n: number): FormulaNode => ({ t: 'round', x, n })
export const iff = (cond: FormulaNode, a: FormulaNode, b: FormulaNode): FormulaNode => ({ t: 'if', cond, a, b })
export const iferror = (x: FormulaNode, fb: FormulaNode): FormulaNode => ({ t: 'iferror', x, fb })
export const abs = (x: FormulaNode): FormulaNode => ({ t: 'abs', x })
const bin = (op: BinOp) => (a: FormulaNode, b: FormulaNode): FormulaNode => ({ t: 'bin', op, a, b })
export const add = bin('+')
export const sub = bin('-')
export const mul = bin('*')
export const div = bin('/')
export const lt = bin('<')
export const le = bin('<=')
export const eq = bin('=')
export const ne = bin('<>')
export const gt = bin('>')
export const ge = bin('>=')
/** Text concatenation (&). */
export const concat = (...args: FormulaNode[]): FormulaNode => ({ t: 'concat', args })
/** SUBSTITUTE(x, from, to) — every occurrence. */
export const substitute = (x: FormulaNode, from: string, to: string): FormulaNode => ({ t: 'substitute', x, from, to })
/** COUNTIF(range, criterion) — the criterion may be a number, text, or
 *  comparison text such as ">=3.7" / "<>" (non-blank). */
export const countif = (range: RangeNode, value: FormulaNode): FormulaNode => ({ t: 'countif', range, value })
/** COUNTIFS(range1, crit1, range2, crit2, …). */
export const countifs = (...crit: Array<[RangeNode, FormulaNode]>): FormulaNode =>
  ({ t: 'countifs', crit: crit.map(([range, value]) => ({ range, value })) })
/** AVERAGEIFS(average_range, range1, crit1, …) — #DIV/0! when nothing matches. */
export const averageifs = (avgRange: RangeNode, ...crit: Array<[RangeNode, FormulaNode]>): FormulaNode =>
  ({ t: 'averageifs', avg: avgRange, crit: crit.map(([range, value]) => ({ range, value })) })
export const and = (...args: FormulaNode[]): FormulaNode => ({ t: 'and', args })
export const or = (...args: FormulaNode[]): FormulaNode => ({ t: 'or', args })
/** SUMPRODUCT(range1, range2, …) — same-length ranges, text reads as 0. */
export const sumproduct = (...ranges: RangeNode[]): FormulaNode => ({ t: 'sumproduct', ranges })
/** An exact-match SUMIFS criterion built from a cell: "=" & the cell's text
 *  with Excel's wildcard characters escaped (~ → ~~, * → ~*, ? → ~?), so a
 *  field named "Pivot*" or "<40" matches only itself. */
export const exactCriterion = (x: FormulaNode): FormulaNode =>
  concat(str('='), substitute(substitute(substitute(x, '~', '~~'), '*', '~*'), '?', '~?'))

// ---------------------------------------------------------------------------
// Excel rendering
// ---------------------------------------------------------------------------

export type SectionLayout = {
  /** The final worksheet name (already sanitized / de-duplicated). */
  sheetName: string
  /** 1-based physical row of the section's first data row (rows[0]). */
  firstRow: number
  /** Number of rows in the section (rows.length). */
  rowCount: number
  /** Column key → A1 column letters. */
  columns: Record<string, string>
}

export type FormulaLayout = Record<string, SectionLayout>

/** 1-based column index → letters (1 → A, 27 → AA). */
export function columnLetters(index: number): string {
  let n = index
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Quote a sheet name for an A1 reference ('Load Data'!A1). */
export function sheetRef(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

/** Escape a text literal for a formula ("Lawrence County"). */
function excelString(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

/** Render a number literal the way Excel accepts it (no locale grouping). */
function excelNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`formula literal is not finite: ${n}`)
  return String(n)
}

export type RenderContext = {
  layout: FormulaLayout
  /** The section + row index of the cell being written (for `self`). */
  at: { s: string; r: number }
}

function sectionOf(layout: FormulaLayout, key: string): SectionLayout {
  const s = layout[key]
  if (!s) throw new Error(`formula refers to unknown section "${key}"`)
  return s
}

function colOf(sec: SectionLayout, key: string, sectionKey: string): string {
  const c = sec.columns[key]
  if (!c) throw new Error(`formula refers to unknown column "${key}" in section "${sectionKey}"`)
  return c
}

/** A single cell's A1 address; sheet-qualified only when it is on another sheet. */
function cellRef(ctx: RenderContext, s: string, c: string, r: number, absolute: boolean): string {
  const sec = sectionOf(ctx.layout, s)
  if (r < 0 || r >= Math.max(1, sec.rowCount)) throw new Error(`formula row ${r} is outside section "${s}" (${sec.rowCount} rows)`)
  const letters = colOf(sec, c, s)
  const row = sec.firstRow + r
  const a1 = absolute ? `$${letters}$${row}` : `${letters}${row}`
  return s === ctx.at.s ? a1 : `${sheetRef(sec.sheetName)}!${a1}`
}

/** A bounded range; an empty section still yields a one-row range (its blank first row). */
function rangeRef(ctx: RenderContext, node: RangeNode): string {
  const sec = sectionOf(ctx.layout, node.s)
  const letters = colOf(sec, node.c, node.s)
  const r0 = node.t === 'col' ? 0 : node.r0
  const r1 = node.t === 'col' ? Math.max(0, sec.rowCount - 1) : node.r1
  if (r0 < 0 || r1 < r0 || r1 >= Math.max(1, sec.rowCount)) throw new Error(`formula range ${r0}..${r1} is outside section "${node.s}" (${sec.rowCount} rows)`)
  const a1 = `$${letters}$${sec.firstRow + r0}:$${letters}$${sec.firstRow + r1}`
  return node.s === ctx.at.s ? a1 : `${sheetRef(sec.sheetName)}!${a1}`
}

const PRECEDENCE: Record<BinOp, number> = { '*': 3, '/': 3, '+': 2, '-': 2, '<': 1, '<=': 1, '=': 1, '<>': 1, '>': 1, '>=': 1 }
const CONCAT_PRECEDENCE = 1.5 // & sits between arithmetic and comparison

function render(node: FormulaNode, ctx: RenderContext): string {
  switch (node.t) {
    case 'num': return excelNumber(node.v)
    case 'str': return excelString(node.v)
    case 'cell': return cellRef(ctx, node.s, node.c, node.r, true)
    case 'self': return cellRef(ctx, ctx.at.s, node.c, ctx.at.r, false)
    case 'col':
    case 'rows': return rangeRef(ctx, node)
    case 'sum': return `SUM(${node.args.map((a) => render(a, ctx)).join(',')})`
    case 'sumifs':
      return `SUMIFS(${[rangeRef(ctx, node.sum), ...node.crit.flatMap((c) => [rangeRef(ctx, c.range), render(c.value, ctx)])].join(',')})`
    case 'round': return `ROUND(${render(node.x, ctx)},${node.n})`
    case 'if': return `IF(${render(node.cond, ctx)},${render(node.a, ctx)},${render(node.b, ctx)})`
    case 'iferror': return `IFERROR(${render(node.x, ctx)},${render(node.fb, ctx)})`
    case 'abs': return `ABS(${render(node.x, ctx)})`
    case 'concat':
      return node.args.map((a) => {
        const s = render(a, ctx)
        return a.t === 'bin' && PRECEDENCE[a.op] <= CONCAT_PRECEDENCE ? `(${s})` : s
      }).join('&')
    case 'substitute': return `SUBSTITUTE(${render(node.x, ctx)},${excelString(node.from)},${excelString(node.to)})`
    case 'countif': return `COUNTIF(${rangeRef(ctx, node.range)},${render(node.value, ctx)})`
    case 'countifs':
      return `COUNTIFS(${node.crit.flatMap((c) => [rangeRef(ctx, c.range), render(c.value, ctx)]).join(',')})`
    case 'averageifs':
      return `AVERAGEIFS(${[rangeRef(ctx, node.avg), ...node.crit.flatMap((c) => [rangeRef(ctx, c.range), render(c.value, ctx)])].join(',')})`
    case 'and': return `AND(${node.args.map((a) => render(a, ctx)).join(',')})`
    case 'or': return `OR(${node.args.map((a) => render(a, ctx)).join(',')})`
    case 'sumproduct': return `SUMPRODUCT(${node.ranges.map((r) => rangeRef(ctx, r)).join(',')})`
    case 'bin': {
      const wrap = (child: FormulaNode, rightSide: boolean) => {
        const s = render(child, ctx)
        if (child.t === 'concat') return PRECEDENCE[node.op] > CONCAT_PRECEDENCE ? `(${s})` : s
        if (child.t !== 'bin') return s
        const p = PRECEDENCE[child.op]
        const q = PRECEDENCE[node.op]
        // Parenthesize a lower-precedence child, or an equal-precedence one on
        // the right of - or / (a-(b-c) must keep its parentheses).
        if (p < q || (p === q && rightSide && (node.op === '-' || node.op === '/'))) return `(${s})`
        return s
      }
      return `${wrap(node.a, false)}${node.op}${wrap(node.b, true)}`
    }
  }
}

/** The Excel formula text (without the leading "=") for a node written at `at`. */
export function toExcelFormula(node: FormulaNode, ctx: RenderContext): string {
  return render(node, ctx)
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** What the evaluator reads: per section key, column keys in order and the
 *  rows' cells. A cell is a literal value or `{ f }` (a formula to evaluate). */
export type FormulaData = Record<string, {
  columns: string[]
  rows: Array<Array<FormulaDataCell>>
}>
export type FormulaDataCell = number | string | null | undefined | boolean | { f: FormulaNode; v?: unknown }

export type Scalar = number | string | boolean | null
export class FormulaError extends Error {
  code: string
  constructor(code: string) { super(code); this.code = code }
}

type EvalCtx = {
  data: FormulaData
  memo: Map<string, Scalar | FormulaError>
  stack: Set<string>
  at: { s: string; r: number }
}

function colIndex(ctx: EvalCtx, s: string, c: string): number {
  const sec = ctx.data[s]
  if (!sec) throw new Error(`evaluate: unknown section "${s}"`)
  const i = sec.columns.indexOf(c)
  if (i < 0) throw new Error(`evaluate: unknown column "${c}" in section "${s}"`)
  return i
}

function isFormulaCell(v: FormulaDataCell): v is { f: FormulaNode; v?: unknown } {
  return v != null && typeof v === 'object' && 'f' in v
}

/** The value of one cell, evaluating a formula cell (memoized, cycle-guarded). */
export function cellValue(ctx: EvalCtx, s: string, r: number): Scalar | FormulaError
export function cellValue(ctx: EvalCtx, s: string, r: number, c?: string): Scalar | FormulaError
export function cellValue(ctx: EvalCtx, s: string, r: number, c?: string): Scalar | FormulaError {
  const sec = ctx.data[s]
  if (!sec) throw new Error(`evaluate: unknown section "${s}"`)
  const ci = c == null ? 0 : colIndex(ctx, s, c)
  const row = sec.rows[r]
  const raw: FormulaDataCell = row ? row[ci] : null
  if (!isFormulaCell(raw)) return raw === undefined ? null : (raw as Scalar)
  const key = `${s}\u0000${r}\u0000${ci}`
  const hit = ctx.memo.get(key)
  if (hit !== undefined) return hit
  if (ctx.stack.has(key)) throw new Error(`evaluate: circular reference at ${s}[${r}].${sec.columns[ci]}`)
  ctx.stack.add(key)
  let out: Scalar | FormulaError
  try {
    out = evalNode(raw.f, { ...ctx, at: { s, r } })
  } finally {
    ctx.stack.delete(key)
  }
  ctx.memo.set(key, out)
  return out
}

function toNumber(v: Scalar | FormulaError): number {
  if (v instanceof FormulaError) throw v
  if (v == null || v === '') return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  const n = Number(v)
  if (!Number.isFinite(n)) throw new FormulaError('#VALUE!')
  return n
}

/** Text coercion as Excel's & does it: blank → "", numbers as plain digits. */
function toText(v: Scalar | FormulaError): string {
  if (v instanceof FormulaError) throw v
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

function rangeCells(ctx: EvalCtx, node: RangeNode): Array<Scalar | FormulaError> {
  const sec = ctx.data[node.s]
  if (!sec) throw new Error(`evaluate: unknown section "${node.s}"`)
  const r0 = node.t === 'col' ? 0 : node.r0
  const r1 = node.t === 'col' ? sec.rows.length - 1 : node.r1
  const out: Array<Scalar | FormulaError> = []
  for (let r = r0; r <= r1; r++) out.push(cellValue(ctx, node.s, r, node.c))
  return out
}

/** SUMIFS criterion match, as Excel does it: a number matches numerically; a
 *  text criterion matches case-insensitively and honors wildcards (* ?) with
 *  ~ as the escape; a leading "=" means an exact (still wildcard-aware)
 *  match of the rest; a blank criterion matches blank cells. */
function criterionMatches(cellV: Scalar | FormulaError, crit: Scalar | FormulaError): boolean {
  if (cellV instanceof FormulaError || crit instanceof FormulaError) return false
  const blank = (v: Scalar) => v == null || v === ''
  if (blank(crit)) return blank(cellV)
  if (typeof crit === 'number') return typeof cellV === 'number' ? cellV === crit : (typeof cellV === 'string' && cellV.trim() !== '' && Number(cellV) === crit)
  if (typeof crit === 'boolean') return cellV === crit
  let text = String(crit)
  // A comparison criterion (">=3.7", "<26", "<>", "<>held"): numbers compare
  // numerically (a text cell never matches a numeric comparison); text
  // compares case-insensitively; "<>" alone matches any non-blank cell.
  const cmp = text.match(/^(<>|<=|>=|<|>)(.*)$/)
  if (cmp) {
    const op = cmp[1] as BinOp
    const rhs = cmp[2]
    if (op === '<>' && rhs === '') return !blank(cellV)
    const rhsNum = rhs.trim() !== '' && Number.isFinite(Number(rhs)) ? Number(rhs) : null
    if (rhsNum != null) {
      if (typeof cellV !== 'number') {
        const asNum = typeof cellV === 'string' && cellV.trim() !== '' ? Number(cellV) : NaN
        if (!Number.isFinite(asNum)) return op === '<>' && !blank(cellV)
        return compare(op, asNum, rhsNum)
      }
      return compare(op, cellV, rhsNum)
    }
    if (typeof cellV !== 'string') return op === '<>'
    return compare(op, cellV, rhs)
  }
  if (text.startsWith('=')) text = text.slice(1)
  // "=2026" against a numeric cell compares numerically.
  if (typeof cellV === 'number') return text.trim() !== '' && !/[*?]/.test(text) && Number(text) === cellV
  if (typeof cellV !== 'string') return text === ''
  return wildcardRegex(text).test(cellV)
}

/** Excel wildcard pattern → RegExp (case-insensitive, whole-cell). */
function wildcardRegex(pattern: string): RegExp {
  const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '~' && i + 1 < pattern.length) { re += escapeRe(pattern[i + 1]); i++ }
    else if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += escapeRe(ch)
  }
  return new RegExp(`^${re}$`, 'i')
}

function evalNode(node: FormulaNode, ctx: EvalCtx): Scalar | FormulaError {
  try {
    switch (node.t) {
      case 'num': return node.v
      case 'str': return node.v
      case 'cell': return cellValue(ctx, node.s, node.r, node.c)
      case 'self': return cellValue(ctx, ctx.at.s, ctx.at.r, node.c)
      case 'col':
      case 'rows': {
        // A bare range in scalar position reads its first cell (not emitted).
        const cells = rangeCells(ctx, node)
        return cells.length ? cells[0] : null
      }
      case 'sum': {
        let total = 0
        for (const a of node.args) {
          if (a.t === 'col' || a.t === 'rows') {
            for (const v of rangeCells(ctx, a)) {
              if (v instanceof FormulaError) throw v
              if (typeof v === 'number') total += v // SUM ignores text / blanks in ranges
            }
          } else {
            total += toNumber(evalNode(a, ctx))
          }
        }
        return total
      }
      case 'sumifs': {
        const sums = rangeCells(ctx, node.sum)
        const crits = node.crit.map((c) => ({ cells: rangeCells(ctx, c.range), value: evalNode(c.value, ctx) }))
        for (const c of crits) {
          if (c.cells.length !== sums.length) throw new FormulaError('#VALUE!')
        }
        let total = 0
        for (let i = 0; i < sums.length; i++) {
          if (!crits.every((c) => criterionMatches(c.cells[i], c.value))) continue
          const v = sums[i]
          if (v instanceof FormulaError) throw v
          if (typeof v === 'number') total += v
        }
        return total
      }
      case 'round': {
        const x = toNumber(evalNode(node.x, ctx))
        const p = Math.pow(10, node.n)
        // Excel rounds half away from zero.
        const r = Math.round(Math.abs(x) * p + 1e-9) / p
        return x < 0 ? -r : r
      }
      case 'if': {
        const c = evalNode(node.cond, ctx)
        if (c instanceof FormulaError) throw c
        const truthy = typeof c === 'boolean' ? c : toNumber(c) !== 0
        return evalNode(truthy ? node.a : node.b, ctx)
      }
      case 'iferror': {
        const x = evalNode(node.x, ctx)
        return x instanceof FormulaError ? evalNode(node.fb, ctx) : x
      }
      case 'abs': return Math.abs(toNumber(evalNode(node.x, ctx)))
      case 'concat': return node.args.map((a) => toText(evalNode(a, ctx))).join('')
      case 'substitute': return toText(evalNode(node.x, ctx)).split(node.from).join(node.to)
      case 'countif': {
        const value = evalNode(node.value, ctx)
        return rangeCells(ctx, node.range).filter((c) => criterionMatches(c, value)).length
      }
      case 'countifs': {
        const crits = node.crit.map((c) => ({ cells: rangeCells(ctx, c.range), value: evalNode(c.value, ctx) }))
        const n = crits[0]?.cells.length ?? 0
        for (const c of crits) if (c.cells.length !== n) throw new FormulaError('#VALUE!')
        let count = 0
        for (let i = 0; i < n; i++) if (crits.every((c) => criterionMatches(c.cells[i], c.value))) count++
        return count
      }
      case 'averageifs': {
        const avgs = rangeCells(ctx, node.avg)
        const crits = node.crit.map((c) => ({ cells: rangeCells(ctx, c.range), value: evalNode(c.value, ctx) }))
        for (const c of crits) if (c.cells.length !== avgs.length) throw new FormulaError('#VALUE!')
        let total = 0
        let count = 0
        for (let i = 0; i < avgs.length; i++) {
          if (!crits.every((c) => criterionMatches(c.cells[i], c.value))) continue
          const v = avgs[i]
          if (v instanceof FormulaError) throw v
          if (typeof v === 'number') { total += v; count++ } // AVERAGEIFS skips text / blanks
        }
        if (count === 0) throw new FormulaError('#DIV/0!')
        return total / count
      }
      case 'and': {
        for (const a of node.args) if (!truthy(evalNode(a, ctx))) return false
        return true
      }
      case 'or': {
        for (const a of node.args) if (truthy(evalNode(a, ctx))) return true
        return false
      }
      case 'sumproduct': {
        const cols = node.ranges.map((r) => rangeCells(ctx, r))
        const n = cols[0]?.length ?? 0
        for (const c of cols) if (c.length !== n) throw new FormulaError('#VALUE!')
        let total = 0
        for (let i = 0; i < n; i++) {
          let p = 1
          for (const c of cols) {
            const v = c[i]
            if (v instanceof FormulaError) throw v
            p *= typeof v === 'number' ? v : 0 // SUMPRODUCT treats text / blanks as 0
          }
          total += p
        }
        return total
      }
      case 'bin': {
        const a = evalNode(node.a, ctx)
        const b = evalNode(node.b, ctx)
        if (a instanceof FormulaError) throw a
        if (b instanceof FormulaError) throw b
        switch (node.op) {
          case '+': return toNumber(a) + toNumber(b)
          case '-': return toNumber(a) - toNumber(b)
          case '*': return toNumber(a) * toNumber(b)
          case '/': {
            const d = toNumber(b)
            if (d === 0) throw new FormulaError('#DIV/0!')
            return toNumber(a) / d
          }
          default: return compare(node.op, a, b)
        }
      }
    }
  } catch (e) {
    if (e instanceof FormulaError) return e
    throw e
  }
}

/** Excel truthiness for AND / OR / IF: booleans as they are, numbers ≠ 0,
 *  blanks false; a text argument is #VALUE!. */
function truthy(v: Scalar | FormulaError): boolean {
  if (v instanceof FormulaError) throw v
  if (typeof v === 'boolean') return v
  if (v == null || v === '') return false
  if (typeof v === 'number') return v !== 0
  throw new FormulaError('#VALUE!')
}

/** Spreadsheet comparison, as Excel does it: two texts compare
 *  case-insensitively; a blank reads as 0 against a number, "" against text
 *  and FALSE against a boolean; across types the order is numbers < text <
 *  booleans and equality is false — so (A1="")=0 is FALSE whatever A1
 *  holds, and FALSE=0 is FALSE. */
function compare(op: BinOp, a: Scalar, b: Scalar): boolean {
  let result: number
  const blankA = a == null || a === ''
  const blankB = b == null || b === ''
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    // A boolean against a boolean (blank = FALSE): FALSE < TRUE. Against a
    // number or text: the boolean is greater, never equal.
    const x = typeof a === 'boolean' ? a : blankA && typeof b === 'boolean' ? false : null
    const y = typeof b === 'boolean' ? b : blankB && typeof a === 'boolean' ? false : null
    if (x != null && y != null) result = Number(x) - Number(y)
    else result = typeof a === 'boolean' ? 1 : -1
  } else if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    result = x < y ? -1 : x > y ? 1 : 0
  } else if ((typeof a === 'string' && a !== '') || (typeof b === 'string' && b !== '')) {
    // Text vs number: Excel sorts text after numbers; equality is false.
    result = typeof a === 'string' ? 1 : -1
  } else {
    const x = toNumber(a)
    const y = toNumber(b)
    result = x < y ? -1 : x > y ? 1 : 0
  }
  switch (op) {
    case '<': return result < 0
    case '<=': return result <= 0
    case '=': return result === 0
    case '<>': return result !== 0
    case '>': return result > 0
    case '>=': return result >= 0
    default: throw new Error(`not a comparison: ${op}`)
  }
}

/** Evaluate one formula as if written at `at` over `data`. */
export function evaluateFormula(node: FormulaNode, data: FormulaData, at: { s: string; r: number }, memo?: Map<string, Scalar | FormulaError>): Scalar | FormulaError {
  return evalNode(node, { data, memo: memo ?? new Map(), stack: new Set(), at })
}

/** Evaluate every cell of every section: the same grid with formula cells
 *  replaced by their values (a FormulaError for a cell that errors). */
export function evaluateData(data: FormulaData): Record<string, Array<Array<Scalar | FormulaError>>> {
  const ctx: EvalCtx = { data, memo: new Map(), stack: new Set(), at: { s: '', r: 0 } }
  const out: Record<string, Array<Array<Scalar | FormulaError>>> = {}
  for (const [s, sec] of Object.entries(data)) {
    out[s] = sec.rows.map((row, r) => row.map((_, ci) => cellValue(ctx, s, r, sec.columns[ci])))
  }
  return out
}
