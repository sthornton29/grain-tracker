import { describe, it, expect } from 'vitest'
import {
  fieldCropAggregates,
  analyzeYields,
  harvestStatusOf,
  isHarvestComplete,
  cropsWithCompleteHarvest,
  expectedYieldForPlanting,
  inProgressPlantingsByCrop,
  groupYieldAggregates,
  practiceOf,
  resolvePracticeBreakout,
  withLoadBreakouts,
  IN_PROGRESS_THRESHOLD,
  IN_PROGRESS_STALE_DAYS,
  type YieldInput,
  type ExclusionReason,
  type FieldCropAgg,
  type GroupYieldPlanting,
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
  practice?: 'irrigated' | 'dryland' | null
}

type SplitLike = {
  load_id: string
  field_id: string
  crop_id: string
  dry_bushels: number | null
  practice?: 'irrigated' | 'dryland' | null
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

    expect(agg.get('fA|corn|2025')).toMatchObject({ dryBu: 1250, lastLoadDate: '2025-09-15' })
    expect(agg.get('fB|corn|2025')).toMatchObject({ dryBu: 500, lastLoadDate: '2025-09-12' })
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

    expect(agg.get('fC|corn|2025')).toMatchObject({ dryBu: 800, lastLoadDate: '2025-09-20' })
    expect(agg.get('fD|beans|2025')).toMatchObject({ dryBu: 300, lastLoadDate: '2025-09-20' })
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
    expect(agg.get('fA|corn|2025')).toMatchObject({ dryBu: 1200, lastLoadDate: '2025-09-22' })
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
    expect(agg.get('fA|corn|2025')).toMatchObject({ dryBu: 1000, lastLoadDate: '2025-09-10' })
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
    expect(agg.get('fA|corn|2025')).toMatchObject({ dryBu: 1000, lastLoadDate: '2025-09-10' })
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
      .toMatchObject({ dryBu: 500, lastLoadDate: '2026-01-03' })
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
    // Deliberately long: brief gaps while working other fields must not
    // complete a low field — the operator commonly comes back to finish it.
    expect(IN_PROGRESS_STALE_DAYS).toBe(10)
  })
})

describe('analyzeYields — unharvested', () => {
  it('excludes a row with 0 dry bushels as unharvested', () => {
    // a's last load is two weeks old (crop quiet → a is not the active field).
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-05' }),
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
  // Two settled fields (quiet past the 10-day window) plus a freshly-started
  // low one.
  //   a: 100 ac, 20000 bu → 200 bu/ac   (dated 2025-09-05 — settled)
  //   b: 100 ac, 18000 bu → 180 bu/ac   (dated 2025-09-06 — settled)
  //   c: 100 ac,  5000 bu →  50 bu/ac   (latest load 2025-09-18 — active)
  // baseline = settled a+b = (20000+18000)/(100+100) = 190 bu/ac.
  // threshold cutoff = 190 * (1 - 0.15) = 161.5. candYield 50 < 161.5 → low.
  const base = [
    row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-05' }),
    row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-06' }),
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

  it('does NOT flag a field within the threshold band once the combine has moved on', () => {
    // c at 170 bu/ac (17000/100). baseline 190, cutoff 161.5. 170 >= 161.5 → counts
    // — as soon as a later-dated load lands on d (the field now being cut,
    // which is held as the active field).
    const rows = [
      ...base,
      row({ id: 'c', acres: 100, dryBu: 17000, lastLoadDate: '2025-09-17' }),
      row({ id: 'd', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    expect(res.autoExcluded.has('c')).toBe(false)
    expect(res.excluded.has('c')).toBe(false)
    expect(res.excluded.get('d')).toBe('in_progress') // the active field
    // Average over a+b+c = (20000+18000+17000)/300 = 55000/300 = 183.333...
    expect(res.averages.get('corn')?.yield).toBeCloseTo(55000 / 300, 6)
  })

  it('a low field stays in-progress at 15 quiet days of ITS OWN while crop loads still arrive', () => {
    // The inactivity clock is CROP-WIDE. low's own loads stopped two weeks
    // ago, but b hauled corn yesterday — harvest is still running, so the
    // operator may well come back to low. It must not complete by its own
    // silence alone.
    //   low:  50 bu/ac, dated 2025-09-05 (own loads 15 days quiet)
    //   a:   200 bu/ac, dated 2025-09-10
    //   b:   180 bu/ac, dated 2025-09-19 (crop still active — b is the
    //        field being cut, so it is held too)
    const rows = [
      row({ id: 'low', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-05' }),
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-10' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('low')).toBe('in_progress')
    expect(res.excluded.has('a')).toBe(false)
    expect(res.excluded.get('b')).toBe('in_progress')
    // Average over a alone = 200.
    expect(res.averages.get('corn')?.yield).toBeCloseTo(200, 6)
  })

  it('a low field STAYS in-progress even when another field has a later-dated load (the Parker case)', () => {
    // THE key regression: harvest started parker, moved off to `other` before
    // finishing, and may well come back. A later-dated load on another field
    // is NOT proof parker finished — its low partial number must not be
    // counted as complete against the crop.
    //   a:      200 bu/ac, 2025-09-08 (settled)
    //   b:      180 bu/ac, 2025-09-09 (settled)        → baseline 190, cutoff 161.5
    //   parker:  50 bu/ac, 2025-09-17 (active, low)    → in_progress
    //   other:  185 bu/ac, 2025-09-19 (newest — the field the combine is in)
    //                                                  → in_progress (active-field hold)
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-08' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-09' }),
      row({ id: 'parker', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-17' }),
      row({ id: 'other', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('parker')).toBe('in_progress')
    expect(res.excluded.get('other')).toBe('in_progress')
    // Average over the settled a+b = 190.
    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
    expect(res.progress.get('corn')?.inProgressAcres).toBe(200)
  })

  it('two simultaneously-harvested low fields are BOTH flagged vs the settled baseline', () => {
    // Two combines running: c and d both partial and low. The baseline comes
    // from the settled a+b (190) — one partial field can't drag the bar down
    // and shelter the other.
    const rows = [
      ...base, // a+b settled at 190
      row({ id: 'c', acres: 100, dryBu: 6000, lastLoadDate: '2025-09-18' }), // 60 bu/ac
      row({ id: 'd', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-18' }), // 50 bu/ac
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('c')).toBe('in_progress')
    expect(res.excluded.get('d')).toBe('in_progress')
    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
    expect(res.progress.get('corn')?.inProgressAcres).toBe(200)
  })

  it('when NOTHING has settled yet, the baseline falls back to the other fields', () => {
    // Harvest just started: both fields are recent, nothing is settled. The
    // combine finished a and is now in b (b's load is later-dated, so a is
    // no longer the active field). b is judged against a (baseline 200,
    // cutoff 170 → 50 flagged — and it is the active field besides); a is
    // judged against b (baseline 50, cutoff 42.5 → 200 fine).
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-18' }),
      row({ id: 'b', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('b')).toBe('in_progress')
    expect(res.excluded.has('a')).toBe(false)
    expect(res.averages.get('corn')?.yield).toBeCloseTo(200, 6)
  })
})

describe('analyzeYields — the low-yield signal PERSISTS (date ordering is not completion evidence)', () => {
  // a and b were loaded earlier this week (active, earlier-dated than c);
  // c is the low, partially-harvested field.
  const week = [
    row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-16' }),
    row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-17' }),
  ]

  it('low yield + only earlier-dated other-field loads + recent activity → in progress', () => {
    const rows = [...week, row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-18' })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('c')).toBe('in_progress')
    expect(res.excluded.has('a')).toBe(false)
    expect(res.excluded.has('b')).toBe(false)
    // Average over a+b: (20000+18000)/200 = 190.
    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
    expect(res.progress.get('corn')?.inProgressAcres).toBe(100)
  })

  it('a LATER-dated other-field load does NOT complete the low field — the operator may come back', () => {
    // d was loaded after c's last load. Moving to another field is not proof
    // c finished (start a field → move off → return is routine), so c's low
    // partial number stays out of the averages until real completion evidence.
    // d itself is the field being cut now → held as the active field.
    const rows = [
      ...week,
      row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-18' }),
      row({ id: 'd', acres: 100, dryBu: 19000, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('c')).toBe('in_progress')
    expect(res.excluded.get('d')).toBe('in_progress')
    // Average over a+b = (20000+18000)/200 = 190.
    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
    expect(res.progress.get('corn')?.inProgressAcres).toBe(200)
  })

  it('a normal-yield field is complete once the combine has moved on, whatever the low field does', () => {
    // d yields in line with the crop and e (later-dated) shows the combine
    // has moved past it: d counts, c (low) stays held, e is the active field.
    const rows = [
      ...week,
      row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-18' }),  // 50 bu/ac — low
      row({ id: 'd', acres: 100, dryBu: 19000, lastLoadDate: '2025-09-18' }), // 190 bu/ac — fine
      row({ id: 'e', acres: 100, dryBu: 9000, lastLoadDate: '2025-09-19' }),  // the field being cut now
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('c')).toBe('in_progress')
    expect(res.excluded.has('d')).toBe(false)
    expect(res.excluded.get('e')).toBe('in_progress')
    expect(res.excluded.has('a')).toBe(false)
    expect(res.excluded.has('b')).toBe(false)
  })

  it('the quiet window counts CALENDAR days — a field is not flipped complete partway through day 10', () => {
    // c's last load was exactly 10 calendar days before NOW. Wall-clock math
    // would measure 10.5 days at midday (date-only strings parse as midnight)
    // and complete it early; calendar-day counting keeps it in progress
    // through the whole final day.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-08' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-09' }),
      row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-10' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('c')).toBe('in_progress')
  })
})

describe('analyzeYields — the long quiet window (crop-wide inactivity fallback)', () => {
  it('a low field completes once the WHOLE CROP has been quiet 10+ days', () => {
    // Crop-wide silence: the newest corn load anywhere is c's 2025-09-09 —
    // 11 days before now — so harvest is genuinely paused/over and every
    // field counts, low ones included.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-05' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-06' }),
      row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-09' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)

    expect(res.autoExcluded.has('c')).toBe(false)
    expect(res.excluded.has('c')).toBe(false)
    // All three count: (20000+18000+5000)/300 = 43000/300 = 143.333...
    expect(res.averages.get('corn')?.yield).toBeCloseTo(43000 / 300, 6)
    const p = res.progress.get('corn')!
    expect(p.completedAcres).toBe(300)
    expect(p.inProgressAcres).toBe(0)
  })

  it('the boundary: crop quiet exactly IN_PROGRESS_STALE_DAYS days is still within the window', () => {
    // The crop's newest load (c's, any timestamp truncated to its calendar
    // date) is 10 calendar days before NOW's date — days <= 10 means the
    // crop is still "active", so the low field stays in progress.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-05' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-06' }),
      row({ id: 'c', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-10T12:00:00Z' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.get('c')).toBe('in_progress')
  })
})

describe('analyzeYields — thin peers: the expected-yield bar (crop_assumptions)', () => {
  // Early harvest: the crop's FIRST field is being cut. There are no peer
  // fields to compare against, so the crop's expected yield stands in.
  it('the failing case: first field cut, low vs the expected yield, no other-field loads, <10 days → in-progress', () => {
    const rows = [
      row({ id: 'first', acres: 100, dryBu: 3000, lastLoadDate: '2025-09-18', expectedYield: 180 }), // 30 bu/ac vs 180 expected
      row({ id: 'rest', acres: 100, dryBu: 0, lastLoadDate: null, expectedYield: 180 }),             // unharvested sibling
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('first')).toBe('in_progress')
    expect(res.excluded.get('rest')).toBe('unharvested')
    expect(res.noBaseline.size).toBe(0)
    // Nothing counted yet → no average for the crop.
    expect(res.averages.has('corn')).toBe(false)
    expect(res.progress.get('corn')?.inProgressAcres).toBe(100)
  })

  it('a first field tracking its expected yield is still the field being cut — complete once the combine moves on', () => {
    const first = row({ id: 'first', acres: 100, dryBu: 17500, lastLoadDate: '2025-09-18', expectedYield: 180 })
    // Alone and recent: it's the active field, whatever its yield.
    const alone = analyzeYields([first], IN_PROGRESS_THRESHOLD, NOW)
    expect(alone.excluded.get('first')).toBe('in_progress')
    // A later-dated load on the next field → the yield rule decides: 175 vs
    // the 180 expected is fine → complete.
    const movedOn = analyzeYields(
      [first, row({ id: 'second', acres: 100, dryBu: 4000, lastLoadDate: '2025-09-19', expectedYield: 180 })],
      IN_PROGRESS_THRESHOLD, NOW,
    )
    expect(movedOn.excluded.has('first')).toBe(false)
    expect(movedOn.excluded.get('second')).toBe('in_progress')
    expect(movedOn.averages.get('corn')?.yield).toBeCloseTo(175, 6)
  })

  it('with ONE partial peer, the expected yield still sets the bar (a low peer cannot shelter)', () => {
    // Both of the first two fields are partial. Against each other (55 vs 60)
    // neither looks low; against the 180 expected, both do.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 5500, lastLoadDate: '2025-09-18', expectedYield: 180 }),
      row({ id: 'b', acres: 100, dryBu: 6000, lastLoadDate: '2025-09-18', expectedYield: 180 }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('a')).toBe('in_progress')
    expect(res.excluded.get('b')).toBe('in_progress')
  })

  it('no peers and no expected yield → still the active field while recent (never defaulted complete)', () => {
    const rows = [row({ id: 'only', acres: 100, dryBu: 3000, lastLoadDate: '2025-09-18' })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('only')).toBe('in_progress')
    expect(res.noBaseline.has('only')).toBe(false)
    expect(res.progress.get('corn')?.inProgressAcres).toBe(100)
  })

  it('a field that cannot be judged after the combine moved on is reported in noBaseline so the UI can say why', () => {
    // The only peer carries bushels but no acres (nothing to weight a
    // baseline by) and there is no expected yield → complete, noted.
    const rows = [
      row({ id: 'only', acres: 100, dryBu: 3000, lastLoadDate: '2025-09-17' }),
      row({ id: 'odd', acres: 0, dryBu: 500, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.has('only')).toBe(false)
    expect(res.noBaseline.has('only')).toBe(true)
    expect(res.excluded.get('odd')).toBe('in_progress') // the active field
  })

  it('the expected-yield bar clears on crop-wide quiet like any other (10+ days → complete)', () => {
    const rows = [row({ id: 'first', acres: 100, dryBu: 3000, lastLoadDate: '2025-09-09', expectedYield: 180 })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.size).toBe(0)
    expect(res.averages.get('corn')?.yield).toBeCloseTo(30, 6)
  })

  it('count anyway still rescues a field flagged by the expected-yield bar', () => {
    const rows = [
      row({ id: 'first', acres: 100, dryBu: 3000, lastLoadDate: '2025-09-18', expectedYield: 180, override: true }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.get('first')).toBe('in_progress')
    expect(res.excluded.has('first')).toBe(false)
    expect(res.progress.get('corn')?.completedAcres).toBe(100)
  })
})

describe('expectedYieldForPlanting — the per-practice bar', () => {
  const a = { crop_id: 'corn', crop_year: 2025, expected_yield: 170, expected_yield_irr: 200, expected_yield_dry: 120 }
  it('pure plantings read their side; a blank side falls back to the overall', () => {
    expect(expectedYieldForPlanting(a, { irrigated_acres: 100, dryland_acres: 0 })).toBe(200)
    expect(expectedYieldForPlanting(a, { irrigated_acres: 0, dryland_acres: 100 })).toBe(120)
    const overallOnly = { crop_id: 'corn', crop_year: 2025, expected_yield: 170 }
    expect(expectedYieldForPlanting(overallOnly, { irrigated_acres: 100, dryland_acres: 0 })).toBe(170)
  })
  it('mixed plantings acre-weight the two sides: 60 ac @ 200 + 40 ac @ 120 = 168', () => {
    expect(expectedYieldForPlanting(a, { irrigated_acres: 60, dryland_acres: 40 })).toBeCloseTo(168, 6)
  })
  it('nothing entered → null (classification falls through to noBaseline)', () => {
    expect(expectedYieldForPlanting(null, { irrigated_acres: 0, dryland_acres: 100 })).toBeNull()
    expect(expectedYieldForPlanting({ crop_id: 'c', crop_year: 2025, expected_yield: null }, { irrigated_acres: 0, dryland_acres: 100 })).toBeNull()
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

  it('override sticks with a later-dated other-field load present (a field that genuinely finished low)', () => {
    // A real crop failure reads exactly like an abandoned partial harvest —
    // the app cannot tell them apart automatically, so "count anyway" is the
    // intended path to include a field that truly finished at a terrible
    // number. The override (persisted on the planting) keeps it counted no
    // matter what loads land on other fields afterward.
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-08' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-09' }),
      row({ id: 'parker', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-17', override: true }),
      row({ id: 'other', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.get('parker')).toBe('in_progress') // still flagged by the rule…
    expect(res.excluded.has('parker')).toBe(false)             // …but counted by the override
    expect(res.excluded.get('other')).toBe('in_progress')      // the field being cut now
    expect(res.averages.get('corn')?.yield).toBeCloseTo(43000 / 300, 6)
    expect(res.progress.get('corn')?.completedAcres).toBe(300)
  })

  it('override does NOT un-exclude an unharvested (0-bu) field', () => {
    // override only applies to in_progress; an unharvested field has no bushels.
    // (a's load is two weeks old — the crop is quiet, so a counts as usual.)
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-05' }),
      row({ id: 'b', acres: 50, dryBu: 0, lastLoadDate: null, override: true }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('b')).toBe('unharvested')
    // Average is still just field a.
    expect(res.averages.get('corn')?.acres).toBe(100)
    expect(res.averages.get('corn')?.yield).toBeCloseTo(180, 6)
  })
})

describe('analyzeYields — a lone harvested field with no expected yield', () => {
  it('is the field being cut while recent (in progress), and counts once the crop goes quiet', () => {
    const recent = [
      row({ id: 'a', acres: 100, dryBu: 100, lastLoadDate: '2025-09-19' }), // tiny yield, alone, yesterday
    ]
    const held = analyzeYields(recent, IN_PROGRESS_THRESHOLD, NOW)
    expect(held.excluded.get('a')).toBe('in_progress')
    expect(held.noBaseline.has('a')).toBe(false)
    expect(held.averages.has('corn')).toBe(false)

    // Eleven days of silence → harvest wrapped; it counts (nothing to judge
    // it against, and the quiet clock is the completion evidence).
    const quiet = analyzeYields(
      [row({ id: 'a', acres: 100, dryBu: 100, lastLoadDate: '2025-09-09' })],
      IN_PROGRESS_THRESHOLD, NOW,
    )
    expect(quiet.autoExcluded.size).toBe(0)
    expect(quiet.excluded.size).toBe(0)
    // Average = 100/100 = 1.
    expect(quiet.averages.get('corn')?.yield).toBeCloseTo(1, 6)
    const p = quiet.progress.get('corn')!
    expect(p.completedAcres).toBe(100)
    expect(p.totalAcres).toBe(100)
    expect(p.pctComplete).toBeCloseTo(100, 6)
  })

  it('an unharvested sibling changes nothing — the harvested one is still the active field', () => {
    const rows = [
      row({ id: 'a', acres: 100, dryBu: 100, lastLoadDate: '2025-09-19' }),
      row({ id: 'b', acres: 100, dryBu: 0, lastLoadDate: null }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.get('a')).toBe('in_progress')
    expect(res.autoExcluded.get('b')).toBe('unharvested')
    expect(res.excluded.get('a')).toBe('in_progress')
  })
})

// ---------------------------------------------------------------------------
// The active field is never complete: the field with loads and no later-dated
// load on any other field of the crop is the one the combine is in.
// ---------------------------------------------------------------------------
describe('analyzeYields — the active field is never complete', () => {
  // Two settled fields set a 190 baseline; `cur` yields a normal 185.
  const settled = [
    row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-05' }),
    row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-06' }),
  ]

  it('one field loading, normal yield, no other-field loads, day 3 → in progress', () => {
    // cur's last load was 2025-09-17 (3 days before NOW) and nothing later
    // has landed anywhere — the combine is still in it.
    const rows = [...settled, row({ id: 'cur', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-17' })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.get('cur')).toBe('in_progress')
    expect(res.excluded.get('cur')).toBe('in_progress')
    expect(res.excluded.has('a')).toBe(false)
    expect(res.excluded.has('b')).toBe(false)
    // The averages hold at the settled 190 — a perfectly normal partial
    // number is still partial.
    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
    expect(res.progress.get('corn')?.inProgressAcres).toBe(100)
  })

  it('the same field after a later-dated load on another field → complete under the yield rules', () => {
    const rows = [
      ...settled,
      row({ id: 'cur', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-17' }),
      row({ id: 'next', acres: 100, dryBu: 6000, lastLoadDate: '2025-09-19' }), // moved on
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.has('cur')).toBe(false)            // normal yield → complete
    expect(res.excluded.get('next')).toBe('in_progress')   // the new active field (and low)
    // Average over a+b+cur = (20000+18000+18500)/300 = 188.333…
    expect(res.averages.get('corn')?.yield).toBeCloseTo(56500 / 300, 6)
  })

  it('the same field with a low yield stays in progress after the move — the standing low-yield rule', () => {
    const rows = [
      ...settled,
      row({ id: 'cur', acres: 100, dryBu: 5000, lastLoadDate: '2025-09-17' }), // 50 bu/ac
      row({ id: 'next', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('cur')).toBe('in_progress')
    expect(res.excluded.get('next')).toBe('in_progress')
    expect(res.averages.get('corn')?.yield).toBeCloseTo(190, 6)
  })

  it('the same field with crop-wide 10-day silence → complete', () => {
    // cur's 2025-09-09 load is the crop's newest — 11 days ago. Harvest has
    // wrapped or paused, so the hold clears and it counts.
    const rows = [...settled, row({ id: 'cur', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-09' })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.autoExcluded.has('cur')).toBe(false)
    expect(res.excluded.has('cur')).toBe(false)
    expect(res.averages.get('corn')?.yield).toBeCloseTo(56500 / 300, 6)
    expect(res.progress.get('corn')?.pctComplete).toBeCloseTo(100, 6)
  })

  it('the last field of the season never gets an other-field load — it completes only via the quiet clock or count anyway', () => {
    const last = row({ id: 'last', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-15' })
    const others = [
      row({ id: 'a', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-05' }),
      row({ id: 'b', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-12' }),
    ]
    // Day 5 after its last load: still held, even though every other field
    // has finished and its yield is normal.
    const day5 = analyzeYields([...others, last], IN_PROGRESS_THRESHOLD, NOW)
    expect(day5.excluded.get('last')).toBe('in_progress')
    expect(day5.excluded.has('b')).toBe(false)
    // Its own last load IS the crop's last load: the crop-wide quiet clock
    // and "no later load anywhere" are the same test for it. At day 11 the
    // crop is quiet → complete.
    const day11 = analyzeYields([...others, last], IN_PROGRESS_THRESHOLD, new Date('2025-09-26T12:00:00Z'))
    expect(day11.excluded.has('last')).toBe(false)
    expect(day11.progress.get('corn')?.pctComplete).toBeCloseTo(100, 6)
    // Or "count anyway" completes it right now.
    const counted = analyzeYields([...others, { ...last, override: true }], IN_PROGRESS_THRESHOLD, NOW)
    expect(counted.autoExcluded.get('last')).toBe('in_progress')
    expect(counted.excluded.has('last')).toBe(false)
    expect(counted.progress.get('corn')?.pctComplete).toBeCloseTo(100, 6)
  })

  it('two fields loaded the same day are both held — dates alone cannot say which one the combine left', () => {
    const rows = [
      ...settled,
      row({ id: 'x', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-19' }),
      row({ id: 'y', acres: 100, dryBu: 19000, lastLoadDate: '2025-09-19' }),
    ]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.get('x')).toBe('in_progress')
    expect(res.excluded.get('y')).toBe('in_progress')
  })

  it('the explicit markers still complete the active field: combine harvest_complete and the crop-level flag', () => {
    const rows = [...settled, row({ id: 'cur', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-17', combineComplete: true })]
    const res = analyzeYields(rows, IN_PROGRESS_THRESHOLD, NOW)
    expect(res.excluded.has('cur')).toBe(false)
    // And the crop-level harvest-complete key overrides at the status seam.
    const held = analyzeYields([...settled, row({ id: 'cur', acres: 100, dryBu: 18500, lastLoadDate: '2025-09-17' })], IN_PROGRESS_THRESHOLD, NOW)
    expect(harvestStatusOf({ id: 'cur', crop_id: 'corn', season_year: 2025 }, held.excluded, new Set(['corn|2025']))).toBe('complete')
    expect(harvestStatusOf({ id: 'cur', crop_id: 'corn', season_year: 2025 }, held.excluded, new Set())).toBe('in_progress')
  })
})

describe('analyzeYields — weighted average over survivors', () => {
  it('is Σ dryBu / Σ acres across the included rows, weighting by acres', () => {
    // Different acreages so a simple mean of yields would differ from the
    // acre-weighted mean. a: 50 ac @ 200 (10000 bu). b: 150 ac @ 100 (15000 bu).
    // Weighted = 25000 / 200 = 125 (a naive average of 200 & 100 would be 150).
    // Both loads are weeks old (settled), so neither is an in-progress
    // candidate — isolating the average math. (b at 100 vs a's 200 WOULD flag
    // if its load were recent.)
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
    // Both crops are quiet (loads 2+ weeks old) so no field is the active
    // one — isolating the per-crop bookkeeping.
    const rows = [
      // corn: two normal fields, weighted avg (20000+18000)/200 = 190.
      row({ id: 'c1', cropId: 'corn', acres: 100, dryBu: 20000, lastLoadDate: '2025-09-01' }),
      row({ id: 'c2', cropId: 'corn', acres: 100, dryBu: 18000, lastLoadDate: '2025-09-03' }),
      // beans: one harvested (60 bu/ac), one unharvested.
      row({ id: 'b1', cropId: 'beans', acres: 100, dryBu: 6000, lastLoadDate: '2025-09-02' }),
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

// ---------------------------------------------------------------------------
// harvestStatusOf / isHarvestComplete — gates the bushel-allocation UI
// ---------------------------------------------------------------------------
describe('harvestStatusOf', () => {
  const planting = (id: string, crop_id = 'corn', season_year = 2026) => ({ id, crop_id, season_year })
  const excl = (pairs: Array<[string, ExclusionReason]>) => new Map<string, ExclusionReason>(pairs)
  const NO_CROPS = new Set<string>()

  it('returns complete when the planting is not excluded', () => {
    expect(harvestStatusOf(planting('a'), excl([]), NO_CROPS)).toBe('complete')
    expect(isHarvestComplete(planting('a'), excl([]), NO_CROPS)).toBe(true)
  })

  it('returns in_progress / unharvested mirroring the exclusion reason', () => {
    expect(harvestStatusOf(planting('a'), excl([['a', 'in_progress']]), NO_CROPS)).toBe('in_progress')
    expect(harvestStatusOf(planting('b'), excl([['b', 'unharvested']]), NO_CROPS)).toBe('unharvested')
    expect(isHarvestComplete(planting('a'), excl([['a', 'in_progress']]), NO_CROPS)).toBe(false)
  })

  it('crop-level harvest_complete forces complete even when in-progress/unharvested', () => {
    const cropDone = new Set(['corn|2026'])
    expect(harvestStatusOf(planting('a'), excl([['a', 'in_progress']]), cropDone)).toBe('complete')
    expect(harvestStatusOf(planting('b'), excl([['b', 'unharvested']]), cropDone)).toBe('complete')
    // ...but only for the matching crop+year.
    expect(harvestStatusOf(planting('c', 'beans', 2026), excl([['c', 'in_progress']]), cropDone)).toBe('in_progress')
    expect(harvestStatusOf(planting('d', 'corn', 2025), excl([['d', 'unharvested']]), cropDone)).toBe('unharvested')
  })
})

// ---------------------------------------------------------------------------
// cropsWithCompleteHarvest — drives the marketing estimate→actual switch
// ---------------------------------------------------------------------------
describe('cropsWithCompleteHarvest', () => {
  const NOW = new Date('2025-09-20T00:00:00')
  const pl = (id: string, field_id: string, crop_id: string, acres: number) =>
    ({ id, field_id, crop_id, season_year: 2026, planted_acres: acres })

  it('a crop is complete only when EVERY field is harvested', () => {
    const plantings = [pl('a', 'f1', 'corn', 100), pl('b', 'f2', 'corn', 100)]
    const agg = new Map<string, FieldCropAgg>([
      ['f1|corn|2026', { dryBu: 18000, lastLoadDate: '2025-09-05' }],
      ['f2|corn|2026', { dryBu: 0, lastLoadDate: null }], // unharvested
    ])
    expect(cropsWithCompleteHarvest({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(), now: NOW }).has('corn')).toBe(false)
    // Both fields now harvested at similar yields, and the crop has been
    // quiet 12 days (last loads stale → nothing is the active field).
    agg.set('f2|corn|2026', { dryBu: 17000, lastLoadDate: '2025-09-08' })
    expect(cropsWithCompleteHarvest({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(), now: NOW }).has('corn')).toBe(true)
  })

  it('the crop-level harvest_complete flag forces complete even with an unharvested field', () => {
    const plantings = [pl('a', 'f1', 'corn', 100), pl('b', 'f2', 'corn', 100)]
    const agg = new Map<string, FieldCropAgg>([['f1|corn|2026', { dryBu: 18000, lastLoadDate: '2025-09-10' }]])
    expect(cropsWithCompleteHarvest({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(['corn|2026']), now: NOW }).has('corn')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// inProgressPlantingsByCrop — the holdouts a surface offers "count anyway" on
// ---------------------------------------------------------------------------
describe('inProgressPlantingsByCrop', () => {
  const NOW = new Date('2025-09-20T12:00:00Z')
  const pl = (id: string, field_id: string, acres: number, override: boolean | null = null) =>
    ({ id, field_id, crop_id: 'corn', season_year: 2026, planted_acres: acres, yield_include_override: override })
  // f1/f2 are normal-yielding, f3 is the low, partially-harvested field.
  const agg = new Map<string, FieldCropAgg>([
    ['f1|corn|2026', { dryBu: 18000, lastLoadDate: '2025-09-16' }],
    ['f2|corn|2026', { dryBu: 17000, lastLoadDate: '2025-09-17' }],
    ['f3|corn|2026', { dryBu: 4000, lastLoadDate: '2025-09-18' }],
  ])

  it('names the in-progress fields per crop, and they block the estimate→actual switch', () => {
    const plantings = [pl('a', 'f1', 100), pl('b', 'f2', 100), pl('c', 'f3', 100)]
    const holdouts = inProgressPlantingsByCrop({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(), now: NOW })
    expect(holdouts.get('corn')?.map((p) => p.id)).toEqual(['c'])
    expect(cropsWithCompleteHarvest({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(), now: NOW }).has('corn')).toBe(false)
  })

  it('the "count anyway" override (stored on the planting) clears the holdout everywhere', () => {
    // The override is persisted on field_plantings.yield_include_override, so
    // once set it sticks: the same rows feed every surface, the field counts,
    // and the crop's harvest reads complete.
    const plantings = [pl('a', 'f1', 100), pl('b', 'f2', 100), pl('c', 'f3', 100, true)]
    const holdouts = inProgressPlantingsByCrop({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(), now: NOW })
    expect(holdouts.size).toBe(0)
    expect(cropsWithCompleteHarvest({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(), now: NOW }).has('corn')).toBe(true)
  })

  it('the crop-level harvest_complete flag also clears the holdouts', () => {
    const plantings = [pl('a', 'f1', 100), pl('b', 'f2', 100), pl('c', 'f3', 100)]
    const holdouts = inProgressPlantingsByCrop({ plantings, aggByKey: agg, cropYear: 2026, cropCompleteKeys: new Set(['corn|2026']), now: NOW })
    expect(holdouts.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// groupYieldAggregates — the by-entity (group) rollup
// ---------------------------------------------------------------------------
function gp(over: Partial<GroupYieldPlanting> & Pick<GroupYieldPlanting, 'groupId' | 'cropId'>): GroupYieldPlanting {
  return {
    groupName: over.groupName ?? over.groupId,
    cropName: over.cropName ?? over.cropId,
    seasonYear: 2026,
    acres: 0,
    dryBu: 0,
    irrigatedAcres: 0,
    drylandAcres: 0,
    yieldBreakoutEntered: false,
    irrigatedBushels: null,
    drylandBushels: null,
    ...over,
  }
}

describe('groupYieldAggregates', () => {
  it('rolls plantings up by group × crop × season with an acre-weighted yield', () => {
    // Acme/corn: 50 ac @ 200 (10000 bu) + 150 ac @ 100 (15000 bu). Weighted =
    // 25000/200 = 125 (a naive mean of 200 & 100 would be 150).
    const rows = groupYieldAggregates([
      gp({ groupId: 'E1', groupName: 'Acme', cropId: 'corn', cropName: 'Corn', acres: 50, dryBu: 10000, drylandAcres: 50 }),
      gp({ groupId: 'E1', groupName: 'Acme', cropId: 'corn', cropName: 'Corn', acres: 150, dryBu: 15000, drylandAcres: 150 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].acres).toBe(200)
    expect(rows[0].dryBu).toBe(25000)
    expect(rows[0].yield).toBeCloseTo(125, 6)
  })

  it('routes pure-irrigated and pure-dryland bushels to their own sides', () => {
    const rows = groupYieldAggregates([
      gp({ groupId: 'E1', cropId: 'corn', acres: 100, dryBu: 18000, irrigatedAcres: 100, drylandAcres: 0 }),
      gp({ groupId: 'E1', cropId: 'corn', acres: 100, dryBu: 12000, irrigatedAcres: 0, drylandAcres: 100 }),
    ])
    const r = rows[0]
    expect(r.acres).toBe(200)
    expect(r.dryBu).toBe(30000)
    expect(r.irrAc).toBe(100); expect(r.irrBu).toBe(18000); expect(r.irrigatedYield).toBeCloseTo(180, 6)
    expect(r.dryAc).toBe(100); expect(r.dryBuLand).toBe(12000); expect(r.drylandYield).toBeCloseTo(120, 6)
    expect(r.yield).toBeCloseTo(150, 6)
  })

  it('splits a mixed planting only when a breakout is entered; otherwise totals only', () => {
    // Mixed w/ breakout (60 irr / 40 dry ac, 15000 / 5000 bu) → irr 250, dry 125.
    // A second mixed planting with NO breakout adds to totals but neither side.
    const rows = groupYieldAggregates([
      gp({ groupId: 'E1', cropId: 'corn', acres: 100, dryBu: 20000, irrigatedAcres: 60, drylandAcres: 40,
           yieldBreakoutEntered: true, irrigatedBushels: 15000, drylandBushels: 5000 }),
      gp({ groupId: 'E1', cropId: 'corn', acres: 100, dryBu: 10000, irrigatedAcres: 50, drylandAcres: 50 }),
    ])
    const r = rows[0]
    expect(r.acres).toBe(200)
    expect(r.dryBu).toBe(30000)
    expect(r.irrAc).toBe(60); expect(r.irrBu).toBe(15000); expect(r.irrigatedYield).toBeCloseTo(250, 6)
    expect(r.dryAc).toBe(40); expect(r.dryBuLand).toBe(5000); expect(r.drylandYield).toBeCloseTo(125, 6)
    expect(r.yield).toBeCloseTo(150, 6) // total uses ALL acres/bushels
  })

  it('keeps groups, crops, and seasons separate and sorts by year, group, crop', () => {
    const rows = groupYieldAggregates([
      gp({ groupId: 'E2', groupName: 'Zeta', cropId: 'beans', cropName: 'Beans', seasonYear: 2026, acres: 100, dryBu: 6000, drylandAcres: 100 }),
      gp({ groupId: 'E1', groupName: 'Acme', cropId: 'corn', cropName: 'Corn', seasonYear: 2026, acres: 100, dryBu: 18000, drylandAcres: 100 }),
      gp({ groupId: 'E1', groupName: 'Acme', cropId: 'corn', cropName: 'Corn', seasonYear: 2025, acres: 100, dryBu: 20000, drylandAcres: 100 }),
    ])
    expect(rows).toHaveLength(3)
    // 2026 before 2025; within 2026, Acme before Zeta.
    expect([rows[0].groupName, rows[0].cropName, rows[0].seasonYear]).toEqual(['Acme', 'Corn', 2026])
    expect([rows[1].groupName, rows[1].seasonYear]).toEqual(['Zeta', 2026])
    expect([rows[2].groupName, rows[2].seasonYear]).toEqual(['Acme', 2025])
    expect(rows[0].yield).toBeCloseTo(180, 6)
    expect(rows[1].yield).toBeCloseTo(60, 6)
  })

  it('returns an empty array for no plantings', () => {
    expect(groupYieldAggregates([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Load-level irrigated/dryland designation (060) — practiceOf,
// practice-aware fieldCropAggregates, resolvePracticeBreakout, withLoadBreakouts
// ---------------------------------------------------------------------------

// A mixed planting: 60 irrigated + 40 dryland acres on fA/corn/2025.
function mixedPlanting(over: Partial<{
  field_id: string; crop_id: string; season_year: number
  irrigated_acres: number | string | null; dryland_acres: number | string | null
  irrigated_bushels: number | string | null; dryland_bushels: number | string | null
  yield_breakout_entered: boolean | null
}> = {}) {
  return {
    field_id: 'fA', crop_id: 'corn', season_year: 2025,
    irrigated_acres: 60, dryland_acres: 40,
    irrigated_bushels: null, dryland_bushels: null,
    yield_breakout_entered: false,
    ...over,
  }
}

describe('practiceOf', () => {
  it('classifies pure-dry, pure-irr, and mixed (both > 0)', () => {
    expect(practiceOf({ irrigated_acres: 0, dryland_acres: 100 })).toBe('pure-dry')
    expect(practiceOf({ irrigated_acres: 100, dryland_acres: 0 })).toBe('pure-irr')
    expect(practiceOf({ irrigated_acres: 60, dryland_acres: 40 })).toBe('mixed')
    // 0/0 and null/null count as pure-dry (matches the historical backfill).
    expect(practiceOf({ irrigated_acres: 0, dryland_acres: 0 })).toBe('pure-dry')
    expect(practiceOf({ irrigated_acres: null, dryland_acres: null })).toBe('pure-dry')
    // Numeric strings (numeric columns come back as strings from supabase-js).
    expect(practiceOf({ irrigated_acres: '60.00', dryland_acres: '40.00' })).toBe('mixed')
  })
})

describe('fieldCropAggregates — practice designation', () => {
  it('sums designated bushels per side and counts designated vs total loads', () => {
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 1000, practice: 'irrigated' }),
      load({ id: 'l2', date: '2025-09-11', dry_bushels_override: 400, practice: 'dryland' }),
      load({ id: 'l3', date: '2025-09-12', dry_bushels_override: 250 }), // undesignated
    ]
    const agg = fieldCropAggregates(loads, [], cropById).get('fA|corn|2025')!
    expect(agg.dryBu).toBe(1650)
    expect(agg.irrBu).toBe(1000)
    expect(agg.dryLandBu).toBe(400)
    expect(agg.designatedLoads).toBe(2)
    expect(agg.totalLoads).toBe(3)
  })

  it('split portions designate independently — each portion counts separately', () => {
    // One split load: the fA portion is irrigated, the fB portion undesignated.
    const loads: LoadLike[] = [
      {
        id: 'p1', date: '2025-09-20', net_weight: null, moisture: null, crop_id: null,
        dry_bushels_override: null, crop_year: 2025, from_type: 'field', from_field_id: null,
      },
    ]
    const splits: SplitLike[] = [
      { load_id: 'p1', field_id: 'fA', crop_id: 'corn', dry_bushels: 800, practice: 'irrigated' },
      { load_id: 'p1', field_id: 'fB', crop_id: 'corn', dry_bushels: 300, practice: null },
    ]
    const agg = fieldCropAggregates(loads, splits, cropById)
    const a = agg.get('fA|corn|2025')!
    expect(a.irrBu).toBe(800)
    expect(a.designatedLoads).toBe(1)
    expect(a.totalLoads).toBe(1)
    const b = agg.get('fB|corn|2025')!
    expect(b.irrBu ?? 0).toBe(0)
    expect(b.designatedLoads).toBe(0)
    expect(b.totalLoads).toBe(1)
  })
})

describe('resolvePracticeBreakout', () => {
  const aggOf = (loads: LoadLike[], splits: SplitLike[] = []) =>
    fieldCropAggregates(loads, splits, cropById).get('fA|corn|2025')

  it('all loads designated: source "loads", breakout equals the designated sums', () => {
    const agg = aggOf([
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 1000, practice: 'irrigated' }),
      load({ id: 'l2', date: '2025-09-11', dry_bushels_override: 400, practice: 'dryland' }),
    ])
    const b = resolvePracticeBreakout(mixedPlanting(), agg)
    expect(b.source).toBe('loads')
    expect(b.irrigatedBushels).toBe(1000)
    expect(b.drylandBushels).toBe(400)
  })

  it('partial designation: source null but designated sums exposed for the pre-fill', () => {
    const agg = aggOf([
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 1000, practice: 'irrigated' }),
      load({ id: 'l2', date: '2025-09-11', dry_bushels_override: 400 }), // untagged
    ])
    const b = resolvePracticeBreakout(mixedPlanting(), agg)
    expect(b.source).toBeNull()
    expect(b.irrigatedBushels).toBeNull()
    expect(b.drylandBushels).toBeNull()
    expect(b.designatedIrrBu).toBe(1000)
    expect(b.designatedLoads).toBe(1)
    expect(b.totalLoads).toBe(2)
  })

  it('no loads at all: source null (nothing to derive)', () => {
    const b = resolvePracticeBreakout(mixedPlanting(), undefined)
    expect(b.source).toBeNull()
    expect(b.totalLoads).toBe(0)
  })

  it('single-practice plantings never produce a load-derived breakout', () => {
    // Even fully-tagged loads: a pure field implies its practice from the
    // planting, so the resolver stays out of the way.
    const agg = aggOf([
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 1000, practice: 'irrigated' }),
    ])
    const pure = mixedPlanting({ irrigated_acres: 100, dryland_acres: 0 })
    expect(resolvePracticeBreakout(pure, agg).source).toBeNull()
  })

  it('a saved manual allocation wins over fully-designated loads', () => {
    const agg = aggOf([
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 1000, practice: 'irrigated' }),
      load({ id: 'l2', date: '2025-09-11', dry_bushels_override: 400, practice: 'dryland' }),
    ])
    const manual = mixedPlanting({
      yield_breakout_entered: true, irrigated_bushels: 900, dryland_bushels: 500,
    })
    const b = resolvePracticeBreakout(manual, agg)
    expect(b.source).toBe('manual')
    expect(b.irrigatedBushels).toBe(900)
    expect(b.drylandBushels).toBe(500)
  })
})

describe('withLoadBreakouts — one shared representation downstream', () => {
  it('materializes the load-derived split so consumers see it exactly like a manual breakout', () => {
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 15000, practice: 'irrigated' }),
      load({ id: 'l2', date: '2025-09-11', dry_bushels_override: 5000, practice: 'dryland' }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById)
    const [eff] = withLoadBreakouts([mixedPlanting()], agg)
    expect(eff.yield_breakout_entered).toBe(true)
    expect(eff.irrigated_bushels).toBe(15000)
    expect(eff.dryland_bushels).toBe(5000)
  })

  it('leaves partially-designated and pure plantings untouched', () => {
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 1000, practice: 'irrigated' }),
      load({ id: 'l2', date: '2025-09-11', dry_bushels_override: 400 }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById)
    const partial = mixedPlanting()
    const pure = mixedPlanting({ field_id: 'fB', irrigated_acres: 0, dryland_acres: 100 })
    const [effPartial, effPure] = withLoadBreakouts([partial, pure], agg)
    expect(effPartial).toBe(partial) // same object — untouched
    expect(effPure).toBe(pure)
  })

  it('downstream per-practice consumers agree between the two paths', () => {
    // Path 1: manual allocation. Path 2: identical numbers via load tags.
    // groupYieldAggregates must produce identical per-practice yields.
    const manual = mixedPlanting({
      yield_breakout_entered: true, irrigated_bushels: 15000, dryland_bushels: 5000,
    })
    const loads: LoadLike[] = [
      load({ id: 'l1', date: '2025-09-10', dry_bushels_override: 15000, practice: 'irrigated' }),
      load({ id: 'l2', date: '2025-09-11', dry_bushels_override: 5000, practice: 'dryland' }),
    ]
    const agg = fieldCropAggregates(loads, [], cropById)
    const [fromLoads] = withLoadBreakouts([mixedPlanting()], agg)

    const toGroupInput = (p: ReturnType<typeof mixedPlanting>): GroupYieldPlanting => gp({
      groupId: 'E1', cropId: 'corn', seasonYear: 2025, acres: 100, dryBu: 20000,
      irrigatedAcres: Number(p.irrigated_acres), drylandAcres: Number(p.dryland_acres),
      yieldBreakoutEntered: !!p.yield_breakout_entered,
      irrigatedBushels: p.irrigated_bushels != null ? Number(p.irrigated_bushels) : null,
      drylandBushels: p.dryland_bushels != null ? Number(p.dryland_bushels) : null,
    })
    const [viaManual] = groupYieldAggregates([toGroupInput(manual)])
    const [viaLoads] = groupYieldAggregates([toGroupInput(fromLoads)])
    expect(viaLoads.irrigatedYield).toBeCloseTo(viaManual.irrigatedYield!, 9)
    expect(viaLoads.drylandYield).toBeCloseTo(viaManual.drylandYield!, 9)
    expect(viaLoads.yield).toBeCloseTo(viaManual.yield!, 9)
    expect(viaManual.irrigatedYield).toBeCloseTo(250, 6) // 15000/60
    expect(viaManual.drylandYield).toBeCloseTo(125, 6)   // 5000/40
  })
})
