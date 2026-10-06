'use client'

// Full-season / double-crop presentation, shared by Yields, Season Summary,
// Yields by Landowner and the drill-downs: the Cropping segmented control, the
// three tiles (Combined | Full-season | Double-crop), the "DC" pill on a
// double-crop field row, and the muted split line under a combined yield.
// Labels everywhere are "Full-season" and "Double-crop", the breakout grid's.

import type { ReactNode } from 'react'
import { CROPPING_LABEL, type Cropping } from '@/lib/plantings'
import type { CropAverage, HarvestProgress } from '@/lib/yields'
import { InfoTip, fmtInt, fmtNum } from '@/components/reports/report-kit'

export type CroppingFilter = 'all' | Cropping

export const CROPPING_FILTER_LABEL: Record<CroppingFilter, string> = {
  all: 'All',
  full_season: CROPPING_LABEL.full_season,
  double_crop: CROPPING_LABEL.double_crop,
}

/** The filter named for an export title / filter line ("Double-crop only"). */
export function croppingFilterLabel(f: CroppingFilter): string | null {
  return f === 'all' ? null : `${CROPPING_FILTER_LABEL[f]} only`
}

/** The segmented control in the filter bar. */
export function CroppingControl({ value, onChange }: { value: CroppingFilter; onChange: (v: CroppingFilter) => void }) {
  const opts: CroppingFilter[] = ['all', 'full_season', 'double_crop']
  return (
    <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden text-sm" role="group" aria-label="Cropping">
      {opts.map((o, i) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          aria-pressed={value === o}
          className={`px-3 min-h-10 ${i > 0 ? 'border-l border-slate-300' : ''} ${value === o ? 'bg-slate-800 text-white' : 'bg-white text-slate-700'}`}
        >
          {CROPPING_FILTER_LABEL[o]}
        </button>
      ))}
    </span>
  )
}

/** The small pill on a double-crop field row; the tip names the spring crop. */
export function DcPill({ springCropName, className }: { springCropName: string | null; className?: string }) {
  return (
    <InfoTip
      label={<span className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-violet-100 text-violet-800 whitespace-nowrap">DC</span>}
      ariaLabel={springCropName ? `Double-crop behind ${springCropName}` : 'Double-crop'}
      className={className}
    >
      {springCropName ? `Double-crop behind ${springCropName}` : 'Double-crop'}
    </InfoTip>
  )
}

export type CohortSide = { acres: number; dryBu: number }

/** Σ per cohort over a row's plantings. Both sides present → the row splits. */
export function cohortSplit<T>(items: readonly T[], of: (t: T) => { cropping: Cropping; acres: number; dryBu: number }): { fs: CohortSide; dc: CohortSide; both: boolean } {
  const fs = { acres: 0, dryBu: 0 }
  const dc = { acres: 0, dryBu: 0 }
  for (const t of items) {
    const v = of(t)
    const side = v.cropping === 'double_crop' ? dc : fs
    side.acres += v.acres
    side.dryBu += v.dryBu
  }
  return { fs, dc, both: fs.acres > 0 && dc.acres > 0 }
}

/** "Full-season 53.8 · Double-crop 42.0" under a combined yield — the
 *  irr/dry breakdown's muted style. Renders nothing unless both exist. */
export function CroppingSplitLine({ split, unit = 'bu' }: { split: { fs: CohortSide; dc: CohortSide; both: boolean }; unit?: 'bu' | 'lbs' }) {
  if (!split.both) return null
  const y = (s: CohortSide) => (s.acres > 0 ? fmtNum(s.dryBu / s.acres, 1) : '—')
  return (
    <div className="text-[11px] text-slate-400 font-normal whitespace-nowrap tabular-nums" aria-label={`Full-season ${y(split.fs)}, Double-crop ${y(split.dc)} ${unit}/ac`}>
      {CROPPING_LABEL.full_season} {y(split.fs)} · {CROPPING_LABEL.double_crop} {y(split.dc)}
    </div>
  )
}

export type CroppingTileData = {
  cropId: string
  cropName: string
  combined: { avg: CropAverage | null; progress: HarvestProgress | null }
  fullSeason: { avg: CropAverage | null; progress: HarvestProgress | null }
  doubleCrop: { avg: CropAverage | null; progress: HarvestProgress | null }
}

/** Three tiles per double-crop crop with both croppings in view. Each is a
 *  button bound to the Cropping control; the selected one carries the ring. */
export function CroppingTiles({ tiles, value, onChange, unitOf }: {
  tiles: readonly CroppingTileData[]
  value: CroppingFilter
  onChange: (v: CroppingFilter) => void
  unitOf?: (cropId: string) => 'bu' | 'lbs'
}) {
  if (tiles.length === 0) return null
  const tile = (t: CroppingTileData, key: CroppingFilter, label: string, side: { avg: CropAverage | null; progress: HarvestProgress | null }): ReactNode => {
    const selected = value === key
    const unit = unitOf?.(t.cropId) === 'lbs' ? 'lbs lint/ac' : 'bu/ac'
    const p = side.progress
    return (
      <button
        key={key}
        type="button"
        onClick={() => onChange(key)}
        aria-pressed={selected}
        className={`text-left rounded-lg border px-3 py-2 min-w-[11rem] min-h-11 ${selected ? 'border-brand ring-2 ring-brand bg-white' : 'border-slate-200 bg-slate-50 hover:bg-white'}`}
      >
        <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-2xl font-bold tabular-nums leading-tight">
          {side.avg ? fmtNum(side.avg.yield, 1) : '—'}
          <span className="text-sm font-medium text-slate-500"> {unit}</span>
        </div>
        <div className="text-xs text-slate-600 tabular-nums">
          {side.avg ? `${fmtNum(side.avg.acres, 1)} ac harvested · ${fmtInt(side.avg.dryBu)} ${unitOf?.(t.cropId) === 'lbs' ? 'lbs' : 'bu'}` : 'nothing harvested yet'}
        </div>
        {p && p.totalAcres > 0 && (
          <div className="text-xs text-slate-500 tabular-nums">{fmtNum(p.completedAcres, 0)} of {fmtNum(p.totalAcres, 0)} ac in</div>
        )}
      </button>
    )
  }
  return (
    <div className="bg-white rounded-xl shadow p-3 avoid-break space-y-3">
      {tiles.map((t) => (
        <div key={t.cropId}>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{t.cropName} · {CROPPING_LABEL.full_season} vs {CROPPING_LABEL.double_crop}</div>
          <div className="flex flex-wrap gap-2">
            {tile(t, 'all', 'Combined', t.combined)}
            {tile(t, 'full_season', CROPPING_LABEL.full_season, t.fullSeason)}
            {tile(t, 'double_crop', CROPPING_LABEL.double_crop, t.doubleCrop)}
          </div>
        </div>
      ))}
    </div>
  )
}
