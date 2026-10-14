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
// the four arithmetic operators and the comparisons IF needs.
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
    case 'bin': {
      const wrap = (child: FormulaNode, rightSide: boolean) => {
        const s = render(child, ctx)
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

function rangeCells(ctx: EvalCtx, node: RangeNode): Array<Scalar | FormulaError> {
  const sec = ctx.data[node.s]
  if (!sec) throw new Error(`evaluate: unknown section "${node.s}"`)
  const r0 = node.t === 'col' ? 0 : node.r0
  const r1 = node.t === 'col' ? sec.rows.length - 1 : node.r1
  const out: Array<Scalar | FormulaError> = []
  for (let r = r0; r <= r1; r++) out.push(cellValue(ctx, node.s, r, node.c))
  return out
}

/** SUMIFS criterion match: numbers numerically, text case-insensitively, blank
 *  criterion matches blank cells. (Only equality criteria are emitted.) */
function criterionMatches(cellV: Scalar | FormulaError, crit: Scalar | FormulaError): boolean {
  if (cellV instanceof FormulaError || crit instanceof FormulaError) return false
  const blank = (v: Scalar) => v == null || v === ''
  if (blank(crit)) return blank(cellV)
  if (typeof crit === 'number') return typeof cellV === 'number' ? cellV === crit : (typeof cellV === 'string' && cellV.trim() !== '' && Number(cellV) === crit)
  if (typeof crit === 'boolean') return cellV === crit
  if (typeof cellV === 'number') return String(cellV) === String(crit).trim()
  return typeof cellV === 'string' && cellV.toLowerCase() === String(crit).toLowerCase()
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

/** Spreadsheet comparison: two texts compare case-insensitively, otherwise
 *  numerically (blank = 0, FALSE = 0, TRUE = 1). */
function compare(op: BinOp, a: Scalar, b: Scalar): boolean {
  let result: number
  if (typeof a === 'string' && typeof b === 'string') {
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
