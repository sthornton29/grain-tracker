'use client'

// The season at a glance for seed cotton (2026-10-12): one strip of pounds
// moving from the field, across the gin yard, into bales — ginned (done) on
// the left, still on the yard (waiting) on the right — with the yard broken
// out by field underneath so the operator can see which field's modules are
// still sitting out. Replaces the KPI cards + the separate Yard Inventory
// card on the Loads page: one panel, one truth, tap a segment to filter.

import { StackedBar, fmtInt, fmtPct } from '@/components/reports/report-kit'
import type { SeasonFlow as SeasonFlowData } from '@/lib/cotton-loads'

export function SeasonFlow({
  flow, cropYear, fieldLabel, onPick,
}: {
  flow: SeasonFlowData
  cropYear: number
  /** "Lamon Farm · Pivot" for a field id; null = loads with no field. */
  fieldLabel: (fieldId: string | null) => string
  /** Tap "ginned" / "on the yard" to filter the list below. */
  onPick?: (status: 'yard' | 'ginned') => void
}) {
  const total = flow.netLbs
  const yardPct = total > 0 ? (flow.yardLbs / total) * 100 : 0
  const ginnedPct = total > 0 ? (flow.ginnedLbs / total) * 100 : 0
  const biggest = Math.max(1, ...flow.fields.map((f) => f.netLbs))

  if (flow.loads === 0) {
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

      {flow.fields.length > 0 && (
        <div className="border-t border-slate-100 pt-3">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">By field</div>
          <ul className="space-y-1.5">
            {flow.fields.map((f) => {
              const w = Math.max(2, Math.round((f.netLbs / biggest) * 100))
              const gw = f.netLbs > 0 ? (f.ginnedLbs / f.netLbs) * 100 : 0
              return (
                <li key={f.fieldId ?? 'none'} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] sm:grid-cols-[minmax(0,16rem)_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate text-slate-800">{fieldLabel(f.fieldId)}</span>
                  <span className="relative h-3 rounded bg-slate-100 overflow-hidden" aria-hidden>
                    <span className="absolute inset-y-0 left-0 flex rounded overflow-hidden" style={{ width: `${w}%` }}>
                      <span className="bg-green-600" style={{ width: `${gw}%` }} />
                      <span className="bg-amber-400 flex-1" />
                    </span>
                  </span>
                  <span className="tabular-nums text-right whitespace-nowrap">
                    {f.yardLbs > 0
                      ? <><span className="font-semibold text-amber-700">{fmtInt(f.yardLbs)}</span> <span className="text-slate-500">lbs on the yard{f.yardRolls > 0 ? ` · ${fmtInt(f.yardRolls)} rolls` : ''}</span></>
                      : <span className="text-green-700">all ginned · {fmtInt(f.netLbs)} lbs</span>}
                  </span>
                </li>
              )
            })}
          </ul>
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
