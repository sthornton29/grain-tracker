import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fieldCropAggregates,
  combineEntryTotals,
  combineNegativeNetMessage,
  analyzeYields,
  harvestStatusOf,
  resolvePracticeBreakout,
  type CombineEntryLike,
} from '@/lib/yields'
import { buildLoadDetail } from '@/lib/yield-detail'
import { emptyCell, cellFor, cellTotal, applyCombineRemainders, orgTotal, type OnHandBag } from '@/lib/bin-inventory'

// Combine-monitor harvest entry (062) — hand-verified worked examples.
// The entry is authoritative for a field × crop × year; weighed loads are
// netted out of it dynamically (entered before OR after the entry), and the
// netted remainder — never the gross total — posts to the destination bin.

const CROPS = new Map([['corn', { id: 'corn', base_moisture_pct: 15, base_lb_per_bushel: 56 }]])

// dry_bushels_override pins each load's dry bushels exactly — the shrink math
// itself is covered by lib/shrink tests.
function load(id: string, dryBu: number, opts?: { date?: string; toBin?: boolean; cropYear?: number }) {
  return {
    id,
    date: opts?.date ?? '2026-09-15',
    net_weight: null,
    moisture: null,
    crop_id: 'corn',
    dry_bushels_override: dryBu,
    crop_year: opts?.cropYear ?? 2026,
    from_type: 'field',
    from_field_id: 'f1',
    practice: null,
  }
}

function entry(adjustedBu: number, over?: Partial<CombineEntryLike>): CombineEntryLike {
  return {
    id: 'e1',
    field_id: 'f1',
    crop_id: 'corn',
    crop_year: 2026,
    stated_total_bushels: adjustedBu,
    adjusted_total_bushels: adjustedBu,
    adjustment_bu_per_acre: null,
    destination_bin_id: null,
    harvest_complete: true,
    entry_date: '2026-09-20',
    ...over,
  }
}

describe('combineEntryTotals', () => {
  it('yield mode: 228 bu/ac − 3.0 adjustment × 1,321 ac = 297,225 bu', () => {
    // 228 × 1,321 = 301,188 stated; −3 × 1,321 = −3,963 → 297,225 adjusted.
    const t = combineEntryTotals({
      entryMode: 'yield_per_acre',
      statedYieldPerAcre: 228,
      statedTotalBushels: null,
      adjustmentBuPerAcre: -3,
      acres: 1321,
    })
    expect(t.statedTotalBu).toBe(301188)
    expect(t.adjustedTotalBu).toBe(297225)
  })

  it('total mode: the adjustment still scales by acres', () => {
    const t = combineEntryTotals({
      entryMode: 'total_bushels',
      statedYieldPerAcre: null,
      statedTotalBushels: 50000,
      adjustmentBuPerAcre: 2,
      acres: 100,
    })
    expect(t.statedTotalBu).toBe(50000)
    expect(t.adjustedTotalBu).toBe(50200)
  })
})

describe('netting engine (fieldCropAggregates + combineEntries)', () => {
  it('combine 50,000 − weighed buyer loads 18,400 → 31,600 to storage', () => {
    const agg = fieldCropAggregates([load('l1', 18400)], [], CROPS, { combineEntries: [entry(50000)] })
    const a = agg.get('f1|corn|2026')!
    expect(a.dryBu).toBe(50000) // the entry is authoritative for production
    expect(a.combine!.weighedBu).toBe(18400)
    expect(a.combine!.remainderBu).toBe(31600)
  })

  it('a buyer load added AFTER the entry re-nets — no double count', () => {
    const before = fieldCropAggregates([load('l1', 18400)], [], CROPS, { combineEntries: [entry(50000)] })
    const after = fieldCropAggregates([load('l1', 18400), load('l2', 5000)], [], CROPS, { combineEntries: [entry(50000)] })
    expect(before.get('f1|corn|2026')!.dryBu).toBe(50000)
    expect(after.get('f1|corn|2026')!.dryBu).toBe(50000) // production unchanged
    expect(after.get('f1|corn|2026')!.combine!.remainderBu).toBe(26600) // 50,000 − 23,400
  })

  it('a January-hauled load (date year ≠ crop year) still nets against its season entry', () => {
    const jan = load('l3', 2000, { date: '2027-01-10', cropYear: 2026 })
    const agg = fieldCropAggregates([load('l1', 18400), jan], [], CROPS, { combineEntries: [entry(50000)] })
    expect(agg.get('f1|corn|2026')!.combine!.weighedBu).toBe(20400)
    expect(agg.has('f1|corn|2027')).toBe(false) // rerouted, not split across years
  })

  it('split-load portions net too', () => {
    const parent = { ...load('l4', 0), from_type: 'field', from_field_id: null as string | null }
    const split = { load_id: 'l4', field_id: 'f1', crop_id: 'corn', dry_bushels: 1200, practice: null }
    const agg = fieldCropAggregates([parent as never], [split], CROPS, { combineEntries: [entry(50000)] })
    expect(agg.get('f1|corn|2026')!.combine!.weighedBu).toBe(1200)
  })

  it('negative net: weighed 34,200 > combine 33,000 warns, never clamps', () => {
    const agg = fieldCropAggregates([load('l1', 34200)], [], CROPS, { combineEntries: [entry(33000)] })
    const c = agg.get('f1|corn|2026')!.combine!
    expect(c.remainderBu).toBe(-1200) // preserved, not clamped
    const msg = combineNegativeNetMessage(c)!
    expect(msg).toContain('34,200')
    expect(msg).toContain('33,000')
    expect(combineNegativeNetMessage({ weighedBu: 10, adjustedBu: 50, remainderBu: 40 })).toBeNull()
  })

  it('a combine field never derives its irr/dry split from load tags alone', () => {
    // All weighed loads tagged, but they are only PART of the production.
    const tagged = { ...load('l1', 18400), practice: 'irrigated' as const }
    const agg = fieldCropAggregates([tagged], [], CROPS, { combineEntries: [entry(50000)] })
    const planting = {
      irrigated_acres: 60, dryland_acres: 40,
      irrigated_bushels: null, dryland_bushels: null, yield_breakout_entered: false,
    }
    expect(resolvePracticeBreakout(planting, agg.get('f1|corn|2026')).source).toBeNull()
    // The manual allocation (incl. the entry form's write-through) still wins.
    expect(resolvePracticeBreakout(
      { ...planting, irrigated_bushels: 30000, dryland_bushels: 20000, yield_breakout_entered: true },
      agg.get('f1|corn|2026'),
    ).source).toBe('manual')
  })
})

describe('harvest-complete flag → harvestStatusOf', () => {
  const plantings = [
    { id: 'p1', cropId: 'corn', acres: 100, dryBu: 50000, lastLoadDate: '2026-09-20' },
    { id: 'p2', cropId: 'corn', acres: 100, dryBu: 21000, lastLoadDate: '2026-09-20' },
  ]
  const now = new Date('2026-09-21T12:00:00Z') // both fields' activity is recent

  it('harvest_complete=true forces complete even when the heuristics say in-progress', () => {
    // p2 is far below the baseline with recent activity → normally in_progress.
    const withoutFlag = analyzeYields(plantings, undefined, now)
    expect(withoutFlag.excluded.get('p2')).toBe('in_progress')
    const withFlag = analyzeYields(
      plantings.map((p) => (p.id === 'p2' ? { ...p, combineComplete: true } : p)),
      undefined, now,
    )
    expect(withFlag.excluded.has('p2')).toBe(false)
    expect(harvestStatusOf({ id: 'p2', crop_id: 'corn', season_year: 2026 }, withFlag.excluded, new Set())).toBe('complete')
  })

  it('harvest_complete=false forces in_progress (rescuable by "count anyway")', () => {
    const a = analyzeYields(
      plantings.map((p) => (p.id === 'p1' ? { ...p, combineComplete: false } : p)),
      undefined, now,
    )
    expect(a.excluded.get('p1')).toBe('in_progress')
    const rescued = analyzeYields(
      plantings.map((p) => (p.id === 'p1' ? { ...p, combineComplete: false, override: true } : p)),
      undefined, now,
    )
    expect(rescued.excluded.has('p1')).toBe(false)
  })
})

describe('bin posting = netted remainder only', () => {
  it('conservation with a weighed bin-bound load present', () => {
    // Field production 50,000: 18,400 hauled to the bin as weighed loads
    // (loadBacked), remainder 31,600 posts via the combine entry. The bin
    // holds exactly the field's production — nothing double-counted.
    const bag: OnHandBag = new Map([['bin1', new Map()]])
    cellFor(bag, 'bin1', 'corn').loadBacked += 18400
    applyCombineRemainders(bag, [{ crop_id: 'corn', destinationBinId: 'bin1', remainderBu: 31600 }])
    expect(cellTotal(bag.get('bin1')!.get('corn')!)).toBe(50000)
    expect(orgTotal(bag)).toBe(50000)
  })

  it('no bin selected or negative remainder → nothing posts', () => {
    const bag: OnHandBag = new Map([['bin1', new Map()]])
    applyCombineRemainders(bag, [
      { crop_id: 'corn', destinationBinId: null, remainderBu: 500 },
      { crop_id: 'corn', destinationBinId: 'bin1', remainderBu: -1200 },
    ])
    expect(bag.get('bin1')!.size).toBe(0)
    const cell = emptyCell()
    expect(cellTotal(cell)).toBe(0)
  })
})

describe('drill-down equals field production', () => {
  it('fieldProductionDryBu uses the adjusted total; weighed loads stay listed', () => {
    const detail = buildLoadDetail({
      keys: new Set(['f1|corn']),
      seasonYear: 2026,
      loads: [{
        id: 'l1', date: '2026-09-15', net_weight: null, moisture: null, test_weight: null,
        crop_id: 'corn', dry_bushels_override: 18400, crop_year: 2026,
        from_type: 'field', from_field_id: 'f1', to_type: 'buyer', to_bin_id: null,
        to_buyer_id: 'b1', truck_id: null, ticket_number: 'T1',
      }],
      splits: [],
      cropById: CROPS,
      combineEntries: [entry(50000)],
    })
    expect(detail.loads).toHaveLength(1) // the weighed load keeps its identity
    expect(detail.summary.totalDryBu).toBe(18400) // netting basis
    expect(detail.summary.fieldProductionDryBu).toBe(50000) // = the yield row
    expect(detail.combineRows).toHaveLength(1)
    expect(detail.combineRows[0].info.remainderBu).toBe(31600)
    // ...and it matches the aggregate the yield row was built from.
    const agg = fieldCropAggregates([load('l1', 18400)], [], CROPS, { combineEntries: [entry(50000)] })
    expect(detail.summary.fieldProductionDryBu).toBe(agg.get('f1|corn|2026')!.dryBu)
  })
})

describe('calibration default shape (migration 062 + entry form)', () => {
  const root = process.cwd() // vitest runs from the repo root
  const sql = readFileSync(join(root, 'supabase', '062_combine_yield_entries.sql'), 'utf8')
  const form = readFileSync(join(root, 'app', 'loads', 'combine', 'page.tsx'), 'utf8')

  it('the per-crop default column exists and the form reads/writes it', () => {
    expect(sql).toContain('alter table public.crops add column if not exists combine_adjustment_bu_per_acre')
    expect(form).toContain('crop.combine_adjustment_bu_per_acre') // pre-fill
    expect(form).toContain("update({ combine_adjustment_bu_per_acre: adjustment })") // persist/clear
  })

  it('upsert revises: the unique key and the onConflict target match', () => {
    expect(sql).toContain('unique (field_id, crop_id, crop_year)')
    expect(form).toContain("onConflict: 'field_id,crop_id,crop_year'")
  })
})
