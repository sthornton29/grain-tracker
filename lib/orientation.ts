// Page-orientation normalization for document uploads (086).
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
// through untouched. (A page that is sideways WITHOUT a rotation flag has no
// signal we can act on without OCR; the extraction prompt tells the model to
// read pages in whichever orientation the text runs, and the photo tray
// offers a manual rotate.)
//
// The planning half is pure and tested; the baking half needs pdf-lib.

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

/** Rewrite a PDF so every page is upright with /Rotate 0. Returns the same
 *  bytes when nothing needs baking. Runs in the browser (pdf-lib is loaded
 *  dynamically) and in node (tests). */
export async function normalizePdfOrientation(bytes: ArrayBuffer | Uint8Array): Promise<{ bytes: Uint8Array; changed: boolean; pages: PagePlan[] }> {
  const { PDFDocument, degrees } = await import('pdf-lib')
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const geometries: PageGeometry[] = src.getPages().map((p) => {
    const { width, height } = p.getSize()
    return { width, height, rotation: p.getRotation().angle }
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

/** File-in, File-out convenience for the upload pipeline; the original
 *  file comes back untouched when nothing needed baking or the PDF could
 *  not be parsed. */
export async function normalizePdfFile(file: File): Promise<{ file: File; changed: boolean }> {
  try {
    const result = await normalizePdfOrientation(await file.arrayBuffer())
    if (!result.changed) return { file, changed: false }
    const buf = result.bytes.slice().buffer
    return { file: new File([buf], file.name, { type: 'application/pdf' }), changed: true }
  } catch {
    return { file, changed: false }
  }
}
