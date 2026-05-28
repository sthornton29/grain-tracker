// Client-side image helpers for the camera/photo capture flow that feeds the
// same AI document parser as PDF upload.
//
//   * compressImage  — decode a captured/selected photo, bake in EXIF rotation,
//                      resize the long edge to <=2000px, and re-encode as JPEG
//                      at quality 0.85. Keeps the base64 payload small enough to
//                      ship several pages to Anthropic in one call.
//   * imagesToPdf    — stitch the compressed photos into a single PDF (one page
//                      per image) so the existing "attach the source PDF on save"
//                      workflow stays unchanged when the input was photos.
//
// jsPDF is already a dependency (used by lib/exports.ts) and is imported
// dynamically so screens that never capture a photo don't pay its download cost.

export type CapturedImage = {
  /** Stable id for React keys and removal. */
  id: string
  /** data: URL for thumbnail/preview rendering. */
  dataUrl: string
  /** Base64 (no data: prefix) for the API payload. */
  base64: string
  /** Always image/jpeg — we re-encode every input to JPEG. */
  mediaType: 'image/jpeg'
  width: number
  height: number
  bytes: number
}

// Long-edge cap and JPEG quality. 2000px @ q0.85 is plenty for text extraction
// and keeps a typical document photo well under ~1 MB of base64.
const MAX_DIM = 2000
const JPEG_QUALITY = 0.85

export class ImageDecodeError extends Error {
  constructor() {
    super("Couldn't read that photo. Try a JPEG or PNG, or upload the PDF instead.")
    this.name = 'ImageDecodeError'
  }
}

// Decode to an ImageBitmap, honoring EXIF orientation so portrait phone photos
// aren't sideways. createImageBitmap with imageOrientation is supported on
// modern Safari/Chrome; fall back to an <img> decode (which applies orientation
// itself in current browsers) when the option is unavailable.
async function decode(file: File): Promise<{ draw: CanvasImageSource; width: number; height: number; cleanup: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      return { draw: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() }
    } catch {
      // Fall through to the <img> path (e.g. option unsupported or decode failed).
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new ImageDecodeError())
      el.src = url
    })
    return {
      draw: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e instanceof ImageDecodeError ? e : new ImageDecodeError()
  }
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export async function compressImage(file: File): Promise<CapturedImage> {
  const { draw, width, height, cleanup } = await decode(file)
  try {
    if (!width || !height) throw new ImageDecodeError()
    const scale = Math.min(1, MAX_DIM / Math.max(width, height))
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new ImageDecodeError()
    // White matte so any transparent PNG areas don't turn black under JPEG.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(draw, 0, 0, w, h)

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    const comma = dataUrl.indexOf(',')
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    // base64 length * 3/4 ≈ decoded byte count.
    const bytes = Math.floor((base64.length * 3) / 4)
    return { id: makeId(), dataUrl, base64, mediaType: 'image/jpeg', width: w, height: h, bytes }
  } finally {
    cleanup()
  }
}

// Build a single PDF, one image per page, each page sized to the image's pixel
// dimensions so nothing is cropped or letter-boxed. Returns a File so callers
// can hand it straight to the existing storage upload helpers.
export async function imagesToPdf(images: CapturedImage[], baseName: string): Promise<File> {
  const { default: JsPDF } = await import('jspdf')
  if (images.length === 0) throw new Error('No images to combine.')

  let doc: InstanceType<typeof JsPDF> | null = null
  for (const img of images) {
    const orientation = img.width >= img.height ? 'landscape' : 'portrait'
    if (!doc) {
      doc = new JsPDF({ orientation, unit: 'px', format: [img.width, img.height] })
    } else {
      doc.addPage([img.width, img.height], orientation)
    }
    doc.addImage(img.dataUrl, 'JPEG', 0, 0, img.width, img.height)
  }

  const blob = doc!.output('blob')
  const safe = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_')
  return new File([blob], `${safe}-${new Date().toISOString().slice(0, 10)}.pdf`, { type: 'application/pdf' })
}
