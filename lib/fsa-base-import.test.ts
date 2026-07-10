import { describe, it, expect } from 'vitest'
import { mergeFsaLines, planBaseAcreSaves, describeBaseAcreConflict, type FsaMergeLine } from './fsa-base-import'

const line = (over: Partial<FsaMergeLine> = {}): FsaMergeLine => ({
  key: 'corn',
  isUnassigned: false,
  baseAcres: 120,
  plcYield: 150,
  election: '',
  ...over,
})

describe('mergeFsaLines', () => {
  it('keeps one row silently when duplicate lines carry identical values', () => {
    const out = mergeFsaLines([line({ election: 'PLC' }), line()])
    expect(out).toHaveLength(1)
    expect(out[0].baseAcres).toBe(120)
    expect(out[0].plcYield).toBe(150)
    // The election survives even when the re-read that missed it comes first.
    expect(out[0].election).toBe('PLC')
    expect(out[0].mergeNote).toBeNull()
    expect(out[0].sources).toHaveLength(2)
  })

  it('sums acres and acres-weights PLC yield across two tract lines, with a merge note', () => {
    const out = mergeFsaLines([line({ baseAcres: 120, plcYield: 150 }), line({ baseAcres: 85.5, plcYield: 180 })])
    expect(out).toHaveLength(1)
    expect(out[0].baseAcres).toBe(205.5)
    // (120×150 + 85.5×180) / 205.5 = 162.481… → 162.48
    expect(out[0].plcYield).toBe(162.48)
    expect(out[0].mergeNote).toBe('Merged 2 lines from upload: 120.0 + 85.5 ac')
  })

  it('sums existing-base + new-base lines (Base Allocation Summary) and notes the composition', () => {
    const out = mergeFsaLines([line({ baseAcres: 100, plcYield: 165 }), line({ baseAcres: 30, plcYield: 165 })])
    expect(out).toHaveLength(1)
    expect(out[0].baseAcres).toBe(130)
    expect(out[0].plcYield).toBe(165)
    expect(out[0].mergeNote).toBe('Merged 2 lines from upload: 100.0 + 30.0 ac')
  })

  it('never merges an unassigned-base row with an eligible row of the same commodity', () => {
    const out = mergeFsaLines([line(), line({ isUnassigned: true, baseAcres: 40, plcYield: null })])
    expect(out).toHaveLength(2)
    expect(out.every((m) => m.mergeNote === null)).toBe(true)
  })

  it('never merges unresolved lines (no commodity identified)', () => {
    const out = mergeFsaLines([line({ key: '' }), line({ key: '' })])
    expect(out).toHaveLength(2)
  })

  it('collapses exact re-reads before summing, so page overlap never double-counts a tract', () => {
    const out = mergeFsaLines([
      line({ baseAcres: 120, plcYield: 150 }),
      line({ baseAcres: 120, plcYield: 150 }), // same tract read again on an overlapping batch
      line({ baseAcres: 85.5, plcYield: 180 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].baseAcres).toBe(205.5)
    expect(out[0].sources).toHaveLength(3)
  })

  it('falls back to a simple mean of PLC yields when the merged lines carry no acre weights', () => {
    const out = mergeFsaLines([line({ baseAcres: null, plcYield: 150 }), line({ baseAcres: null, plcYield: 180 })])
    expect(out).toHaveLength(1)
    expect(out[0].baseAcres).toBeNull()
    expect(out[0].plcYield).toBe(165)
  })
})

describe('planBaseAcreSaves', () => {
  const row = (farm: string, commodity: string, acres: number, plc = 150) => ({
    farm_id: farm,
    commodity_id: commodity,
    base_acres: acres,
    plc_yield: plc,
  })

  it('passes a clean batch through unchanged', () => {
    const plan = planBaseAcreSaves([row('f1', 'corn', 120), row('f1', 'soy', 80), row('f2', 'corn', 60)])
    expect(plan.rows).toHaveLength(3)
    expect(plan.conflicts).toHaveLength(0)
  })

  it('collapses identical duplicates silently and never emits duplicate conflict keys', () => {
    const plan = planBaseAcreSaves([row('f1', 'corn', 120), row('f1', 'corn', 120), row('f1', 'soy', 80)])
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.rows).toHaveLength(2)
    const keys = plan.rows.map((r) => `${r.farm_id}|${r.commodity_id}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('reports contradictory duplicates as conflicts instead of letting the upsert fail', () => {
    const plan = planBaseAcreSaves([row('f1', 'corn', 120), row('f1', 'corn', 95), row('f1', 'soy', 80)])
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toEqual({ farm_id: 'f1', commodity_id: 'corn', count: 2, acres: [120, 95] })
    // The conflicted key is withheld entirely — no half of a contradiction saves.
    expect(plan.rows.map((r) => r.commodity_id)).toEqual(['soy'])
    expect(describeBaseAcreConflict(plan.conflicts[0], 'Farm 1234', 'Corn')).toBe(
      'Farm 1234 — Corn appears 2× with conflicting values (120.0 ac vs 95.0 ac)',
    )
  })

  it('a review-screen merge feeds a save plan with no duplicate conflict keys and no conflicts', () => {
    // End-to-end over the pure layer: raw extraction dupes → merge → plan.
    const merged = mergeFsaLines([
      line({ key: 'corn', baseAcres: 120, plcYield: 150 }),
      line({ key: 'corn', baseAcres: 85.5, plcYield: 180 }),
      line({ key: 'corn', baseAcres: 85.5, plcYield: 180 }),
      line({ key: 'soy', baseAcres: 80, plcYield: 45 }),
    ])
    const plan = planBaseAcreSaves(
      merged.map((m) => ({
        farm_id: 'f1',
        commodity_id: m.sources[0].key,
        base_acres: m.baseAcres ?? 0,
        plc_yield: m.plcYield ?? 0,
      })),
    )
    expect(plan.conflicts).toHaveLength(0)
    const keys = plan.rows.map((r) => `${r.farm_id}|${r.commodity_id}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(plan.rows.find((r) => r.commodity_id === 'corn')?.base_acres).toBe(205.5)
  })
})
