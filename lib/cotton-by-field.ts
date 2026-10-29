// Seed Cotton Loads — the "by field" bars (2026-10-28). One row per cotton
// field with any activity or planting this crop year, every bar on ONE shared
// pounds axis (0 → the largest field's max(actual, expected)), so a big field
// half done reads as a long ghost half filled and a small finished field as a
// short solid bar. Pure: the page feeds it the season flow's per-field pounds
// (lib/cotton-loads seasonFlow) and each planted field's expected seed cotton
// (expectedSeedLbsForPlanting below — the Yields page's expectation and
// turnout seams), and renders the fractions it hands back.

import type { SeasonFlowField } from '@/lib/cotton-loads'
import { expectedYieldForPlanting, type ExpectedYieldAssumption } from '@/lib/yields'
import type { Cropping } from '@/lib/plantings'

export type FieldBarStatus = 'not_started' | 'picking' | 'on_yard' | 'all_ginned'

export const FIELD_STATUS_LABEL: Record<FieldBarStatus, string> = {
  not_started: 'Not started',
  picking: 'Picking',
  on_yard: 'On the yard',
  all_ginned: 'All ginned',
}

/** Chip classes per status — data colors on the stock palette (never brand green). */
export const FIELD_STATUS_CHIP: Record<FieldBarStatus, string> = {
  not_started: 'bg-slate-100 text-slate-500',
  picking: 'bg-sky-100 text-sky-800',
  on_yard: 'bg-amber-100 text-amber-800',
  all_ginned: 'bg-green-100 text-green-800',
}

/** Default order: fields with cotton on the yard first, then picking, then all ginned, then not started. */
const STATUS_ORDER: Record<FieldBarStatus, number> = { on_yard: 0, picking: 1, all_ginned: 2, not_started: 3 }

export type PlantedFieldInput = {
  fieldId: string
  /** Planted cotton acres this crop year. */
  acres: number
  /** Expected seed cotton pounds (acres × expected lint/ac ÷ turnout); null = no expectation on file. */
  expectedSeedLbs: number | null
  /** Why there is no expectation (shown in the tooltip when expectedSeedLbs is null). */
  expectationNote?: string | null
}

export type FieldBarRow = {
  fieldId: string | null
  /** Planted acres; null for a field with loads but no cotton planting (or the no-field bucket). */
  acres: number | null
  loads: number
  /** Every roll counted on the field's loads. */
  rolls: number
  yardRolls: number
  ginnedLbs: number
  yardLbs: number
  /** ginned + yard — everything hauled off the field. */
  netLbs: number
  expectedLbs: number | null
  expectationNote: string | null
  /** netLbs ÷ expectedLbs × 100; null without an expectation. */
  pctOfExpected: number | null
  /** ginnedLbs ÷ netLbs × 100; null when nothing is hauled. */
  pctGinned: number | null
  status: FieldBarStatus
  // ---- fractions of the shared axis (0–1) the bar renders from ----
  ginnedFrac: number
  yardFrac: number
  /** The faint outlined track out to the expectation; null without one. */
  ghostFrac: number | null
  /** The expectation tick when actual runs past it; null otherwise. */
  tickFrac: number | null
}

/**
 * Status rule:
 *   not_started — nothing hauled yet (no loads);
 *   all_ginned  — hauled and nothing left on the yard (every load is on a receipt);
 *   picking     — seed cotton on the yard, NOTHING ginned yet, and an
 *                 expectation on file the field is still well short of
 *                 (< 95% of expected): modules are still coming off the field;
 *   on_yard     — seed cotton on the yard otherwise: some of it already ginned
 *                 (the gin has started on this field), at/over the expectation,
 *                 or no expectation to judge against — picked, waiting on the gin.
 */
export function fieldBarStatus(f: { loads: number; yardLbs: number; ginnedLbs: number; netLbs: number; expectedLbs: number | null }): FieldBarStatus {
  if (f.loads === 0 && f.netLbs <= 0) return 'not_started'
  if (f.yardLbs <= 0) return 'all_ginned'
  if (f.ginnedLbs <= 0 && f.expectedLbs != null && f.expectedLbs > 0 && f.netLbs < 0.95 * f.expectedLbs) return 'picking'
  return 'on_yard'
}

/**
 * The rows and their shared axis. A field appears when it has loads this crop
 * year (a season-flow field) or a cotton planting (a planted field) — a planted
 * field nothing has come off yet is "not started" with a ghost only.
 */
export function buildFieldBars(args: {
  flowFields: ReadonlyArray<SeasonFlowField>
  planted: ReadonlyArray<PlantedFieldInput>
}): { rows: FieldBarRow[]; axisMax: number } {
  const plantedById = new Map(args.planted.map((p) => [p.fieldId, p]))
  const seen = new Set<string | null>()
  const base: Array<Omit<FieldBarRow, 'ginnedFrac' | 'yardFrac' | 'ghostFrac' | 'tickFrac'>> = []
  const push = (fieldId: string | null, flow: SeasonFlowField | null, planted: PlantedFieldInput | null) => {
    const ginnedLbs = flow?.ginnedLbs ?? 0
    const yardLbs = flow?.yardLbs ?? 0
    const netLbs = flow?.netLbs ?? ginnedLbs + yardLbs
    const expectedLbs = planted?.expectedSeedLbs != null && planted.expectedSeedLbs > 0 ? planted.expectedSeedLbs : null
    const loads = flow?.loads ?? 0
    base.push({
      fieldId,
      acres: planted ? planted.acres : null,
      loads,
      rolls: flow?.rolls ?? 0,
      yardRolls: flow?.yardRolls ?? 0,
      ginnedLbs, yardLbs, netLbs,
      expectedLbs,
      expectationNote: expectedLbs == null ? planted?.expectationNote ?? (planted ? 'No expectation on file' : 'No cotton planting on file for this field') : null,
      pctOfExpected: expectedLbs != null ? (netLbs / expectedLbs) * 100 : null,
      pctGinned: netLbs > 0 ? (ginnedLbs / netLbs) * 100 : null,
      status: fieldBarStatus({ loads, yardLbs, ginnedLbs, netLbs, expectedLbs }),
    })
  }
  for (const f of args.flowFields) {
    seen.add(f.fieldId)
    push(f.fieldId, f, f.fieldId ? plantedById.get(f.fieldId) ?? null : null)
  }
  for (const p of args.planted) {
    if (seen.has(p.fieldId)) continue
    seen.add(p.fieldId)
    push(p.fieldId, null, p)
  }
  const axisMax = Math.max(1, ...base.map((r) => Math.max(r.netLbs, r.expectedLbs ?? 0)))
  const rows: FieldBarRow[] = base.map((r) => ({
    ...r,
    ginnedFrac: r.ginnedLbs / axisMax,
    yardFrac: r.yardLbs / axisMax,
    ghostFrac: r.expectedLbs != null ? r.expectedLbs / axisMax : null,
    tickFrac: r.expectedLbs != null && r.netLbs > r.expectedLbs ? r.expectedLbs / axisMax : null,
  }))
  return { rows, axisMax }
}

export type FieldBarSort = 'default' | 'name' | 'pounds' | 'pct'

export const FIELD_BAR_SORT_LABEL: Record<FieldBarSort, string> = {
  default: 'Status',
  name: 'Name',
  pounds: 'Pounds',
  pct: '% of expected',
}

export function sortFieldBars(rows: ReadonlyArray<FieldBarRow>, key: FieldBarSort, nameOf: (fieldId: string | null) => string): FieldBarRow[] {
  const byName = (a: FieldBarRow, b: FieldBarRow) => nameOf(a.fieldId).localeCompare(nameOf(b.fieldId), undefined, { numeric: true, sensitivity: 'base' })
  const out = [...rows]
  out.sort((a, b) => {
    // The no-field bucket always sits last.
    if ((a.fieldId == null) !== (b.fieldId == null)) return a.fieldId == null ? 1 : -1
    let c = 0
    switch (key) {
      case 'name': c = byName(a, b); break
      case 'pounds': c = b.netLbs - a.netLbs; break
      case 'pct':
        if ((a.pctOfExpected == null) !== (b.pctOfExpected == null)) c = a.pctOfExpected == null ? 1 : -1
        else c = (b.pctOfExpected ?? 0) - (a.pctOfExpected ?? 0)
        break
      default:
        c = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        if (c === 0) c = b.netLbs - a.netLbs
    }
    return c !== 0 ? c : byName(a, b)
  })
  return out
}

/**
 * A planted field's expected seed cotton: planted acres × the expected LINT
 * yield the Yields page judges the planting against (crop_assumptions via
 * expectedYieldForPlanting — per practice, double-crop breakout when the field
 * is double-cropped) ÷ the resolved turnout fraction (lib/cotton resolveTurnout).
 * Null with a plain reason when either side is missing.
 */
export function expectedSeedLbsForPlanting(args: {
  plantedAcres: number
  assumption: ExpectedYieldAssumption | null | undefined
  practice: { irrigated_acres: number | string | null; dryland_acres: number | string | null }
  cropping?: Cropping
  /** Turnout as a fraction (0.40); null/0 = none on file. */
  turnoutFraction: number | null | undefined
  cropName?: string
  cropYear?: number
}): { lbs: number | null; note: string | null } {
  const lint = expectedYieldForPlanting(args.assumption, args.practice, args.cropping ?? 'full_season')
  const who = `${args.cropName ?? 'Cotton'}${args.cropYear != null ? ` ${args.cropYear}` : ''}`
  if (lint == null) {
    return { lbs: null, note: args.cropping === 'double_crop' ? `No double-crop expected yield for ${who} in Marketing assumptions` : `No expected lint yield for ${who} in Marketing assumptions` }
  }
  const t = args.turnoutFraction
  if (t == null || !(t > 0)) return { lbs: null, note: 'No turnout on file' }
  if (!(args.plantedAcres > 0)) return { lbs: null, note: 'No planted acres on file' }
  return { lbs: (args.plantedAcres * lint) / t, note: null }
}

/** "0" … "400,000 lb" — the light scale labels over the bar column. */
export function axisLabels(axisMax: number, fmt: (n: number) => string): { left: string; mid: string; right: string } {
  return { left: '0', mid: fmt(Math.round(axisMax / 2)), right: `${fmt(Math.round(axisMax))} lb` }
}
