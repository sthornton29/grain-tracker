'use client'

// Cotton yields section (092) — the cotton table on the Yields page and the
// Season Summary, FED by the page (no reads of its own): one row per cotton
// planting of the year, classified by the SAME engine as grain (harvest
// status from the seed cotton loads via lib/yields buildYieldInputs + the
// cotton adapter) with the lint estimate for picked-but-unginned cotton
// layered on top (lib/cotton.ts cottonPlantingYield). Harvest status is not a
// column (2026-10-12, Stuart: it carried no information on a table that is
// mostly finished fields): a not-yet-complete row is dimmed, and its status
// line — "still being picked" with Count anyway, "nothing picked yet", or the
// counted-as-finished note with Undo — lives in the row's detail. Ginning
// status stays a column: a field can be picked out and still on the yard.
//
// Columns: Farm · Field · Acres · Seed cotton lbs · Seed cotton lbs/ac ·
// Lint lbs (actual / est.) · Lint lbs/ac · Turnout % (actual / est.) · Bales ·
// Ginning status. The export keeps a Harvest status column so a spreadsheet
// can still tell the rows apart. The drill-down lists the field's seed cotton
// loads and its gin receipts, with totals that equal the row.
//
// Irrigated / dryland (2026-11-18): the Yields page's Practice filter and
// "Irrigated / Dryland breakdown" switch drive the same columns the grain
// table shows — Irr ac · Dry ac after Acres, Irrigated / Dryland lint lbs/ac
// beside Lint lbs/ac (`practiceColumns`) — and a mixed field's split is
// allocated in lint lbs from the breakdown's own column (`split`; the page
// renders the shared PracticeSplitEditor). The per-row figures come from
// lib/yields cottonPracticeYields; without `practiceColumns` (Season Summary,
// the rollup drill-downs) the table is unchanged.

import { Fragment, useState, type ReactNode } from 'react'
import { TurnoutLines, type CottonTurnoutLine } from '@/components/reports/turnout-control'
import { InfoTip, fmtNum, fmtInt, theadCls, grandTotalRowCls } from '@/components/reports/report-kit'
import { fmtDateShort } from '@/lib/format-date'
import { formatCottonPrice } from '@/lib/hedging'
import { buildCottonFieldDetail } from '@/lib/yield-detail'
import { GINNING_STATUS_LABEL, type CottonPlantingYield } from '@/lib/cotton'
import type { CottonYieldModel } from '@/lib/cotton-yield-sources'
import { compareLoadNumbers } from '@/lib/cotton-loads'
import type { CottonPracticeYields, ExclusionReason, HarvestStatus } from '@/lib/yields'
import type { ExportColumn, ExportSection } from '@/lib/exports'

export type CottonSectionRow = {
  key: string
  plantingId: string
  fieldId: string
  cropId: string
  cropName: string
  year: number
  farmName: string
  fieldName: string
  acres: number
  y: CottonPlantingYield
  status: HarvestStatus
  /** The automatic classification (before "count anyway"). */
  autoFlag: ExclusionReason | undefined
  /** yield_include_override === true on an in-progress field. */
  overridden: boolean
  noBaseline: boolean
  /** Irrigated / dryland figures (lib/yields cottonPracticeYields); only the
   *  Yields page's main cotton table carries them. */
  practice?: CottonPracticeYields
}

/** Which irrigated / dryland columns show — the grain table's rules, worked
 *  out by the page: the breakdown switch shows both sides + the total; a
 *  Practice filter shows its one side (falling back to the field's whole lint
 *  per acre where a mixed field has no split yet) and hides the total. */
export type CottonPracticeColumns = {
  irrigated: boolean
  dryland: boolean
  total: boolean
  fallback: 'irrigated' | 'dryland' | null
  /** The breakdown is on: the allocate column shows. */
  allocate: boolean
}

const TOTAL_ONLY: CottonPracticeColumns = { irrigated: false, dryland: false, total: true, fallback: null, allocate: false }

/** The irrigated / dryland lint per acre a row shows (with the Practice-filter fall-back). */
function practicePerAcre(r: CottonSectionRow, side: 'irrigated' | 'dryland', cols: CottonPracticeColumns): number | null {
  const v = side === 'irrigated' ? r.practice?.irrigatedPerAcre : r.practice?.drylandPerAcre
  if (v != null) return v
  const unsplit = r.practice?.kind === 'mixed' && !r.practice.entered
  return cols.fallback === side && unsplit ? r.y.lintPerAcre : null
}

/** Total row: each side's lint over the acres whose lint is known on that side
 *  (the grain rollups' rule), plus the fall-back rows the column shows. */
function practiceTotalsOf(rows: readonly CottonSectionRow[], cols: CottonPracticeColumns) {
  const t = { irrAc: 0, dryAc: 0, irrLbs: 0, irrLbsAc: 0, dryLbs: 0, dryLbsAc: 0 }
  for (const r of rows) {
    const p = r.practice
    if (!p) continue
    t.irrAc += p.irrAc
    t.dryAc += p.dryAc
    const unsplit = p.kind === 'mixed' && !p.entered
    if (p.irrigatedLbs != null) { t.irrLbs += p.irrigatedLbs; t.irrLbsAc += p.irrAc }
    else if (unsplit && cols.fallback === 'irrigated') { t.irrLbs += r.y.lintLbs; t.irrLbsAc += r.acres }
    if (p.drylandLbs != null) { t.dryLbs += p.drylandLbs; t.dryLbsAc += p.dryAc }
    else if (unsplit && cols.fallback === 'dryland') { t.dryLbs += r.y.lintLbs; t.dryLbsAc += r.acres }
  }
  return {
    ...t,
    irrPerAcre: t.irrLbsAc > 0 && t.irrLbs > 0 ? t.irrLbs / t.irrLbsAc : null,
    dryPerAcre: t.dryLbsAc > 0 && t.dryLbs > 0 ? t.dryLbs / t.dryLbsAc : null,
  }
}

export type { CottonTurnoutLine }

const lbs = (n: number | null | undefined) => (n == null ? '—' : fmtInt(Math.round(n)))

function EstChip({ y, soFar }: { y: CottonPlantingYield; soFar: boolean }) {
  if (y.lintBasis == null || y.lintBasis === 'actual') return null
  const label = soFar ? 'so far' : y.lintBasis === 'mixed' ? 'part est.' : 'est.'
  return (
    <InfoTip label={label} tone="warning" className="ml-1">
      {y.lintBasis === 'mixed'
        ? `${lbs(y.actualLintLbs)} lbs of lint are on gin receipts; the other ${lbs(y.estimatedLintLbs)} lbs are ${lbs(y.yardSeedLbs)} lbs of seed cotton still on the yard at ${y.turnout.label}.`
        : `${lbs(y.yardSeedLbs)} lbs of seed cotton are picked but not ginned yet. Lint is estimated at ${y.turnout.label}${soFar ? '; more loads may still come from this field' : ''}.`}
    </InfoTip>
  )
}

function GinningBadge({ y }: { y: CottonPlantingYield }) {
  const g = y.ginning
  if (g === 'none') return <span className="text-slate-400">—</span>
  const cls = g === 'ginned' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`text-xs rounded-full px-2 py-0.5 ${cls}`}>{GINNING_STATUS_LABEL[g]}</span>
      {g !== 'ginned' && <span className="text-xs text-slate-500 whitespace-nowrap">{lbs(y.yardSeedLbs)} lbs on yard</span>}
    </span>
  )
}

const detailBtnCls = 'inline-flex items-center min-h-10 px-2 rounded-lg border border-slate-300 bg-white text-brand-deep text-xs font-semibold disabled:opacity-50 no-print'

/** Seed cotton loads + gin receipts behind one row; totals equal the row.
 *  The field's harvest status lives here, not in the table: still being
 *  picked (with Count anyway), nothing picked yet, or counted as finished by
 *  hand (with Undo). Handlers absent = read-only. */
export function CottonRowDetail({ r, model, allowLoadLinks, onCountAnyway, onUndoCount, saving }: {
  r: CottonSectionRow
  model: CottonYieldModel
  allowLoadLinks: boolean
  onCountAnyway?: (plantingId: string) => void
  onUndoCount?: (plantingId: string) => void
  saving?: boolean
}) {
  const src = model.sources
  const statusNote = r.overridden ? (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      <span>Counted as finished — you marked this field done while it still read in progress.</span>
      {onUndoCount && <button type="button" disabled={saving} onClick={() => onUndoCount(r.plantingId)} className={detailBtnCls}>Undo</button>}
    </div>
  ) : r.status === 'in_progress' ? (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      <span className="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800">in progress</span>
      <span>Still being picked — its lint is not in the averages yet.</span>
      {onCountAnyway && <button type="button" disabled={saving} onClick={() => onCountAnyway(r.plantingId)} className={detailBtnCls}>Count anyway</button>}
    </div>
  ) : r.status === 'unharvested' ? (
    <div className="text-xs text-slate-500">Nothing picked from this field yet.</div>
  ) : r.noBaseline ? (
    <div className="text-xs text-slate-500">Counted as finished — no other picked fields and no yield estimate to compare against yet.</div>
  ) : null
  if (!src) return statusNote
  const loads = [...model.loadsFor(r.fieldId, r.year)].sort((a, b) => compareLoadNumbers(a.load_number, b.load_number))
  const receipts = [...model.receiptsFor(r.fieldId, r.year)].sort((a, b) => ((a.receipt_date ?? '') < (b.receipt_date ?? '') ? -1 : 1))
  const ginName = new Map(src.gins.map((g) => [g.id, g.name]))
  const receiptNo = new Map(src.receipts.map((x) => [x.id, x.receipt_number]))
  const d = buildCottonFieldDetail({
    fieldIds: new Set([r.fieldId]), cropYear: r.year,
    ginReceipts: src.receipts.map((x) => ({ id: x.id, field_id: x.field_id, crop_year: x.crop_year, bales_count: x.bales_count, total_bale_weight: x.total_bale_weight == null ? null : Number(x.total_bale_weight), total_seed_cotton_weight: x.total_seed_cotton_weight == null ? null : Number(x.total_seed_cotton_weight) })),
    bales: src.bales, baleGrades: src.baleGrades,
    yardLoads: src.loads.map((l) => ({ field_id: l.field_id, crop_year: l.crop_year, net_weight: l.net_weight == null ? null : Number(l.net_weight), onReceipt: src.ginnedLoadIds.has(l.id) })),
  })
  const balesByReceipt = new Map<string, { lbs: number; count: number }>()
  for (const b of src.bales) {
    const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    g.lbs += Number(b.net_weight_lbs) || 0
    g.count += 1
    balesByReceipt.set(b.gin_receipt_id, g)
  }
  const stat = (label: string, value: string) => (
    <div key={label} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 whitespace-nowrap">{label}</div>
      <div className="text-sm font-semibold tabular-nums whitespace-nowrap">{value}</div>
    </div>
  )
  return (
    <div className="space-y-3">
      {statusNote}
      <div className="flex flex-wrap gap-2">
        {stat('Seed cotton', `${lbs(r.y.seedLbs)} lbs · ${r.y.loadCount} load${r.y.loadCount === 1 ? '' : 's'}`)}
        {stat('Lint', `${lbs(r.y.lintLbs)} lbs${r.y.lintBasis === 'actual' || r.y.lintBasis == null ? '' : r.y.lintBasis === 'mixed' ? ' (part est.)' : ' (est.)'}`)}
        {stat('Gin receipts', String(d.receiptCount))}
        {stat('Bales', d.avgBaleLbs != null ? `${d.baleCount} · avg ${lbs(d.avgBaleLbs)} lbs` : String(d.baleCount))}
        {stat('Turnout', r.y.turnoutPct != null ? `${r.y.turnoutPct}%${r.y.turnoutBasis === 'estimated' ? ' est.' : ''}` : '—')}
        {d.weightedLoanCentsPerLb != null && stat(`Avg loan value (${d.classedBaleCount} classed)`, formatCottonPrice(d.weightedLoanCentsPerLb, { perLb: true }))}
        {d.yardLoadCount > 0 && stat('Still on the yard', `${lbs(d.yardSeedCottonLbs)} lbs seed cotton · ${d.yardLoadCount} load${d.yardLoadCount === 1 ? '' : 's'}`)}
      </div>
      {loads.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                <th className="text-left px-3 py-2 whitespace-nowrap">Load #</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Picked</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Delivered</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Truck</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Gin</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Seed cotton lbs</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Rolls</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Ginned</th>
              </tr>
            </thead>
            <tbody>
              {loads.map((l) => {
                const rid = src.receiptByLoadId.get(l.id)
                return (
                  <tr key={l.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-medium">
                      {allowLoadLinks ? <a href={`/cotton/loads/${l.id}`} className="text-brand-deep hover:underline">{l.load_number}</a> : l.load_number}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{l.picked_date ? fmtDateShort(l.picked_date) : '—'}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{l.delivered_date ? fmtDateShort(l.delivered_date) : '—'}</td>
                    <td className="px-3 py-1.5">{l.truck ?? ''}</td>
                    <td className="px-3 py-1.5">{l.gin_id ? ginName.get(l.gin_id) ?? '' : ''}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{lbs(Number(l.net_weight) || 0)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.rolls ?? ''}</td>
                    <td className="px-3 py-1.5 text-xs">{rid ? <span className="text-green-800">receipt {receiptNo.get(rid) ?? ''}</span> : <span className="text-amber-700">on yard</span>}</td>
                  </tr>
                )
              })}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-3 py-1.5" colSpan={5}>{loads.length} load{loads.length === 1 ? '' : 's'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{lbs(r.y.seedLbs)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{loads.reduce((s, l) => s + (Number(l.rolls) || 0), 0) || ''}</td>
                <td className="px-3 py-1.5 text-xs">{r.y.yardSeedLbs > 0 ? `${lbs(r.y.yardSeedLbs)} lbs on yard` : 'all ginned'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {receipts.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                <th className="text-left px-3 py-2 whitespace-nowrap">Gin receipt</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Date</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Gin</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Seed cotton lbs</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Bales</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Lint lbs</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Turnout</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((x) => {
                const fromBales = balesByReceipt.get(x.id)
                const lint = fromBales && fromBales.lbs > 0 ? fromBales.lbs : Number(x.total_bale_weight) || 0
                const count = fromBales && fromBales.count > 0 ? fromBales.count : Number(x.bales_count) || 0
                const seed = Number(x.total_seed_cotton_weight) || 0
                return (
                  <tr key={x.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-medium">
                      {allowLoadLinks ? <a href={`/cotton/receipts/${x.id}`} className="text-brand-deep hover:underline">{x.receipt_number}</a> : x.receipt_number}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{x.receipt_date ? fmtDateShort(x.receipt_date) : '—'}</td>
                    <td className="px-3 py-1.5">{x.gin_id ? ginName.get(x.gin_id) ?? '' : ''}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{seed > 0 ? lbs(seed) : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{count}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{lbs(lint)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{seed > 0 && lint > 0 ? `${Math.round((lint / seed) * 1000) / 10}%` : '—'}</td>
                  </tr>
                )
              })}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-3 py-1.5" colSpan={4}>{receipts.length} receipt{receipts.length === 1 ? '' : 's'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.y.bales}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{lbs(r.y.actualLintLbs)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.y.turnoutBasis === 'actual' && r.y.turnoutPct != null ? `${r.y.turnoutPct}%` : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {r.y.estimatedLintLbs > 0 && (
        <p className="text-xs text-slate-600">
          Row lint = {lbs(r.y.actualLintLbs)} lbs on receipts + {lbs(r.y.yardSeedLbs)} lbs seed cotton on the yard × {r.y.turnout.label} = <span className="font-semibold">{lbs(r.y.lintLbs)} lbs</span>.
        </p>
      )}
      {loads.length === 0 && receipts.length === 0 && <p className="text-sm text-slate-500">No seed cotton loads or gin receipts recorded yet.</p>}
    </div>
  )
}

/** The export's columns, in the screen's order, for the columns on screen. */
function cottonSectionColumns(cols: CottonPracticeColumns): ExportColumn[] {
  return [
    { label: 'Farm' },
    { label: 'Field' },
    { label: 'Year', format: 'text' },
    { label: 'Acres', align: 'right', format: 'acres' },
    ...(cols.irrigated ? [{ label: 'Irr ac', align: 'right', format: 'acres' } as ExportColumn] : []),
    ...(cols.dryland ? [{ label: 'Dry ac', align: 'right', format: 'acres' } as ExportColumn] : []),
    { label: 'Seed cotton lbs', align: 'right', format: 'lbs' },
    { label: 'Seed cotton lbs/ac', align: 'right', format: 'yield' },
    { label: 'Lint lbs', align: 'right', format: 'lbs' },
    { label: 'Lint basis' },
    ...(cols.irrigated ? [{ label: 'Irrigated lint lbs/ac', align: 'right', format: 'yield' } as ExportColumn] : []),
    ...(cols.dryland ? [{ label: 'Dryland lint lbs/ac', align: 'right', format: 'yield' } as ExportColumn] : []),
    ...(cols.total ? [{ label: 'Lint lbs/ac', align: 'right', format: 'yield' } as ExportColumn] : []),
    { label: 'Turnout %', align: 'right', format: 'pct1' },
    { label: 'Turnout basis' },
    { label: 'Bales', align: 'right', format: 'int' },
    { label: 'Harvest status' },
    { label: 'Ginning status' },
  ]
}

export const COTTON_SECTION_COLUMNS: ExportColumn[] = cottonSectionColumns(TOTAL_ONLY)

const STATUS_LABEL: Record<HarvestStatus, string> = { complete: 'complete', in_progress: 'in progress', unharvested: 'not picked' }

/** The cotton table as an export section (the on-screen columns plus Harvest
 *  status, which the screen keeps in the row detail). `practiceColumns` = the
 *  irrigated / dryland columns showing on screen. */
export function cottonSectionExport(rows: readonly CottonSectionRow[], title?: string, practiceColumns: CottonPracticeColumns = TOTAL_ONLY): ExportSection {
  const cols = practiceColumns
  const data = rows.map((r) => [
    r.farmName, r.fieldName, r.year, r.acres,
    // No irrigated / dryland acres is a blank, as on screen — not 0.0.
    ...(cols.irrigated ? [r.practice && r.practice.irrAc > 0 ? r.practice.irrAc : ''] : []),
    ...(cols.dryland ? [r.practice && r.practice.dryAc > 0 ? r.practice.dryAc : ''] : []),
    r.y.seedLbs > 0 ? r.y.seedLbs : '',
    r.y.seedPerAcre ?? '',
    r.y.lintLbs > 0 ? r.y.lintLbs : '',
    r.y.lintBasis == null ? '' : r.y.lintBasis === 'actual' ? 'actual' : r.y.lintBasis === 'mixed' ? `part est. (${r.y.turnout.label})` : `est. (${r.y.turnout.label})`,
    ...(cols.irrigated ? [practicePerAcre(r, 'irrigated', cols) ?? ''] : []),
    ...(cols.dryland ? [practicePerAcre(r, 'dryland', cols) ?? ''] : []),
    ...(cols.total ? [r.y.lintPerAcre ?? ''] : []),
    r.y.turnoutPct ?? '',
    r.y.turnoutBasis == null ? '' : r.y.turnoutBasis === 'actual' ? 'actual' : 'est.',
    // No bales yet is a blank, as on screen — not a 0.
    r.y.bales > 0 ? r.y.bales : '',
    // Amber "in progress", as in the row's detail on screen.
    r.overridden ? 'complete (counted)' : r.status === 'in_progress' ? { v: STATUS_LABEL[r.status], tone: 'warning' } : STATUS_LABEL[r.status],
    // The badge's colors: green once ginned, amber while seed cotton is on the yard.
    r.y.ginning === 'none' ? '' : { v: GINNING_STATUS_LABEL[r.y.ginning], tone: r.y.ginning === 'ginned' ? 'favorable' : 'warning' },
  ] as ExportSection['rows'][number])
  const t = totalsOf(rows)
  const pt = practiceTotalsOf(rows, cols)
  // The total leaves blank what the screen's total row leaves blank.
  data.push([
    'Total', '', '', t.acres,
    ...(cols.irrigated ? [pt.irrAc > 0 ? pt.irrAc : ''] : []),
    ...(cols.dryland ? [pt.dryAc > 0 ? pt.dryAc : ''] : []),
    t.seed > 0 ? t.seed : '', t.acres > 0 && t.seed > 0 ? t.seed / t.acres : '', t.lint > 0 ? t.lint : '', t.est > 0 ? 'incl. est.' : '',
    ...(cols.irrigated ? [pt.irrPerAcre ?? ''] : []),
    ...(cols.dryland ? [pt.dryPerAcre ?? ''] : []),
    ...(cols.total ? [t.acres > 0 && t.lint > 0 ? t.lint / t.acres : ''] : []),
    t.seedGinned > 0 && t.actual > 0 ? Math.round((t.actual / t.seedGinned) * 1000) / 10 : '', '', t.bales > 0 ? t.bales : '', '', '',
  ] as ExportSection['rows'][number])
  // Farm + Field stay in view while the columns scroll.
  return { title, freezeColumns: 2, columns: cottonSectionColumns(cols), rows: data, rowMeta: [...rows.map(() => 'data' as const), 'total'] }
}

function totalsOf(rows: readonly CottonSectionRow[]) {
  return rows.reduce(
    (t, r) => ({
      acres: t.acres + r.acres,
      seed: t.seed + r.y.seedLbs,
      lint: t.lint + r.y.lintLbs,
      actual: t.actual + r.y.actualLintLbs,
      est: t.est + r.y.estimatedLintLbs,
      // Seed cotton on receipts (the actual-turnout denominator): seed − yard.
      seedGinned: t.seedGinned + Math.max(0, r.y.seedLbs - r.y.yardSeedLbs),
      bales: t.bales + r.y.bales,
      yard: t.yard + r.y.yardSeedLbs,
    }),
    { acres: 0, seed: 0, lint: 0, actual: 0, est: 0, seedGinned: 0, bales: 0, yard: 0 },
  )
}

export default function CottonYieldsSection({
  rows, turnouts, model, title, subtitle, showYear, canEdit, allowLoadLinks, loading,
  onSaveTurnout, onCountAnyway, onUndoCount, savingPlantingId, openKey, onToggle, standalone, emptyText,
  practiceColumns, split,
}: {
  rows: readonly CottonSectionRow[]
  turnouts: readonly CottonTurnoutLine[]
  model: CottonYieldModel
  title: string
  subtitle?: string
  showYear?: boolean
  canEdit: boolean
  allowLoadLinks: boolean
  loading?: boolean
  /** Save a manual turnout for a crop × year (null clears). Absent = read-only. */
  onSaveTurnout?: (cropId: string, year: number, v: number | null) => void
  onCountAnyway?: (plantingId: string) => void
  onUndoCount?: (plantingId: string) => void
  savingPlantingId?: string | null
  /** Controlled open detail (the page owns one open detail across views); uncontrolled when absent. */
  openKey?: string | null
  onToggle?: (key: string) => void
  /** Render as the page's main table (no section card). */
  standalone?: boolean
  emptyText?: string
  /** The irrigated / dryland columns on screen (the page's Practice filter +
   *  breakdown switch). Absent = the total only, as before. */
  practiceColumns?: CottonPracticeColumns
  /** Allocating a mixed field's irrigated / dryland lint (breakdown on). The
   *  page owns the open editor and renders it. Absent = no allocate controls. */
  split?: {
    canEdit: boolean
    openId: string | null
    onOpen: (plantingId: string) => void
    renderEditor: (r: CottonSectionRow) => ReactNode
  }
}) {
  const [localOpen, setLocalOpen] = useState<string | null>(null)
  const open = onToggle ? openKey ?? null : localOpen
  const toggle = (key: string) => (onToggle ? onToggle(key) : setLocalOpen((k) => (k === key ? null : key)))
  const t = totalsOf(rows)
  const anyEst = t.est > 0
  const cols = practiceColumns ?? TOTAL_ONLY
  const pt = practiceTotalsOf(rows, cols)
  const practiceColCount = (cols.irrigated ? 2 : 0) + (cols.dryland ? 2 : 0) - (cols.total ? 0 : 1) + (cols.allocate ? 1 : 0)
  const colCount = 11 + (showYear ? 1 : 0) + practiceColCount
  const perAcre = (v: number | null) => (v != null ? fmtNum(v, 1) : '—')
  // The allocate column's control, grain's rules: only a mixed field; offered
  // once it is picked out; a saved split always stays editable.
  const allocateCell = (r: CottonSectionRow): ReactNode => {
    if (!split || !split.canEdit || r.practice?.kind !== 'mixed' || split.openId === r.plantingId) return null
    if (r.status !== 'complete' && !r.practice.entered) {
      return <span className="text-slate-400 text-xs whitespace-nowrap no-print">Allocate after harvest</span>
    }
    return (
      <button
        type="button"
        onClick={() => split.onOpen(r.plantingId)}
        className="inline-flex items-center min-h-10 px-2 rounded-lg border border-slate-300 bg-white text-brand-deep text-sm font-semibold whitespace-nowrap no-print"
      >
        {r.practice.entered ? 'Edit breakout' : 'Allocate irr/dry'}
      </button>
    )
  }
  const rowClickIsOnControl = (e: { target: EventTarget | null }) =>
    e.target instanceof Element && e.target.closest('button, a, input') != null

  const table = (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead className={theadCls}>
          <tr>
            <th className="w-10 px-1 py-2"></th>
            <th className="text-left px-2 py-1.5 whitespace-nowrap">Farm</th>
            <th className="text-left px-2 py-1.5 whitespace-nowrap">Field</th>
            {showYear && <th className="text-left px-2 py-1.5 whitespace-nowrap">Year</th>}
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Acres</th>
            {cols.irrigated && <th className="text-right px-2 py-1.5 whitespace-nowrap">Irr ac</th>}
            {cols.dryland && <th className="text-right px-2 py-1.5 whitespace-nowrap">Dry ac</th>}
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Seed cotton lbs</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Seed cotton lbs/ac</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Lint lbs</th>
            {cols.irrigated && <th className="text-right px-2 py-1.5 whitespace-nowrap">Irrigated lint lbs/ac</th>}
            {cols.dryland && <th className="text-right px-2 py-1.5 whitespace-nowrap">Dryland lint lbs/ac</th>}
            {cols.total && <th className="text-right px-2 py-1.5 whitespace-nowrap">Lint lbs/ac</th>}
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Turnout %</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Bales</th>
            <th className="text-left px-2 py-1.5 whitespace-nowrap">Ginning</th>
            {cols.allocate && <th className="text-left px-2 py-1.5 whitespace-nowrap"></th>}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={colCount} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={colCount} className="px-3 py-6 text-center text-slate-400">{emptyText ?? 'No cotton plantings match these filters.'}</td></tr>
          )}
          {rows.map((r) => {
            const detailOpen = open === r.key
            const dim = r.status !== 'complete'
            const soFar = r.status === 'in_progress'
            return (
              <Fragment key={r.key}>
                <tr
                  className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer ${dim ? 'text-slate-400' : ''}`}
                  onClick={(e) => { if (rowClickIsOnControl(e)) return; toggle(r.key) }}
                >
                  <td className="px-1 py-1">
                    <button type="button" aria-expanded={detailOpen} aria-label={`${detailOpen ? 'Hide' : 'Show'} detail for ${r.fieldName}`} onClick={() => toggle(r.key)} className="inline-flex items-center justify-center min-h-10 min-w-10 rounded-lg text-slate-400 hover:bg-slate-100">{detailOpen ? '▾' : '▸'}</button>
                  </td>
                  <td className="px-2 py-1.5">{r.farmName}</td>
                  <td className="px-2 py-1.5 font-semibold">{r.fieldName}</td>
                  {showYear && <td className="px-2 py-1.5">{r.year}</td>}
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.acres, 1)}</td>
                  {cols.irrigated && <td className="px-2 py-1.5 text-right tabular-nums">{r.practice && r.practice.irrAc > 0 ? fmtNum(r.practice.irrAc, 1) : '—'}</td>}
                  {cols.dryland && <td className="px-2 py-1.5 text-right tabular-nums">{r.practice && r.practice.dryAc > 0 ? fmtNum(r.practice.dryAc, 1) : '—'}</td>}
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.y.seedLbs > 0 ? lbs(r.y.seedLbs) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.y.seedPerAcre != null ? fmtNum(r.y.seedPerAcre, 1) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {r.y.lintLbs > 0 ? lbs(r.y.lintLbs) : '—'}
                    <EstChip y={r.y} soFar={soFar} />
                  </td>
                  {cols.irrigated && <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{perAcre(practicePerAcre(r, 'irrigated', cols))}</td>}
                  {cols.dryland && <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{perAcre(practicePerAcre(r, 'dryland', cols))}</td>}
                  {cols.total && <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{r.y.lintPerAcre != null ? fmtNum(r.y.lintPerAcre, 1) : '—'}</td>}
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {r.y.turnoutPct != null ? `${r.y.turnoutPct}%` : '—'}
                    {r.y.turnoutBasis === 'estimated' && (
                      <InfoTip label="est." tone={r.y.turnout.assumed ? 'warning' : 'neutral'} className="ml-1">{r.y.turnout.label}. Replaced by the field’s own turnout once its cotton is ginned.</InfoTip>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.y.bales > 0 ? r.y.bales : '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap"><GinningBadge y={r.y} /></td>
                  {cols.allocate && <td className="px-2 py-1.5 whitespace-nowrap">{allocateCell(r)}</td>}
                </tr>
                {detailOpen && (
                  <tr className="bg-slate-50">
                    <td colSpan={colCount} className="px-3 py-3">
                      <CottonRowDetail r={r} model={model} allowLoadLinks={allowLoadLinks} onCountAnyway={canEdit ? onCountAnyway : undefined} onUndoCount={canEdit ? onUndoCount : undefined} saving={savingPlantingId === r.plantingId} />
                    </td>
                  </tr>
                )}
                {split && split.openId === r.plantingId && (
                  <tr className="bg-sky-50 no-print">
                    <td colSpan={colCount} className="px-3 py-3">{split.renderEditor(r)}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {rows.length > 0 && (
            <tr className={grandTotalRowCls}>
              <td></td>
              <td className="px-2 py-1.5" colSpan={showYear ? 3 : 2}>Total</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(t.acres, 1)}</td>
              {cols.irrigated && <td className="px-2 py-1.5 text-right tabular-nums">{pt.irrAc > 0 ? fmtNum(pt.irrAc, 1) : '—'}</td>}
              {cols.dryland && <td className="px-2 py-1.5 text-right tabular-nums">{pt.dryAc > 0 ? fmtNum(pt.dryAc, 1) : '—'}</td>}
              <td className="px-2 py-1.5 text-right tabular-nums">{t.seed > 0 ? lbs(t.seed) : '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{t.acres > 0 && t.seed > 0 ? fmtNum(t.seed / t.acres, 1) : '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                {t.lint > 0 ? lbs(t.lint) : '—'}
                {anyEst && <InfoTip label="incl. est." tone="warning" className="ml-1">{lbs(t.actual)} lbs on gin receipts + {lbs(t.est)} lbs estimated from {lbs(t.yard)} lbs of seed cotton on the yard.</InfoTip>}
              </td>
              {cols.irrigated && <td className="px-2 py-1.5 text-right tabular-nums">{perAcre(pt.irrPerAcre)}</td>}
              {cols.dryland && <td className="px-2 py-1.5 text-right tabular-nums">{perAcre(pt.dryPerAcre)}</td>}
              {cols.total && <td className="px-2 py-1.5 text-right tabular-nums">{t.acres > 0 && t.lint > 0 ? fmtNum(t.lint / t.acres, 1) : '—'}</td>}
              <td className="px-2 py-1.5 text-right tabular-nums">{t.seedGinned > 0 && t.actual > 0 ? `${Math.round((t.actual / t.seedGinned) * 1000) / 10}%` : '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{t.bales > 0 ? t.bales : '—'}</td>
              <td className="px-2 py-1.5">{t.yard > 0 ? <span className="text-xs text-amber-700 font-normal">{lbs(t.yard)} lbs on yard</span> : null}</td>
              {cols.allocate && <td></td>}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="font-bold text-lg">
        {title}
        {subtitle && <span className="ml-2 text-sm font-normal text-slate-500">{subtitle}</span>}
      </h2>
      <TurnoutLines lines={turnouts} onSave={onSaveTurnout} />
    </div>
  )

  if (standalone) {
    return (
      <div className="space-y-2">
        {header}
        <div className="bg-white rounded-xl shadow">{table}</div>
      </div>
    )
  }
  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-2 avoid-break">
      {header}
      {table}
    </section>
  )
}
