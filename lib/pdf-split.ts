// Client-side PDF splitting for the AI document parser.
//
// A single Anthropic vision call over a long PDF (e.g. "all my 156EZ forms")
// can exceed the serverless function's time limit and return a 504, and a
// many-record extraction can also blow past the response token cap. Splitting
// the PDF into small page-batches in the browser keeps each /api/parse-document
// call fast and bounded; the caller merges the per-batch results.
//
// pdf-lib runs entirely in the browser and is loaded dynamically so pages that
// never parse a document don't pay its download cost.

export async function getPdfPageCount(file: File): Promise<number> {
  const { PDFDocument } = await import('pdf-lib')
  const bytes = await file.arrayBuffer()
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPageCount()
}

// Split a PDF File into a list of smaller PDF Files of at most `pagesPerBatch`
// pages each. Returns the original file unchanged when it already fits in one
// batch, or when it can't be parsed (callers fall back to the whole file).
export async function splitPdfIntoBatches(file: File, pagesPerBatch = 4): Promise<File[]> {
  if (pagesPerBatch < 1) pagesPerBatch = 1
  const { PDFDocument } = await import('pdf-lib')
  const bytes = await file.arrayBuffer()
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const total = src.getPageCount()
  if (total <= pagesPerBatch) return [file]

  const baseName = file.name.replace(/\.pdf$/i, '')
  const batches: File[] = []
  for (let start = 0; start < total; start += pagesPerBatch) {
    const end = Math.min(start + pagesPerBatch, total)
    const out = await PDFDocument.create()
    const indices = Array.from({ length: end - start }, (_, i) => start + i)
    const pages = await out.copyPages(src, indices)
    pages.forEach((p) => out.addPage(p))
    const u8 = await out.save()
    // Copy into a fresh ArrayBuffer so the File holds a plain ArrayBuffer part.
    const buf = u8.slice().buffer
    batches.push(new File([buf], `${baseName}-p${start + 1}-${end}.pdf`, { type: 'application/pdf' }))
  }
  return batches
}
