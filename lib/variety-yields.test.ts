// Variety attribution + drill-down math — hand-verified. The drill-down
// renders the SAME parts the variety row summed (one seam), so these tests
// pin the conservation guarantee: Σ drill-down bushels = the variety row.

import { describe, expect, it } from 'vitest'
import {
  attributeVarietyBushels, summarizeVarietyDetail, varietyShareOfField,
  VARIETY_BASIS_LABEL, type VarietyPlantingPart,
} from '@/lib/variety-yields'
import { summarizeDetail, type YieldDetailLoad } from '@/lib/yield-detail'

const planting = (id: string, acres = 300) => ({
  id, field_id: `f-${id}`, crop_id: 'soy', season_year: 2026, planted_acres: acres,
})

describe('attributeVarietyBushels', () => {
  it('single variety: every bushel, acres from the variety row (planted fallback)', () => {
    const [part] = attributeVarietyBushels({
      planting: planting('p1', 250),
      varieties: [{ variety: 'AG55XF5', acres: 240, bushels: null }],
      dryBu: 12000,
    })
    expect(part.basis).toBe('whole')
    expect(part.dryBu).toBe(12000)
    expect(part.varietyAcres).toBe(240)
    // Variety acres left at 0 → planted_acres fallback.
    const [fb] = attributeVarietyBushels({
      planting: planting('p1', 250),
      varieties: [{ variety: 'AG55XF5', acres: 0, bushels: null }],
      dryBu: 12000,
    })
    expect(fb.varietyAcres).toBe(250)
  })

  it('multi-variety with a full manual allocation: the allocation is authoritative', () => {
    const parts = attributeVarietyBushels({
      planting: planting('p2'),
      varieties: [
        { variety: 'A', acres: 100, bushels: 4200 },
        { variety: 'B', acres: 50, bushels: 1800 },
      ],
      dryBu: 6000,
    })
    expect(parts.map((p) => p.basis)).toEqual(['allocated', 'allocated'])
    expect(parts.map((p) => p.dryBu)).toEqual([4200, 1800])
    expect(parts.reduce((s, p) => s + p.dryBu, 0)).toBe(6000)
  })

  it('multi-variety unallocated: acre-share estimate — 100/50 ac of 6,000 bu → 4,000/2,000', () => {
    const parts = attributeVarietyBushels({
      planting: planting('p3'),
      varieties: [
        { variety: 'A', acres: 100, bushels: null },
        { variety: 'B', acres: 50, bushels: null },
      ],
      dryBu: 6000,
    })
    expect(parts.map((p) => p.basis)).toEqual(['acre_share', 'acre_share'])
    expect(parts[0].dryBu).toBeCloseTo(4000, 10)
    expect(parts[1].dryBu).toBeCloseTo(2000, 10)
    // Conservation: the estimate never invents or drops bushels.
    expect(parts.reduce((s, p) => s + p.dryBu, 0)).toBeCloseTo(6000, 10)
  })

  it('no basis at all: unallocated with zero variety acres, or no varieties → excluded', () => {
    expect(attributeVarietyBushels({
      planting: planting('p4'),
      varieties: [
        { variety: 'A', acres: 0, bushels: null },
        { variety: 'B', acres: null, bushels: null },
      ],
      dryBu: 6000,
    })).toEqual([])
    expect(attributeVarietyBushels({ planting: planting('p5'), varieties: [], dryBu: 6000 })).toEqual([])
  })

  it('badge labels: whole is unbadged, the two multi-variety bases are named', () => {
    expect(VARIETY_BASIS_LABEL.whole).toBeNull()
    expect(VARIETY_BASIS_LABEL.allocated).toBe('allocated')
    expect(VARIETY_BASIS_LABEL.acre_share).toBe('acre-share est.')
  })
})

describe('variety row ↔ drill-down conservation', () => {
  it('one variety across whole + allocated + acre-share plantings sums exactly', () => {
    // The same rollup the page runs: attribute each planting, sum variety "A".
    const all = [
      // Single-variety field: 1,000 bu whole.
      ...attributeVarietyBushels({
        planting: planting('w', 100),
        varieties: [{ variety: 'A', acres: 100, bushels: null }],
        dryBu: 1000,
      }),
      // Allocated multi-variety field: A gets 500 of 2,000.
      ...attributeVarietyBushels({
        planting: planting('al', 200),
        varieties: [
          { variety: 'A', acres: 50, bushels: 500 },
          { variety: 'B', acres: 150, bushels: 1500 },
        ],
        dryBu: 2000,
      }),
      // Unallocated multi-variety field: A gets 100/150 of 6,000 = 4,000 est.
      ...attributeVarietyBushels({
        planting: planting('as', 150),
        varieties: [
          { variety: 'A', acres: 100, bushels: null },
          { variety: 'B', acres: 50, bushels: null },
        ],
        dryBu: 6000,
      }),
    ]
    const aParts = all.filter((p) => p.variety === 'A')
    const rowDryBu = aParts.reduce((s, p) => s + p.dryBu, 0)
    const rowAcres = aParts.reduce((s, p) => s + p.varietyAcres, 0)
    expect(rowDryBu).toBeCloseTo(1000 + 500 + 4000, 10)
    expect(rowAcres).toBeCloseTo(100 + 50 + 100, 10)
    // The drill-down summary is built from the SAME parts → identical total.
    const summary = summarizeVarietyDetail(aParts.map((part) => ({
      part,
      fieldSummary: summarizeDetail([]),
      loads: [],
    })))
    expect(summary.dryBu).toBeCloseTo(rowDryBu, 10)
    expect(summary.varietyAcres).toBeCloseTo(rowAcres, 10)
    expect(summary.yieldPerAcre).toBeCloseTo(rowDryBu / rowAcres, 10)
  })
})

// ---------------------------------------------------------------------------
// Variety-level weighted stats: multi-variety fields weigh in at the
// variety's SHARE of the field's production (the grain is commingled).
// ---------------------------------------------------------------------------

function mkLoad(over: Partial<YieldDetailLoad> & Pick<YieldDetailLoad, 'loadId' | 'netLbs' | 'moisture' | 'dryBu'>): YieldDetailLoad {
  return {
    fieldId: 'f', cropId: 'soy', date: '2026-10-01', ticket: null,
    truckId: null, truckLabel: null, haulerTruck: null,
    testWeight: null, wetBu: null, destination: 'bin', destinationId: 'b1', split: null,
    ...over,
  }
}

describe('summarizeVarietyDetail weighted stats', () => {
  it('share-weights moisture: (30k@16 + 50k@18) whole + 40k@20 at a 25% share → 17.5556', () => {
    // Field A: single-variety (share 1), production 1,000 bu.
    const aLoads = [
      mkLoad({ loadId: 'a1', netLbs: 30000, moisture: 16, dryBu: 400, date: '2026-09-20' }),
      mkLoad({ loadId: 'a2', netLbs: 50000, moisture: 18, dryBu: 600, date: '2026-09-25', destination: 'buyer', destinationId: 'buy1' }),
    ]
    const aSummary = summarizeDetail(aLoads)
    const aPart: VarietyPlantingPart = {
      plantingId: 'pa', fieldId: 'fa', cropId: 'soy', seasonYear: 2026,
      variety: 'A', varietyAcres: 100, dryBu: aSummary.fieldProductionDryBu, basis: 'whole',
    }
    expect(varietyShareOfField(aPart, aSummary)).toBe(1)

    // Field B: allocated multi-variety — this variety holds 500 of 2,000 bu.
    const bLoads = [mkLoad({ loadId: 'b1', netLbs: 40000, moisture: 20, dryBu: 2000, date: '2026-10-05' })]
    const bSummary = summarizeDetail(bLoads)
    const bPart: VarietyPlantingPart = {
      plantingId: 'pb', fieldId: 'fb', cropId: 'soy', seasonYear: 2026,
      variety: 'A', varietyAcres: 40, dryBu: 500, basis: 'allocated',
    }
    expect(varietyShareOfField(bPart, bSummary)).toBeCloseTo(0.25, 10)

    const s = summarizeVarietyDetail([
      { part: aPart, fieldSummary: aSummary, loads: aLoads },
      { part: bPart, fieldSummary: bSummary, loads: bLoads },
    ])
    // Weighted moisture = (30,000×16 + 50,000×18 + 40,000×0.25×20)
    //                   ÷ (30,000 + 50,000 + 10,000) = 1,580,000 / 90,000
    expect(s.weightedMoisture).toBeCloseTo(1580000 / 90000, 10)
    // Row total = 1,000 (whole) + 500 (allocated slice).
    expect(s.dryBu).toBeCloseTo(1500, 10)
    // Physical loads involved, unscaled.
    expect(s.loadCount).toBe(3)
    // Harvest window spans both fields' loads.
    expect(s.firstLoadDate).toBe('2026-09-20')
    expect(s.lastLoadDate).toBe('2026-10-05')
    // Destination mix at share weights: bins 400 + 2,000×0.25 = 900 of 1,500.
    expect(s.toBinsPct).toBeCloseTo((900 / 1500) * 100, 10)
    expect(s.toBuyersPct).toBeCloseTo((600 / 1500) * 100, 10)
  })
})
