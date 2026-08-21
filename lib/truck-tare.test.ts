import { describe, expect, it } from 'vitest'
import {
  LOW_TARE_WARN_FRACTION,
  TARE_BASELINE_MIN_LOADS,
  buildTareStatsIndex,
  isLowTare,
  lowTareWarning,
  median,
  truckTareKey,
  truckTareStats,
  type TareHistoryLoad,
} from '@/lib/truck-tare'

const load = (over: Partial<TareHistoryLoad> & Pick<TareHistoryLoad, 'id'>): TareHistoryLoad => ({
  date: '2026-08-01',
  time: null,
  created_at: null,
  tare_weight: 31000,
  truck_id: 'T1',
  hauler_truck: null,
  ...over,
})

describe('truckTareKey', () => {
  it('keys own trucks by id and hauler trucks by normalised name', () => {
    expect(truckTareKey({ truck_id: 'T1' })).toBe('own:T1')
    expect(truckTareKey({ truck_id: null, hauler_truck: '  JD  Trucking 12 ' })).toBe('hauler:jd trucking 12')
    expect(truckTareKey({ truck_id: '', hauler_truck: '' })).toBeNull()
    expect(truckTareKey({})).toBeNull()
  })
})

describe('median', () => {
  it('odd and even counts', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('truckTareStats — baseline', () => {
  it('median of the truck tares (odd count), last tare by recency', () => {
    const loads = [
      load({ id: 'a', date: '2026-07-01', tare_weight: 30000 }),
      load({ id: 'b', date: '2026-07-02', tare_weight: 34000 }),
      load({ id: 'c', date: '2026-07-03', tare_weight: 31200 }),
    ]
    const s = truckTareStats(loads, 'own:T1')
    expect(s).toEqual({ lastTare: 31200, lastTareDate: '2026-07-03', normalTare: 31200, sampleCount: 3 })
  })

  it('median of an even count averages the middle pair', () => {
    const loads = [30000, 31000, 32000, 40000].map((t, i) => load({ id: `l${i}`, date: `2026-07-0${i + 1}`, tare_weight: t }))
    expect(truckTareStats(loads, 'own:T1').normalTare).toBe(31500)
  })

  it('excludes null and zero tares from both the baseline and the last tare', () => {
    const loads = [
      load({ id: 'a', date: '2026-07-01', tare_weight: 30000 }),
      load({ id: 'b', date: '2026-07-02', tare_weight: 32000 }),
      load({ id: 'c', date: '2026-07-03', tare_weight: 31000 }),
      load({ id: 'd', date: '2026-07-04', tare_weight: 0 }),
      load({ id: 'e', date: '2026-07-05', tare_weight: null }),
      load({ id: 'f', date: '2026-07-06', tare_weight: '' as unknown as number }),
    ]
    const s = truckTareStats(loads, 'own:T1')
    expect(s.sampleCount).toBe(3)
    expect(s.lastTare).toBe(31000)
    expect(s.lastTareDate).toBe('2026-07-03')
    expect(s.normalTare).toBe(31000)
  })

  it(`returns last tare only (no baseline) under ${TARE_BASELINE_MIN_LOADS} loads`, () => {
    const loads = [
      load({ id: 'a', date: '2026-07-01', tare_weight: 30000 }),
      load({ id: 'b', date: '2026-07-02', tare_weight: 34000 }),
    ]
    const s = truckTareStats(loads, 'own:T1')
    expect(s.lastTare).toBe(34000)
    expect(s.normalTare).toBeNull()
    expect(lowTareWarning(100, s)).toBeNull() // no baseline ⇒ never warns
  })

  it('only counts loads of the keyed truck — own vs hauler kept apart', () => {
    const loads = [
      load({ id: 'a', truck_id: 'T1', tare_weight: 30000 }),
      load({ id: 'b', truck_id: 'T2', tare_weight: 50000 }),
      load({ id: 'c', truck_id: null, hauler_truck: 'Red Pete', tare_weight: 28000 }),
      load({ id: 'd', truck_id: null, hauler_truck: 'red  pete ', tare_weight: 29000, date: '2026-08-02' }),
    ]
    expect(truckTareStats(loads, 'own:T1')).toMatchObject({ lastTare: 30000, sampleCount: 1 })
    expect(truckTareStats(loads, 'hauler:red pete')).toMatchObject({ lastTare: 29000, sampleCount: 2 })
    expect(truckTareStats(loads, null)).toMatchObject({ lastTare: null, sampleCount: 0 })
  })

  it('can exclude the load being edited from its own baseline', () => {
    const loads = [
      load({ id: 'a', date: '2026-07-01', tare_weight: 30000 }),
      load({ id: 'b', date: '2026-07-02', tare_weight: 30000 }),
      load({ id: 'c', date: '2026-07-03', tare_weight: 30000 }),
      load({ id: 'me', date: '2026-07-04', tare_weight: 12000 }),
    ]
    expect(truckTareStats(loads, 'own:T1').lastTare).toBe(12000)
    const s = truckTareStats(loads, 'own:T1', { excludeLoadId: 'me' })
    expect(s.lastTare).toBe(30000)
    expect(s.sampleCount).toBe(3)
  })
})

describe('truckTareStats — last-tare selection', () => {
  it('most recent by date, then time, then created_at', () => {
    const loads = [
      load({ id: 'a', date: '2026-07-03', time: '08:00', created_at: '2026-07-03T08:05:00Z', tare_weight: 30100 }),
      load({ id: 'b', date: '2026-07-03', time: '17:30', created_at: '2026-07-03T17:31:00Z', tare_weight: 30200 }),
      load({ id: 'c', date: '2026-07-02', time: '23:59', created_at: '2026-07-04T00:00:00Z', tare_weight: 30300 }), // entered later, but an older date
      load({ id: 'd', date: '2026-07-03', time: '17:30', created_at: '2026-07-03T17:32:00Z', tare_weight: 30400 }), // same date/time, created later
    ]
    const s = truckTareStats(loads, 'own:T1')
    expect(s.lastTare).toBe(30400)
    expect(s.lastTareDate).toBe('2026-07-03')
  })

  it('a split parent joined to its splits counts once', () => {
    // Three rows for the same parent load (one per split) + two other loads.
    const loads = [
      load({ id: 'parent', date: '2026-07-05', tare_weight: 20000 }),
      load({ id: 'parent', date: '2026-07-05', tare_weight: 20000 }),
      load({ id: 'parent', date: '2026-07-05', tare_weight: 20000 }),
      load({ id: 'x', date: '2026-07-01', tare_weight: 30000 }),
      load({ id: 'y', date: '2026-07-02', tare_weight: 32000 }),
    ]
    const s = truckTareStats(loads, 'own:T1')
    expect(s.sampleCount).toBe(3)
    expect(s.lastTare).toBe(20000)
    expect(s.normalTare).toBe(30000) // median of 20000/30000/32000, not 20000 ×3 dominating
  })
})

describe('isLowTare / lowTareWarning — the 50% boundary', () => {
  it('exactly 50% below flags; 49% below does not', () => {
    expect(LOW_TARE_WARN_FRACTION).toBe(0.5)
    expect(isLowTare(15600, 31200)).toBe(true) // exactly 50% below
    expect(isLowTare(15599, 31200)).toBe(true)
    expect(isLowTare(15912, 31200)).toBe(false) // 49% below
    expect(isLowTare(31200, 31200)).toBe(false)
    expect(isLowTare(null, 31200)).toBe(false)
    expect(isLowTare(15000, null)).toBe(false)
    expect(isLowTare(0, 31200)).toBe(false) // blank/zero is "not entered", not "low"
  })

  it('produces the inline message and clears once corrected', () => {
    const stats = { lastTare: 31220, lastTareDate: '2026-08-01', normalTare: 31200, sampleCount: 5 }
    expect(lowTareWarning(14800, stats)).toBe(
      "Tare 14,800 lbs is well below this truck's usual ~31,200 lbs. Double-check the ticket; a low tare overstates net weight.",
    )
    expect(lowTareWarning(30800, stats)).toBeNull()
    expect(lowTareWarning(14800, null)).toBeNull()
  })
})

describe('buildTareStatsIndex', () => {
  it('one stats entry per truck present', () => {
    const loads = [
      load({ id: 'a', truck_id: 'T1' }),
      load({ id: 'b', truck_id: 'T2', tare_weight: 25000 }),
      load({ id: 'c', truck_id: null, hauler_truck: 'Red Pete', tare_weight: 28000 }),
      load({ id: 'd', truck_id: null, hauler_truck: null, tare_weight: 28000 }), // no truck → no key
    ]
    const idx = buildTareStatsIndex(loads)
    expect([...idx.keys()].sort()).toEqual(['hauler:red pete', 'own:T1', 'own:T2'])
    expect(idx.get('own:T2')!.lastTare).toBe(25000)
  })
})
