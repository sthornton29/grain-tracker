import { describe, it, expect } from 'vitest'
import {
  fieldCropAggregates,
  analyzeYields,
  IN_PROGRESS_THRESHOLD,
  IN_PROGRESS_STALE_DAYS,
  type YieldInput,
} from '@/lib/yields'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

type LoadLike = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
}

type SplitLike = {
  load_id: string
  field_id: string
  crop_id: string
  dry_bushels: number | null
}

type CropLike = {
  id: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}

// A field load. By default we pin the dry bushels with dry_bushels_override so
// the aggregate math is exact and independent of the shrink formula (which has
// its own test). Pass net_weight/moisture explicitly to exercise computeBushels.
function load(over: Partial<LoadLike> & { id: string; date: string }): LoadLike {
  return {
    net_weight: null,
    moisture: null,
    crop_id: 'corn',
    dry_bushels_override: null,
    crop_year: 2025,
    from_type: 'field',
    from_field_id: 'fA',
    ...over,
  }
}

// Crop with 56 lb/bu and 15.0% base moisture (corn) so net 56000 lb → 1000 wet bu.
const cropById = new Map<string, CropLike>([
  ['corn', { id: 'corn', base_moisture_pct: 15, base_lb_per_bushel: 56 }],
  ['beans', { id: 'beans', base_moisture_pct: 13, base_lb_per_bushel: 60 }],
])

// ---------------------------------------------------------------------------
// fieldCropAggregates
// ---------------------------------------------------------------------------

describe('fieldCropAggregates', () => {
  it('sums single-field loads per (field|crop|year) and tracks the max date', () => {
    // Two field loads on fA/corn/2025 via override (1000 + 250 = 1250 dry bu),
    // newest date 2025-09-15. One field load on fB/corn/2025 (500 dry bu).
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', from_field_id: 'fA', dry_bushels_override: 1000 }),
      load({ id: 'l2', date: '2025-09-15', from_field_id: 'fA', dry_bushels_override: 250 }),
      load({ id: 'l3', date: '2025-09-12', from_field_id: 'fB', dry_bushels_override: 500 }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById)

    expect(agg.get('fA|corn|2025')).toEqual({ dryBu: 1250, lastLoadDate: '2025-09-15' })
    expect(agg.get('fB|corn|2025')).toEqual({ dryBu: 500, lastLoadDate: '2025-09-12' })
    expect(agg.size).toBe(2)
  })

  it('computes dry bushels via the shrink formula when no override is set', () => {
    // net 56000 / 56 lb/bu = 1000 wet bu. moisture null → dry = wet = 1000.
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', from_field_id: 'fA', net_weight: 56000, moisture: null }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById)
    expect(agg.get('fA|corn|2025')?.dryBu).toBeCloseTo(1000, 6)
  })

  it('adds load_splits.dry_bushels keyed by the split field/crop and the parent date year', () => {
    // One parent load (no from_field_id contribution since from_type is not a
    // single field aggregation here — it carries the date/crop_year). The split
    // routes 800 dry bu to fC/corn and 300 to fD/beans, parent dated 2025-09-20.
    const loads: LoadLike[] = [
      {
        id: 'p1',
        date: '2025-09-20',
        net_weight: null,
        moisture: null,
        crop_id: null,
        dry_bushels_override: null,
        crop_year: 2025,
        from_type: 'field',
        from_field_id: null, // no single-field contribution; split-only
      },
    ]
    const splits: SplitLike[] = [
      { load_id: 'p1', field_id: 'fC', crop_id: 'corn', dry_bushels: 800 },
      { load_id: 'p1', field_id: 'fD', crop_id: 'beans', dry_bushels: 300 },
      { load_id: 'p1', field_id: 'fE', crop_id: 'corn', dry_bushels: null }, // ignored (null)
    ]
    const agg = fieldCropAggregates(loads, splits, cropById)

    expect(agg.get('fC|corn|2025')).toEqual({ dryBu: 800, lastLoadDate: '2025-09-20' })
    expect(agg.get('fD|beans|2025')).toEqual({ dryBu: 300, lastLoadDate: '2025-09-20' })
    expect(agg.get('fE|corn|2025')).toBeUndefined()
    expect(agg.size).toBe(2)
  })

  it('combines a single-field load and a split into the same key (sum + max date)', () => {
    // fA/corn/2025: field load 1000 dry bu on 2025-09-10, plus a split of 200
    // dry bu whose parent is dated 2025-09-22 → 1200 dry bu, lastLoadDate is the
    // newer split parent date.
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', from_field_id: 'fA', dry_bushels_override: 1000 }),
      // split parent (also dated, used only for the split routing below)
      {
        id: 'p1', date: '2025-09-22', net_weight: null, moisture: null, crop_id: null,
        dry_bushels_override: null, crop_year: 2025, from_type: 'field', from_field_id: null,
      },
    ]
    const splits: SplitLike[] = [
      { load_id: 'p1', field_id: 'fA', crop_id: 'corn', dry_bushels: 200 },
    ]
    const agg = fieldCropAggregates(loads, splits, cropById)
    expect(agg.get('fA|corn|2025')).toEqual({ dryBu: 1200, lastLoadDate: '2025-09-22' })
  })

  it('skips non-field loads, and loads missing from_field_id or crop_id', () => {
    const loads: LoadLike[] = [
      load({ id: 'b1', date: '2025-09-10', from_type: 'bin', dry_bushels_override: 999 }),
      load({ id: 'nf', date: '2025-09-10', from_field_id: null, dry_bushels_override: 999 }),
      load({ id: 'nc', date: '2025-09-10', crop_id: null, dry_bushels_override: 999 }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById)
    expect(agg.size).toBe(0)
  })

  it('skips loads whose computed dry bushels are zero/falsy', () => {
    // override 0 → falsy → skipped (the `if (!dryBushels) continue` guard).
    const loads: LoadLike[] = [
      load({ id: 'z1', date: '2025-09-10', dry_bushels_override: 0 }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById)
    expect(agg.size).toBe(0)
  })

  it('filters by crop_year (loads.crop_year), for both single-field loads and splits', () => {
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', from_field_id: 'fA', dry_bushels_override: 1000, crop_year: 2025 }),
      load({ id: 'l2', date: '2024-09-10', from_field_id: 'fA', dry_bushels_override: 700, crop_year: 2024 }),
      // split parent in crop_year 2024 → excluded when filtering to 2025
      {
        id: 'p24', date: '2024-09-15', net_weight: null, moisture: null, crop_id: null,
        dry_bushels_override: null, crop_year: 2024, from_type: 'field', from_field_id: null,
      },
    ]
    const splits: SplitLike[] = [
      { load_id: 'p24', field_id: 'fA', crop_id: 'corn', dry_bushels: 400 },
    ]
    const agg = fieldCropAggregates(loads, splits, cropById, { cropYear: 2025 })
    // Only l1 survives (crop_year 2025). l2 (2024) and the 2024 split are dropped.
    expect(agg.get('fA|corn|2025')).toEqual({ dryBu: 1000, lastLoadDate: '2025-09-10' })
    expect(agg.size).toBe(1)
  })

  it('filters by loadYear (year parsed from the date), independent of crop_year', () => {
    // Same crop_year on both loads, but different calendar dates. loadYear 2025
    // keeps only the 2025-dated load.
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', from_field_id: 'fA', dry_bushels_override: 1000, crop_year: 2025 }),
      load({ id: 'l2', date: '2026-01-05', from_field_id: 'fA', dry_bushels_override: 700, crop_year: 2025 }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById, { loadYear: 2025 })
    // The 2026-dated load is keyed under fA|corn|2026 too, but loadYear filters it out.
    expect(agg.get('fA|corn|2025')).toEqual({ dryBu: 1000, lastLoadDate: '2025-09-10' })
    expect(agg.size).toBe(1)
  })

  it('keys split bushels by the PARENT load date year, not the split itself', () => {
    // Parent dated 2026 but crop_year 2025. With loadYear 2026 the split lands
    // under year 2026; with loadYear 2025 it is filtered out.
    const loads: LoadLike[] = [
      {
        id: 'p1', date: '2026-01-03', net_weight: null, moisture: null, crop_id: null,
        dry_bushels_override: null, crop_year: 2025, from_type: 'field', from_field_id: null,
      },
    ]
    const splits: SplitLike[] = [
      { load_id: 'p1', field_id: 'fA', crop_id: 'corn', dry_bushels: 500 },
    ]
    expect(fieldCropAggregates(loads, splits, cropById, { loadYear: 2026 }).get('fA|corn|2026'))
      .toEqual({ dryBu: 500, lastLoadDate: '2026-01-03' })
    expect(fieldCropAggregates(loads, splits, cropById, { loadYear: 2025 }).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// analyzeYields — always pass an explicit `now` for determinism.
// ---------------------------------------------------------------------------

// Fixed reference "now" for the deterministic tests.
const NOW = new Date('2025-09-20T12:00:00Z')

function row(over: Partial<YieldInput> & { id: string }): YieldInput {
  return {
    cropId: 'corn',
    acres: 100,
    dryBu: 0,
    lastLoadDate: null,
    override: null,
    ...over,
  }
}

describe('analyzeYields — exported constants', () => {
  it('matches the documented thresholds', () => {
    expect(IN_PROGRESS_THRESHOLD).toBe(0.15)
    expect(IN_PROGRESS_STALE_DAYS).toBe(5)
  })
})

describe('analyzeYields — unharvested', () => {
  it('excludes a row with 0 dry bushels as unharvested', () => {
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-10' }),
      row({ id: 'b', acres: 50, dryBu: 0, lastLoadDate: null }), // unharvested
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    expect(res.excluded.get('b')).toBe('unharvested')
    expect(res.autoExcluded.get('b')).toBe('unharvested')
    expect(res.excluded.has('a')).toBe(false)

    // Average over survivors = only field a: 18000 / 100 = 180.
    expect(res.averages.get('corn')?.acres).toBe(100)
    expect(res.averages.get('corn')?.dryBu).toBe(18000)
    expect(res.averages.get('corn')?.yield).toBeCloseTo(180, 6)

    // Progress: a completed (100 ac), b remaining (50 ac), none in-progress.
    const p = res.progress.get('corn')!
    expect(p.completedAcres).toBe(100)
    expect(p.inProgressAcres).toBe(0)
    expect(p.remainingAcres).toBe(50)
    expect(p.totalAcres).toBe(150)
    expect(p.pctComplete).toBeCloseTo((100 / 150) * 100, 6) // 66.666...
  })
})

describe('analyzeYields — in-progress detection', () => {
  // Two established fields plus a freshly-started low one.
  //   a: 100 ac, 20000 bu → 200 bu/ac   (latest-but-not: dated 2025-09-10)
  //   b: 100 ac, 18000 bu → 180 bu/ac   (dated 2025-09-12)
  //   c: 100 ac,  5000 bu →  50 bu/ac   (LATEST load 2025-09-18 — candidate)
  // baseline = OTHER harvested fields (a+b) = (20000+18000)/(100+100) = 190 bu/ac.
  // threshold cutoff = 190 * (1 - 0.15) = 161.5. candYield 50 < 161.5 → low.
  // days since last load = 2025-09-20 - 2025-09-18 = 2 days ≤ 5 → in_progress.
  const base = [
    row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-10' }),
    row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-12' }),
  ]

  it('flags the latest low field as in_progress and drops it from the average', () => {
    const rows = [...base, row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-18' })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    expect(res.autoExcluded.get('c')).toBe('in_progress')
    expect(res.excluded.get('c')).toBe('in_progress')

    // Average over survivors a+b = (20000+18000)/(100+100) = 38000/200 = 190.
    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
    expect(res.averages.get('corn')?.acres).toBe(200)
    expect(res.averages.get('corn')?.dryBu).toBe(38000)

    // Progress: a+b completed = 200 ac, c in-progress = 100 ac, remaining 0.
    const p = res.progress.get('corn')!
    expect(p.completedAcres).toBe(200)
    expect(p.inProgressAcres).toBe(100)
    expect(p.remainingAcres).toBe(0)
    expect(p.totalAcres).toBe(300)
    expect(p.pctComplete).toBeCloseTo((200 / 300) * 100, 6)
  })

  it('does NOT flag the latest field when its yield is within the threshold band', () => {
    // c at 170 bu/ac (17000/100). baseline 190, cutoff 161.5. 170 >= 161.5 → counts.
    const rows = [...base, row({ id: 'c', acres: 100, dryBu: 17000, lastLoadDate: '2025-09-18' })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    expect(res.autoExcluded.has('c')).toBe(false)
    expect(res.excluded.has('c')).toBe(false)
    // Average over all three = (20000+18000+17000)/300 = 55000/300 = 183.333...
    expect(res.averages.get('corn')?.yield).toBeCloseTo(55000 / 300, 6)
  })

  it('only the LATEST field is a candidate (an older low field is not flagged)', () => {
    // Make the low field the OLDEST instead of the latest. Now the latest field
    // (b, dated 2025-09-19) has a high yield, so nothing is flagged.
    //   low:  50 bu/ac, dated 2025-09-05 (oldest, not the candidate)
    //   a:   200 bu/ac, dated 2025-09-10
    //   b:   180 bu/ac, dated 2025-09-19 (latest → candidate). baseline of a+low
    //        = (20000+5000)/(200) = 125; cutoff 125*0.85 = 106.25; 180 >= → ok.
    const rows = [
      row({ id: 'low', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-05' }),
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-10' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.size).toBe(0)
    expect(res.excluded.size).toBe(0)
    // Average over all = (5000+20000+18000)/300 = 43000/300 = 143.333...
    expect(res.averages.get('corn')?.yield).toBeCloseTo(43000 / 300, 6)
  })
})

describe('analyzeYields — stale window', () => {
  // Same low latest field as the in-progress test, but the last load is well
  // older than IN_PROGRESS_STALE_DAYS, so it has clearly finished → completed.
  const base = [
    row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-10' }),
    row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-12' }),
  ]

  it('a low latest field whose last load is older than the stale window is NOT in-progress', () => {
    // c dated 2025-09-13 → now (2025-09-20) is 7 days > 5 → finished, counts.
    const rows = [...base, row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-13' })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    expect(res.autoExcluded.has('c')).toBe(false)
    expect(res.excluded.has('c')).toBe(false)
    // All three count: (20000+18000+5000)/300 = 43000/300 = 143.333...
    expect(res.averages.get('corn')?.yield).toBeCloseTo(43000 / 300, 6)
    const p = res.progress.get('corn')!
    expect(p.completedAcres).toBe(300)
    expect(p.inProgressAcres).toBe(0)
  })

  it('the boundary: exactly IN_PROGRESS_STALE_DAYS old is still in-progress (days <= window)', () => {
    // c dated 2025-09-15T12:00:00Z → exactly 5.0 days before NOW. days <= 5 → in_progress.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-10' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-12' }),
      row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-15T12:00:00Z' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.get('c')).toBe('in_progress')
  })
})

describe('analyzeYields — override', () => {
  it('override === true un-excludes an in-progress field (counts it)', () => {
    // Same setup as the in-progress test, but c is overridden to count anyway.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-10' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-12' }),
      row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-18', override: true }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    // The auto classification still flags it...
    expect(res.autoExcluded.get('c')).toBe('in_progress')
    // ...but the effective exclusion does not (overridden to count).
    expect(res.excluded.has('c')).toBe(false)

    // Average now includes c: (20000+18000+5000)/300 = 43000/300 = 143.333...
    expect(res.averages.get('corn')?.acres).toBe(300)
    expect(res.averages.get('corn')?.dryBu).toBe(43000)
    expect(res.averages.get('corn')?.yield).toBeCloseTo(43000 / 300, 6)

    // Progress: the override moves c into completed.
    const p = res.progress.get('corn')!
    expect(p.completedAcres).toBe(300)
    expect(p.inProgressAcres).toBe(0)
    expect(p.pctComplete).toBeCloseTo(100, 6)
  })

  it('override does NOT un-exclude an unharvested (0-bu) field', () => {
    // override only applies to in_progress; an unharvested field has no bushels.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-10' }),
      row({ id: 'b', acres: 50, dryBu: 0, lastLoadDate: null, override: true }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('b')).toBe('unharvested')
    // Average is still just field a.
    expect(res.averages.get('corn')?.acres).toBe(100)
    expect(res.averages.get('corn')?.yield).toBeCloseTo(180, 6)
  })
})

describe('analyzeYields — needs >= 2 harvested fields', () => {
  it('a single harvested field is never flagged in-progress (no baseline)', () => {
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 100, lastLoadDate: '2025-09-19' }), // tiny yield, but alone
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.size).toBe(0)
    expect(res.excluded.size).toBe(0)
    // Average = 100/100 = 1.
    expect(res.averages.get('corn')?.yield).toBeCloseTo(1, 6)
    const p = res.progress.get('corn')!
    expect(p.completedAcres).toBe(100)
    expect(p.totalAcres).toBe(100)
    expect(p.pctComplete).toBeCloseTo(100, 6)
  })

  it('a single harvested field with an unharvested sibling still has no baseline', () => {
    // Only one field has bushels → harvested.length === 1 → no in-progress check.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 100, lastLoadDate: '2025-09-19' }),
      row({ id: 'b', acres: 100, dryBu: 0, lastLoadDate: null }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.get('a')).toBeUndefined()
    expect(res.autoExcluded.get('b')).toBe('unharvested')
    expect(res.excluded.get('a')).toBeUndefined()
  })
})

describe('analyzeYields — weighted average over survivors', () => {
  it('is Σ dryBu / Σ acres across the included rows, weighting by acres', () => {
    // Different acreages so a simple mean of yields would differ from the
    // acre-weighted mean. a: 50 ac @ 200 (10000 bu). b: 150 ac @ 100 (15000 bu).
    // Weighted = 25000 / 200 = 125 (a naive average of 200 & 100 would be 150).
    // Both dated recently and within threshold of each other's baselines so
    // neither is flagged: candidate is b (latest). baseline = a only = 200,
    // cutoff 170; b yield 100 < 170 → b WOULD flag if recent. Keep b's load old
    // so it is not flagged, isolating the average math.
    const rows = [
      row({ id: 'a', acres: 50, dryBu: 10000, lastLoadDate: '2025-09-01' }),
      row({ id: 'b', acres: 150, dryBu: 15000, lastLoadDate: '2025-09-02' }), // 18 days old → not in-progress
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.size).toBe(0)
    const avg = res.averages.get('corn')!
    expect(avg.acres).toBe(200)
    expect(avg.dryBu).toBe(25000)
    expect(avg.yield).toBeCloseTo(125, 6)
  })
})

describe('analyzeYields — multiple crops handled independently', () => {
  it('classifies and averages each crop separately', () => {
    const rows = [
      // corn: two normal fields, weighted avg (20000+18000)/200 = 190.
      row({ id: 'c1', cropId: 'corn', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-10' }),
      row({ id: 'c2', cropId: 'corn', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-12' }),
      // beans: one harvested (60 bu/ac), one unharvested.
      row({ id: 'b1', cropId: 'beans', acres: 100, dryBu: 6000, lastLoadDate: '2025-09-11' }),
      row({ id: 'b2', cropId: 'beans', acres: 100, dryBu: 0, lastLoadDate: null }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
    expect(res.averages.get('beans')?.yield).toBeCloseTo(60, 6)
    expect(res.excluded.get('b2')).toBe('unharvested')

    const cp = res.progress.get('corn')!
    expect(cp.totalAcres).toBe(200)
    expect(cp.pctComplete).toBeCloseTo(100, 6)

    const bp = res.progress.get('beans')!
    expect(bp.completedAcres).toBe(100)
    expect(bp.remainingAcres).toBe(100)
    expect(bp.pctComplete).toBeCloseTo(50, 6)
  })
})
