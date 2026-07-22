// Pure save/reload semantics for the shared county-yield assumption
// (county_yield_assumptions, differential model since 047). The inline
// CountyAssumptionControl builds a SavePlan here and executes it against
// Supabase; the plan is NEVER delete-then-insert, so a failed write (e.g. the
// 047 column missing) can no longer destroy the existing row. One row per
// crop × county × crop_year; blank inputs on all three fields clear the row.

import type { CountyYieldAssumption } from '@/lib/types'

/** Parse a yield-figure input: blank → null, non-numeric → null. */
export function parseYieldInput(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export type AssumptionDraft = {
  /** "my yield − county" differential, crop's own unit */
  diff: string
  /** absolute county-yield override (wins over the differential) */
  abs: string
  /** RMA final county yield (pins everything) */
  final: string
}

export type AssumptionValues = {
  yield_differential: number | null
  county_yield_override: number | null
  rma_final_county_yield: number | null
}

export type SavePlan =
  | { kind: 'noop' }
  | { kind: 'delete'; id: string }
  | { kind: 'update'; id: string; patch: AssumptionValues }
  | { kind: 'insert'; row: AssumptionValues & { crop_id: string; county_id: string | null; crop_year: number } }

export function draftValues(draft: AssumptionDraft): AssumptionValues {
  return {
    yield_differential: parseYieldInput(draft.diff),
    county_yield_override: parseYieldInput(draft.abs),
    rma_final_county_yield: parseYieldInput(draft.final),
  }
}

const numEq = (a: number | null, b: number | null) =>
  (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9)

/** Build the write for one blur/save. Update-in-place when a row exists (never
 *  delete-then-insert); delete only when every field is blank; noop when
 *  nothing changed. */
export function planAssumptionSave(args: {
  existing: Pick<CountyYieldAssumption, 'id' | 'yield_differential' | 'county_yield_override' | 'rma_final_county_yield'> | null
  cropId: string
  countyId: string | null
  cropYear: number
  draft: AssumptionDraft
}): SavePlan {
  const v = draftValues(args.draft)
  const empty = v.yield_differential == null && v.county_yield_override == null && v.rma_final_county_yield == null
  const e = args.existing
  if (!e) {
    if (empty) return { kind: 'noop' }
    return { kind: 'insert', row: { crop_id: args.cropId, county_id: args.countyId, crop_year: args.cropYear, ...v } }
  }
  if (empty) return { kind: 'delete', id: e.id }
  if (
    numEq(v.yield_differential, e.yield_differential) &&
    numEq(v.county_yield_override, e.county_yield_override) &&
    numEq(v.rma_final_county_yield, e.rma_final_county_yield)
  ) return { kind: 'noop' }
  return { kind: 'update', id: e.id, patch: v }
}

/** Apply a SavePlan to an in-memory row set — the reload the pages perform is
 *  just "select *", so this models the full save → reload round trip for
 *  tests. `makeId` supplies the id for inserts. */
export function applySavePlan(
  rows: readonly CountyYieldAssumption[],
  plan: SavePlan,
  makeId: () => string = () => `id-${rows.length + 1}`,
): CountyYieldAssumption[] {
  switch (plan.kind) {
    case 'noop':
      return [...rows]
    case 'delete':
      return rows.filter((r) => r.id !== plan.id)
    case 'update':
      return rows.map((r) => (r.id === plan.id ? { ...r, ...plan.patch } : r))
    case 'insert':
      return [
        ...rows,
        {
          id: makeId(),
          variance_pct: 0,
          notes: null,
          created_at: '',
          ...plan.row,
        },
      ]
  }
}

/** Human message for a failed write. 42703 (undefined column) means the 047
 *  migration hasn't been run against this database. */
export function saveErrorMessage(err: { code?: string | null; message?: string | null } | null | undefined): string {
  if (err?.code === '42703' || /yield_differential.*does not exist/i.test(err?.message ?? '')) {
    return 'Not saved — the database is missing migration 047 (yield_differential). Run supabase/047_county_yield_differential.sql in the Supabase SQL editor, then retry.'
  }
  return err?.message || 'Save failed.'
}
