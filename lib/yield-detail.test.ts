import { describe, it, expect } from 'vitest'
import {
  buildLoadDetail,
  summarizeDetail,
  weightedAverage,
  buildCottonFieldDetail,
  type DetailLoadLike,
  type DetailSplitLike,
} from './yield-detail'
import { fieldCropAggregates } from './yields'

const CORN = { id: 'corn', base_moisture_pct: 15, base_lb_per_bushel: 56 }
const cropById = new Map([[CORN.id, CORN]])

function load(over: Partial<DetailLoadLike> & Pick<DetailLoadLike, 'id' | 'date'>): DetailLoadLike {
  return {
    net_weight: null, moisture: null, test_weight: null, crop_id: CORN.id,
    dry_bushels_override: null, crop_year: 2026,
    from_type: 'field', from_field_id: 'f1',
    to_type: null, to_bin_id: null, to_buyer_id: null,
    truck_id: null, ticket_number: null,
    ...over,
  }
}

describe('weightedAverage — weighted by net lbs, never a simple mean', () => {
  it('30,000 lbs @ 16.0 + 50,000 lbs @ 18.0 → 17.25, not 17.0', () => {
    const avg = weightedAverage([
      { value: 16.0, weight: 30000 },
      { value: 18.0, weight: 50000 },
    ])
    expect(avg).toBeCloseTo(17.25, 6)
  })

  it('rows without a value drop from numerator AND denominator', () => {
    const avg = weightedAverage([
      { value: 16.0, weight: 30000 },
      { value: null, weight: 99999 },
    ])
    expect(avg).toBeCloseTo(16.0, 6)
  })

  it('null when nothing weighs in', () => {
    expect(weightedAverage([])).toBeNull()
    expect(weightedAverage([{ value: 15, weight: 0 }])).toBeNull()
  })
})

describe('buildLoadDetail — the drill-down sums to the row it explains', () => {
  const loads: DetailLoadLike[] = [
    load({ id: 'l1', date: '2026-09-10', net_weight: 30000, moisture: 16, test_weight: 56.5, to_type: 'bin', to_bin_id: 'b1', ticket_number: 'T-101' }),
    load({ id: 'l2', date: '2026-09-12', net_weight: 50000, moisture: 18, test_weight: 55.0, to_type: 'buyer', to_buyer_id: 'buy1' }),
    // A split parent: 34,300 lbs from two fields; f1's slice is 14,200 lbs' worth.
    load({ id: 'l3', date: '2026-09-14', net_weight: 34300, moisture: 15, from_type: 'field', from_field_id: null, to_type: 'bin', to_bin_id: 'b1' }),
    // Noise: another field, another year — never in f1's 2026 detail.
    load({ id: 'l4', date: '2026-09-11', net_weight: 10000, moisture: 15, from_field_id: 'f2' }),
    load({ id: 'l5', date: '2025-09-11', net_weight: 10000, moisture: 15 }),
  ]
  // Parent l3: wet = 34300/56 = 612.5 bu; moisture at base → dry = 612.5.
  // f1's split slice: 14,200 lbs' worth = 253.571… dry bu; f2 takes the rest.
  const f1SplitDry = (14200 / 56)
  const f2SplitDry = 34300 / 56 - f1SplitDry
  const splits: DetailSplitLike[] = [
    { load_id: 'l3', field_id: 'f1', crop_id: CORN.id, dry_bushels: f1SplitDry },
    { load_id: 'l3', field_id: 'f2', crop_id: CORN.id, dry_bushels: f2SplitDry },
  ]

  it('field-level totals exactly equal fieldCropAggregates for the same key', () => {
    const agg = fieldCropAggregates(loads, splits, cropById)
    const detail = buildLoadDetail({ keys: new Set(['f1|corn']), seasonYear: 2026, loads, splits, cropById })
    expect(detail.summary.totalDryBu).toBeCloseTo(agg.get('f1|corn|2026')!.dryBu, 6)
    expect(detail.summary.lastLoadDate).toBe(agg.get('f1|corn|2026')!.lastLoadDate)
  })

  it('aggregate-level totals (farm/entity/landowner = a key set) equal the summed rows', () => {
    const agg = fieldCropAggregates(loads, splits, cropById)
    const detail = buildLoadDetail({ keys: new Set(['f1|corn', 'f2|corn']), seasonYear: 2026, loads, splits, cropById })
    const expected = agg.get('f1|corn|2026')!.dryBu + agg.get('f2|corn|2026')!.dryBu
    expect(detail.summary.totalDryBu).toBeCloseTo(expected, 6)
  })

  it('a split load carries only this field\'s portion, badged against the whole', () => {
    const detail = buildLoadDetail({ keys: new Set(['f1|corn']), seasonYear: 2026, loads, splits, cropById })
    const split = detail.loads.find((l) => l.loadId === 'l3')!
    expect(split.split).toEqual({ portionLbs: 14200, parentLbs: 34300 })
    expect(split.netLbs).toBe(14200)
    expect(split.dryBu).toBeCloseTo(f1SplitDry, 6)
    expect(split.moisture).toBe(15)
  })

  it('weighted moisture over the direct loads matches the worked example', () => {
    const detail = buildLoadDetail({ keys: new Set(['f1|corn']), seasonYear: 2026, loads: loads.slice(0, 2), splits: [], cropById })
    expect(detail.summary.weightedMoisture).toBeCloseTo(17.25, 6)
    expect(detail.summary.weightedTestWeight).toBeCloseTo((56.5 * 30000 + 55.0 * 50000) / 80000, 6)
  })

  it('destination mix by dry bushels', () => {
    const detail = buildLoadDetail({ keys: new Set(['f1|corn']), seasonYear: 2026, loads, splits, cropById })
    const s = detail.summary
    // l1 (bin) + l3 slice (bin) vs l2 (buyer)
    const l1Dry = (30000 / 56) * (100 - 16) / (100 - 15)
    const l2Dry = (50000 / 56) * (100 - 18) / (100 - 15)
    expect(s.toBinsDryBu).toBeCloseTo(l1Dry + f1SplitDry, 6)
    expect(s.toBuyersDryBu).toBeCloseTo(l2Dry, 6)
    expect((s.toBinsPct ?? 0) + (s.toBuyersPct ?? 0)).toBeCloseTo(100, 6)
    expect(s.firstLoadDate).toBe('2026-09-10')
    expect(s.lastLoadDate).toBe('2026-09-14')
  })

  it('loads sort by date and link ids/tickets/trucks through', () => {
    const detail = buildLoadDetail({ keys: new Set(['f1|corn']), seasonYear: 2026, loads, splits, cropById })
    expect(detail.loads.map((l) => l.loadId)).toEqual(['l1', 'l2', 'l3'])
    expect(detail.loads[0].ticket).toBe('T-101')
  })

  it('summarizeDetail of an empty list is all-zero/null', () => {
    const s = summarizeDetail([])
    expect(s.loadCount).toBe(0)
    expect(s.totalDryBu).toBe(0)
    expect(s.weightedMoisture).toBeNull()
    expect(s.toBinsPct).toBeNull()
  })
})

describe('buildCottonFieldDetail — gin-receipt lbs, not grain loads', () => {
  const receipts = [
    { id: 'r1', field_id: 'f1', crop_year: 2026, bales_count: 10, total_bale_weight: 4800, total_seed_cotton_weight: 12000 },
    // Receipt with per-bale weights on file: bales win over the receipt total.
    { id: 'r2', field_id: 'f1', crop_year: 2026, bales_count: 2, total_bale_weight: 999999, total_seed_cotton_weight: null },
    { id: 'r3', field_id: 'f2', crop_year: 2026, bales_count: 5, total_bale_weight: 2400, total_seed_cotton_weight: null },
    { id: 'r4', field_id: 'f1', crop_year: 2025, bales_count: 5, total_bale_weight: 2400, total_seed_cotton_weight: null },
  ]
  const bales = [
    { id: 'b1', gin_receipt_id: 'r2', net_weight_lbs: 500 },
    { id: 'b2', gin_receipt_id: 'r2', net_weight_lbs: 480 },
  ]
  const grades = [
    { bale_id: 'b1', loan_value_cents_per_lb: 55.0 },
    { bale_id: 'b2', loan_value_cents_per_lb: 50.0 },
  ]
  const yardLoads = [
    { field_id: 'f1', crop_year: 2026, net_weight: 20000, onReceipt: false },
    { field_id: 'f1', crop_year: 2026, net_weight: 18000, onReceipt: true }, // already ginned
    { field_id: 'f2', crop_year: 2026, net_weight: 5000, onReceipt: false },
  ]

  it('lint = per-bale weights when on file, else the receipt total; scoped to field + year', () => {
    const d = buildCottonFieldDetail({ fieldIds: new Set(['f1']), cropYear: 2026, ginReceipts: receipts, bales, baleGrades: grades, yardLoads })
    expect(d.lintLbs).toBe(4800 + 980) // r1 total + r2 bales (999999 ignored)
    expect(d.baleCount).toBe(12)
    expect(d.receiptCount).toBe(2)
  })

  it('turnout uses only receipts carrying both seed and lint', () => {
    const d = buildCottonFieldDetail({ fieldIds: new Set(['f1']), cropYear: 2026, ginReceipts: receipts, bales, baleGrades: grades, yardLoads })
    expect(d.turnoutPct).toBeCloseTo((4800 / 12000) * 100, 6)
  })

  it('loan value weights by classed-bale lint lbs', () => {
    const d = buildCottonFieldDetail({ fieldIds: new Set(['f1']), cropYear: 2026, ginReceipts: receipts, bales, baleGrades: grades, yardLoads })
    expect(d.weightedLoanCentsPerLb).toBeCloseTo((55 * 500 + 50 * 480) / 980, 6)
    expect(d.classedBaleCount).toBe(2)
  })

  it('yard seed cotton counts only loads not yet on a receipt', () => {
    const d = buildCottonFieldDetail({ fieldIds: new Set(['f1']), cropYear: 2026, ginReceipts: receipts, bales, baleGrades: grades, yardLoads })
    expect(d.yardSeedCottonLbs).toBe(20000)
    expect(d.yardLoadCount).toBe(1)
  })
})
