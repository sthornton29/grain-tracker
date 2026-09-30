import { describe, expect, it } from 'vitest'
import {
  EMPTY_COTTON_FILTERS, documentPagePlan, filterCottonLoads, lbsPerRoll, rollsSummary, sortCottonLoads,
  type CottonLoadRow, type CottonSortContext,
} from './cotton-loads'

const row = (p: Partial<CottonLoadRow> & { id: string; load_number: string }): CottonLoadRow => ({
  farm_id: null, field_id: null, gin_id: null, picked_date: null, delivered_date: null, truck: null,
  gross_weight: null, tare_weight: null, net_weight: null, rolls: null, ...p,
})

const ctx: CottonSortContext = {
  farmName: (id) => ({ f1: 'Blythe', f2: 'Adams' } as Record<string, string>)[id ?? ''] ?? '',
  fieldName: (id) => ({ x1: 'Big South', x2: 'North 40' } as Record<string, string>)[id ?? ''] ?? '',
  ginName: (id) => ({ g1: 'Servico' } as Record<string, string>)[id ?? ''] ?? '',
  ginned: (id) => id === 'b',
}

const A = row({ id: 'a', load_number: 'M-10', farm_id: 'f1', field_id: 'x1', net_weight: 40_000, rolls: 4, delivered_date: '2026-10-02', truck: 'T7' })
const B = row({ id: 'b', load_number: 'M-9', farm_id: 'f2', field_id: 'x2', net_weight: 33_000, rolls: 3, delivered_date: '2026-10-01', gin_id: 'g1' })
const C = row({ id: 'c', load_number: 'M-11', farm_id: 'f1', net_weight: 20_000, rolls: null, delivered_date: null })

describe('lbsPerRoll / rollsSummary', () => {
  it('divides net pounds by rolls and is null without either', () => {
    expect(lbsPerRoll(40_000, 4)).toBe(10_000)
    expect(lbsPerRoll(40_000, 0)).toBeNull()
    expect(lbsPerRoll(null, 4)).toBeNull()
  })

  it('weights the average by pounds on the loads that recorded rolls', () => {
    const s = rollsSummary([A, B, C])
    expect(s).toMatchObject({ loads: 3, netLbs: 93_000, rolls: 7, loadsWithRolls: 2, netLbsWithRolls: 73_000 })
    expect(s.avgLbsPerRoll).toBeCloseTo(73_000 / 7)
    expect(rollsSummary([C]).avgLbsPerRoll).toBeNull()
  })
})

describe('sortCottonLoads', () => {
  it('sorts load numbers naturally', () => {
    expect(sortCottonLoads([A, B, C], 'load', 'asc', ctx).map((r) => r.load_number)).toEqual(['M-9', 'M-10', 'M-11'])
    expect(sortCottonLoads([A, B, C], 'load', 'desc', ctx).map((r) => r.load_number)).toEqual(['M-11', 'M-10', 'M-9'])
  })

  it('keeps blanks last in both directions for numbers and dates', () => {
    expect(sortCottonLoads([A, B, C], 'rolls', 'asc', ctx).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortCottonLoads([A, B, C], 'rolls', 'desc', ctx).map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(sortCottonLoads([A, B, C], 'delivered', 'desc', ctx).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts by looked-up names, pounds per roll, and status', () => {
    expect(sortCottonLoads([A, B, C], 'farm', 'asc', ctx).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortCottonLoads([A, B, C], 'perRoll', 'desc', ctx).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortCottonLoads([A, B, C], 'status', 'asc', ctx).map((r) => r.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('filterCottonLoads', () => {
  it('matches the search across load number, truck, farm, field, and gin', () => {
    expect(filterCottonLoads([A, B, C], { ...EMPTY_COTTON_FILTERS, q: 'blythe' }, ctx).map((r) => r.id)).toEqual(['a', 'c'])
    expect(filterCottonLoads([A, B, C], { ...EMPTY_COTTON_FILTERS, q: 't7' }, ctx).map((r) => r.id)).toEqual(['a'])
    expect(filterCottonLoads([A, B, C], { ...EMPTY_COTTON_FILTERS, q: 'servico' }, ctx).map((r) => r.id)).toEqual(['b'])
  })

  it('filters by status and delivered date range (undated loads fall outside a range)', () => {
    expect(filterCottonLoads([A, B, C], { ...EMPTY_COTTON_FILTERS, status: 'ginned' }, ctx).map((r) => r.id)).toEqual(['b'])
    expect(filterCottonLoads([A, B, C], { ...EMPTY_COTTON_FILTERS, status: 'yard' }, ctx).map((r) => r.id)).toEqual(['a', 'c'])
    expect(filterCottonLoads([A, B, C], { ...EMPTY_COTTON_FILTERS, from: '2026-10-02' }, ctx).map((r) => r.id)).toEqual(['a'])
    expect(filterCottonLoads([A, B, C], { ...EMPTY_COTTON_FILTERS, to: '2026-10-01' }, ctx).map((r) => r.id)).toEqual(['b'])
  })
})

describe('documentPagePlan', () => {
  it('gives each load its own page only when one load per page holds', () => {
    expect(documentPagePlan(12, 12)).toBe('per-page')
    expect(documentPagePlan(10, 12)).toBe('whole')
    expect(documentPagePlan(0, 3)).toBe('none')
  })
})
