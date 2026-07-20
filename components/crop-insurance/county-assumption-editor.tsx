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

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
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
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

  async function save() {
    setBusy(true); setErr(null)
    const num = (s: string) => (s.trim() === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null)
    try {
      // Delete-then-insert: the unique key coalesces null counties (expression
      // index), which upsert onConflict can't target reliably.
      let del = supabase.from('county_yield_assumptions').delete()
        .eq('crop_id', cropId).eq('crop_year', cropYear)
      del = countyId == null ? del.is('county_id', null) : del.eq('county_id', countyId)
      const { error: delErr } = await del
      if (delErr) throw new Error(delErr.message)
      const { error } = await supabase.from('county_yield_assumptions').insert({
        crop_id: cropId, county_id: countyId, crop_year: cropYear,
        yield_differential: num(diff), county_yield_override: num(abs), rma_final_county_yield: num(finalYld),
      })
      if (error) throw new Error(error.message)
      setEditing(false)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed (is migration 047 applied?)')
    } finally { setBusy(false) }
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
        <input type="text" inputMode="decimal" value={diff} onChange={(e) => setDiff(e.target.value)} placeholder="+15"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <label className="flex flex-col gap-0.5">or absolute county yield
        <input type="text" inputMode="decimal" value={abs} onChange={(e) => setAbs(e.target.value)} placeholder="—"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <label className="flex flex-col gap-0.5">RMA final (pins)
        <input type="text" inputMode="decimal" value={finalYld} onChange={(e) => setFinalYld(e.target.value)} placeholder="—"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <button type="button" disabled={busy} onClick={save} className="rounded bg-green-700 text-white px-2 py-1 font-semibold disabled:opacity-50">Save</button>
      <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded border border-slate-300 bg-white px-2 py-1">Cancel</button>
      <span className="text-slate-400 max-w-[28rem]">
        Estimated county yield = your expected/actual yield minus this differential (positive = you typically beat the
        county). Separate from the ARC-CO expectation — that stays in the FSA benchmark world.
      </span>
    </span>
  )
}
