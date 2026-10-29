import { describe, it, expect } from 'vitest'
import { PDFDocument, degrees, rgb } from 'pdf-lib'
import { combineRotations, contentRotationDegrees, detectContentOrientation, needsNormalization, normalizePdfOrientation, normalizeRotation, parsePageOrientations, planPage } from '@/lib/orientation'

describe('page orientation planning (086)', () => {
  it('normalizes stored rotations to 0/90/180/270 (negative and over-360 included)', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(null)).toBe(0)
  })

  it('an upright page passes through; a landscape statement is landscape, not a defect', () => {
    const p = planPage({ width: 792, height: 612, rotation: 0 })
    expect(p.bake).toBe(false)
    expect(p.landscape).toBe(true)
    expect([p.outWidth, p.outHeight]).toEqual([792, 612])
  })

  it('a portrait scan stored sideways (/Rotate 90) bakes into a landscape page, and 270 the other way', () => {
    const p90 = planPage({ width: 612, height: 792, rotation: 90 })
    expect(p90.bake).toBe(true)
    expect([p90.outWidth, p90.outHeight]).toEqual([792, 612])
    expect(p90.drawRotation).toBe(270)
    const p270 = planPage({ width: 612, height: 792, rotation: 270 })
    expect([p270.outWidth, p270.outHeight]).toEqual([792, 612])
    expect(p270.drawRotation).toBe(90)
    const p180 = planPage({ width: 612, height: 792, rotation: 180 })
    expect([p180.outWidth, p180.outHeight]).toEqual([612, 792])
    expect(p180.drawRotation).toBe(180)
    expect(needsNormalization([{ width: 1, height: 1, rotation: 0 }, { width: 1, height: 1, rotation: 90 }])).toBe(true)
  })
})

// A rotated page → the same upright geometry as the original. Built with
// pdf-lib in node: page A is an upright landscape settlement page with a
// mark near its top-left; page B is the same content stored sideways with
// /Rotate 90 (how a scanner saves a turned sheet). After normalization B's
// page box equals A's and /Rotate is 0 — the extraction model sees the same
// upright page either way.
describe('content orientation (0099) — the duplex-scan case a /Rotate flag cannot tell', () => {
  it('maps the model verdicts to clockwise display rotations and combines them with the stored flag', () => {
    expect(contentRotationDegrees('upright')).toBe(0)
    expect(contentRotationDegrees('upside_down')).toBe(180)
    expect(contentRotationDegrees('rotated_cw')).toBe(270)
    expect(contentRotationDegrees('rotated_ccw')).toBe(90)
    expect(contentRotationDegrees('blank')).toBe(0)
    expect(combineRotations(0, 180)).toBe(180)
    expect(combineRotations(90, 180)).toBe(270)
    expect(combineRotations(180, 180)).toBe(0)
  })
  it('parsePageOrientations is defensive: by page number, else by order; unknown or missing pages stay 0', () => {
    expect(parsePageOrientations({ pages: [{ page: 2, orientation: 'upside_down' }, { page: 4, orientation: 'UPSIDE_DOWN' }, { page: 6, orientation: 'upside_down' }] }, 6)).toEqual([0, 180, 0, 180, 0, 180])
    expect(parsePageOrientations({ pages: [{ orientation: 'rotated_cw' }, { orientation: 'nonsense' }] }, 2)).toEqual([270, 0])
    expect(parsePageOrientations(null, 3)).toEqual([0, 0, 0])
    expect(parsePageOrientations({ pages: [{ page: 99, orientation: 'upside_down' }] }, 2)).toEqual([0, 0])
  })
  it('detectContentOrientation batches the thumbnails and returns one rotation per page; null when nothing renders', async () => {
    const thumbs = Array.from({ length: 25 }, (_, i) => ({ base64: `p${i + 1}`, mediaType: 'image/jpeg' }))
    const calls: number[] = []
    const detector = async (images: Array<{ base64: string }>) => {
      calls.push(images.length)
      return { pages: images.map((img, i) => ({ page: i + 1, orientation: Number(img.base64.slice(1)) % 2 === 0 ? 'upside_down' : 'upright' })) }
    }
    const out = await detectContentOrientation(new Uint8Array([1]), detector, async () => thumbs)
    expect(calls).toEqual([20, 5])
    expect(out?.length).toBe(25)
    expect(out?.slice(0, 4)).toEqual([0, 180, 0, 180])
    expect(await detectContentOrientation(new Uint8Array([1]), detector, async () => null)).toBeNull()
    expect(await detectContentOrientation(new Uint8Array([1]), async () => { throw new Error('x') }, async () => thumbs)).toBeNull()
  })
})

describe('normalizePdfOrientation — a rotated scan comes out upright', () => {
  async function landscapePage(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const page = doc.addPage([792, 612])
    page.drawRectangle({ x: 20, y: 560, width: 200, height: 30, color: rgb(0, 0, 0) })
    return doc.save()
  }
  async function storedSideways(upright: Uint8Array): Promise<Uint8Array> {
    // Embed the upright landscape content into a PORTRAIT page turned by
    // −90°, then flag the page /Rotate 90 so viewers display it upright.
    const src = await PDFDocument.load(upright)
    const out = await PDFDocument.create()
    const [emb] = await out.embedPages(src.getPages())
    const page = out.addPage([612, 792])
    page.drawPage(emb, { x: 612, y: 0, rotate: degrees(90) })
    page.setRotation(degrees(90))
    return out.save()
  }

  it('bakes /Rotate 90 into an upright 792×612 page with rotation 0; upright input is returned unchanged', async () => {
    const upright = await landscapePage()
    const sideways = await storedSideways(upright)
    const before = await PDFDocument.load(sideways)
    expect(before.getPage(0).getRotation().angle).toBe(90)
    expect(before.getPage(0).getSize()).toEqual({ width: 612, height: 792 })

    const fixed = await normalizePdfOrientation(sideways)
    expect(fixed.changed).toBe(true)
    const after = await PDFDocument.load(fixed.bytes)
    expect(after.getPageCount()).toBe(1)
    expect(after.getPage(0).getRotation().angle).toBe(0)
    expect(after.getPage(0).getSize()).toEqual({ width: 792, height: 612 })

    const same = await normalizePdfOrientation(upright)
    expect(same.changed).toBe(false)
    expect(same.pages[0].bake).toBe(false)
  })

  it('a six-page document whose pages 2, 4 and 6 are stored upside down (no /Rotate) bakes exactly those pages when told their content rotation', async () => {
    // Upright page: a black mark in the TOP-LEFT corner. Upside-down page:
    // the same content drawn turned 180° — the mark sits bottom-right and
    // the page carries NO rotation flag (the duplex-scan case).
    const upright = await PDFDocument.create()
    const up = upright.addPage([612, 792])
    up.drawRectangle({ x: 20, y: 740, width: 200, height: 30, color: rgb(0, 0, 0) })
    const uprightBytes = await upright.save()
    const flipped = await PDFDocument.create()
    const [emb] = await flipped.embedPages((await PDFDocument.load(uprightBytes)).getPages())
    const fp = flipped.addPage([612, 792])
    fp.drawPage(emb, { x: 612, y: 792, rotate: degrees(180) })
    const flippedBytes = await flipped.save()
    const doc = await PDFDocument.create()
    for (let i = 1; i <= 6; i++) {
      const [pg] = await doc.copyPages(await PDFDocument.load(i % 2 === 0 ? flippedBytes : uprightBytes), [0])
      doc.addPage(pg)
    }
    const bytes = await doc.save()
    const asStored = await PDFDocument.load(bytes)
    expect(asStored.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 0, 0, 0, 0])

    const fixed = await normalizePdfOrientation(bytes, { contentRotations: [0, 180, 0, 180, 0, 180] })
    expect(fixed.changed).toBe(true)
    expect(fixed.pages.map((p) => p.bake)).toEqual([false, true, false, true, false, true])
    expect(fixed.pages.map((p) => p.rotation)).toEqual([0, 180, 0, 180, 0, 180])
    const out = await PDFDocument.load(fixed.bytes)
    expect(out.getPageCount()).toBe(6)
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 0, 0, 0, 0])
    expect(out.getPages().map((p) => p.getSize())).toEqual(Array.from({ length: 6 }, () => ({ width: 612, height: 792 })))
    // Nothing detected → nothing baked.
    expect((await normalizePdfOrientation(bytes, { contentRotations: null })).changed).toBe(false)
  })

  it('a multi-page document keeps page count and order, fixing only the turned pages', async () => {
    const upright = await landscapePage()
    const sideways = await storedSideways(upright)
    const merged = await PDFDocument.create()
    const [a] = await merged.copyPages(await PDFDocument.load(upright), [0])
    const [b] = await merged.copyPages(await PDFDocument.load(sideways), [0])
    merged.addPage(a); merged.addPage(b)
    const fixed = await normalizePdfOrientation(await merged.save())
    const doc = await PDFDocument.load(fixed.bytes)
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getPage(0).getSize()).toEqual({ width: 792, height: 612 })
    expect(doc.getPage(1).getSize()).toEqual({ width: 792, height: 612 })
    expect(doc.getPage(1).getRotation().angle).toBe(0)
    expect(fixed.pages.map((p) => p.bake)).toEqual([false, true])
  })
})
