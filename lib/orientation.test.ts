import { describe, it, expect } from 'vitest'
import { PDFDocument, degrees, rgb } from 'pdf-lib'
import { needsNormalization, normalizePdfOrientation, normalizeRotation, planPage } from '@/lib/orientation'

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
