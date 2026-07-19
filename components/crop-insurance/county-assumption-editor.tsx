'use client'

// Inline editor for the UNIFIED county-yield variance assumption (045) — the
// ONE source for every county-triggered insurance calculation (SCO/ECO/STAX/
// ARP/AYP/MCO). variance_pct: −10 = "the county typically runs 10% below its
// RMA expected yield this year"; an absolute override wins; the RMA final
// pins everything. Mirrors the ARC-CO expectation-slider pattern — but this is
// a SEPARATE assumption from the ARC-CO one (insurance uses RMA expected
// county yields; ARC uses FSA benchmarks — never merged).

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { CountyYieldAssumption } from '@/lib/types'

export function CountyAssumptionControl({ cropId, countyId, cropYear, assumption, compact = false, onChanged }: {
  cropId: string
  countyId: string | null
  cropYear: number
  assumption: CountyYieldAssumption | null
  compact?: boolean
  onChanged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [editing, setEditing] = useState(false)
  const [pct, setPct] = useState('')
  const [abs, setAbs] = useState('')
  const [finalYld, setFinalYld] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const label = assumption?.rma_final_county_yield != null
    ? `final ${assumption.rma_final_county_yield}`
    : assumption?.county_yield_override != null
      ? `= ${assumption.county_yield_override}`
      : `${(assumption?.variance_pct ?? 0) > 0 ? '+' : ''}${assumption?.variance_pct ?? 0}%`

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
        variance_pct: num(pct) ?? 0, county_yield_override: num(abs), rma_final_county_yield: num(finalYld),
      })
      if (error) throw new Error(error.message)
      setEditing(false)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed (is migration 045 applied?)')
    } finally { setBusy(false) }
  }

  if (!editing) {
    return (
      <span className={`inline-flex items-center gap-1 ${compact ? 'text-xs' : 'text-sm'}`}>
        <span className="text-slate-500">County yield assumption:</span>
        <span className="font-semibold tabular-nums">{label}</span>
        <button type="button" className="text-sky-700 underline decoration-dotted"
          onClick={() => {
            setPct(assumption?.variance_pct != null ? String(assumption.variance_pct) : '0')
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
      <label className="flex flex-col gap-0.5">vs expected (%)
        <input type="number" step="1" min="-50" max="50" value={pct} onChange={(e) => setPct(e.target.value)}
          className="rounded border border-slate-300 px-1.5 py-0.5 w-20 bg-white" />
      </label>
      <label className="flex flex-col gap-0.5">or absolute yield
        <input type="number" step="0.1" value={abs} onChange={(e) => setAbs(e.target.value)} placeholder="—"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <label className="flex flex-col gap-0.5">RMA final (pins)
        <input type="number" step="0.1" value={finalYld} onChange={(e) => setFinalYld(e.target.value)} placeholder="—"
          className="rounded border border-slate-300 px-1.5 py-0.5 w-24 bg-white" />
      </label>
      <button type="button" disabled={busy} onClick={save} className="rounded bg-green-700 text-white px-2 py-1 font-semibold disabled:opacity-50">Save</button>
      <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded border border-slate-300 bg-white px-2 py-1">Cancel</button>
      <span className="text-slate-400 max-w-[26rem]">
        Separate from the ARC-CO expectation — insurance uses RMA expected county yields, ARC uses FSA benchmarks.
      </span>
    </span>
  )
}
