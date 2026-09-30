import { describe, expect, it } from 'vitest'
import { checkLoad, MAX_PLAUSIBLE_NET_LB } from '@/lib/load-checks'

const ok = { gross: 82000, tare: 32000, net: 50000, moisture: 15.2, testWeight: 56, truckPicked: true }

describe('checkLoad — a normal load passes clean', () => {
  it('no warnings, no blockers', () => {
    expect(checkLoad(ok)).toEqual({ blockers: [], warnings: [] })
  })
})

describe('checkLoad — blockers', () => {
  it('a negative net weight blocks the save', () => {
    const r = checkLoad({ ...ok, gross: 30000, tare: 32000, net: -2000 })
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers[0]).toMatch(/below zero/)
  })
})

describe('checkLoad — warnings (save anyway / go back)', () => {
  it('gross under tare asks whether they are swapped', () => {
    const r = checkLoad({ ...ok, gross: 32000, tare: 82000, net: 50000 })
    expect(r.warnings).toContain('Gross is less than tare — are they swapped?')
  })
  it('no net weight', () => {
    expect(checkLoad({ ...ok, gross: null, tare: null, net: null }).warnings.some((w) => /No net weight/.test(w))).toBe(true)
  })
  it('zero net weight', () => {
    expect(checkLoad({ ...ok, net: 0 }).warnings.some((w) => /zero/.test(w))).toBe(true)
  })
  it('an implausibly heavy load names the figure with commas', () => {
    const r = checkLoad({ ...ok, net: MAX_PLAUSIBLE_NET_LB + 1 })
    expect(r.warnings.some((w) => w.includes('120,001 lb'))).toBe(true)
  })
  it('exactly the cap is still fine', () => {
    expect(checkLoad({ ...ok, net: MAX_PLAUSIBLE_NET_LB }).warnings).toEqual([])
  })
  it('no truck picked', () => {
    expect(checkLoad({ ...ok, truckPicked: false }).warnings).toContain('No truck picked.')
  })
  it('moisture outside 0–40', () => {
    expect(checkLoad({ ...ok, moisture: 41 }).warnings.some((w) => /Moisture 41%/.test(w))).toBe(true)
    expect(checkLoad({ ...ok, moisture: -1 }).warnings.some((w) => /Moisture -1%/.test(w))).toBe(true)
    expect(checkLoad({ ...ok, moisture: 40 }).warnings).toEqual([])
  })
  it('test weight outside 30–80', () => {
    expect(checkLoad({ ...ok, testWeight: 29.9 }).warnings.some((w) => /Test weight/.test(w))).toBe(true)
    expect(checkLoad({ ...ok, testWeight: 80.5 }).warnings.some((w) => /Test weight/.test(w))).toBe(true)
    expect(checkLoad({ ...ok, testWeight: 30 }).warnings).toEqual([])
    expect(checkLoad({ ...ok, testWeight: 80 }).warnings).toEqual([])
  })
  it('crop-aware: moisture far above the crop base warns even under the cap', () => {
    const r = checkLoad({ ...ok, moisture: 36, crop: { name: 'Corn', base_moisture_pct: 15 } })
    expect(r.warnings).toEqual(["Moisture 36% is far above Corn's base of 15%."])
    // Just under the crop threshold is quiet.
    expect(checkLoad({ ...ok, moisture: 34, crop: { name: 'Corn', base_moisture_pct: 15 } }).warnings).toEqual([])
    // Never doubles up with the hard-range warning.
    const both = checkLoad({ ...ok, moisture: 45, crop: { name: 'Corn', base_moisture_pct: 15 } })
    expect(both.warnings.filter((w) => /Moisture/.test(w))).toHaveLength(1)
  })
  it('several problems list together, in ticket order', () => {
    const r = checkLoad({ gross: 10, tare: 20, net: 0, moisture: 99, testWeight: 5, truckPicked: false })
    expect(r.blockers).toEqual([])
    expect(r.warnings).toHaveLength(5)
    expect(r.warnings[0]).toMatch(/swapped/)
    expect(r.warnings[1]).toMatch(/zero/)
    expect(r.warnings[2]).toBe('No truck picked.')
    expect(r.warnings[3]).toMatch(/Moisture/)
    expect(r.warnings[4]).toMatch(/Test weight/)
  })
})
