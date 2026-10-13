// The PDF text layer, read in the browser, so a chunked parse can size its
// chunks from the REAL row density of each page (lib/chunk-plan.ts) instead
// of a conservative guess. A scanned statement has no text layer; pdf.js
// then returns nothing and the conservative plan applies.
//
// pdfjs-dist is loaded DYNAMICALLY and only ever in the browser: the legacy
// build is the one that runs in Safari on an iPad, and the worker comes from
// a same-version CDN URL (the bundler never sees it). Nothing here runs on
// the server — pdfPageTextRows returns null there.
//
// countSettlementRows is pure and tested (lib/pdf-text.test.ts).

export const PDFJS_VERSION = '4.10.38'
const WORKER_SRC = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.mjs`

type TextItemLike = { str?: string; transform?: number[]; hasEOL?: boolean }

/**
 * Per-page text lines of `file`, or null when the PDF has no text layer (a
 * scan), pdf.js cannot load it, or this is not a browser.
 */
export async function pdfPageTextRows(file: File): Promise<string[][] | null> {
  if (typeof window === 'undefined') return null
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC
    const data = new Uint8Array(await file.arrayBuffer())
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
    const pages: string[][] = []
    let any = false
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const lines = linesFromItems(content.items as TextItemLike[])
      if (lines.length > 0) any = true
      pages.push(lines)
    }
    void doc.destroy().catch(() => {})
    return any ? pages : null
  } catch {
    return null
  }
}

/** Group text items into lines by their baseline (y), left to right. */
export function linesFromItems(items: ReadonlyArray<TextItemLike>): string[] {
  const rows = new Map<number, Array<{ x: number; str: string }>>()
  for (const it of items) {
    const str = (it.str ?? '').trim()
    if (!str) continue
    const t = it.transform ?? []
    const x = Number(t[4] ?? 0)
    const y = Math.round(Number(t[5] ?? 0) / 2) * 2 // 2pt buckets
    const row = rows.get(y) ?? []
    row.push({ x, str })
    rows.set(y, row)
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top of the page first
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((r) => r.str).join(' ').trim())
    .filter(Boolean)
}

const TICKET_LINE = /^\d{5,}$/
const DATE_LINE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/

/**
 * Ticket rows on one page of a settlement sheet: a line that is ONLY a 5+
 * digit number, followed within 8 lines by a M/D/YYYY date. Generic across
 * buyers (Woodall prints the ticket number, then the vehicle id, grade and
 * date). The window keeps a bare page number or a contract number from
 * counting.
 */
export function countSettlementRows(lines: ReadonlyArray<string>): number {
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    if (!TICKET_LINE.test(lines[i].trim())) continue
    for (let j = i + 1; j <= Math.min(i + 8, lines.length - 1); j++) {
      if (DATE_LINE.test(lines[j])) { n++; break }
    }
  }
  return n
}

/** Rows per page for the types whose density is counted from text. */
export function countRowsForType(documentType: string, lines: ReadonlyArray<string>): number | null {
  if (documentType === 'settlement') return countSettlementRows(lines)
  return null
}
