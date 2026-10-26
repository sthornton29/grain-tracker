'use client'

// The lint turnout behind picked-but-unginned estimates (092) — one control
// for the Yields cotton section header, every other Yields view (farm,
// entity, variety, landowner — TurnoutLines), the Yields by Landowner report
// and the Marketing assumptions panel. All of them read and write the same
// crop × crop year assumption, so a change on one shows on the others.
// Shows the RESOLVED turnout with its source ("41.5% from your ginned
// cotton", "40% assumed" in amber), and lets an owner type a manual figure
// for the crop × crop year (blank = back to the automatic tiers). Viewers get
// the same input when the page hands an onSave that writes a private
// override; without onSave it is read-only text.

import { useEffect, useState } from 'react'
import { InfoTip } from '@/components/reports/report-kit'
import type { TurnoutResolution } from '@/lib/cotton'

/** One cotton crop × crop year's turnout, as a Yields view shows it. */
export type CottonTurnoutLine = {
  cropId: string
  cropName: string
  year: number
  turnout: TurnoutResolution
  manualPct: number | null
}

/** The turnout line per cotton crop in view, for one crop year (a crop × year assumption). */
export function cottonTurnoutLines(args: {
  cropIds: Iterable<string>
  cropName: (id: string) => string
  year: number
  turnoutFor: (cropId: string, year: number) => TurnoutResolution
  assumptions: ReadonlyArray<{ crop_id: string; crop_year: number; assumed_turnout_pct?: number | string | null }>
}): CottonTurnoutLine[] {
  return [...new Set(args.cropIds)].map((id) => {
    const a = args.assumptions.find((x) => x.crop_id === id && x.crop_year === args.year)
    return {
      cropId: id,
      cropName: args.cropName(id),
      year: args.year,
      turnout: args.turnoutFor(id, args.year),
      manualPct: a?.assumed_turnout_pct != null ? Number(a.assumed_turnout_pct) : null,
    }
  })
}

/** The turnout control(s) for a set of lines — one per cotton crop, labeled when there are several. */
export function TurnoutLines({ lines, onSave, className = '' }: {
  lines: readonly CottonTurnoutLine[]
  /** Save a manual turnout for a crop × year (null clears). Absent = read-only. */
  onSave?: (cropId: string, year: number, v: number | null) => void
  className?: string
}) {
  if (lines.length === 0) return null
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 no-print ${className}`}>
      {lines.map((tl) => (
        <span key={`${tl.cropId}|${tl.year}`} className="inline-flex items-center gap-1.5 flex-wrap">
          {lines.length > 1 && <span className="text-xs text-slate-500">{tl.cropName} {tl.year}:</span>}
          <TurnoutControl
            turnout={tl.turnout}
            manualPct={tl.manualPct}
            onSave={onSave ? (v) => onSave(tl.cropId, tl.year, v) : undefined}
            compact
          />
        </span>
      ))}
    </div>
  )
}

export function turnoutExplanation(t: TurnoutResolution): string {
  switch (t.source) {
    case 'manual':
      return 'You set this turnout for the crop year. Clear it to go back to the figure from your ginned cotton.'
    case 'ginned_this_year':
      return 'Lint pounds divided by seed cotton pounds across every gin receipt for this crop year — the weighted average of what has actually been ginned.'
    case 'ginned_prior_year':
      return 'Nothing has been ginned this crop year yet, so last crop year’s gin receipts set the turnout until this year’s first receipt arrives.'
    default:
      return 'No gin receipts carry a turnout yet, so Turnrow assumes 40% lint. Type your own figure, or it updates itself from your first gin receipt.'
  }
}

export default function TurnoutControl({ turnout, manualPct, onSave, compact }: {
  turnout: TurnoutResolution
  /** The stored manual figure (crop_assumptions.assumed_turnout_pct), if any. */
  manualPct: number | null
  /** Save the manual turnout (null clears it). Absent = read-only. */
  onSave?: (v: number | null) => void
  compact?: boolean
}) {
  const [text, setText] = useState(manualPct != null ? String(manualPct) : '')
  useEffect(() => { setText(manualPct != null ? String(manualPct) : '') }, [manualPct])

  function commit() {
    if (!onSave) return
    const t = text.trim()
    if (t === '') { if (manualPct != null) onSave(null); return }
    const v = Number(t)
    if (!Number.isFinite(v) || v <= 0 || v > 100) { setText(manualPct != null ? String(manualPct) : ''); return }
    if (v !== manualPct) onSave(Math.round(v * 100) / 100)
  }

  const tone = turnout.assumed ? 'warning' : 'neutral'
  const sourceChip = (
    <InfoTip label={turnout.assumed ? 'assumed' : turnout.source === 'manual' ? 'set by you' : 'from your ginned cotton'} tone={tone}>
      {turnoutExplanation(turnout)}
    </InfoTip>
  )

  return (
    <span className={`inline-flex items-center gap-1.5 flex-wrap ${compact ? 'text-xs' : 'text-sm'} text-slate-600`}>
      <span>Turnout for estimates:</span>
      {onSave ? (
        <span className="inline-flex items-center gap-0.5">
          <input
            type="number"
            inputMode="decimal"
            min="1"
            max="100"
            step="0.1"
            value={text}
            placeholder={String(turnout.pct)}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            aria-label="Lint turnout percent for estimates (blank = automatic)"
            className="w-20 rounded-lg border border-slate-300 px-1 min-h-10 text-sm text-right tabular-nums bg-white"
          />
          <span>%</span>
        </span>
      ) : (
        <span className="font-semibold tabular-nums text-slate-700">{turnout.pct}%</span>
      )}
      {sourceChip}
    </span>
  )
}
