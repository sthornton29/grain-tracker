'use client'

// Cotton yields section (092) — the cotton table on the Yields page and the
// Season Summary, FED by the page (no reads of its own): one row per cotton
// planting of the year, classified by the SAME engine as grain (harvest
// status from the seed cotton loads via lib/yields buildYieldInputs + the
// cotton adapter) with the lint estimate for picked-but-unginned cotton
// layered on top (lib/cotton.ts cottonPlantingYield). Harvest status and
// ginning status are separate columns: a field can be picked out and still
// sitting on the yard.
//
// Columns: Farm · Field · Acres · Seed cotton lbs · Seed cotton lbs/ac ·
// Lint lbs (actual / est.) · Lint lbs/ac · Turnout % (actual / est.) · Bales ·
// Harvest status · Ginning status. The drill-down lists the field's seed
// cotton loads and its gin receipts, with totals that equal the row.

import { Fragment, useState } from 'react'
import TurnoutControl from '@/components/reports/turnout-control'
import { InfoTip, fmtNum, fmtInt, theadCls, grandTotalRowCls } from '@/components/reports/report-kit'
import { fmtDateShort } from '@/lib/format-date'
import { formatCottonPrice } from '@/lib/hedging'
import { buildCottonFieldDetail } from '@/lib/yield-detail'
import { GINNING_STATUS_LABEL, type CottonPlantingYield, type TurnoutResolution } from '@/lib/cotton'
import type { CottonYieldModel } from '@/lib/cotton-yield-sources'
import type { ExclusionReason, HarvestStatus } from '@/lib/yields'
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
}

export type CottonTurnoutLine = {
  cropId: string
  cropName: string
  year: number
  turnout: TurnoutResolution
  manualPct: number | null
}

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

function HarvestBadge({ r, canEdit, onCountAnyway, onUndoCount, saving }: {
  r: CottonSectionRow
  canEdit: boolean
  onCountAnyway?: (plantingId: string) => void
  onUndoCount?: (plantingId: string) => void
  saving: boolean
}) {
  if (r.status === 'unharvested') return <span className="text-xs rounded px-2 py-0.5 bg-slate-100 text-slate-500">not picked</span>
  if (r.status === 'in_progress') {
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        <span className="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800">in progress</span>
        {canEdit && onCountAnyway && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onCountAnyway(r.plantingId)}
            className="inline-flex items-center min-h-10 px-2 rounded-lg border border-slate-300 bg-white text-brand-deep text-xs font-semibold disabled:opacity-50 no-print"
          >Count anyway</button>
        )}
      </span>
    )
  }
  if (r.overridden) {
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">complete</span>
        <InfoTip label="counted" tone="neutral">You counted this field as finished while it still read in progress.</InfoTip>
        {canEdit && onUndoCount && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onUndoCount(r.plantingId)}
            className="inline-flex items-center min-h-10 px-2 rounded-lg border border-slate-300 bg-white text-brand-deep text-xs font-semibold disabled:opacity-50 no-print"
          >Undo</button>
        )}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">complete</span>
      {r.noBaseline && (
        <InfoTip label="?" tone="neutral">Counted as finished — no other picked fields and no yield estimate to compare against yet.</InfoTip>
      )}
    </span>
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

/** Seed cotton loads + gin receipts behind one row; totals equal the row. */
export function CottonRowDetail({ r, model, allowLoadLinks }: { r: CottonSectionRow; model: CottonYieldModel; allowLoadLinks: boolean }) {
  const src = model.sources
  if (!src) return null
  const loads = [...model.loadsFor(r.fieldId, r.year)].sort((a, b) => ((a.picked_date ?? a.delivered_date ?? '') < (b.picked_date ?? b.delivered_date ?? '') ? -1 : 1))
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
                      {x.receipt_number}
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

export const COTTON_SECTION_COLUMNS: ExportColumn[] = [
  { label: 'Farm' },
  { label: 'Field' },
  { label: 'Year', format: 'text' },
  { label: 'Acres', align: 'right', format: 'acres' },
  { label: 'Seed cotton lbs', align: 'right', format: 'lbs' },
  { label: 'Seed cotton lbs/ac', align: 'right', format: 'yield' },
  { label: 'Lint lbs', align: 'right', format: 'lbs' },
  { label: 'Lint basis' },
  { label: 'Lint lbs/ac', align: 'right', format: 'yield' },
  { label: 'Turnout %', align: 'right', format: 'pct1' },
  { label: 'Turnout basis' },
  { label: 'Bales', align: 'right', format: 'int' },
  { label: 'Harvest status' },
  { label: 'Ginning status' },
]

const STATUS_LABEL: Record<HarvestStatus, string> = { complete: 'complete', in_progress: 'in progress', unharvested: 'not picked' }

/** The cotton table as an export section (mirrors the on-screen columns). */
export function cottonSectionExport(rows: readonly CottonSectionRow[], title?: string): ExportSection {
  const data = rows.map((r) => [
    r.farmName, r.fieldName, r.year, r.acres,
    r.y.seedLbs > 0 ? r.y.seedLbs : '',
    r.y.seedPerAcre ?? '',
    r.y.lintLbs > 0 ? r.y.lintLbs : '',
    r.y.lintBasis == null ? '' : r.y.lintBasis === 'actual' ? 'actual' : r.y.lintBasis === 'mixed' ? `part est. (${r.y.turnout.label})` : `est. (${r.y.turnout.label})`,
    r.y.lintPerAcre ?? '',
    r.y.turnoutPct ?? '',
    r.y.turnoutBasis == null ? '' : r.y.turnoutBasis === 'actual' ? 'actual' : 'est.',
    r.y.bales,
    r.overridden ? 'complete (counted)' : STATUS_LABEL[r.status],
    GINNING_STATUS_LABEL[r.y.ginning] === '—' ? '' : GINNING_STATUS_LABEL[r.y.ginning],
  ] as ExportSection['rows'][number])
  const t = totalsOf(rows)
  data.push([
    'Total', '', '', t.acres, t.seed, t.acres > 0 && t.seed > 0 ? t.seed / t.acres : '', t.lint, t.est > 0 ? 'incl. est.' : '',
    t.acres > 0 && t.lint > 0 ? t.lint / t.acres : '', t.seedGinned > 0 ? Math.round((t.actual / t.seedGinned) * 1000) / 10 : '', '', t.bales, '', '',
  ] as ExportSection['rows'][number])
  return { title, columns: COTTON_SECTION_COLUMNS, rows: data, rowMeta: [...rows.map(() => 'data' as const), 'total'] }
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
}) {
  const [localOpen, setLocalOpen] = useState<string | null>(null)
  const open = onToggle ? openKey ?? null : localOpen
  const toggle = (key: string) => (onToggle ? onToggle(key) : setLocalOpen((k) => (k === key ? null : key)))
  const t = totalsOf(rows)
  const anyEst = t.est > 0
  const colCount = 12 + (showYear ? 1 : 0)
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
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Seed cotton lbs</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Seed cotton lbs/ac</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Lint lbs</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Lint lbs/ac</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Turnout %</th>
            <th className="text-right px-2 py-1.5 whitespace-nowrap">Bales</th>
            <th className="text-left px-2 py-1.5 whitespace-nowrap">Harvest</th>
            <th className="text-left px-2 py-1.5 whitespace-nowrap">Ginning</th>
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
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.y.seedLbs > 0 ? lbs(r.y.seedLbs) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.y.seedPerAcre != null ? fmtNum(r.y.seedPerAcre, 1) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {r.y.lintLbs > 0 ? lbs(r.y.lintLbs) : '—'}
                    <EstChip y={r.y} soFar={soFar} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{r.y.lintPerAcre != null ? fmtNum(r.y.lintPerAcre, 1) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {r.y.turnoutPct != null ? `${r.y.turnoutPct}%` : '—'}
                    {r.y.turnoutBasis === 'estimated' && (
                      <InfoTip label="est." tone={r.y.turnout.assumed ? 'warning' : 'neutral'} className="ml-1">{r.y.turnout.label}. Replaced by the field’s own turnout once its cotton is ginned.</InfoTip>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.y.bales > 0 ? r.y.bales : '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <HarvestBadge r={r} canEdit={canEdit} onCountAnyway={onCountAnyway} onUndoCount={onUndoCount} saving={savingPlantingId === r.plantingId} />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap"><GinningBadge y={r.y} /></td>
                </tr>
                {detailOpen && (
                  <tr className="bg-slate-50">
                    <td colSpan={colCount} className="px-3 py-3">
                      <CottonRowDetail r={r} model={model} allowLoadLinks={allowLoadLinks} />
                    </td>
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
              <td className="px-2 py-1.5 text-right tabular-nums">{t.seed > 0 ? lbs(t.seed) : '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{t.acres > 0 && t.seed > 0 ? fmtNum(t.seed / t.acres, 1) : '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                {t.lint > 0 ? lbs(t.lint) : '—'}
                {anyEst && <InfoTip label="incl. est." tone="warning" className="ml-1">{lbs(t.actual)} lbs on gin receipts + {lbs(t.est)} lbs estimated from {lbs(t.yard)} lbs of seed cotton on the yard.</InfoTip>}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{t.acres > 0 && t.lint > 0 ? fmtNum(t.lint / t.acres, 1) : '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{t.seedGinned > 0 && t.actual > 0 ? `${Math.round((t.actual / t.seedGinned) * 1000) / 10}%` : '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{t.bales > 0 ? t.bales : '—'}</td>
              <td className="px-2 py-1.5" colSpan={2}>{t.yard > 0 ? <span className="text-xs text-amber-700 font-normal">{lbs(t.yard)} lbs on yard</span> : null}</td>
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 no-print">
        {turnouts.map((tl) => (
          <span key={`${tl.cropId}|${tl.year}`} className="inline-flex items-center gap-1.5 flex-wrap">
            {turnouts.length > 1 && <span className="text-xs text-slate-500">{tl.cropName} {tl.year}:</span>}
            <TurnoutControl
              turnout={tl.turnout}
              manualPct={tl.manualPct}
              onSave={onSaveTurnout ? (v) => onSaveTurnout(tl.cropId, tl.year, v) : undefined}
              compact
            />
          </span>
        ))}
      </div>
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
