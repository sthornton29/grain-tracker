import { describe, expect, it } from 'vitest'
import {
  axisLabels, buildFieldBars, expectedSeedLbsForPlanting, fieldBarStatus, sortFieldBars,
  type FieldBarRow, type PlantedFieldInput,
} from './cotton-by-field'
import { seasonFlow, type SeasonFlowField } from './cotton-loads'

const flow = (p: Partial<SeasonFlowField> & { fieldId: string | null }): SeasonFlowField => ({
  loads: 1, netLbs: 0, yardLbs: 0, ginnedLbs: 0, yardRolls: 0, rolls: 0, ...p,
})
const planted = (fieldId: string, acres: number, expectedSeedLbs: number | null, note?: string): PlantedFieldInput => ({ fieldId, acres, expectedSeedLbs, expectationNote: note ?? null })
const nameOf = (id: string | null) => ({ A: 'Adams', B: 'Blythe', C: 'Creek' } as Record<string, string>)[id ?? ''] ?? 'No field'

describe('buildFieldBars — one shared pounds axis', () => {
  // The spec's three fields.
  const A = flow({ fieldId: 'A', loads: 12, ginnedLbs: 300_000, yardLbs: 50_000, netLbs: 350_000, yardRolls: 10, rolls: 70 })
  const B = flow({ fieldId: 'B', loads: 5, ginnedLbs: 150_000, yardLbs: 0, netLbs: 150_000, rolls: 30 })
  const plantedAll = [planted('A', 300, 400_000), planted('B', 100, 150_000), planted('C', 150, 200_000)]

  it('scales every bar to the largest field’s max(actual, expected) and ghosts to the expectation', () => {
    const { rows, axisMax } = buildFieldBars({ flowFields: [A, B], planted: plantedAll })
    expect(axisMax).toBe(400_000)
    const byId = new Map(rows.map((r) => [r.fieldId, r]))
    const a = byId.get('A')!
    expect(a.ginnedFrac).toBeCloseTo(0.75)
    expect(a.yardFrac).toBeCloseTo(0.125)
    expect(a.ghostFrac).toBeCloseTo(1)
    expect(a.tickFrac).toBeNull()
    expect(a.pctOfExpected).toBeCloseTo(87.5)
    expect(a.pctGinned).toBeCloseTo((300_000 / 350_000) * 100)
    expect(a.status).toBe('on_yard')
    expect(a.acres).toBe(300)
    expect(a.rolls).toBe(70)
    const b = byId.get('B')!
    expect(b.ginnedFrac).toBeCloseTo(0.375)
    expect(b.yardFrac).toBe(0)
    expect(b.ghostFrac).toBeCloseTo(0.375)
    expect(b.status).toBe('all_ginned')
    const c = byId.get('C')!
    expect(c.loads).toBe(0)
    expect(c.ginnedFrac).toBe(0)
    expect(c.yardFrac).toBe(0)
    expect(c.ghostFrac).toBeCloseTo(0.5)
    expect(c.status).toBe('not_started')
    expect(c.pctGinned).toBeNull()
    expect(c.pctOfExpected).toBe(0)
  })

  it('default order: on the yard, then picking, then all ginned, then not started', () => {
    const { rows } = buildFieldBars({ flowFields: [B, A], planted: plantedAll })
    expect(sortFieldBars(rows, 'default', nameOf).map((r) => r.fieldId)).toEqual(['A', 'B', 'C'])
  })

  it('an actual past the expectation runs past the ghost with the expectation tick', () => {
    const C = flow({ fieldId: 'C', loads: 9, ginnedLbs: 0, yardLbs: 220_000, netLbs: 220_000 })
    const { rows, axisMax } = buildFieldBars({ flowFields: [A, B, C], planted: plantedAll })
    expect(axisMax).toBe(400_000)
    const c = rows.find((r) => r.fieldId === 'C')!
    expect(c.yardFrac).toBeCloseTo(0.55)
    expect(c.ghostFrac).toBeCloseTo(0.5)
    expect(c.tickFrac).toBeCloseTo(0.5)
    expect(c.pctOfExpected).toBeCloseTo(110)
    expect(c.status).toBe('on_yard')
  })

  it('no expectation → no ghost, with the reason; a field with loads but no planting still appears', () => {
    const D = flow({ fieldId: 'D', loads: 2, yardLbs: 40_000, netLbs: 40_000 })
    const { rows } = buildFieldBars({ flowFields: [D, A], planted: [planted('A', 300, null, 'No expected lint yield for Cotton 2026 in Marketing assumptions')] })
    const a = rows.find((r) => r.fieldId === 'A')!
    expect(a.ghostFrac).toBeNull()
    expect(a.tickFrac).toBeNull()
    expect(a.pctOfExpected).toBeNull()
    expect(a.expectationNote).toMatch(/No expected lint yield/)
    const d = rows.find((r) => r.fieldId === 'D')!
    expect(d.acres).toBeNull()
    expect(d.expectationNote).toMatch(/No cotton planting/)
    expect(d.status).toBe('on_yard')
  })

  it('the no-field bucket keeps its pounds and sorts last', () => {
    const none = flow({ fieldId: null, loads: 3, yardLbs: 900_000, netLbs: 900_000 })
    const { rows, axisMax } = buildFieldBars({ flowFields: [none, B], planted: [planted('B', 100, 150_000)] })
    expect(axisMax).toBe(900_000)
    expect(sortFieldBars(rows, 'pounds', nameOf).map((r) => r.fieldId)).toEqual(['B', null])
  })
})

describe('fieldBarStatus', () => {
  it('picking = on the yard, nothing ginned, and well short of the expectation; on the yard otherwise', () => {
    expect(fieldBarStatus({ loads: 0, yardLbs: 0, ginnedLbs: 0, netLbs: 0, expectedLbs: 100 })).toBe('not_started')
    expect(fieldBarStatus({ loads: 3, yardLbs: 0, ginnedLbs: 90, netLbs: 90, expectedLbs: 100 })).toBe('all_ginned')
    expect(fieldBarStatus({ loads: 3, yardLbs: 60, ginnedLbs: 0, netLbs: 60, expectedLbs: 100 })).toBe('picking')
    expect(fieldBarStatus({ loads: 3, yardLbs: 96, ginnedLbs: 0, netLbs: 96, expectedLbs: 100 })).toBe('on_yard')
    expect(fieldBarStatus({ loads: 3, yardLbs: 30, ginnedLbs: 30, netLbs: 60, expectedLbs: 100 })).toBe('on_yard')
    expect(fieldBarStatus({ loads: 3, yardLbs: 60, ginnedLbs: 0, netLbs: 60, expectedLbs: null })).toBe('on_yard')
  })
})

describe('sortFieldBars', () => {
  const rows: FieldBarRow[] = buildFieldBars({
    flowFields: [
      flow({ fieldId: 'A', loads: 2, yardLbs: 10, netLbs: 10 }),
      flow({ fieldId: 'B', loads: 2, ginnedLbs: 50, netLbs: 50 }),
    ],
    planted: [planted('A', 1, 100), planted('B', 1, null), planted('C', 1, 20)],
  }).rows
  it('by name, by pounds, and by % of expected with blanks last', () => {
    expect(sortFieldBars(rows, 'name', nameOf).map((r) => r.fieldId)).toEqual(['A', 'B', 'C'])
    expect(sortFieldBars(rows, 'pounds', nameOf).map((r) => r.fieldId)).toEqual(['B', 'A', 'C'])
    // A 10%, C 0%, B no expectation.
    expect(sortFieldBars(rows, 'pct', nameOf).map((r) => r.fieldId)).toEqual(['A', 'C', 'B'])
  })
})

describe('expectedSeedLbsForPlanting — the Yields page’s expectation ÷ turnout', () => {
  const assumption = { crop_id: 'cot', crop_year: 2026, expected_yield: 1200, expected_yield_irr: null, expected_yield_dry: null }
  it('100 ac × 1,200 lint/ac ÷ 0.40 = 300,000 lb of seed cotton', () => {
    const r = expectedSeedLbsForPlanting({ plantedAcres: 100, assumption, practice: { irrigated_acres: null, dryland_acres: null }, turnoutFraction: 0.4 })
    expect(r.lbs).toBeCloseTo(300_000)
    expect(r.note).toBeNull()
  })
  it('says why when the lint expectation or the turnout is missing', () => {
    expect(expectedSeedLbsForPlanting({ plantedAcres: 100, assumption: null, practice: { irrigated_acres: null, dryland_acres: null }, turnoutFraction: 0.4, cropName: 'Cotton', cropYear: 2026 }))
      .toEqual({ lbs: null, note: 'No expected lint yield for Cotton 2026 in Marketing assumptions' })
    expect(expectedSeedLbsForPlanting({ plantedAcres: 100, assumption, practice: { irrigated_acres: null, dryland_acres: null }, turnoutFraction: null }))
      .toEqual({ lbs: null, note: 'No turnout on file' })
  })
  it('a per-practice assumption follows the planting’s practice split', () => {
    const a = { ...assumption, expected_yield_irr: 1500, expected_yield_dry: 900 }
    const r = expectedSeedLbsForPlanting({ plantedAcres: 100, assumption: a, practice: { irrigated_acres: 50, dryland_acres: 50 }, turnoutFraction: 0.5 })
    expect(r.lbs).toBeCloseTo((100 * 1200) / 0.5)
  })
})

describe('seasonFlow carries total rolls per field', () => {
  it('counts every roll, ginned or not', () => {
    const f = seasonFlow([
      { id: 'a', field_id: 'x', net_weight: 10, rolls: 3 },
      { id: 'b', field_id: 'x', net_weight: 10, rolls: 2 },
    ], (id) => id === 'b')
    expect(f.fields[0]).toMatchObject({ rolls: 5, yardRolls: 3 })
  })
})

describe('axisLabels', () => {
  it('labels the ends and the middle of the axis', () => {
    expect(axisLabels(400_000, (n) => n.toLocaleString('en-US'))).toEqual({ left: '0', mid: '200,000', right: '400,000 lb' })
  })
})
