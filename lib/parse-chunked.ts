// Chunked AI document parsing — the client-side fix for gateway timeouts and
// cut-off answers on large documents.
//
// One serverless call per page chunk keeps every Anthropic request under
// the function time limit AND under the answer's token cap, with:
//   * chunks sized by DENSITY (lib/chunk-plan.ts): expected output under 60%
//     of max_tokens, from the page's counted rows when the PDF has a text
//     layer (lib/pdf-text.ts) or a conservative per-type default otherwise;
//   * ADAPTIVE SPLITTING: a chunk that comes back cut off (TOO_LONG) or
//     times out is halved and each half read on its own, depth-first and in
//     order, down to a single page; a single page that still truncates gets
//     ONE more try with a bigger token cap, then is recorded as failed;
//   * one plain retry for any other failure (network, model hiccup);
//   * partial results kept when a range still fails — the caller gets the
//     merged data plus the failed ranges and the attempt log, never a bare
//     504 — and can ask for ONLY those pages again (`pages`);
//   * merge functions (lib/parse-merge.ts) that dedupe records straddling
//     chunk boundaries.
//
// Short documents (one chunk) behave like a plain parseDocument call — the
// same single request, the same errors — unless that one chunk is too long,
// in which case it splits like any other. The parser is injectable (`parse`)
// so lib/parse-chunked.test.ts scripts the model.

import { getPdfPageCount, slicePdfPages } from '@/lib/pdf-split'
import { normalizePdfFile } from '@/lib/orientation'
import {
  parseDocument,
  ParseTimeoutError,
  ParseTooLongError,
  type DocumentType,
  type ParseImage,
  type ParseOptions,
  type ParseUsage,
} from '@/lib/pdf-upload'
import type { CottonMarketingCategory } from '@/lib/cotton-doc-import'
import { planChunks, rangeLabel, type PageRange } from '@/lib/chunk-plan'
import { countRowsForType, pdfPageTextRows } from '@/lib/pdf-text'

export { DEFAULT_PAGES_PER_BATCH } from '@/lib/chunk-plan'
export type { PageRange } from '@/lib/chunk-plan'

/** The route's own default answer cap (app/api/parse-document). */
export const DEFAULT_MAX_TOKENS = 8192
/** The one bigger cap a single dense page gets after truncating. */
export const DEFAULT_BOOST_MAX_TOKENS = 16384

export type FailReason = 'too_long' | 'timeout' | 'error'

export type FailedRange = PageRange & { reason: FailReason; message: string }

/** One model call, as logged — the test asserts the split order on these. */
export type ParseAttempt = PageRange & {
  outcome: 'ok' | FailReason
  outputTokens?: number
  ms: number
}

export type ChunkedParseResult<M> = {
  data: M
  /** "9–16" style list of page ranges that could not be read; null = all read. */
  failedPages: string | null
  /** Customer-facing sentence to show when failedPages is set. */
  warning: string | null
  /** The ranges that failed, with why — the review page offers to read them again. */
  failedRanges: FailedRange[]
  /** Every model call made, in order. */
  attempts: ParseAttempt[]
  /** Pages (or photos) whose extraction made it into `data`. */
  pagesRead: number
}

/** parseDocument's untyped form (the caller's merge fn pins T). */
export type ChunkParseFn = (input: File | ParseImage[], documentType: DocumentType, opts: ParseOptions) => Promise<unknown>

export type ChunkedParseOptions<T, M> = {
  /** Combine per-chunk results (see lib/parse-merge.ts). May also transform
   *  (e.g. the settings upload normalizes each raw chunk before merging). */
  merge: (parts: T[]) => M
  /** Fixed pages per chunk. Default: the density plan (lib/chunk-plan). */
  pagesPerBatch?: number
  onProgress?: (label: string) => void
  category?: CottonMarketingCategory
  primaryTarget?: string
  /** Rebase a chunk's result to the whole document before merging — e.g.
   *  add the chunk's first page (1-based) to per-record page numbers. */
  rebase?: (part: T, firstPage: number) => T
  /** Read ONLY these 1-based page ranges of the source — the "Read those
   *  pages again" path. The source is taken as already normalized (the
   *  File handed back through onNormalized on the first read). */
  pages?: PageRange[]
  /** Answer cap per call (default 8192, the route's own). */
  maxTokens?: number
  /** The one bigger cap a single page gets after truncating (default 16384). */
  boostMaxTokens?: number
  /** The first read hands back the straightened PDF so a later `pages`
   *  re-read slices the same file. */
  onNormalized?: (file: File) => void
  // ---- test hooks: script the model and the PDF without pdf-lib / pdf.js ----
  parse?: ChunkParseFn
  pageCount?: (file: File) => Promise<number>
  slice?: (file: File, from: number, to: number) => Promise<File>
  textRows?: (file: File) => Promise<string[][] | null>
}

/** TOO_LONG and TIMEOUT split the chunk; anything else gets one plain retry. */
export function classifyParseError(e: unknown): FailReason {
  if (e instanceof ParseTooLongError) return 'too_long'
  if (e instanceof ParseTimeoutError) return 'timeout'
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'TOO_LONG') return 'too_long'
  if (code === 'TIMEOUT') return 'timeout'
  return 'error'
}

const NOUN: Partial<Record<DocumentType, string>> = {
  settlement: 'tickets',
  tickets: 'tickets',
  gin_receipt: 'bales',
  cotton_weight_ticket: 'loads',
  brokerage_statement: 'positions',
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export async function parseDocumentChunked<T, M = T>(
  source: File | ParseImage[],
  documentType: DocumentType,
  opts: ChunkedParseOptions<T, M>,
): Promise<ChunkedParseResult<M>> {
  const parse: ChunkParseFn = opts.parse ?? (parseDocument as unknown as ChunkParseFn)
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const boostMaxTokens = opts.boostMaxTokens ?? DEFAULT_BOOST_MAX_TOKENS
  const isImages = Array.isArray(source)
  const unit = isImages ? 'photos' : 'pages'

  // The source as 1-based pages: a lazy slicer per range (photos slice the
  // array; PDFs are cut with pdf-lib and cached per range) and, when the
  // PDF has a text layer, the counted rows per page for the density plan.
  let total: number
  let getInput: (r: PageRange) => Promise<File | ParseImage[]>
  let rowsByPage: number[] | null = null
  if (isImages) {
    total = source.length
    getInput = async (r) => source.slice(r.from - 1, r.to)
  } else {
    let pdfFile = source
    if (!opts.pages) {
      // Orientation first (086): pages a scanner stored sideways are baked
      // upright before anything is counted, split, or sent.
      const normalized = await normalizePdfFile(source)
      pdfFile = normalized.file
      if (normalized.changed) opts.onProgress?.('Straightening pages…')
      opts.onNormalized?.(pdfFile)
    }
    const count = opts.pageCount ?? getPdfPageCount
    total = await count(pdfFile).catch(() => 1)
    const slice = opts.slice ?? slicePdfPages
    const cache = new Map<string, Promise<File>>()
    const whole = pdfFile
    getInput = (r) => {
      if (r.from === 1 && r.to === total) return Promise.resolve(whole)
      const key = `${r.from}-${r.to}`
      let p = cache.get(key)
      if (!p) { p = slice(whole, r.from, r.to); cache.set(key, p) }
      return p
    }
    if (opts.pagesPerBatch == null && countRowsForType(documentType, []) != null) {
      const rows = await (opts.textRows ?? pdfPageTextRows)(whole).catch(() => null)
      if (rows) rowsByPage = rows.map((lines) => countRowsForType(documentType, lines) ?? 0)
    }
  }
  total = Math.max(1, total)

  // The ranges to read: the whole document, or only the pages asked for.
  const targets: PageRange[] = (opts.pages ?? [])
    .map((r) => ({ from: Math.max(1, Math.min(r.from, r.to)), to: Math.min(total, Math.max(r.from, r.to)) }))
    .filter((r) => r.from <= r.to)
  if (!opts.pages) targets.push({ from: 1, to: total })
  // An explicit pagesPerBatch is the caller's batch size (and the cap on a
  // counted plan); otherwise the density plan sizes the chunks.
  const chunks: PageRange[] = targets.flatMap((t) =>
    planChunks({ documentType, maxTokens, from: t.from, to: t.to, rowsByPage, maxPages: opts.pagesPerBatch }),
  )
  if (chunks.length === 0) chunks.push({ from: 1, to: total })

  const parts: Array<{ from: number; part: T }> = []
  const attempts: ParseAttempt[] = []
  const failed: FailedRange[] = []
  const errors: unknown[] = []
  let pagesRead = 0
  const parseOpts = { category: opts.category, primaryTarget: opts.primaryTarget }
  const wholeDocument = chunks.length === 1 && chunks[0].from === 1 && chunks[0].to === total

  const progress = (r: PageRange, note: string | null) => {
    if (!opts.onProgress) return
    if (wholeDocument && !note) { opts.onProgress('Reading the document…'); return }
    opts.onProgress(`Reading ${unit} ${rangeLabel(r)} of ${total}…${note ? ` (${note})` : ''}`)
  }

  type Outcome = { ok: true; part: T } | { ok: false; reason: FailReason; error: unknown }
  const tryParse = async (r: PageRange, tokens: number): Promise<Outcome> => {
    const t0 = now()
    let usage: ParseUsage | null = null
    const ms = () => Math.round(now() - t0)
    try {
      const input = await getInput(r)
      const part = (await parse(input, documentType, {
        ...parseOpts,
        maxTokens: tokens,
        pageCount: r.to - r.from + 1,
        onUsage: (u) => { usage = u },
      })) as T
      const u = usage as ParseUsage | null
      attempts.push({ from: r.from, to: r.to, outcome: 'ok', outputTokens: u?.output_tokens ?? undefined, ms: ms() })
      return { ok: true, part }
    } catch (error) {
      const reason = classifyParseError(error)
      const u = usage as ParseUsage | null
      const outputTokens = error instanceof ParseTooLongError ? error.outputTokens ?? undefined : u?.output_tokens ?? undefined
      attempts.push({ from: r.from, to: r.to, outcome: reason, outputTokens, ms: ms() })
      errors.push(error)
      return { ok: false, reason, error }
    }
  }

  type State = { tokens: number; boosted: boolean; retried: boolean; note: string | null }
  const read = async (r: PageRange, s: State): Promise<void> => {
    progress(r, s.note)
    const res = await tryParse(r, s.tokens)
    if (res.ok) {
      parts.push({ from: r.from, part: res.part })
      pagesRead += r.to - r.from + 1
      return
    }
    const message = res.error instanceof Error ? res.error.message : String(res.error)
    if (res.reason === 'too_long' || res.reason === 'timeout') {
      if (r.to > r.from) {
        // Halve and read each half in order (depth-first), each with the
        // normal cap and a clean retry budget.
        const mid = Math.floor((r.from + r.to) / 2)
        const fresh: State = { tokens: s.tokens, boosted: false, retried: false, note: 'splitting a long section' }
        await read({ from: r.from, to: mid }, fresh)
        await read({ from: mid + 1, to: r.to }, fresh)
        return
      }
      if (res.reason === 'too_long' && !s.boosted && boostMaxTokens > s.tokens) {
        await read(r, { tokens: boostMaxTokens, boosted: true, retried: s.retried, note: 'reading a dense page' })
        return
      }
      if (res.reason === 'timeout' && !s.retried) {
        await read(r, { ...s, retried: true, note: 'trying again' })
        return
      }
      failed.push({ from: r.from, to: r.to, reason: res.reason, message })
      return
    }
    // A plain failure (network, a model hiccup): one retry, then recorded.
    if (!s.retried) {
      await read(r, { ...s, retried: true, note: 'trying again' })
      return
    }
    failed.push({ from: r.from, to: r.to, reason: 'error', message })
  }

  for (const c of chunks) await read(c, { tokens: maxTokens, boosted: false, retried: false, note: null })

  if (parts.length === 0) {
    // Nothing succeeded: a single plain failure rethrows the real error
    // (preserves PdfTooLargeError etc.); anything else gets a clean summary.
    const first = errors[0]
    if (chunks.length === 1 && first instanceof Error && classifyParseError(first) === 'error') throw first
    throw new Error(
      `None of the document's ${unit} could be read. Try again, or upload fewer ${unit} at a time.`,
    )
  }

  parts.sort((a, b) => a.from - b.from)
  failed.sort((a, b) => a.from - b.from)
  const failedPages = failed.length > 0 ? failed.map(rangeLabel).join(', ') : null
  const noun = NOUN[documentType] ?? 'records'
  const onePage = failed.length === 1 && failed[0].from === failed[0].to
  const pageWord = unit === 'pages' ? (onePage ? 'Page' : 'Pages') : onePage ? 'Photo' : 'Photos'
  return {
    data: opts.merge(parts.map((p) => (opts.rebase ? opts.rebase(p.part, p.from) : p.part))),
    failedPages,
    warning: failedPages
      ? `${pageWord} ${failedPages} returned no ${noun} after several tries.`
      : null,
    failedRanges: failed,
    attempts,
    pagesRead,
  }
}
