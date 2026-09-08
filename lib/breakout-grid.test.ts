import { describe, it, expect } from 'vitest'
import {
  breakoutRowKeys, breakoutRowLabel, breakoutShowsSeason, hiddenDoubleCropAcres, hiddenDoubleCropNotice,
} from '@/lib/breakout-grid'

// The assumptions grid's rows follow the crop's Double-crop designation in
// Settings → Crops: a future-year (assumed) grid offers the Double-crop rows
// only for a crop designated Double-crop (soybeans after wheat); everyone
// else gets Irrigated + Dryland, labeled plainly.

const zero = { fullIrr: 0, fullDry: 0, dcIrr: 0, dcDry: 0 }

describe('breakoutRowKeys — assumed (future-year) grids follow the designation', () => {
  it('a Double-crop crop offers all four rows', () => {
    expect(breakoutRowKeys({ mode: 'assumed', doubleCrop: true, seg: zero })).toEqual(['irr', 'dry', 'dcIrr', 'dcDry'])
  })
  it('a non-Double-crop crop offers only Irrigated + Dryland', () => {
    expect(breakoutRowKeys({ mode: 'assumed', doubleCrop: false, seg: zero })).toEqual(['irr', 'dry'])
  })
  it('…even when stale double-crop acres are sitting in the row (they surface as a notice instead)', () => {
    expect(breakoutRowKeys({ mode: 'assumed', doubleCrop: false, seg: { ...zero, dcDry: 300 } })).toEqual(['irr', 'dry'])
  })
})

describe('breakoutRowKeys — planted grids derive from the real plantings', () => {
  it('only segments with acres appear, whatever the designation', () => {
    expect(breakoutRowKeys({ mode: 'planted', doubleCrop: true, seg: { fullIrr: 0, fullDry: 1200, dcIrr: 0, dcDry: 0 } })).toEqual(['dry'])
    expect(breakoutRowKeys({ mode: 'planted', doubleCrop: true, seg: { fullIrr: 500, fullDry: 700, dcIrr: 0, dcDry: 400 } })).toEqual(['irr', 'dry', 'dcDry'])
    expect(breakoutRowKeys({ mode: 'planted', doubleCrop: false, seg: zero })).toEqual([])
  })
})

describe('labels — the season prefix appears only when both kinds are showing', () => {
  it('two rows read plainly', () => {
    const rows = breakoutRowKeys({ mode: 'assumed', doubleCrop: false, seg: zero })
    const show = breakoutShowsSeason(rows)
    expect(show).toBe(false)
    expect(rows.map((k) => breakoutRowLabel(k, show))).toEqual(['Irrigated', 'Dryland'])
  })
  it('four rows carry Full-season · / Double-crop ·', () => {
    const rows = breakoutRowKeys({ mode: 'assumed', doubleCrop: true, seg: zero })
    const show = breakoutShowsSeason(rows)
    expect(show).toBe(true)
    expect(rows.map((k) => breakoutRowLabel(k, show))).toEqual([
      'Full-season · Irrigated', 'Full-season · Dryland', 'Double-crop · Irrigated', 'Double-crop · Dryland',
    ])
  })
  it('a planted crop with only double-crop acres reads plainly too', () => {
    const rows = breakoutRowKeys({ mode: 'planted', doubleCrop: true, seg: { ...zero, dcIrr: 200, dcDry: 100 } })
    expect(breakoutShowsSeason(rows)).toBe(false)
    expect(rows.map((k) => breakoutRowLabel(k, false))).toEqual(['Irrigated', 'Dryland'])
  })
})

describe('a changed designation never drops entered acres silently', () => {
  it('double-crop acres stored on a crop no longer designated Double-crop raise the notice', () => {
    const hidden = hiddenDoubleCropAcres({ doubleCrop: false, stored: { dcIrr: 120, dcDry: '180' } })
    expect(hidden).toBe(300)
    expect(hiddenDoubleCropNotice({ cropYear: 2026, cropName: 'Soybean', hiddenAcres: hidden! }))
      .toBe('2026 had 300 double-crop acres entered for Soybean — re-enable Double-crop for it under Settings → Crops, or clear them.')
  })
  it('nothing to say when the crop is Double-crop, or the cells are empty', () => {
    expect(hiddenDoubleCropAcres({ doubleCrop: true, stored: { dcIrr: 120, dcDry: 180 } })).toBeNull()
    expect(hiddenDoubleCropAcres({ doubleCrop: false, stored: { dcIrr: null, dcDry: '' } })).toBeNull()
    expect(hiddenDoubleCropAcres({ doubleCrop: false, stored: { dcIrr: 0, dcDry: undefined } })).toBeNull()
  })
})
