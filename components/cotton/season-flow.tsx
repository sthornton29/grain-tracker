'use client'

// The season at a glance for seed cotton (2026-10-12): one strip of pounds
// moving from the field, across the gin yard, into bales — ginned (done) on
// the left, still on the yard (waiting) on the right — with every cotton
// field underneath on ONE shared pounds axis (components/cotton/field-bars:
// ginned / on the yard / a ghost out to the field's expectation) so the
// operator can see which field's modules are still sitting out and how far
// each field is from what it should make. Replaces the KPI cards + the
// separate Yard Inventory card on the Loads page: one panel, one truth, tap a
// segment or a field row to filter.

import { StackedBar, fmtInt, fmtPct } from '@/components/reports/report-kit'
import { YieldFigure } from '@/components/cotton/cotton-page-header'
import { FieldBars, type FieldBarLabel } from '@/components/cotton/field-bars'
import type { SeasonFlow as SeasonFlowData } from '@/lib/cotton-loads'
import type { CottonFarmYield } from '@/lib/cotton-field-yields'
import type { FieldBarRow } from '@/lib/cotton-by-field'

export function SeasonFlow({
  flow, cropYear, fieldLabel, onPick, farm, bars, onPickField, activeFieldId,
}: {
  flow: SeasonFlowData
  cropYear: number
  /** Field name + farm (muted) for a field id; null = loads with no field. */
  fieldLabel: (fieldId: string | null) => FieldBarLabel
  /** Tap "ginned" / "on the yard" to filter the list below. */
  onPick?: (status: 'yard' | 'ginned') => void
  /** Farm-wide yields (lib/use-cotton-field-yields) — seed cotton and lint per picked acre. */
  farm?: CottonFarmYield | null
  /** The by-field rows on their shared axis (lib/cotton-by-field buildFieldBars). */
  bars?: { rows: FieldBarRow[]; axisMax: number } | null
  /** Tap a field row to filter the list below to that field. */
  onPickField?: (fieldId: string | null) => void
  activeFieldId?: string | null
}) {
  const total = flow.netLbs
  const yardPct = total > 0 ? (flow.yardLbs / total) * 100 : 0
  const ginnedPct = total > 0 ? (flow.ginnedLbs / total) * 100 : 0

  if (flow.loads === 0 && !(bars && bars.rows.length > 0)) {
    return (
      <section className="bg-white rounded-xl shadow p-5">
        <div className="text-xs text-slate-500 uppercase tracking-wide">{cropYear} seed cotton</div>
        <div className="font-display text-3xl font-bold text-slate-300 mt-1">0 lbs</div>
        <p className="text-sm text-slate-500 mt-1">Nothing hauled yet this crop year. The first module list or hand-entered load starts the season.</p>
      </section>
    )
  }

  return (
    <section className="bg-white rounded-xl shadow p-5 space-y-4" aria-label={`${cropYear} seed cotton season flow`}>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">{cropYear} seed cotton</div>
          <div className="font-display text-3xl sm:text-4xl font-bold text-slate-900 tabular-nums leading-none mt-1">
            {fmtInt(total)} <span className="text-base font-semibold text-slate-500">lbs</span>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <Stat label="loads" value={fmtInt(flow.loads)} />
          <Stat label="rolls" value={flow.rolls > 0 ? fmtInt(flow.rolls) : '—'} sub={flow.loadsWithoutRolls > 0 ? `${fmtInt(flow.loadsWithoutRolls)} uncounted` : undefined} />
          <Stat label="lbs per roll" value={flow.avgLbsPerRoll != null ? fmtInt(flow.avgLbsPerRoll) : '—'} />
          {farm && farm.acresPicked > 0 && (
            <>
              <div>
                <dt className="text-xs text-slate-500">seed cotton per acre</dt>
                <dd><YieldFigure perAcre={farm.seedPerAcre} /> <span className="text-xs text-slate-400">on {fmtInt(farm.acresPicked)} ac picked{farm.acresPlanted > farm.acresPicked ? ` of ${fmtInt(farm.acresPlanted)}` : ''}</span></dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">lint per acre</dt>
                <dd><YieldFigure perAcre={farm.lintPerAcre} basis={farm.lintBasis} turnoutLabel={farm.turnoutLabel} /></dd>
              </div>
            </>
          )}
        </dl>
      </div>

      <div>
        <StackedBar
          height="h-6"
          segments={[
            { value: flow.ginnedLbs, className: 'bg-green-600', label: `Ginned ${fmtInt(flow.ginnedLbs)} lbs` },
            { value: flow.yardLbs, className: 'bg-amber-400', label: `On the yard ${fmtInt(flow.yardLbs)} lbs` },
          ]}
        />
        <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 mt-2 text-sm">
          <Legend swatch="bg-green-600" label="Ginned" lbs={flow.ginnedLbs} pct={ginnedPct} onClick={onPick ? () => onPick('ginned') : undefined} />
          <Legend swatch="bg-amber-400" label="On the yard" lbs={flow.yardLbs} pct={yardPct} sub={flow.yardRolls > 0 ? `${fmtInt(flow.yardRolls)} rolls waiting` : undefined} onClick={onPick ? () => onPick('yard') : undefined} align="right" />
        </div>
      </div>

      {bars && bars.rows.length > 0 && (
        <div className="border-t border-slate-100 pt-3">
          <FieldBars rows={bars.rows} axisMax={bars.axisMax} labelFor={fieldLabel} onPick={onPickField} activeFieldId={activeFieldId} />
        </div>
      )}
    </section>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-semibold tabular-nums text-slate-900">{value}{sub && <span className="ml-1 text-xs font-normal text-slate-400">({sub})</span>}</dd>
    </div>
  )
}

function Legend({ swatch, label, lbs, pct, sub, onClick, align = 'left' }: { swatch: string; label: string; lbs: number; pct: number; sub?: string; onClick?: () => void; align?: 'left' | 'right' }) {
  const body = (
    <>
      <span aria-hidden className={`inline-block h-3 w-3 rounded-sm ${swatch}`} />
      <span className="font-medium text-slate-800">{label}</span>
      <span className="tabular-nums text-slate-900">{fmtInt(lbs)} lbs</span>
      <span className="text-slate-500">{fmtPct(pct)}</span>
      {sub && <span className="text-slate-500">· {sub}</span>}
    </>
  )
  const cls = `inline-flex items-center gap-2 min-h-9 ${align === 'right' ? 'justify-end' : ''}`
  return onClick
    ? <button type="button" onClick={onClick} className={`${cls} rounded px-1 -mx-1 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand`} aria-label={`Show ${label.toLowerCase()} loads`}>{body}</button>
    : <span className={cls}>{body}</span>
}
