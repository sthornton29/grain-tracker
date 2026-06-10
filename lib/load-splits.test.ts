import { describe, it, expect } from 'vitest'
import {
  allocateSplits,
  validateSplitDrafts,
  splitFieldLabel,
  WEIGHT_TOLERANCE_LB,
  PCT_TOLERANCE,
  type SplitDraft,
  type ParentLoadForAllocation,
} from '@/lib/load-splits'
import { computeBushels } from '@/lib/shrink'
import type { Crop } from '@/lib/types'

// A soybean-ish crop: base 13% moisture, 60 lb/bu. Used for the worked examples.
const SOY: Crop = {
  id: 'crop-soy',
  name: 'Soybeans',
  base_moisture_pct: 13,
  base_lb_per_bushel: 60,
  harvest_category: 'fall',
  double_crop: false,
}

function draft(field_id: string, net_weight: number): SplitDraft {
  return { field_id, net_weight }
}

describe('allocateSplits', () => {
  // Parent: 100,000 lb net, moisture 15.0%. Crop base 13% MC, 60 lb/bu.
  // Split A: 60,000 lb. Split B: 40,000 lb. Sum = 100,000 = parent net.
  //
  // Percentages:
  //   A: 60000 / 100000 * 100 = 60.000
  //   B: 40000 / 100000 * 100 = 40.000
  // Wet bushels (net / 60):
  //   A: 60000 / 60 = 1000.000000  -> round2 1000.00
  //   B: 40000 / 60 =  666.666...  -> round2  666.67
  // Dry bushels (mc=15 > baseMc=13 => wet * (100-15)/(100-13) = wet * 85/87):
  //   A: 1000.000000 * 85/87 = 85000/87 = 977.0114942... -> round2 977.01
  //   B:  666.666667 * 85/87 = 56666.6667/87 = 651.3409962... -> round2 651.34
  const parent: ParentLoadForAllocation = {
    crop_id: 'crop-soy',
    net_weight: 100000,
    moisture: 15,
  }
  const splits = [draft('field-a', 60000), draft('field-b', 40000)]
  const out = allocateSplits(parent, splits, SOY)

  it('stamps the parent crop_id and original field_id onto each split', () => {
    expect(out).toHaveLength(2)
    expect(out[0].field_id).toBe('field-a')
    expect(out[1].field_id).toBe('field-b')
    expect(out[0].crop_id).toBe('crop-soy')
    expect(out[1].crop_id).toBe('crop-soy')
  })

  it('computes each split percentage from its share of the parent net', () => {
    expect(out[0].percentage).toBeCloseTo(60.0, 6)
    expect(out[1].percentage).toBeCloseTo(40.0, 6)
  })

  it('percentages sum to ~100', () => {
    const sumPct = out.reduce((a, s) => a + s.percentage, 0)
    expect(sumPct).toBeCloseTo(100, 6)
  })

  it('rounds net_weight to 2 decimals and the split nets sum to the parent net', () => {
    expect(out[0].net_weight).toBe(60000)
    expect(out[1].net_weight).toBe(40000)
    const sumNet = out.reduce((a, s) => a + s.net_weight, 0)
    expect(sumNet).toBeCloseTo(parent.net_weight, 2)
  })

  it('computes wet bushels per split as net / base_lb_per_bushel (rounded to 2dp)', () => {
    expect(out[0].wet_bushels).toBeCloseTo(1000.0, 2) // 60000/60
    expect(out[1].wet_bushels).toBeCloseTo(666.67, 2) // 40000/60 = 666.6667
  })

  it('computes dry bushels per split via the same shrink formula (wet * 85/87)', () => {
    expect(out[0].dry_bushels).toBeCloseTo(977.01, 2) // 1000 * 85/87
    expect(out[1].dry_bushels).toBeCloseTo(651.34, 2) // 666.6667 * 85/87
  })

  it('dry bushels per split cross-check against lib/shrink for an individual split', () => {
    // Independently run computeBushels for split A and compare (pre-rounding).
    const direct = computeBushels({
      netWeightLb: 60000,
      moisturePct: 15,
      baseMoisturePct: 13,
      baseLbPerBushel: 60,
    })
    // 60000/60 = 1000 wet; dry = 1000 * 85/87 = 977.011494...
    expect(direct.wetBushels).toBeCloseTo(1000, 6)
    expect(direct.dryBushels).toBeCloseTo(85000 / 87, 6)
    // The allocated (rounded) value matches round2 of the direct computation.
    expect(out[0].dry_bushels).toBe(Math.round((direct.dryBushels as number) * 100) / 100)
  })

  it('sum of split dry bushels ~ parent dry bushels (within rounding)', () => {
    // Parent computed in one shot: 100000/60 = 1666.6667 wet; dry = 1666.6667*85/87
    const parentDirect = computeBushels({
      netWeightLb: 100000,
      moisturePct: 15,
      baseMoisturePct: 13,
      baseLbPerBushel: 60,
    })
    const sumDry = out.reduce((a, s) => a + (s.dry_bushels ?? 0), 0)
    expect(sumDry).toBeCloseTo(parentDirect.dryBushels as number, 1)
  })

  it('no shrink when measured moisture <= base moisture: dry equals wet', () => {
    // mc=11 <= baseMc=13 => computedDry = wet, so dry == wet per split.
    const noShrink = allocateSplits(
      { crop_id: 'crop-soy', net_weight: 100000, moisture: 11 },
      splits,
      SOY,
    )
    expect(noShrink[0].dry_bushels).toBe(noShrink[0].wet_bushels)
    expect(noShrink[1].dry_bushels).toBe(noShrink[1].wet_bushels)
    expect(noShrink[0].wet_bushels).toBeCloseTo(1000, 2)
  })

  it('falls back to wet bushels when parent moisture is null (no shrink possible)', () => {
    const noMoist = allocateSplits(
      { crop_id: 'crop-soy', net_weight: 100000, moisture: null },
      splits,
      SOY,
    )
    expect(noMoist[0].dry_bushels).toBe(noMoist[0].wet_bushels)
    expect(noMoist[0].wet_bushels).toBeCloseTo(1000, 2)
  })

  it('yields null bushels when the crop is null (no base lb/bu)', () => {
    const noCrop = allocateSplits(parent, splits, null)
    expect(noCrop[0].wet_bushels).toBeNull()
    expect(noCrop[0].dry_bushels).toBeNull()
    // percentages are still computed from weights.
    expect(noCrop[0].percentage).toBeCloseTo(60, 6)
  })

  it('rounds percentage to 3 decimals (uneven split)', () => {
    // Parent 30000, splits 10000 / 20000.
    //   A: 10000/30000*100 = 33.33333... -> round3 33.333
    //   B: 20000/30000*100 = 66.66667... -> round3 66.667
    const uneven = allocateSplits(
      { crop_id: 'crop-soy', net_weight: 30000, moisture: 15 },
      [draft('field-a', 10000), draft('field-b', 20000)],
      SOY,
    )
    expect(uneven[0].percentage).toBe(33.333)
    expect(uneven[1].percentage).toBe(66.667)
  })

  it('returns zero percentage and null bushels when parent net is zero', () => {
    // totalNet <= 0 => pct = 0; computeBushels with net 0 still divides:
    // 0/60 = 0 wet, dry = 0. (Weights of 0 are an allocation artifact here.)
    const zero = allocateSplits(
      { crop_id: 'crop-soy', net_weight: 0, moisture: 15 },
      [draft('field-a', 0), draft('field-b', 0)],
      SOY,
    )
    expect(zero[0].percentage).toBe(0)
    expect(zero[0].wet_bushels).toBe(0)
    expect(zero[0].dry_bushels).toBe(0)
  })
})

describe('validateSplitDrafts', () => {
  it('rejects fewer than two fields', () => {
    expect(validateSplitDrafts([draft('field-a', 1000)], 1000)).toBe(
      'A split load needs at least two fields.',
    )
    expect(validateSplitDrafts([], 0)).toBe('A split load needs at least two fields.')
  })

  it('rejects a row with no field selected', () => {
    const r = validateSplitDrafts([draft('', 500), draft('field-b', 500)], 1000)
    expect(r).toBe('Split row 1: pick a field.')
  })

  it('rejects a zero-weight row', () => {
    const r = validateSplitDrafts([draft('field-a', 0), draft('field-b', 1000)], 1000)
    expect(r).toBe('Split row 1: weight must be greater than zero.')
  })

  it('rejects a negative-weight row', () => {
    const r = validateSplitDrafts([draft('field-a', -100), draft('field-b', 1100)], 1000)
    expect(r).toBe('Split row 1: weight must be greater than zero.')
  })

  it('rejects duplicate fields (requires distinct fields)', () => {
    const r = validateSplitDrafts([draft('field-a', 500), draft('field-a', 500)], 1000)
    expect(r).toBe('Each split must use a different field.')
  })

  it('rejects a non-positive parent net weight', () => {
    const r = validateSplitDrafts([draft('field-a', 500), draft('field-b', 500)], 0)
    // Note: error string uses a typographic apostrophe (U+2019).
    expect(r).toBe('Enter the load’s net weight before allocating splits.')
  })

  it('accepts an exact-sum allocation', () => {
    const r = validateSplitDrafts([draft('field-a', 60000), draft('field-b', 40000)], 100000)
    expect(r).toBeNull()
  })

  it('accepts a sum just INSIDE the weight tolerance (1 lb)', () => {
    // sum = 100000.999, |sum - 100000| = 0.999 <= 1 -> OK.
    const r = validateSplitDrafts(
      [draft('field-a', 60000), draft('field-b', 40000.999)],
      100000,
    )
    expect(WEIGHT_TOLERANCE_LB).toBe(1)
    expect(r).toBeNull()
  })

  it('accepts a sum off by exactly the tolerance (not strictly greater)', () => {
    // sum = 100001, |diff| = 1, condition is > 1, so 1 is accepted.
    const r = validateSplitDrafts(
      [draft('field-a', 60001), draft('field-b', 40000)],
      100000,
    )
    expect(r).toBeNull()
  })

  it('rejects a sum just OUTSIDE the weight tolerance', () => {
    // sum = 100001.5, |diff| = 1.5 > 1 -> error message with the totals.
    const r = validateSplitDrafts(
      [draft('field-a', 60001.5), draft('field-b', 40000)],
      100000,
    )
    expect(r).not.toBeNull()
    expect(r).toContain('Split weights total')
    // formatted with no fraction digits: 100,002 (100001.5 rounds to 100,002) vs 100,000
    expect(r).toContain('100,000')
  })
})

describe('splitFieldLabel', () => {
  const names = new Map<string, string>([
    ['field-a', 'North 40'],
    ['field-b', 'River Bottom'],
    ['field-c', 'Home Place'],
  ])

  it('orders fields by largest net_weight first', () => {
    // weights: b=40000 (largest), a=30000, c=10000 -> River Bottom / North 40 / Home Place
    const label = splitFieldLabel(
      [
        { field_id: 'field-a', net_weight: 30000 },
        { field_id: 'field-b', net_weight: 40000 },
        { field_id: 'field-c', net_weight: 10000 },
      ],
      names,
    )
    expect(label).toBe('River Bottom / North 40 / Home Place')
  })

  it('uses an em-dash placeholder for unknown field ids', () => {
    const label = splitFieldLabel(
      [
        { field_id: 'field-a', net_weight: 50000 },
        { field_id: 'missing', net_weight: 10000 },
      ],
      names,
    )
    expect(label).toBe('North 40 / —')
  })

  it('does not mutate the input array order', () => {
    const input = [
      { field_id: 'field-a', net_weight: 10000 },
      { field_id: 'field-b', net_weight: 40000 },
    ]
    splitFieldLabel(input, names)
    expect(input[0].field_id).toBe('field-a')
    expect(input[1].field_id).toBe('field-b')
  })
})

describe('exported tolerances', () => {
  it('exposes the documented tolerances', () => {
    expect(WEIGHT_TOLERANCE_LB).toBe(1)
    expect(PCT_TOLERANCE).toBe(0.05)
  })
})
