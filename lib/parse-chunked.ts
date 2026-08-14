// Chunked AI document parsing — the client-side fix for gateway timeouts on
// large documents.
//
// One serverless call per page batch keeps every Anthropic request well under
// the function time limit (each chunk is its own /api/parse-document POST),
// with:
//   * a progress label per batch ("Reading pages 9–16 of 24…"),
//   * one automatic retry per chunk on a transient failure,
//   * partial results kept when a chunk still fails — the caller gets the
//     merged data plus a warning naming the failed pages, never a bare 504,
//   * merge functions (lib/parse-merge.ts) that dedupe records straddling
//     chunk boundaries.
//
// Short documents (≤ pagesPerBatch pages) behave exactly like a plain
// parseDocument call — same single request, same errors.

import { getPdfPageCount, splitPdfIntoBatches } from '@/lib/pdf-split'
import { parseDocument, type DocumentType, type ParseImage } from '@/lib/pdf-upload'
import type { CottonMarketingCategory } from '@/lib/cotton-doc-import'

export const DEFAULT_PAGES_PER_BATCH = 6

export type ChunkedParseResult<M> = {
  data: M
  /** "9–16" style list of page ranges that could not be read; null = all read. */
  failedPages: string | null
  /** Customer-facing sentence to show when failedPages is set. */
  warning: string | null
}

type Chunk = { input: File | ParseImage[]; from: number; to: number }

// parseDocument's public signature is a per-document-type overload set; this
// generic runner needs the untyped form (the caller's merge fn pins T).
const parseAny = parseDocument as (
  input: File | ParseImage[],
  documentType: DocumentType,
  opts?: { category?: CottonMarketingCategory; primaryTarget?: string },
) => Promise<unknown>

function rangeLabel(c: Chunk): string {
  return c.from === c.to ? String(c.from) : `${c.from}–${c.to}`
}

export async function parseDocumentChunked<T, M = T>(
  source: File | ParseImage[],
  documentType: DocumentType,
  opts: {
    /** Combine per-chunk results (see lib/parse-merge.ts). May also transform
     *  (e.g. the settings upload normalizes each raw chunk before merging). */
    merge: (parts: T[]) => M
    pagesPerBatch?: number
    onProgress?: (label: string) => void
    category?: CottonMarketingCategory
    primaryTarget?: string
  },
): Promise<ChunkedParseResult<M>> {
  const pagesPerBatch = opts.pagesPerBatch ?? DEFAULT_PAGES_PER_BATCH
  const parseOpts = { category: opts.category, primaryTarget: opts.primaryTarget }
  const isImages = Array.isArray(source)
  const unit = isImages ? 'photos' : 'pages'

  // Build the chunk list with 1-based page ranges for progress/error copy.
  let chunks: Chunk[]
  let total: number
  if (isImages) {
    total = source.length
    chunks = []
    for (let i = 0; i < source.length; i += pagesPerBatch) {
      chunks.push({ input: source.slice(i, i + pagesPerBatch), from: i + 1, to: Math.min(i + pagesPerBatch, source.length) })
    }
    if (chunks.length === 0) chunks = [{ input: source, from: 1, to: Math.max(source.length, 1) }]
  } else {
    total = await getPdfPageCount(source).catch(() => 1)
    if (total <= pagesPerBatch) {
      chunks = [{ input: source, from: 1, to: total }]
    } else {
      const files = await splitPdfIntoBatches(source, pagesPerBatch)
      chunks = files.map((f, i) => ({
        input: f,
        from: i * pagesPerBatch + 1,
        to: Math.min((i + 1) * pagesPerBatch, total),
      }))
    }
  }

  const parts: T[] = []
  const failed: Chunk[] = []
  let firstError: unknown = null
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    opts.onProgress?.(
      chunks.length === 1
        ? 'Reading the document…'
        : `Reading ${unit} ${rangeLabel(c)} of ${total}…`,
    )
    // One retry per chunk: transient network / model hiccups shouldn't cost
    // the whole upload (or the chunks that already succeeded).
    let result: T | null = null
    for (let attempt = 0; attempt < 2 && result == null; attempt++) {
      try {
        result = (await parseAny(c.input, documentType, parseOpts)) as T
      } catch (e) {
        if (attempt === 1) {
          firstError = firstError ?? e
          failed.push(c)
        }
      }
    }
    if (result != null) parts.push(result)
  }

  if (parts.length === 0) {
    // Nothing succeeded: single chunk rethrows the real error (preserves
    // PdfTooLargeError etc.); multi-chunk gets a clean summary.
    if (chunks.length === 1 && firstError instanceof Error) throw firstError
    throw new Error(
      `None of the document's ${unit} could be read. Try again, or upload fewer ${unit} at a time.`,
    )
  }

  const failedPages = failed.length > 0 ? failed.map(rangeLabel).join(', ') : null
  return {
    data: opts.merge(parts),
    failedPages,
    warning: failedPages
      ? `${unit === 'pages' ? 'Pages' : 'Photos'} ${failedPages} couldn't be read — everything else was. Try uploading ${unit === 'pages' ? 'those pages' : 'those photos'} separately.`
      : null,
  }
}
