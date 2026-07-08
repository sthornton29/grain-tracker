'use client'

// MYA price panel — shared by the ARC/PLC Decision Aid and the Government
// Payment Tracker so both pages surface (and edit) the SAME per-commodity MYA
// resolution (lib/government-payments.ts resolveMyaPrice: published final >
// manual override > WASDE midpoint > blended estimate). For each commodity:
// the resolved MYA with its state, an Auto | Manual toggle, the effective
// reference price, and the PLC payment rate the spread produces. The
// expandable Details row exposes the estimate's composition (which months are
// USDA-published vs futures-implied), the editable monthly-price table, the
// WASDE-midpoint shortcut, and — for seed cotton — the lint↔seed-cotton entry
// modes.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtPrice } from '@/lib/hedging'
import {
  resolveMyaPrice, effectiveReferencePrice, MYA_STATE_LABEL, type MyaResolution,
} from '@/lib/government-payments'
import { marketingYearMonths, describeMyaComposition } from '@/lib/mya-estimate'
import type { LiveMyaDetail } from '@/lib/use-live-mya'
import SeedCottonCalculator from '@/components/government/seed-cotton-calculator'
import { theadCls, toneText } from '@/components/reports/report-kit'
import type { ArcPlcPriceData, CoveredCommodity, MyaMonthlyPrice } from '@/lib/types'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function MyaPricePanel({
  cropYear, commodities, priceData, liveMya, liveDetails, monthlyPrices, onChanged, onRefreshEstimates,
}: {
  cropYear: number
  commodities: CoveredCommodity[]
  priceData: ArcPlcPriceData[]
  liveMya: Map<string, number>
  /** Per-commodity blend composition from useLiveMyaDetailed (optional). */
  liveDetails?: Map<string, LiveMyaDetail>
  /** All mya_monthly_prices rows (any year; filtered here). */
  monthlyPrices?: MyaMonthlyPrice[]
  /** Called after a manual save / auto revert so the page refetches price data. */
  onChanged: () => void
  /** Called after monthly-price/WASDE edits so the page re-runs the blend. */
  onRefreshEstimates?: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  // Drafts are keyed commodity × crop year so a number typed for one year can
  // never be shown — or saved — against another.
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map())
  const [monthDrafts, setMonthDrafts] = useState<Map<string, string>>(new Map())
  const [wasdeDrafts, setWasdeDrafts] = useState<Map<string, string>>(new Map())
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)

  const draftKey = (commodityId: string) => `${cropYear}:${commodityId}`
  const storedFor = (commodityId: string) =>
    priceData.find((p) => p.commodity_id === commodityId && p.crop_year === cropYear) ?? null
  const monthlyFor = (commodityId: string) =>
    (monthlyPrices ?? []).filter((m) => m.commodity_id === commodityId && m.crop_year === cropYear)

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
      .update({ source: 'barchart', mya_price_estimate: null, mya_note: null, updated_at: new Date().toISOString() })
      .eq('id', stored.id)
    setSaving((s) => { const n = new Set(s); n.delete(c.id); return n })
    if (error) { setErr(`Could not revert ${c.name} to Auto: ${error.message}`); return }
    setErr(null)
    setDrafts((m) => { const n = new Map(m); n.delete(draftKey(c.id)); return n })
    onChanged()
  }

  async function saveWasde(c: CoveredCommodity, raw: string) {
    const trimmed = raw.trim()
    const v = trimmed === '' ? null : Number(trimmed)
    if (v != null && (!Number.isFinite(v) || v < 0)) return
    setSaving((s) => new Set(s).add(c.id))
    const { error } = await supabase.from('arc_plc_price_data').upsert(
      {
        commodity_id: c.id, crop_year: cropYear, wasde_midpoint: v,
        source: v != null ? 'wasde' : 'barchart', updated_at: new Date().toISOString(),
      },
      { onConflict: 'commodity_id,crop_year' },
    )
    setSaving((s) => { const n = new Set(s); n.delete(c.id); return n })
    if (error) { setErr(`Could not save the ${c.name} WASDE midpoint: ${error.message}`); return }
    setErr(null)
    setWasdeDrafts((m) => { const n = new Map(m); n.delete(draftKey(c.id)); return n })
    onChanged()
  }

  async function saveMonthly(c: CoveredCommodity, month: number, raw: string) {
    const trimmed = raw.trim()
    setSaving((s) => new Set(s).add(c.id))
    let error: { message: string } | null = null
    if (trimmed === '') {
      const existing = monthlyFor(c.id).find((m) => m.month === month)
      if (existing) ({ error } = await supabase.from('mya_monthly_prices').delete().eq('id', existing.id))
    } else {
      const v = Number(trimmed)
      if (!Number.isFinite(v) || v < 0) { setSaving((s) => { const n = new Set(s); n.delete(c.id); return n }); return }
      ;({ error } = await supabase.from('mya_monthly_prices').upsert(
        { commodity_id: c.id, crop_year: cropYear, month, price: v, source: 'usda', updated_at: new Date().toISOString() },
        { onConflict: 'commodity_id,crop_year,month' },
      ))
    }
    setSaving((s) => { const n = new Set(s); n.delete(c.id); return n })
    if (error) { setErr(`Could not save the ${c.name} monthly price: ${error.message}`); return }
    setErr(null)
    setMonthDrafts((m) => { const n = new Map(m); n.delete(`${draftKey(c.id)}:${month}`); return n })
    onChanged()
    onRefreshEstimates?.()
  }

  function stateChip(r: MyaResolution) {
    const cls = r.state === 'final' ? 'bg-green-100 text-green-800'
      : r.state === 'manual' ? 'bg-sky-100 text-sky-800'
      : r.state === 'wasde' ? 'bg-violet-100 text-violet-800'
      : r.state === 'estimate' ? 'bg-slate-200 text-slate-700'
      : 'bg-amber-100 text-amber-800'
    return <span className={`text-xs rounded-full px-2 py-0.5 whitespace-nowrap ${cls}`}>{MYA_STATE_LABEL[r.state]}</span>
  }

  if (commodities.length === 0) return null

  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-2 avoid-break">
      <h2 className="font-bold text-lg">MYA Prices — {cropYear}</h2>
      <p className="text-xs text-slate-500">
        The Marketing-Year Average price drives every PLC and ARC-CO projection. Estimates are a month-by-month
        marketing-year blend: USDA-published monthly farm prices where entered, futures-implied for the remaining
        months (nearest contract − a per-commodity adjustment), weighted by typical monthly marketings. Open{' '}
        <b>Details</b> to enter monthly prices, a WASDE season-average midpoint (which overrides the blend), or the
        seed-cotton lint conversion. A Manual override and a published USDA final outrank all estimates.
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
              const detail = liveDetails?.get(c.id)
              const isOpen = expanded.has(c.id)
              const monthly = monthlyFor(c.id)
              const months = marketingYearMonths(Number(c.marketing_year_start_month || 9), cropYear)
              const isSeedCotton = c.name.trim().toLowerCase() === 'seed cotton'
              return (
                <FragmentRow key={c.id}>
                  <tr className="border-t border-slate-100 align-middle">
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
                    <td className="px-2 py-1 text-xs text-slate-500">
                      {r.state === 'final' ? 'USDA published final'
                        : r.state === 'manual' ? (stored?.mya_note || 'Operator override')
                        : r.state === 'wasde' ? 'WASDE season-average midpoint'
                        : r.state === 'estimate' && detail?.composition ? describeMyaComposition({
                            estimate: detail.price,
                            months: detail.composition.months,
                            publishedCount: detail.composition.publishedCount,
                            futuresCount: detail.composition.futuresCount,
                            missingCount: detail.composition.missingCount,
                            basisAdj: detail.composition.basisAdj,
                          })
                        : r.manualOnly ? 'Manual only — no futures market'
                        : r.state === 'estimate' ? (r.live ? 'Live marketing-year blend' : 'Most recent stored estimate')
                        : 'No estimate available'}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtPrice(effRef)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums font-semibold ${rate != null && rate > 0 ? toneText('favorable') : toneText('muted')}`}>
                      {rate != null ? fmtPrice(rate) : '—'}
                    </td>
                    <td className="px-2 py-1 no-print whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
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
                        <button
                          onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })}
                          className="text-xs text-slate-500 underline whitespace-nowrap"
                        >
                          {isOpen ? 'Hide details' : 'Details'}
                        </button>
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-slate-100 bg-slate-50 no-print">
                      <td colSpan={7} className="px-3 py-3">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-end gap-4">
                            <label className="text-sm flex flex-col gap-1">
                              <span className="text-slate-500">
                                WASDE season-average midpoint ($/{c.unit === 'pound' ? 'lb' : 'bu'}) — overrides the blend when set
                              </span>
                              <input
                                type="number" step="0.01" min="0"
                                value={wasdeDrafts.get(draftKey(c.id)) ?? (stored?.wasde_midpoint != null ? String(stored.wasde_midpoint) : '')}
                                onChange={(e) => setWasdeDrafts((m) => new Map(m).set(draftKey(c.id), e.target.value))}
                                onBlur={(e) => saveWasde(c, e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                disabled={busy}
                                className="w-32 rounded border border-slate-300 px-2 py-1 text-right tabular-nums bg-white"
                              />
                            </label>
                            <div className="text-xs text-slate-500 max-w-md">
                              Monthly USDA/NASS average farm prices — type them as they’re published; blank clears a
                              month. Months without a price are futures-implied
                              {c.mya_basis_adj != null ? ` (futures ${Number(c.mya_basis_adj) < 0 ? '−' : '+'} $${Math.abs(Number(c.mya_basis_adj)).toFixed(2)})` : ''}.
                              <span className="ml-1 font-semibold">{monthly.length} of 12 filled.</span>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                            {months.map((m) => {
                              const existing = monthly.find((mp) => mp.month === m.month)
                              const mKey = `${draftKey(c.id)}:${m.month}`
                              const monthDetail = detail?.composition?.months.find((x) => x.month === m.month)
                              return (
                                <label key={m.month} className="text-xs flex flex-col gap-0.5">
                                  <span className={existing ? 'text-green-700 font-semibold' : 'text-slate-500'}>
                                    {MONTH_ABBR[m.month - 1]} {String(m.year % 100).padStart(2, '0')}
                                    {!existing && monthDetail?.source === 'futures' && monthDetail.symbol ? ` · ${monthDetail.symbol}` : ''}
                                  </span>
                                  <input
                                    type="number" step="0.01" min="0"
                                    placeholder={!existing && monthDetail?.price != null ? String(monthDetail.price) : ''}
                                    value={monthDrafts.get(mKey) ?? (existing ? String(existing.price) : '')}
                                    onChange={(e) => setMonthDrafts((dm) => new Map(dm).set(mKey, e.target.value))}
                                    onBlur={(e) => { if (monthDrafts.has(mKey)) saveMonthly(c, m.month, e.target.value) }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                    disabled={busy}
                                    className="w-full rounded border border-slate-300 px-1.5 py-1 text-right tabular-nums bg-white"
                                  />
                                </label>
                              )
                            })}
                          </div>
                          {isSeedCotton && (
                            <SeedCottonCalculator
                              commodity={c}
                              cropYear={cropYear}
                              priceData={stored}
                              onSaved={onChanged}
                              compact
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              )
            })}
          </tbody>
        </table>
      </div>
      {commodities.some((c) => resolveMyaPrice({ commodityName: c.name, priceData: storedFor(c.id), liveEstimate: liveMya.get(c.id) ?? null }).manualOnly) && (
        <p className="text-xs text-slate-400">
          Commodities without traded futures (seed cotton, sorghum, oats, …) have no futures-implied months — enter
          monthly USDA prices in Details, use the seed-cotton conversion, or set the MYA manually.
        </p>
      )}
    </section>
  )
}

// A keyed fragment for the main row + expandable detail row pair.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
