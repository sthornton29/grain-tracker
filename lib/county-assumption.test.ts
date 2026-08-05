import { describe, it, expect } from 'vitest'
import { parseYieldInput, planAssumptionSave, applySavePlan, saveErrorMessage, isUniqueViolation, type AssumptionDraft } from '@/lib/county-assumption'
import { countyAssumptionFor } from '@/lib/crop-insurance'
import type { CountyYieldAssumption } from '@/lib/types'

// The save/reload round trip behind the inline "My yield vs county" control:
// planAssumptionSave builds the write, applySavePlan models the DB, and
// countyAssumptionFor is the exact read both the Claims Monitor and the
// Crop Insurance settings card resolve through — so a value saved on one
// surface MUST come back on the other.

const draft = (over: Partial<AssumptionDraft> = {}): AssumptionDraft => ({ diff: '', abs: '', final: '', ...over })
const key = { cropId: 'corn', countyId: 'A', cropYear: 2026 }

const row = (over: Partial<CountyYieldAssumption> = {}): CountyYieldAssumption => ({
  id: 'r1', crop_id: 'corn', county_id: 'A', crop_year: 2026, variance_pct: 0,
  yield_differential: null, county_yield_override: null, rma_final_county_yield: null,
  notes: null, created_at: '', updated_at: '', ...over,
})

describe('parseYieldInput', () => {
  it('blank → null, numbers (incl. signed) parse, junk → null', () => {
    expect(parseYieldInput('')).toBeNull()
    expect(parseYieldInput('   ')).toBeNull()
    expect(parseYieldInput('+15')).toBe(15)
    expect(parseYieldInput('-10.5')).toBe(-10.5)
    expect(parseYieldInput('abc')).toBeNull()
  })
})

describe('save → reload round trip (crop × county × crop_year)', () => {
  it('first save inserts a row that the reload finds under the same key', () => {
    const plan = planAssumptionSave({ existing: null, ...key, draft: draft({ diff: '15' }) })
    expect(plan.kind).toBe('insert')
    const db = applySavePlan([], plan)
    expect(db).toHaveLength(1)
    // Both surfaces resolve through countyAssumptionFor:
    expect(countyAssumptionFor(db, 'corn', 'A', 2026)?.yield_differential).toBe(15)
    // …and the key is exact: other crop/county/year must NOT see it.
    expect(countyAssumptionFor(db, 'soy', 'A', 2026)).toBeNull()
    expect(countyAssumptionFor(db, 'corn', 'A', 2025)).toBeNull()
  })

  it('editing an existing row UPDATES in place — never delete-then-insert', () => {
    const existing = row({ yield_differential: 15, rma_final_county_yield: 172 })
    const plan = planAssumptionSave({ existing, ...key, draft: draft({ diff: '20', final: '172' }) })
    expect(plan.kind).toBe('update')
    const db = applySavePlan([existing], plan)
    expect(db).toHaveLength(1)
    const back = countyAssumptionFor(db, 'corn', 'A', 2026)!
    expect(back.id).toBe(existing.id) // same row, no destroy/recreate window
    expect(back.yield_differential).toBe(20)
    expect(back.rma_final_county_yield).toBe(172)
  })

  it('a null-county default row round-trips and serves as the fallback read', () => {
    const plan = planAssumptionSave({ existing: null, cropId: 'corn', countyId: null, cropYear: 2026, draft: draft({ diff: '5' }) })
    const db = applySavePlan([], plan)
    expect(countyAssumptionFor(db, 'corn', 'B', 2026)?.yield_differential).toBe(5)
  })

  it('blanking every field deletes the row; blank-on-nothing is a noop', () => {
    const existing = row({ yield_differential: 15 })
    const del = planAssumptionSave({ existing, ...key, draft: draft() })
    expect(del.kind).toBe('delete')
    expect(applySavePlan([existing], del)).toHaveLength(0)
    expect(planAssumptionSave({ existing: null, ...key, draft: draft() }).kind).toBe('noop')
  })

  it('re-saving the same values is a noop (blur without a change writes nothing)', () => {
    const existing = row({ yield_differential: 15, county_yield_override: 140 })
    const plan = planAssumptionSave({ existing, ...key, draft: draft({ diff: '15', abs: '140' }) })
    expect(plan.kind).toBe('noop')
  })
})

describe('saveErrorMessage', () => {
  it('maps the missing-047-column error to an actionable message', () => {
    expect(saveErrorMessage({ code: '42703', message: 'column county_yield_assumptions.yield_differential does not exist' }))
      .toMatch(/047/)
    expect(saveErrorMessage({ message: 'boom' })).toBe('boom')
  })
})

describe('insert collision (stale cached row) resolves as an update — no error', () => {
  it('stale null existing plans an insert; on 23505 the fresh row re-plans to an update onto the SAME row', () => {
    // The row already exists (created from the Claims Monitor, say) but this
    // surface's cached prop was still null → the naive plan is an insert.
    const fresh = row({ id: 'r9', yield_differential: 12 })
    const stale = planAssumptionSave({ existing: null, ...key, draft: draft({ diff: '20' }) })
    expect(stale.kind).toBe('insert')
    // The DB rejects it on the crop × county × crop_year unique key…
    expect(isUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint "county_yield_assumptions_key"' })).toBe(true)
    // …and re-planning against the freshly-fetched row lands on a clean update.
    const replan = planAssumptionSave({ existing: fresh, ...key, draft: draft({ diff: '20' }) })
    expect(replan.kind).toBe('update')
    const db = applySavePlan([fresh], replan)
    expect(db).toHaveLength(1)
    expect(db[0].id).toBe('r9') // same row — no duplicate, no destroy/recreate
    expect(db[0].yield_differential).toBe(20)
  })

  it('real failures are NOT treated as collisions', () => {
    expect(isUniqueViolation({ code: '42703', message: 'column yield_differential does not exist' })).toBe(false)
    expect(isUniqueViolation({ message: 'network error' })).toBe(false)
  })
})
