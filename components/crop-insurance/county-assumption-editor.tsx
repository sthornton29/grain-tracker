'use client'

// Inline editor for the UNIFIED county-yield assumption — the ONE source for
// every county-triggered insurance calculation (SCO/ECO/STAX/ARP/AYP/MCO).
// Differential semantics (047): yield_differential = "my yields run this much
// ABOVE the county average", an absolute figure in the crop's own yield unit
// (bu/ac grains, lbs/ac cotton). Estimated county yield = your expected/actual
// farm yield − differential. An absolute override wins over the differential;
// the RMA final pins everything. This is a SEPARATE assumption from the ARC-CO
// expectation (insurance uses the farm-vs-county relationship; ARC uses FSA
// benchmarks — never merged).
//
// Every edit SAVES ON BLUR through the pure save-plan seam
// (lib/county-assumption.ts): update-in-place when the row exists, insert when
// it doesn't, delete when all three fields are blanked. Never delete-then-
// insert — a failed write can't destroy the stored assumption.

import { useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { planAssumptionSave, saveErrorMessage } from '@/lib/county-assumption'
import type { CountyYieldAssumption } from '@/lib/types'

export function CountyAssumptionControl({ cropId, countyId, cropYear, assumption, farmYield, yieldUnit = 'bu/ac', compact = false, onChanged }: {
  cropId: string
  countyId: string | null
  cropYear: number
  assumption: CountyYieldAssumption | null
  /** The farm's expected/actual yield driving the derivation line (the same
   *  basis the insurance math subtracts the differential from). */
  farmYield?: number | null
  /** 'bu/ac' grains, 'lbs/ac' cotton. */
  yieldUnit?: string
  compact?: boolean
  onChanged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [editing, setEditing] = useState(false)
  const [diff, setDiff] = useState('')
  const [abs, setAbs] = useState('')
  const [finalYld, setFinalYld] = useState('')
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Latest props/state for the serialized save chain (blur events can stack).
  const latest = useRef({ assumption, diff, abs, finalYld })
  latest.current = { assumption, diff, abs, finalYld }
  const chain = useRef<Promise<void>>(Promise.resolve())

  const differential = assumption?.yield_differential != null ? Number(assumption.yield_differential) : null
  const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`

  const label = assumption?.rma_final_county_yield != null
    ? `final ${Number(assumption.rma_final_county_yield).toFixed(1)}`
    : assumption?.county_yield_override != null
      ? `county = ${Number(assumption.county_yield_override).toFixed(1)}`
      : differential != null
        ? `${signed(differential)} ${yieldUnit}`
        : 'not set'

  // Derivation shown only in differential mode with a farm yield on hand:
  // "Your yield 185.0 − 15.0 = county est. 170.0"
  const derivation = assumption?.rma_final_county_yield == null && assumption?.county_yield_override == null
    && differential != null && farmYield != null
    ? `Your yield ${Number(farmYield).toFixed(1)} − ${differential.toFixed(1)} = county est. ${Math.max(0, Number(farmYield) - differential).toFixed(1)}`
    : null

  // Serialized so a rapid blur → blur never runs two writes concurrently; the
  // plan is recomputed at execution time against the freshest row.
  function saveOnBlur() {
    chain.current = chain.current.then(async () => {
      const { assumption: a, diff: d, abs: o, finalYld: f } = latest.current
      const plan = planAssumptionSave({
        existing: a, cropId, countyId, cropYear,
        draft: { diff: d, abs: o, final: f },
      })
      if (plan.kind === 'noop') return
      setErr(null)
      const t = supabase.from('county_yield_assumptions')
      const { error } =
        plan.kind === 'delete' ? await t.delete().eq('id', plan.id)
        : plan.kind === 'update' ? await t.update(plan.patch).eq('id', plan.id)
        : await t.insert(plan.row)
      if (error) { setErr(saveErrorMessage(error)); return }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onChanged()
    })
  }

  if (!editing) {
    return (
      <span className={`inline-flex items-center gap-1.5 flex-wrap ${compact ? 'text-xs' : 'text-sm'}`}>
        <span className="text-slate-500">My yield vs county:</span>
        <span className="font-semibold tabular-nums">{label}</span>
        {derivation && <span className="text-slate-400 tabular-nums">· {derivation}</span>}
        <button type="button" className="text-sky-700 underline decoration-dotted"
          onClick={() => {
            setDiff(assumption?.yield_differential != null ? String(assumption.yield_differential) : '')
            setAbs(assumption?.county_yield_override != null ? String(assumption.county_yield_override) : '')
            setFinalYld(assumption?.rma_final_county_yield != null ? String(assumption.rma_final_county_yield) : '')
            setErr(null)
            setEditing(true)
          }}>
          edit
        </button>
        {err && <span className="text-red-600">{err}</span>}
      </span>
    )
  }
  return (
    <span className="inline-flex items-end gap-2 text-xs flex-wrap">
      <label className="flex flex-col gap-0.5">my yield − county ({yieldUnit})
        <input type="text" inputMode="decimal" value={diff} onChange={(e) => setDiff(e.target.value)} onBlur={saveOnBlur} placeholder="+15"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <label className="flex flex-col gap-0.5">or absolute county yield
        <input type="text" inputMode="decimal" value={abs} onChange={(e) => setAbs(e.target.value)} onBlur={saveOnBlur} placeholder="—"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <label className="flex flex-col gap-0.5">RMA final (pins)
        <input type="text" inputMode="decimal" value={finalYld} onChange={(e) => setFinalYld(e.target.value)} onBlur={saveOnBlur} placeholder="—"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <button type="button" onClick={() => { saveOnBlur(); setEditing(false) }} className="rounded bg-green-700 text-white px-2 py-1 font-semibold">Done</button>
      {saved && <span className="text-green-700 font-semibold self-center">saved ✓</span>}
      {err && <span className="text-red-600 max-w-[28rem] self-center">{err}</span>}
      <span className="text-slate-400 max-w-[28rem]">
        Saves as you go (on leaving each field). Estimated county yield = your expected/actual yield minus this
        differential (positive = you typically beat the county). Blank all three to clear. Separate from the ARC-CO
        expectation — that stays in the FSA benchmark world.
      </span>
    </span>
  )
}
