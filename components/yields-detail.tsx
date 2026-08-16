'use client'

// Drill-down detail for the Yields page — the itemized layer under a yield row.
//
// All numbers come from lib/yield-detail (buildLoadDetail / summarizeDetail /
// buildCottonFieldDetail), which iterates exactly like fieldCropAggregates, so
// a detail's totals provably match the row it explains. This file only renders
// (and shapes the same data for exports) — it never re-aggregates.

import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  buildLoadDetail,
  summarizeDetail,
  buildCottonFieldDetail,
  type DetailLoadLike,
  type DetailSplitLike,
  type YieldDetailLoad,
  type YieldDetailSummary,
  type CottonFieldDetail,
  type CombineDetailRow,
} from '@/lib/yield-detail'
import { combineNegativeNetMessage, type CombineEntryLike } from '@/lib/yields'
import { formatCottonPrice } from '@/lib/hedging'
import type { ExportSection } from '@/lib/exports'
import type { createClient } from '@/lib/supabase/client'

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** The slice of a planting the detail needs — every view's rows already carry
 *  these on their constituent plantings. */
export type DetailPlantingRef = {
  field_id: string
  crop_id: string
  season_year: number
  planted_acres: number | string | null
}

type DetailCropLike = {
  id: string
  name: string
  base_moisture_pct: number | null
  base_lb_per_bushel: number | null
}

/** id → display-name lookups for the load list (fetched light: id + name). */
export type DetailLookups = {
  fieldNameById: Map<string, string>
  truckNameById: Map<string, string>
  binNameById: Map<string, string>
  buyerNameById: Map<string, string>
}

function fmtNum(n: number, d = 2) {
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${m}/${d}/${y}`
}

function fmtLbs(n: number | null): string {
  return n != null ? Math.round(n).toLocaleString() : '—'
}

function destinationLabel(l: YieldDetailLoad, lookups: DetailLookups): string {
  if (l.destination === 'bin' && l.destinationId) {
    const name = lookups.binNameById.get(l.destinationId)
    return name ? `Bin ${name}` : 'Bin'
  }
  if (l.destination === 'buyer' && l.destinationId) {
    return lookups.buyerNameById.get(l.destinationId) ?? 'Buyer'
  }
  return '—'
}

function splitLabel(split: NonNullable<YieldDetailLoad['split']>): string {
  return split.portionLbs != null && split.parentLbs != null
    ? `split — ${split.portionLbs.toLocaleString()} of ${split.parentLbs.toLocaleString()} lbs`
    : 'split'
}

// ---------------------------------------------------------------------------
// Detail building — thin wrapper over buildLoadDetail that handles rows whose
// constituent plantings span more than one season (e.g. "All seasons"): one
// lib call per season year, concatenated, summarized with the lib's summarizer.
// ---------------------------------------------------------------------------

export function buildDetailForPlantings(args: {
  plantings: readonly DetailPlantingRef[]
  loads: readonly DetailLoadLike[]
  splits: readonly DetailSplitLike[]
  cropById: Map<string, DetailCropLike>
  combineEntries?: readonly CombineEntryLike[] | null
}): { loads: YieldDetailLoad[]; summary: YieldDetailSummary; combineRows: CombineDetailRow[] } {
  const keysByYear = new Map<number, Set<string>>()
  for (const p of args.plantings) {
    const s = keysByYear.get(p.season_year) ?? new Set<string>()
    s.add(`${p.field_id}|${p.crop_id}`)
    keysByYear.set(p.season_year, s)
  }
  const all: YieldDetailLoad[] = []
  const allCombine: CombineDetailRow[] = []
  for (const [seasonYear, keys] of keysByYear) {
    const built = buildLoadDetail({
      keys,
      seasonYear,
      loads: args.loads,
      splits: args.splits,
      cropById: args.cropById,
      combineEntries: args.combineEntries,
    })
    all.push(...built.loads)
    allCombine.push(...built.combineRows)
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.loadId.localeCompare(b.loadId)))
  return { loads: all, summary: summarizeDetail(all, allCombine), combineRows: allCombine }
}

// ---------------------------------------------------------------------------
// Cotton sources — fetched lazily the first time a cotton detail opens, then
// cached for the rest of the visit. Kept out of the page's initial load.
// ---------------------------------------------------------------------------

export type CottonDetailSources = {
  ginReceipts: Array<{
    id: string
    field_id: string | null
    crop_year: number
    bales_count: number | null
    total_bale_weight: number | null
    total_seed_cotton_weight: number | null
  }>
  bales: Array<{ id: string; gin_receipt_id: string; net_weight_lbs: number; crop_year: number }>
  baleGrades: Array<{ bale_id: string; loan_value_cents_per_lb: number | null }>
  yardLoads: Array<{ field_id: string | null; crop_year: number; net_weight: number | null; onReceipt: boolean }>
}

export type CottonDetailState = {
  data: CottonDetailSources | null
  loading: boolean
  error: string | null
  /** Kick off the fetch if it hasn't started; call when a cotton detail opens. */
  ensure: () => void
}

export function useCottonDetailData(supabase: ReturnType<typeof createClient>): CottonDetailState {
  const [data, setData] = useState<CottonDetailSources | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  const ensure = useCallback(() => {
    if (started.current) return
    started.current = true
    setLoading(true)
    setError(null)
    ;(async () => {
      const [gr, cb, bg, cl, grl] = await Promise.all([
        supabase.from('gin_receipts').select('id, field_id, crop_year, bales_count, total_bale_weight, total_seed_cotton_weight'),
        supabase.from('cotton_bales').select('id, gin_receipt_id, net_weight_lbs, crop_year'),
        supabase.from('cotton_bale_grades').select('bale_id, loan_value_cents_per_lb'),
        supabase.from('cotton_loads').select('id, field_id, crop_year, net_weight'),
        supabase.from('gin_receipt_loads').select('cotton_load_id'),
      ])
      setLoading(false)
      const err = gr.error ?? cb.error ?? bg.error ?? cl.error ?? grl.error
      if (err) {
        // Allow a retry on the next open.
        started.current = false
        setError("Couldn't load the cotton detail. Close and reopen this row to try again.")
        return
      }
      const onReceipt = new Set(
        ((grl.data as Array<{ cotton_load_id: string }>) || []).map((r) => r.cotton_load_id),
      )
      const cottonLoads = (cl.data as Array<{ id: string; field_id: string | null; crop_year: number; net_weight: number | null }>) || []
      setData({
        ginReceipts: (gr.data as CottonDetailSources['ginReceipts']) || [],
        bales: (cb.data as CottonDetailSources['bales']) || [],
        baleGrades: (bg.data as CottonDetailSources['baleGrades']) || [],
        yardLoads: cottonLoads.map((l) => ({
          field_id: l.field_id,
          crop_year: l.crop_year,
          net_weight: l.net_weight,
          onReceipt: onReceipt.has(l.id),
        })),
      })
    })()
  }, [supabase])

  return { data, loading, error, ensure }
}

// ---------------------------------------------------------------------------
// Presentation pieces
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 whitespace-nowrap">{label}</div>
      <div className="text-sm font-semibold tabular-nums whitespace-nowrap">{value}</div>
    </div>
  )
}

function destinationMix(summary: YieldDetailSummary): string | null {
  const parts: string[] = []
  if (summary.toBinsPct != null && summary.toBinsPct > 0) parts.push(`${Math.round(summary.toBinsPct)}% to bins`)
  if (summary.toBuyersPct != null && summary.toBuyersPct > 0) parts.push(`${Math.round(summary.toBuyersPct)}% sold`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function GrainSummaryStrip({ summary }: { summary: YieldDetailSummary }) {
  const window =
    summary.firstLoadDate && summary.lastLoadDate
      ? summary.firstLoadDate === summary.lastLoadDate
        ? fmtDate(summary.firstLoadDate)
        : `${fmtDate(summary.firstLoadDate)} — ${fmtDate(summary.lastLoadDate)}`
      : null
  const mix = destinationMix(summary)
  const hasCombine = summary.fieldProductionDryBu !== summary.totalDryBu
  return (
    <div className="flex flex-wrap gap-2">
      {hasCombine && <Stat label="Production (bu)" value={fmtNum(summary.fieldProductionDryBu)} />}
      <Stat label="Loads" value={String(summary.loadCount)} />
      <Stat label="Net lbs" value={fmtLbs(summary.totalNetLbs)} />
      <Stat label="Wet bu" value={fmtNum(summary.totalWetBu)} />
      <Stat label={hasCombine ? 'Weighed dry bu' : 'Dry bu'} value={fmtNum(summary.totalDryBu)} />
      <Stat label="Moisture (wtd)" value={summary.weightedMoisture != null ? `${summary.weightedMoisture.toFixed(1)}%` : '—'} />
      {summary.weightedTestWeight != null && (
        <Stat label="Test wt (wtd)" value={summary.weightedTestWeight.toFixed(1)} />
      )}
      {window && <Stat label="Harvest window" value={window} />}
      {mix && <Stat label="Where it went" value={mix} />}
    </div>
  )
}

// The labeled combine source row above a field's weighed-load list (062): the
// authoritative entry, the netting against the loads listed below it, and the
// never-clamped negative-net warning.
function CombineEntryBanner({ rows, lookups }: { rows: readonly CombineDetailRow[]; lookups: DetailLookups }) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const c = r.info
        const warning = combineNegativeNetMessage(c)
        const adjLabel = c.adjustmentBuPerAcre != null && c.adjustmentBuPerAcre !== 0
          ? ` (adjusted ${c.adjustmentBuPerAcre > 0 ? '+' : ''}${fmtNum(c.adjustmentBuPerAcre, 1)} bu/ac)`
          : ''
        const binName = c.destinationBinId ? lookups.binNameById.get(c.destinationBinId) : null
        return (
          <div key={r.info.entryId} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm space-y-0.5">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-emerald-800 mr-2">Combine entry</span>
              <span className="font-semibold tabular-nums">{fmtNum(c.adjustedBu)} bu</span>
              <span className="text-slate-600">{adjLabel} · {fmtDate(c.entryDate)}{c.harvestComplete ? '' : ' · still harvesting'}</span>
            </div>
            <div className="text-slate-600 tabular-nums">
              {c.weighedBu > 0
                ? `− ${fmtNum(c.weighedBu)} bu weighed loads → ${fmtNum(Math.max(0, c.remainderBu))} bu ${binName ? `to Bin ${binName}` : c.destinationBinId ? 'to storage' : 'not yet hauled or stored'}`
                : binName ? `→ ${fmtNum(c.remainderBu)} bu to Bin ${binName}` : 'No weighed loads netted yet.'}
            </div>
            {warning && <p className="text-amber-700">{warning}</p>}
          </div>
        )
      })}
    </div>
  )
}

function LoadTable({
  rows,
  lookups,
  allowLoadLinks,
}: {
  rows: readonly YieldDetailLoad[]
  lookups: DetailLookups
  allowLoadLinks: boolean
}) {
  // Default oldest-first (harvest order); the Date header flips it.
  const [dateDesc, setDateDesc] = useState(false)
  const sorted = dateDesc ? [...rows].reverse() : rows
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-700">
          <tr>
            <th className="text-left px-3 py-2 whitespace-nowrap">
              <button
                type="button"
                onClick={() => setDateDesc((d) => !d)}
                className="inline-flex items-center gap-1"
                title="Sort by date"
              >
                Date <span className="text-slate-400">{dateDesc ? '↓' : '↑'}</span>
              </button>
            </th>
            <th className="text-left px-3 py-2 whitespace-nowrap">Ticket</th>
            <th className="text-left px-3 py-2 whitespace-nowrap">Truck</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Net lbs</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Moisture</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Test wt</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Wet bu</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
            <th className="text-left px-3 py-2 whitespace-nowrap">Destination</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((l) => (
            <tr key={`${l.loadId}|${l.fieldId}`} className="border-t border-slate-100">
              <td className="px-3 py-2 whitespace-nowrap">
                {allowLoadLinks ? (
                  <Link href={`/loads/${l.loadId}`} className="text-brand-deep hover:underline">
                    {fmtDate(l.date)}
                  </Link>
                ) : (
                  fmtDate(l.date)
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {allowLoadLinks && l.ticket ? (
                  <Link href={`/loads/${l.loadId}`} className="text-brand-deep hover:underline">
                    {l.ticket}
                  </Link>
                ) : (
                  <span>{l.ticket ?? '—'}</span>
                )}
                {l.split && (
                  <span className="ml-1.5 text-xs rounded px-2 py-0.5 bg-sky-100 text-sky-800 whitespace-nowrap">
                    {splitLabel(l.split)}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {l.truckId
                  ? l.truckLabel ?? lookups.truckNameById.get(l.truckId) ?? '—'
                  : l.haulerTruck
                  ? (
                    <>
                      {l.haulerTruck}
                      <span className="ml-1.5 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">hauler</span>
                    </>
                  )
                  : '—'}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtLbs(l.netLbs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{l.moisture != null ? `${l.moisture.toFixed(1)}%` : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{l.testWeight != null ? l.testWeight.toFixed(1) : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{l.wetBu != null ? fmtNum(l.wetBu) : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNum(l.dryBu)}</td>
              <td className="px-3 py-2 whitespace-nowrap">{destinationLabel(l, lookups)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Per-field breakdown for farm / entity / landowner rows: one row per
// constituent field, each expandable into that field's own load list.
function PerFieldBreakdown({
  plantings,
  loads,
  splits,
  cropById,
  lookups,
  allowLoadLinks,
  combineEntries,
}: {
  plantings: readonly DetailPlantingRef[]
  loads: readonly DetailLoadLike[]
  splits: readonly DetailSplitLike[]
  cropById: Map<string, DetailCropLike>
  lookups: DetailLookups
  allowLoadLinks: boolean
  combineEntries?: readonly CombineEntryLike[] | null
}) {
  const rows = useMemo(() => {
    const m = new Map<string, { key: string; fieldId: string; cropId: string; seasonYear: number; acres: number; plantings: DetailPlantingRef[] }>()
    for (const p of plantings) {
      const key = `${p.field_id}|${p.crop_id}|${p.season_year}`
      const g = m.get(key) ?? { key, fieldId: p.field_id, cropId: p.crop_id, seasonYear: p.season_year, acres: 0, plantings: [] }
      g.acres += Number(p.planted_acres) || 0
      g.plantings.push(p)
      m.set(key, g)
    }
    return [...m.values()]
      .map((g) => ({
        ...g,
        fieldName: lookups.fieldNameById.get(g.fieldId) ?? '—',
        detail: buildDetailForPlantings({ plantings: g.plantings, loads, splits, cropById, combineEntries }),
      }))
      .sort((a, b) => {
        if (a.seasonYear !== b.seasonYear) return b.seasonYear - a.seasonYear
        return a.fieldName.localeCompare(b.fieldName)
      })
  }, [plantings, loads, splits, cropById, lookups, combineEntries])

  const showYear = new Set(rows.map((r) => r.seasonYear)).size > 1
  const [openField, setOpenField] = useState<string | null>(null)
  const colCount = 7 + (showYear ? 1 : 0)

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-700">
          <tr>
            <th className="w-6 px-2 py-2"></th>
            <th className="text-left px-3 py-2 whitespace-nowrap">Field</th>
            {showYear && <th className="text-left px-3 py-2 whitespace-nowrap">Year</th>}
            <th className="text-right px-3 py-2 whitespace-nowrap">Acres</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Dry bu</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Yield (bu/ac)</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Moisture (wtd)</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">Loads</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = openField === r.key
            const s = r.detail.summary
            const yld = r.acres > 0 ? s.fieldProductionDryBu / r.acres : null
            return (
              <Fragment key={r.key}>
                <tr
                  className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button, a')) return
                    setOpenField(isOpen ? null : r.key)
                  }}
                >
                  <td className="px-2 py-2 text-slate-400">{isOpen ? '▾' : '▸'}</td>
                  <td className="px-3 py-2 font-medium">{r.fieldName}</td>
                  {showYear && <td className="px-3 py-2">{r.seasonYear}</td>}
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.acres)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtNum(s.fieldProductionDryBu)}
                    {r.detail.combineRows.length > 0 && (
                      <span className="ml-1.5 text-xs rounded px-1.5 py-0.5 bg-emerald-100 text-emerald-800 whitespace-nowrap">combine</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{yld != null ? yld.toFixed(1) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.weightedMoisture != null ? `${s.weightedMoisture.toFixed(1)}%` : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.loadCount}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-slate-50">
                    <td colSpan={colCount} className="px-3 py-3 space-y-2">
                      <CombineEntryBanner rows={r.detail.combineRows} lookups={lookups} />
                      {r.detail.loads.length === 0 ? (
                        r.detail.combineRows.length === 0 && (
                          <p className="text-sm text-slate-500">No loads recorded yet for this field.</p>
                        )
                      ) : (
                        <LoadTable rows={r.detail.loads} lookups={lookups} allowLoadLinks={allowLoadLinks} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cotton detail — gin receipts, bales, and yard seed cotton instead of loads.
// ---------------------------------------------------------------------------

/** Per season year: the cotton rollup over that year's constituent fields. */
export function cottonDetailsByYear(
  plantings: readonly DetailPlantingRef[],
  sources: CottonDetailSources,
): Array<{ year: number; fieldIds: Set<string>; d: CottonFieldDetail }> {
  const years = [...new Set(plantings.map((p) => p.season_year))].sort((a, b) => b - a)
  return years.map((year) => {
    const fieldIds = new Set(plantings.filter((p) => p.season_year === year).map((p) => p.field_id))
    return {
      year,
      fieldIds,
      d: buildCottonFieldDetail({
        fieldIds,
        cropYear: year,
        ginReceipts: sources.ginReceipts,
        bales: sources.bales,
        baleGrades: sources.baleGrades,
        yardLoads: sources.yardLoads,
      }),
    }
  })
}

function CottonSummaryStrip({ d }: { d: CottonFieldDetail }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Stat label="Gin receipts" value={String(d.receiptCount)} />
      <Stat label="Lint" value={`${fmtLbs(d.lintLbs)} lbs`} />
      <Stat
        label="Bales"
        value={d.avgBaleLbs != null ? `${d.baleCount} · avg ${fmtLbs(d.avgBaleLbs)} lbs` : String(d.baleCount)}
      />
      <Stat label="Turnout" value={d.turnoutPct != null ? `${d.turnoutPct.toFixed(1)}%` : '—'} />
      {d.weightedLoanCentsPerLb != null && (
        <Stat
          label={`Avg loan value (${d.classedBaleCount} classed)`}
          value={formatCottonPrice(d.weightedLoanCentsPerLb, { perLb: true })}
        />
      )}
      {d.yardLoadCount > 0 && (
        <Stat
          label="Still on the yard"
          value={`${fmtLbs(d.yardSeedCottonLbs)} lbs seed cotton · ${d.yardLoadCount} load${d.yardLoadCount === 1 ? '' : 's'}`}
        />
      )}
    </div>
  )
}

function CottonDetail({
  plantings,
  cotton,
  lookups,
  perFieldBreakdown,
}: {
  plantings: readonly DetailPlantingRef[]
  cotton: CottonDetailState
  lookups: DetailLookups
  perFieldBreakdown: boolean
}) {
  if (cotton.error) return <p className="text-sm text-red-600">{cotton.error}</p>
  if (cotton.loading || !cotton.data) return <p className="text-sm text-slate-500">Loading cotton detail…</p>
  const byYear = cottonDetailsByYear(plantings, cotton.data)
  const showYearHeadings = byYear.length > 1
  return (
    <div className="space-y-3">
      {byYear.map(({ year, fieldIds, d }) => (
        <div key={year} className="space-y-2">
          {showYearHeadings && <div className="text-xs font-semibold text-slate-500">{year}</div>}
          {d.receiptCount === 0 && d.yardLoadCount === 0 ? (
            <p className="text-sm text-slate-500">No gin receipts or seed cotton recorded yet.</p>
          ) : (
            <>
              <CottonSummaryStrip d={d} />
              {perFieldBreakdown && fieldIds.size > 1 && (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-700">
                      <tr>
                        <th className="text-left px-3 py-2 whitespace-nowrap">Field</th>
                        <th className="text-right px-3 py-2 whitespace-nowrap">Gin receipts</th>
                        <th className="text-right px-3 py-2 whitespace-nowrap">Lint lbs</th>
                        <th className="text-right px-3 py-2 whitespace-nowrap">Bales</th>
                        <th className="text-right px-3 py-2 whitespace-nowrap">Turnout</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...fieldIds]
                        .map((fid) => ({
                          fid,
                          name: lookups.fieldNameById.get(fid) ?? '—',
                          fd: buildCottonFieldDetail({
                            fieldIds: new Set([fid]),
                            cropYear: year,
                            ginReceipts: cotton.data!.ginReceipts,
                            bales: cotton.data!.bales,
                            baleGrades: cotton.data!.baleGrades,
                            yardLoads: cotton.data!.yardLoads,
                          }),
                        }))
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map(({ fid, name, fd }) => (
                          <tr key={fid} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-medium">{name}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fd.receiptCount}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtLbs(fd.lintLbs)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fd.baleCount}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fd.turnoutPct != null ? `${fd.turnoutPct.toFixed(1)}%` : '—'}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The inline detail panel a clicked row expands into.
// ---------------------------------------------------------------------------

export function YieldRowDetail({
  plantings,
  loads,
  splits,
  cropById,
  lookups,
  allowLoadLinks,
  perFieldBreakdown,
  flag,
  cotton,
  combineEntries,
}: {
  /** The row's constituent plantings — the SAME set its numbers rolled up from. */
  plantings: readonly DetailPlantingRef[]
  loads: readonly DetailLoadLike[]
  splits: readonly DetailSplitLike[]
  cropById: Map<string, DetailCropLike>
  lookups: DetailLookups
  /** False for viewers — /loads is outside their route allowlist, so no links. */
  allowLoadLinks: boolean
  /** True for farm / entity / landowner rows: fields table → loads two levels. */
  perFieldBreakdown: boolean
  /** The parent row's status flag, repeated so the list matches its number. */
  flag?: ReactNode
  /** Pass the shared cotton state when this row's crop is cotton. */
  cotton?: CottonDetailState | null
  /** Combine yield entries (062) — labeled source rows with the netting. */
  combineEntries?: readonly CombineEntryLike[] | null
}) {
  const detail = useMemo(
    () => buildDetailForPlantings({ plantings, loads, splits, cropById, combineEntries }),
    [plantings, loads, splits, cropById, combineEntries],
  )

  if (cotton) {
    return (
      <div className="space-y-2 text-left">
        {flag && <div>{flag}</div>}
        <CottonDetail plantings={plantings} cotton={cotton} lookups={lookups} perFieldBreakdown={perFieldBreakdown} />
      </div>
    )
  }

  return (
    <div className="space-y-2 text-left">
      {flag && <div>{flag}</div>}
      {detail.loads.length === 0 && detail.combineRows.length === 0 ? (
        <p className="text-sm text-slate-500">No loads recorded yet.</p>
      ) : (
        <>
          <GrainSummaryStrip summary={detail.summary} />
          {perFieldBreakdown ? (
            <PerFieldBreakdown
              plantings={plantings}
              loads={loads}
              splits={splits}
              cropById={cropById}
              lookups={lookups}
              allowLoadLinks={allowLoadLinks}
              combineEntries={combineEntries}
            />
          ) : (
            <>
              <CombineEntryBanner rows={detail.combineRows} lookups={lookups} />
              {detail.loads.length > 0 && (
                <LoadTable rows={detail.loads} lookups={lookups} allowLoadLinks={allowLoadLinks} />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export sections — appended to a view's payload while its detail is open.
// ---------------------------------------------------------------------------

export function grainDetailExportSection(args: {
  title: string
  detailLoads: readonly YieldDetailLoad[]
  lookups: DetailLookups
  combineRows?: readonly CombineDetailRow[]
}): ExportSection {
  const { title, detailLoads, lookups, combineRows = [] } = args
  // Combine entries lead the sheet as labeled source rows (netting in the
  // Split column), mirroring the on-screen banner above the load list.
  const combineExportRows: ExportSection['rows'] = combineRows.map((r) => [
    fmtDate(r.info.entryDate),
    'Combine entry',
    '',
    null,
    null,
    null,
    null,
    r.info.adjustedBu,
    r.info.destinationBinId ? `Bin ${lookups.binNameById.get(r.info.destinationBinId) ?? ''}`.trim() : '',
    r.info.weighedBu > 0
      ? `adjusted total — ${Math.round(r.info.weighedBu).toLocaleString()} bu weighed → ${Math.round(Math.max(0, r.info.remainderBu)).toLocaleString()} bu remainder`
      : 'adjusted total',
  ])
  return {
    title,
    columns: [
      { label: 'Date' },
      { label: 'Ticket' },
      { label: 'Truck' },
      { label: 'Net lbs', align: 'right', format: 'lbs' },
      { label: 'Moisture', align: 'right', format: 'dec1' },
      { label: 'Test wt', align: 'right', format: 'dec1' },
      { label: 'Wet bu', align: 'right', format: 'bu' },
      { label: 'Dry bu', align: 'right', format: 'bu' },
      { label: 'Destination' },
      { label: 'Split' },
    ],
    rows: [
      ...combineExportRows,
      ...detailLoads.map((l) => [
        fmtDate(l.date),
        l.ticket ?? '',
        l.truckId ? l.truckLabel ?? lookups.truckNameById.get(l.truckId) ?? '' : l.haulerTruck ? `${l.haulerTruck} (hauler)` : '',
        l.netLbs,
        l.moisture,
        l.testWeight,
        l.wetBu,
        l.dryBu,
        destinationLabel(l, lookups),
        l.split ? splitLabel(l.split) : '',
      ] as ExportSection['rows'][number]),
    ],
  }
}

export function cottonDetailExportSection(args: {
  title: string
  details: ReadonlyArray<{ year: number; d: CottonFieldDetail }>
  showYear: boolean
}): ExportSection {
  const rows: ExportSection['rows'] = []
  const rowMeta: NonNullable<ExportSection['rowMeta']> = []
  for (const { year, d } of args.details) {
    if (args.showYear) {
      rows.push([String(year), null])
      rowMeta.push('subhead')
    }
    const push = (label: string, cell: ExportSection['rows'][number][number]) => {
      rows.push([label, cell])
      rowMeta.push('data')
    }
    push('Gin receipts', { v: d.receiptCount, format: 'int' })
    push('Lint (lbs)', { v: d.lintLbs, format: 'lbs' })
    push('Bales', { v: d.baleCount, format: 'int' })
    push('Avg bale (lbs)', d.avgBaleLbs != null ? { v: d.avgBaleLbs, format: 'int' } : '—')
    push('Turnout', d.turnoutPct != null ? { v: d.turnoutPct, format: 'pct1' } : '—')
    push('Avg loan value ($/lb)', d.weightedLoanCentsPerLb != null ? { v: d.weightedLoanCentsPerLb, format: 'cents' } : '—')
    push('Bales classed', { v: d.classedBaleCount, format: 'int' })
    push('Seed cotton on yard (lbs)', { v: d.yardSeedCottonLbs, format: 'lbs' })
  }
  return {
    title: args.title,
    columns: [{ label: '' }, { label: '', align: 'right' }],
    rows,
    rowMeta,
  }
}
