'use client'

// MYA price panel — shared by the ARC/PLC Decision Aid and the Government
// Payment Tracker so both pages surface (and edit) the SAME per-commodity MYA
// resolution (lib/government-payments.ts resolveMyaPrice: published final >
// manual override > estimate). For each commodity: the resolved MYA with its
// state, an Auto | Manual toggle (Manual persists to arc_plc_price_data with
// source='manual'; Auto reverts to the computed estimate), the effective
// reference price, and the PLC payment rate the spread produces — the whole
// PLC story at a glance. Commodities without Barchart coverage are manual-only;
// once a USDA final is on file it governs and the toggle disappears (edit the
// final under Settings → Government Payments).

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtPrice } from '@/lib/hedging'
import {
  resolveMyaPrice, effectiveReferencePrice, MYA_STATE_LABEL, type MyaResolution,
} from '@/lib/government-payments'
import { theadCls, toneText } from '@/components/reports/report-kit'
import type { ArcPlcPriceData, CoveredCommodity } from '@/lib/types'

export default function MyaPricePanel({
  cropYear, commodities, priceData, liveMya, onChanged,
}: {
  cropYear: number
  commodities: CoveredCommodity[]
  priceData: ArcPlcPriceData[]
  liveMya: Map<string, number>
  /** Called after a manual save / auto revert so the page refetches price data. */
  onChanged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  // Drafts are keyed commodity × crop year so a number typed for one year can
  // never be shown — or saved — against another.
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map())
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)

  const draftKey = (commodityId: string) => `${cropYear}:${commodityId}`
  const storedFor = (commodityId: string) =>
    priceData.find((p) => p.commodity_id === commodityId && p.crop_year === cropYear) ?? null

  async function saveManual(c: CoveredCommodity, raw: string) {
    const v = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(v) || v < 0) return
    setSaving((s) => new Set(s).add(c.id))
    const { error } = await supabase.from('arc_plc_price_data').upsert(
      { commodity_id: c.id, crop_year: cropYear, mya_price_estimate: v, source: 'manual', updated_at: new Date().toISOString() },
      { onConflict: 'commodity_id,crop_year' },
    )
    setSaving((s) => { const n = new Set(s); n.delete(c.id); return n })
    if (error) { setErr(`Could not save the ${c.name} MYA: ${error.message}`); return }
    setErr(null)
    setDrafts((m) => { const n = new Map(m); n.delete(draftKey(c.id)); return n })
    onChanged()
  }

  async function revertToAuto(c: CoveredCommodity) {
    const stored = storedFor(c.id)
    if (!stored || stored.source !== 'manual') return
    setSaving((s) => new Set(s).add(c.id))
    // Back to the computed estimate. The manual value is cleared too — leaving
    // it in the estimate slot would keep resolving as a stored "estimate"
    // whenever no live quote is available, silently reinstating the revoked
    // override. The next live refresh repopulates the slot.
    const { error } = await supabase.from('arc_plc_price_data')
      .update({ source: 'barchart', mya_price_estimate: null, updated_at: new Date().toISOString() })
      .eq('id', stored.id)
    setSaving((s) => { const n = new Set(s); n.delete(c.id); return n })
    if (error) { setErr(`Could not revert ${c.name} to Auto: ${error.message}`); return }
    setErr(null)
    setDrafts((m) => { const n = new Map(m); n.delete(draftKey(c.id)); return n })
    onChanged()
  }

  function stateChip(r: MyaResolution) {
    const cls = r.state === 'final' ? 'bg-green-100 text-green-800'
      : r.state === 'manual' ? 'bg-sky-100 text-sky-800'
      : r.state === 'estimate' ? 'bg-slate-200 text-slate-700'
      : 'bg-amber-100 text-amber-800'
    return <span className={`text-xs rounded-full px-2 py-0.5 whitespace-nowrap ${cls}`}>{MYA_STATE_LABEL[r.state]}</span>
  }

  if (commodities.length === 0) return null

  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-2 avoid-break">
      <h2 className="font-bold text-lg">MYA Prices — {cropYear}</h2>
      <p className="text-xs text-slate-500">
        The Marketing-Year Average price drives every PLC projection: the payment rate is the effective reference
        price minus the MYA (floored at the loan rate, never below $0). Estimates blend season-to-date USDA averages
        with current futures; switch a commodity to Manual to override. A published USDA final always governs.
      </p>
      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{err}</div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className={theadCls}>
            <tr>
              {['Commodity', 'MYA Price', 'State', 'Source', 'Ref. Price', 'PLC Rate/Unit', ''].map((h) => (
                <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {commodities.map((c) => {
              const stored = storedFor(c.id)
              const r = resolveMyaPrice({ commodityName: c.name, priceData: stored, liveEstimate: liveMya.get(c.id) ?? null })
              const effRef = effectiveReferencePrice(c, stored)
              const loan = Number(c.national_loan_rate)
              const rate = r.price != null ? Math.max(0, effRef - Math.max(r.price, loan)) : null
              const isManual = r.state === 'manual'
              // Manual-only commodities always edit inline — there is no auto
              // estimate to toggle back to. A published final locks the row.
              const editable = isManual || (r.manualOnly && r.state !== 'final')
              const busy = saving.has(c.id)
              const draft = drafts.get(draftKey(c.id))
              return (
                <tr key={c.id} className="border-t border-slate-100 align-middle">
                  <td className="px-2 py-1 font-semibold whitespace-nowrap">{c.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                    {editable ? (
                      <input
                        type="number" step="0.01" min="0"
                        value={draft ?? (r.price != null ? String(r.price) : '')}
                        onChange={(e) => setDrafts((m) => new Map(m).set(draftKey(c.id), e.target.value))}
                        onBlur={() => { if (draft != null) saveManual(c, draft) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                        disabled={busy}
                        className="w-24 rounded border border-slate-300 px-2 py-1 text-right tabular-nums no-print"
                      />
                    ) : (
                      <span className={r.price == null ? toneText('warning') : ''}>{r.price != null ? fmtPrice(r.price) : 'enter a price'}</span>
                    )}
                    {editable && <span className="hidden print:inline">{r.price != null ? fmtPrice(r.price) : '—'}</span>}
                  </td>
                  <td className="px-2 py-1">{stateChip(r)}</td>
                  <td className="px-2 py-1 text-xs text-slate-500 whitespace-nowrap">
                    {r.state === 'final' ? 'USDA published final'
                      : r.manualOnly ? 'Manual only — no futures market'
                      : r.state === 'estimate' ? (r.live ? 'Live nearby futures (Barchart)' : 'Most recent stored estimate')
                      : r.state === 'manual' ? 'Operator override'
                      : 'No estimate available'}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtPrice(effRef)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums font-semibold ${rate != null && rate > 0 ? toneText('favorable') : toneText('muted')}`}>
                    {rate != null ? fmtPrice(rate) : '—'}
                  </td>
                  <td className="px-2 py-1 no-print whitespace-nowrap">
                    {r.manualOnly || r.state === 'final' ? null : (
                      <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden text-xs">
                        <button
                          onClick={() => revertToAuto(c)}
                          disabled={busy || !isManual}
                          className={`px-2 py-1 ${!isManual ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                        >
                          Auto
                        </button>
                        <button
                          onClick={() => { if (!isManual && r.price != null) saveManual(c, String(r.price)) }}
                          disabled={busy || isManual}
                          className={`px-2 py-1 border-l border-slate-300 ${isManual ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                        >
                          Manual
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {commodities.some((c) => resolveMyaPrice({ commodityName: c.name, priceData: storedFor(c.id), liveEstimate: liveMya.get(c.id) ?? null }).manualOnly) && (
        <p className="text-xs text-slate-400">
          Commodities without traded futures (seed cotton, sorghum, oats, …) have no auto estimate — enter the MYA manually.
        </p>
      )}
    </section>
  )
}
