// Page-orientation normalization for document uploads (086, extended 0099).
//
// Scanners and phones save sideways pages two ways: a PDF page whose stored
// /Rotate says "display me turned 90°/180°/270°" (the content stream is
// sideways; viewers honor the flag, some rasterizers do not), or a photo
// whose EXIF orientation says the same (browsers honor EXIF when we decode
// with createImageBitmap — lib/image-capture.ts). Before a PDF goes to the
// extraction model, every page carrying a rotation is BAKED upright: the
// page content is embedded into a fresh page of the rotated size and drawn
// with the rotation applied, so the output page has /Rotate 0 and reads
// correctly regardless of the rasterizer. Pages already upright pass
// through untouched.
//
// 0099 adds the case a flag cannot tell: a page whose CONTENT is turned
// (every even page of a duplex-scanned FSA statement is stored upside down
// with /Rotate 0). A scan has no text layer to measure, and pixel heuristics
// on scanned text (ascender/descender asymmetry, ink profiles) could not tell
// the two October 2026 statements' upright pages from their inverted ones —
// so the content orientation is asked of the extraction model in one cheap
// pre-pass (detectContentOrientation: one small JPEG per page, one verdict
// each, document_type 'page_orientation'), only for PDFs with no text layer,
// and then baked exactly like a stored rotation: combineRotations adds the
// content rotation to the stored one and planPage does the rest.
//
// The planning half (planPage, combineRotations, parsePageOrientations) is
// pure and tested; the baking half needs pdf-lib; the rendering half needs
// pdf.js in a browser.

export type PageGeometry = { width: number; height: number; rotation: number }

export type PagePlan = {
  /** The stored rotation, normalized to 0 | 90 | 180 | 270. */
  rotation: 0 | 90 | 180 | 270
  /** True when the page must be re-drawn (rotation ≠ 0). */
  bake: boolean
  /** Output page size after baking (swapped for 90 / 270). */
  outWidth: number
  outHeight: number
  /** Where to place the embedded page and how much to turn it (pdf-lib's
   *  drawPage rotates about the page's lower-left corner, counter-clockwise
   *  for positive degrees). */
  x: number
  y: number
  drawRotation: 0 | 90 | 180 | 270
  /** The page reads landscape after normalization (statements often do —
   *  this is information, not a defect). */
  landscape: boolean
}

export function normalizeRotation(deg: number | null | undefined): 0 | 90 | 180 | 270 {
  const r = ((Math.round((deg ?? 0) / 90) * 90) % 360 + 360) % 360
  return r as 0 | 90 | 180 | 270
}

/** How to bring one page upright. /Rotate R means "rotate the page R°
 *  clockwise when displaying"; baking draws the content rotated by R°
 *  clockwise (= −R° in pdf-lib's counter-clockwise degrees) into a page of
 *  the displayed size. */
export function planPage(page: PageGeometry): PagePlan {
  const rotation = normalizeRotation(page.rotation)
  const { width, height } = page
  if (rotation === 0) {
    return { rotation, bake: false, outWidth: width, outHeight: height, x: 0, y: 0, drawRotation: 0, landscape: width > height }
  }
  const swapped = rotation === 90 || rotation === 270
  const outWidth = swapped ? height : width
  const outHeight = swapped ? width : height
  // Clockwise display rotation R ⇔ draw with pdf-lib rotation (360 − R),
  // translating so the rotated content lands inside the new page box.
  const drawRotation = ((360 - rotation) % 360) as 0 | 90 | 180 | 270
  let x = 0, y = 0
  if (rotation === 90) { x = 0; y = outHeight }           // draw at −90°: content swings down from the top-left
  else if (rotation === 180) { x = outWidth; y = outHeight }
  else if (rotation === 270) { x = outWidth; y = 0 }
  return { rotation, bake: true, outWidth, outHeight, x, y, drawRotation, landscape: outWidth > outHeight }
}

export function planDocument(pages: ReadonlyArray<PageGeometry>): PagePlan[] {
  return pages.map(planPage)
}

/** True when any page needs baking. */
export function needsNormalization(pages: ReadonlyArray<PageGeometry>): boolean {
  return pages.some((p) => normalizeRotation(p.rotation) !== 0)
}

// ---------- content orientation (0099) ----------

export type ContentOrientation = 'upright' | 'upside_down' | 'rotated_cw' | 'rotated_ccw' | 'blank'

/** The clockwise display rotation that brings content of this orientation
 *  upright: content turned 90° clockwise needs a 270° clockwise turn (one
 *  counter-clockwise quarter), and the mirror case 90°. */
export function contentRotationDegrees(o: ContentOrientation | null | undefined): 0 | 90 | 180 | 270 {
  switch (o) {
    case 'upside_down': return 180
    case 'rotated_cw': return 270
    case 'rotated_ccw': return 90
    default: return 0
  }
}

/** The stored /Rotate plus a detected content rotation, normalized. */
export function combineRotations(stored: number | null | undefined, content: number | null | undefined): 0 | 90 | 180 | 270 {
  return normalizeRotation((stored ?? 0) + (content ?? 0))
}

/** The model's answer for the pre-pass, defensively, as one rotation per
 *  page (0 for a page it did not mention, could not judge, or found blank). */
export function parsePageOrientations(raw: unknown, pageCount: number): Array<0 | 90 | 180 | 270> {
  const out: Array<0 | 90 | 180 | 270> = Array.from({ length: Math.max(0, pageCount) }, () => 0)
  const pages = (raw as { pages?: unknown } | null)?.pages
  if (!Array.isArray(pages)) return out
  pages.forEach((p, i) => {
    const x = (p ?? {}) as { page?: unknown; orientation?: unknown }
    const n = Number(x.page)
    const hasPage = x.page != null && x.page !== ''
    if (hasPage && !(Number.isInteger(n) && n >= 1 && n <= pageCount)) return
    const idx = hasPage ? n - 1 : i
    if (idx < 0 || idx >= pageCount) return
    const o = typeof x.orientation === 'string' ? x.orientation.trim().toLowerCase() : ''
    const known: ContentOrientation | null =
      o === 'upright' || o === 'upside_down' || o === 'rotated_cw' || o === 'rotated_ccw' || o === 'blank' ? (o as ContentOrientation) : null
    out[idx] = contentRotationDegrees(known)
  })
  return out
}

/** Per-page content detection: small JPEGs in, one verdict per page out. */
export type OrientationDetector = (images: Array<{ base64: string; mediaType: string }>) => Promise<unknown>

/** The route accepts at most this many photos per call. */
export const ORIENTATION_BATCH = 20
/** Long edge of the thumbnails the pre-pass sends — enough to read text direction, a few KB each. */
export const ORIENTATION_THUMB_PX = 480

/** Render every page to a small grayscale JPEG (browser only; null elsewhere or on failure). */
export async function renderPageThumbnails(bytes: ArrayBuffer | Uint8Array, longEdge = ORIENTATION_THUMB_PX): Promise<Array<{ base64: string; mediaType: string }> | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { PDFJS_VERSION } = await import('@/lib/pdf-text')
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.mjs`
    const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0))
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
    const out: Array<{ base64: string; mediaType: string }> = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const base = page.getViewport({ scale: 1 })
      const scale = longEdge / Math.max(base.width, base.height)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6)
      out.push({ base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' })
    }
    void doc.destroy().catch(() => {})
    return out
  } catch {
    return null
  }
}

/** The pre-pass over a scanned PDF: thumbnails → the model (in batches of
 *  ORIENTATION_BATCH) → one rotation per page. Null when the pages could not
 *  be rendered or the detector failed (the caller then bakes stored
 *  rotations only, as before). */
export async function detectContentOrientation(
  bytes: ArrayBuffer | Uint8Array,
  detector: OrientationDetector,
  render: typeof renderPageThumbnails = renderPageThumbnails,
  onStart?: () => void,
): Promise<Array<0 | 90 | 180 | 270> | null> {
  const thumbs = await render(bytes)
  if (!thumbs || thumbs.length === 0) return null
  onStart?.()
  const out: Array<0 | 90 | 180 | 270> = []
  try {
    for (let i = 0; i < thumbs.length; i += ORIENTATION_BATCH) {
      const batch = thumbs.slice(i, i + ORIENTATION_BATCH)
      const raw = await detector(batch)
      out.push(...parsePageOrientations(raw, batch.length))
    }
  } catch {
    return null
  }
  return out
}

/** Rewrite a PDF so every page is upright with /Rotate 0. `contentRotations`
 *  (one clockwise degree value per page, from detectContentOrientation) is
 *  added to each page's stored rotation. Returns the same bytes when nothing
 *  needs baking. Runs in the browser (pdf-lib is loaded dynamically) and in
 *  node (tests). */
export async function normalizePdfOrientation(
  bytes: ArrayBuffer | Uint8Array,
  opts?: { contentRotations?: ReadonlyArray<number> | null },
): Promise<{ bytes: Uint8Array; changed: boolean; pages: PagePlan[] }> {
  const { PDFDocument, degrees } = await import('pdf-lib')
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const geometries: PageGeometry[] = src.getPages().map((p, i) => {
    const { width, height } = p.getSize()
    return { width, height, rotation: combineRotations(p.getRotation().angle, opts?.contentRotations?.[i] ?? 0) }
  })
  const plans = planDocument(geometries)
  if (!plans.some((p) => p.bake)) {
    return { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), changed: false, pages: plans }
  }
  const out = await PDFDocument.create()
  const embedded = await out.embedPages(src.getPages())
  for (let i = 0; i < embedded.length; i++) {
    const plan = plans[i]
    const page = out.addPage([plan.outWidth, plan.outHeight])
    page.drawPage(embedded[i], { x: plan.x, y: plan.y, rotate: degrees(plan.drawRotation) })
    page.setRotation(degrees(0))
  }
  return { bytes: await out.save(), changed: true, pages: plans }
}

export type NormalizeFileOptions = {
  /** Ask the model which pages' CONTENT is turned (scans only — a PDF with a
   *  text layer is never content-rotated without a flag). Pass the detector
   *  (production: lib/pdf-upload's parseDocument over 'page_orientation'
   *  images); omit to bake stored rotations only. */
  detect?: OrientationDetector | null
  /** Whether the PDF has a text layer (lib/pdf-text pdfPageTextRows); when
   *  it does, detection is skipped. Omit = unknown = detect. */
  hasTextLayer?: boolean | null
  onProgress?: (label: string) => void
  /** Test hook: the thumbnail renderer. */
  render?: typeof renderPageThumbnails
}

/** File-in, File-out convenience for the upload pipeline; the original
 *  file comes back untouched when nothing needed baking or the PDF could
 *  not be parsed. */
export async function normalizePdfFile(file: File, opts?: NormalizeFileOptions): Promise<{ file: File; changed: boolean; contentRotations: Array<0 | 90 | 180 | 270> | null }> {
  try {
    const bytes = await file.arrayBuffer()
    let contentRotations: Array<0 | 90 | 180 | 270> | null = null
    if (opts?.detect && opts.hasTextLayer !== true) {
      contentRotations = await detectContentOrientation(bytes, opts.detect, opts.render, () => opts.onProgress?.('Checking which way the pages face…'))
    }
    const result = await normalizePdfOrientation(bytes, { contentRotations })
    if (!result.changed) return { file, changed: false, contentRotations }
    const buf = result.bytes.slice().buffer
    return { file: new File([buf], file.name, { type: 'application/pdf' }), changed: true, contentRotations }
  } catch {
    return { file, changed: false, contentRotations: null }
  }
}
