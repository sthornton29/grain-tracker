// Density sizing for chunked AI parsing (lib/parse-chunked.ts).
//
// The model's answer is capped at max_tokens; a chunk whose extraction
// would not fit comes back cut off mid-JSON. The measured cost of a Woodall
// settlement (2026-10-13, claude-sonnet-4-6, max_tokens 8192) was ≈235
// output tokens per ticket with the old verbose shape — 6 landscape pages
// (81 tickets) blew straight past the cap. Chunks are therefore sized so
// their EXPECTED output stays under 60% of max_tokens:
//
//   pages = floor((0.6 × maxTokens − fixed) / (tokensPerItem × rowsPerPage + perPage))
//
// clamped to 1..6, with per-type tokens-per-item constants and a default
// rows-per-page when the page density is unknown (no text layer). When
// lib/pdf-text counted the rows on each page, planChunks sizes every chunk
// greedily from the real counts instead. Pure — tested in
// lib/chunk-plan.test.ts.

import type { DocumentType } from '@/lib/pdf-upload'

export const OUTPUT_BUDGET_SHARE = 0.6
export const MAX_PAGES_PER_CHUNK = 6
export const MIN_PAGES_PER_CHUNK = 1

export type DensityProfile = {
  /** Output tokens per extracted item (ticket, bale, row, load). */
  tokensPerItem: number
  /** Tokens per page that do not scale with items (page headers, totals). */
  perPage: number
  /** Tokens per CHUNK that do not scale with pages (document header, summary). */
  fixed: number
  /** Items per page assumed when no text layer could be counted. */
  defaultRowsPerPage: number
}

// settlement: 130/ticket is the trimmed shape (nulls omitted, block
// constants stated once) + ≈500 for the header, discount items and summary.
// Measured untrimmed: 235–245/ticket. gin_receipt: a bale row is a PBI +
// weight (≈25) and each page restates the statement header (≈300).
export const DENSITY: Partial<Record<DocumentType, DensityProfile>> = {
  settlement: { tokensPerItem: 130, perPage: 0, fixed: 500, defaultRowsPerPage: 14 },
  gin_receipt: { tokensPerItem: 25, perPage: 300, fixed: 0, defaultRowsPerPage: 45 },
  brokerage_statement: { tokensPerItem: 130, perPage: 0, fixed: 300, defaultRowsPerPage: 20 },
  cotton_weight_ticket: { tokensPerItem: 150, perPage: 0, fixed: 0, defaultRowsPerPage: 1 },
  tickets: { tokensPerItem: 120, perPage: 0, fixed: 0, defaultRowsPerPage: 4 },
}

// Types with no measured profile (contracts, leases, insurance summaries…)
// are one record per document: the legacy batch size stands.
export const DEFAULT_PAGES_PER_BATCH = 6

export type PageRange = { from: number; to: number }

export type ChunkPlan = {
  documentType: DocumentType
  maxTokens: number
  /** Items per page for the pages in this chunk (counted or assumed). */
  rowsByPage: number[]
}

export function densityFor(documentType: DocumentType): DensityProfile | null {
  return DENSITY[documentType] ?? null
}

/** The output tokens a chunk is expected to need (items + per-page + fixed). */
export function expectedOutputTokens(plan: ChunkPlan): number {
  const d = densityFor(plan.documentType)
  if (!d) return 0
  const items = plan.rowsByPage.reduce((s, r) => s + Math.max(0, r), 0)
  return Math.round(d.fixed + d.perPage * plan.rowsByPage.length + d.tokensPerItem * items)
}

/** Output tokens a chunk may use: 60% of max_tokens. */
export function outputBudget(maxTokens: number): number {
  return Math.floor(maxTokens * OUTPUT_BUDGET_SHARE)
}

/**
 * Pages per batch when the page density is NOT known: the per-type default
 * rows per page, or `rowsPerPage` when the caller measured it. Types without
 * a profile keep DEFAULT_PAGES_PER_BATCH.
 */
export function planPagesPerBatch(input: { documentType: DocumentType; maxTokens: number; rowsPerPage?: number | null }): number {
  const d = densityFor(input.documentType)
  if (!d) return DEFAULT_PAGES_PER_BATCH
  const rows = input.rowsPerPage != null && input.rowsPerPage > 0 ? input.rowsPerPage : d.defaultRowsPerPage
  const perPage = d.tokensPerItem * rows + d.perPage
  const usable = outputBudget(input.maxTokens) - d.fixed
  const pages = perPage > 0 ? Math.floor(usable / perPage) : MAX_PAGES_PER_CHUNK
  return Math.max(MIN_PAGES_PER_CHUNK, Math.min(MAX_PAGES_PER_CHUNK, pages))
}

/**
 * Chunk the pages `from..to` (1-based, inclusive) so each chunk's expected
 * output stays under the budget. With counted rows per page (rowsByPage[i]
 * is page i+1's count) the plan is greedy over the real counts; without, it
 * cuts fixed-size batches of planPagesPerBatch. A page that alone exceeds
 * the budget still gets its own chunk — the splitter boosts max_tokens for
 * it. `maxPages` is a caller's own batch size: the fixed size without
 * counts, the cap with them (default 6).
 */
export function planChunks(input: {
  documentType: DocumentType
  maxTokens: number
  from: number
  to: number
  rowsByPage?: number[] | null
  maxPages?: number
}): PageRange[] {
  const { from, to } = input
  if (to < from) return []
  // An explicit maxPages is honored as given (a caller's own batch size);
  // the plan's own chunks never exceed MAX_PAGES_PER_CHUNK.
  const cap = Math.max(1, Math.round(input.maxPages ?? MAX_PAGES_PER_CHUNK))
  const d = densityFor(input.documentType)
  const rows = input.rowsByPage
  if (!d || !rows) {
    // An explicit maxPages is the caller's batch size; otherwise the plan's.
    const size = input.maxPages != null ? cap : d ? planPagesPerBatch({ documentType: input.documentType, maxTokens: input.maxTokens }) : DEFAULT_PAGES_PER_BATCH
    const out: PageRange[] = []
    for (let p = from; p <= to; p += size) out.push({ from: p, to: Math.min(p + size - 1, to) })
    return out
  }
  const budget = outputBudget(input.maxTokens)
  const out: PageRange[] = []
  let start = from
  let chunkRows: number[] = []
  for (let p = from; p <= to; p++) {
    const r = rows[p - 1] ?? d.defaultRowsPerPage
    const candidate = [...chunkRows, r]
    const fits = expectedOutputTokens({ documentType: input.documentType, maxTokens: input.maxTokens, rowsByPage: candidate }) <= budget
    if (chunkRows.length > 0 && (!fits || candidate.length > cap)) {
      out.push({ from: start, to: p - 1 })
      start = p
      chunkRows = [r]
    } else {
      chunkRows = candidate
    }
  }
  if (chunkRows.length > 0) out.push({ from: start, to })
  return out
}

/** "1–6" / "8" labels for progress and error copy. */
export function rangeLabel(r: PageRange): string {
  return r.from === r.to ? String(r.from) : `${r.from}–${r.to}`
}
