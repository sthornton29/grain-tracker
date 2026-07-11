'use client'

// MYA price panel — shared by the ARC/PLC Decision Aid and the Government
// Payment Tracker so both pages surface (and edit) the SAME per-commodity MYA
// resolution (lib/government-payments.ts resolveMyaPrice: published final >
// manual override > WASDE midpoint > blended estimate). EVERY covered
// commodity gets the same treatment: an Auto | Manual toggle, inline manual
// entry, and the USDA monthly AI lookup — commodities without Barchart
// futures (seed cotton, sorghum, oats, …) simply have no futures-implied
// months, so their Auto mode is the USDA monthly blend alone. Seed cotton is
// ONE commodity with ONE price: the lookup fetches the NASS lint + cottonseed
// series and the blend (configurable 43/57 shares) is computed in code, with
// the components shown before anything saves. The expandable Details row
// exposes the estimate's composition, the editable monthly-price table, and
// the WASDE-midpoint shortcut.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtPrice } from '@/lib/hedging'
import {
  resolveMyaPrice, effectiveReferencePrice, MYA_STATE_LABEL, LINT_SHARE, COTTONSEED_SHARE, type MyaResolution,
} from '@/lib/government-payments'
import { marketingYearMonths, describeMyaComposition, estimateMyaBlend } from '@/lib/mya-estimate'
import {
  defaultConfirmedMonths, planMonthlySaves, isSeedCotton, type MyaMonthlyLookupResult,
} from '@/lib/ai-lookups'
import type { LiveMyaDetail } from '@/lib/use-live-mya'
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
  // USDA monthly-price lookup, keyed commodity × crop year like the drafts:
  // the fetched months, which ones the user has confirmed, and any edits made
  // to the fetched values before confirming. Never auto-saved. The PRIMARY
  // source is the NASS Quick Stats API (real published data → source 'usda');
  // the AI web search is an explicit fallback (source 'ai').
  const [aiLookups, setAiLookups] = useState<Map<string, MyaMonthlyLookupResult>>(new Map())
  const [aiLooking, setAiLooking] = useState<Set<string>>(new Set())
  const [aiConfirmed, setAiConfirmed] = useState<Map<string, Set<number>>>(new Map())
  const [aiEdits, setAiEdits] = useState<Map<string, Map<number, string>>>(new Map())
  // Which backend produced the current result — drives the saved source.
  const [lookupSource, setLookupSource] = useState<Map<string, 'nass' | 'ai'>>(new Map())
  // NASS failure per key → an inline strip offering the AI fallback.
  const [lookupFailed, setLookupFailed] = useState<Map<string, string>>(new Map())
  // Lookups fired from the row's inline ↻ render as a compact confirm strip
  // under the row (instead of the full table inside Details).
  const [compactFor, setCompactFor] = useState<Set<string>>(new Set())

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
        { commodity_id: c.id, crop_year: cropYear, month, price: v, source: 'manual', note: null, updated_at: new Date().toISOString() },
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

  // Primary path hits the NASS Quick Stats route; `viaAi` retries through the
  // AI web-search route (offered only when NASS fails or finds nothing).
  async function lookupUsdaPrices(c: CoveredCommodity, opts?: { compact?: boolean; viaAi?: boolean }) {
    const k = draftKey(c.id)
    setCompactFor((s) => { const n = new Set(s); if (opts?.compact) n.add(k); else n.delete(k); return n })
    setAiLooking((s) => new Set(s).add(k))
    setErr(null)
    setLookupFailed((m) => { const n = new Map(m); n.delete(k); return n })
    try {
      const res = await fetch(opts?.viaAi ? '/api/mya-monthly-lookup' : '/api/nass-monthly-prices', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commodity: c.name,
          marketing_year: cropYear,
          start_month: Number(c.marketing_year_start_month || 9),
          unit: c.unit === 'pound' ? 'pound' : 'bushel',
          // Seed cotton: both routes fetch lint + cottonseed and blend at
          // these shares (in code, never at the source).
          lint_share: c.lint_share != null ? Number(c.lint_share) : undefined,
          seed_share: c.cottonseed_share != null ? Number(c.cottonseed_share) : undefined,
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.data) {
        const msg = json?.error ?? `USDA price lookup failed for ${c.name}.`
        if (opts?.viaAi) setErr(msg)
        else setLookupFailed((m) => new Map(m).set(k, msg))
        return
      }
      const data = json.data as MyaMonthlyLookupResult
      const existing = new Set(monthlyFor(c.id).map((m) => m.month))
      setLookupSource((m) => new Map(m).set(k, opts?.viaAi ? 'ai' : 'nass'))
      setAiLookups((m) => new Map(m).set(k, data))
      // Months already entered start UNCHECKED — they are never overwritten
      // without the user explicitly ticking them.
      setAiConfirmed((m) => new Map(m).set(k, defaultConfirmedMonths(data.monthly_prices, existing)))
      setAiEdits((m) => { const n = new Map(m); n.delete(k); return n })
    } catch {
      const msg = `USDA price lookup failed for ${c.name} — check your connection and try again.`
      if (opts?.viaAi) setErr(msg)
      else setLookupFailed((m) => new Map(m).set(k, msg))
    } finally {
      setAiLooking((s) => { const n = new Set(s); n.delete(k); return n })
    }
  }

  function dismissLookup(commodityId: string) {
    const k = draftKey(commodityId)
    setAiLookups((m) => { const n = new Map(m); n.delete(k); return n })
    setAiConfirmed((m) => { const n = new Map(m); n.delete(k); return n })
    setAiEdits((m) => { const n = new Map(m); n.delete(k); return n })
    setCompactFor((s) => { const n = new Set(s); n.delete(k); return n })
    setLookupSource((m) => { const n = new Map(m); n.delete(k); return n })
    setLookupFailed((m) => { const n = new Map(m); n.delete(k); return n })
  }

  // The MYA the blend would resolve to if the currently-confirmed fetched
  // months were saved: confirmed AI months merged over the existing entries,
  // the remaining months futures-implied from the live composition (whose
  // prices already include the basis adjustment — strip it so estimateMyaBlend
  // can re-apply it).
  function previewMya(c: CoveredCommodity, detail: LiveMyaDetail | undefined): number | null {
    const k = draftKey(c.id)
    const lookup = aiLookups.get(k)
    if (!lookup) return null
    const confirmed = aiConfirmed.get(k) ?? new Set<number>()
    const merged = new Map<number, number>(monthlyFor(c.id).map((m) => [m.month, Number(m.price)]))
    for (const f of lookup.monthly_prices) if (f.price != null && confirmed.has(f.month)) merged.set(f.month, f.price)
    const comp = detail?.composition
    const futuresBySymbol = new Map<string, number>()
    if (comp) {
      for (const m of comp.months) {
        if (m.source === 'futures' && m.symbol && m.price != null) futuresBySymbol.set(m.symbol, m.price - comp.basisAdj)
      }
    }
    return estimateMyaBlend({
      commodityName: c.name,
      marketingYearStartMonth: Number(c.marketing_year_start_month || 9),
      cropYear,
      monthlyPrices: [...merged].map(([month, price]) => ({ month, price })),
      futuresPriceForSymbol: (s) => futuresBySymbol.get(s) ?? null,
      basisAdj: comp?.basisAdj ?? (c.mya_basis_adj != null ? Number(c.mya_basis_adj) : null),
      weights: (c.mya_month_weights as number[] | null) ?? null,
    }).estimate
  }

  async function saveConfirmedMonths(c: CoveredCommodity) {
    const k = draftKey(c.id)
    const lookup = aiLookups.get(k)
    if (!lookup) return
    const edited = new Map<number, number>()
    for (const [month, raw] of aiEdits.get(k) ?? []) {
      const v = Number(raw)
      if (raw.trim() !== '' && Number.isFinite(v) && v >= 0) edited.set(month, v)
    }
    const plan = planMonthlySaves({
      fetched: lookup.monthly_prices,
      confirmed: aiConfirmed.get(k) ?? new Set(),
      edited,
      // NASS Quick Stats results are real published data → 'usda'; the AI
      // web-search fallback stays 'ai'.
      confirmedSource: lookupSource.get(k) === 'ai' ? 'ai' : 'usda',
    })
    if (plan.length === 0) { dismissLookup(c.id); return }
    setSaving((s) => new Set(s).add(c.id))
    const now = new Date().toISOString()
    const { error } = await supabase.from('mya_monthly_prices').upsert(
      plan.map((p) => ({ commodity_id: c.id, crop_year: cropYear, month: p.month, price: p.price, source: p.source, note: p.note, updated_at: now })),
      { onConflict: 'commodity_id,crop_year,month' },
    )
    setSaving((s) => { const n = new Set(s); n.delete(c.id); return n })
    if (error) { setErr(`Could not save the ${c.name} USDA prices: ${error.message}`); return }
    setErr(null)
    dismissLookup(c.id)
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
        months (nearest contract − a per-commodity adjustment), weighted by typical monthly marketings. Commodities
        without traded futures blend from USDA monthly prices alone — every commodity has the same Auto | Manual
        toggle and the same lookup, which pulls published months <b>directly from the USDA NASS Quick Stats API</b>
        (an AI web search remains as an explicit fallback). Open <b>Details</b> to enter monthly prices or a WASDE
        season-average midpoint (which overrides the blend). A Manual override and a published USDA final outrank
        all estimates.
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
              // Uniform behavior for every commodity: Manual state (and a row
              // with nothing resolved yet) edits inline; a published final
              // locks the row; everything else shows the Auto estimate.
              const editable = isManual || r.state === 'missing'
              const busy = saving.has(c.id)
              const draft = drafts.get(draftKey(c.id))
              const detail = liveDetails?.get(c.id)
              const isOpen = expanded.has(c.id)
              const monthly = monthlyFor(c.id)
              const months = marketingYearMonths(Number(c.marketing_year_start_month || 9), cropYear)
              const seedCotton = isSeedCotton(c.name)
              const k = draftKey(c.id)
              const canRefresh = !isManual && r.state !== 'final'
              const refreshTitle = canRefresh
                ? 'Refresh from USDA monthly prices (NASS Quick Stats — you confirm before anything saves)'
                : isManual ? 'Switch to Auto to use lookups'
                : 'USDA final published — nothing to refresh'
              const viaAi = lookupSource.get(k) === 'ai'
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
                      <button
                        onClick={() => { if (canRefresh) lookupUsdaPrices(c, { compact: true }) }}
                        disabled={!canRefresh || busy || aiLooking.has(k)}
                        title={refreshTitle}
                        aria-label={`Refresh ${c.name} MYA from USDA prices`}
                        className="ml-1.5 align-middle text-violet-700 hover:text-violet-900 disabled:text-slate-300 no-print"
                      >
                        <span className={aiLooking.has(k) ? 'inline-block animate-spin' : ''}>↻</span>
                      </button>
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
                        : r.state === 'estimate' ? (r.live ? (r.manualOnly ? 'USDA monthly blend (no futures market)' : 'Live marketing-year blend') : 'Most recent stored estimate')
                        : r.manualOnly ? 'No futures market — look up USDA prices (↻) or type a price'
                        : 'No estimate available'}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtPrice(effRef)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums font-semibold ${rate != null && rate > 0 ? toneText('favorable') : toneText('muted')}`}>
                      {rate != null ? fmtPrice(rate) : '—'}
                    </td>
                    <td className="px-2 py-1 no-print whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        {r.state === 'final' ? null : (
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
                  {!isOpen && compactFor.has(k) && (() => {
                    const lookup = aiLookups.get(k)
                    if (!lookup) return null
                    const confirmed = aiConfirmed.get(k) ?? new Set<number>()
                    const published = lookup.monthly_prices.filter((f) => f.price != null)
                    const confirmCount = published.filter((f) => confirmed.has(f.month)).length
                    const skipped = published.length - confirmCount
                    const resulting = previewMya(c, detail)
                    return (
                      <tr className="bg-violet-50 no-print">
                        <td colSpan={7} className="px-3 py-2 text-sm">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="font-semibold whitespace-nowrap">USDA prices found:</span>
                            <span className="text-xs text-slate-600">
                              {published.length === 0
                                ? 'no published months yet'
                                : published.map((f, i) => (
                                    <span key={f.key} title={f.note ?? undefined}>
                                      {i > 0 ? ' · ' : ''}{MONTH_ABBR[f.month - 1]} {fmtPrice(f.price!)}{f.note ? '*' : ''}
                                    </span>
                                  ))}
                            </span>
                            {viaAi
                              ? <span className={`text-xs rounded-full px-1.5 py-0.5 ${lookup.confidence === 'high' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>AI fallback — {lookup.confidence} confidence</span>
                              : <span className="text-xs rounded-full px-1.5 py-0.5 bg-green-100 text-green-800">NASS published</span>}
                            {resulting != null && confirmCount > 0 && (
                              <span className="whitespace-nowrap">→ resulting MYA <b>{fmtPrice(resulting)}</b></span>
                            )}
                            {confirmCount > 0 ? (
                              <button
                                onClick={() => saveConfirmedMonths(c)}
                                disabled={busy}
                                className="rounded-lg bg-green-700 text-white px-3 py-1 text-xs font-semibold disabled:opacity-50"
                              >
                                Confirm &amp; save {confirmCount} month{confirmCount === 1 ? '' : 's'}
                              </button>
                            ) : (
                              <span className="text-xs text-amber-800">Nothing new to save{skipped > 0 ? ' — all fetched months are already entered (open Details to overwrite)' : ''}.</span>
                            )}
                            {published.length === 0 && !viaAi && (
                              <button
                                onClick={() => lookupUsdaPrices(c, { compact: true, viaAi: true })}
                                disabled={busy || aiLooking.has(k)}
                                className="rounded-lg bg-violet-700 text-white px-3 py-1 text-xs font-semibold disabled:opacity-50"
                              >
                                Try AI lookup
                              </button>
                            )}
                            <button
                              onClick={() => setExpanded((s) => new Set(s).add(c.id))}
                              className="text-xs text-slate-600 underline whitespace-nowrap"
                            >
                              Review / edit in details
                            </button>
                            <button onClick={() => dismissLookup(c.id)} className="text-xs text-slate-500 underline">cancel</button>
                          </div>
                          {skipped > 0 && confirmCount > 0 && (
                            <p className="text-[11px] text-slate-500 mt-1">
                              {skipped} month{skipped === 1 ? ' was' : 's were'} left out because you already entered {skipped === 1 ? 'it' : 'them'} —
                              open Details to overwrite explicitly. Recent NASS months are often preliminary.
                            </p>
                          )}
                        </td>
                      </tr>
                    )
                  })()}
                  {!isOpen && lookupFailed.has(k) && (
                    <tr className="bg-amber-50 no-print">
                      <td colSpan={7} className="px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-amber-900">{lookupFailed.get(k)}</span>
                          <button
                            onClick={() => lookupUsdaPrices(c, { compact: true, viaAi: true })}
                            disabled={busy || aiLooking.has(k)}
                            className="rounded-lg bg-violet-700 text-white px-3 py-1 text-xs font-semibold disabled:opacity-50"
                          >
                            {aiLooking.has(k) ? 'Searching…' : 'Try AI lookup'}
                          </button>
                          <button onClick={() => setLookupFailed((m) => { const n = new Map(m); n.delete(k); return n })} className="text-xs text-slate-500 underline">dismiss</button>
                        </div>
                      </td>
                    </tr>
                  )}
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
                            <button
                              onClick={() => lookupUsdaPrices(c)}
                              disabled={busy || aiLooking.has(draftKey(c.id))}
                              title="Pulls the published months straight from the USDA NASS Quick Stats API — you confirm before anything saves."
                              className="rounded-lg bg-violet-700 text-white px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
                            >
                              {aiLooking.has(draftKey(c.id)) ? 'Searching…' : 'Look up USDA prices'}
                            </button>
                          </div>
                          {lookupFailed.has(k) && (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm flex flex-wrap items-center gap-3">
                              <span className="text-amber-900">{lookupFailed.get(k)}</span>
                              <button
                                onClick={() => lookupUsdaPrices(c, { viaAi: true })}
                                disabled={busy || aiLooking.has(k)}
                                className="rounded-lg bg-violet-700 text-white px-3 py-1 text-xs font-semibold disabled:opacity-50"
                              >
                                {aiLooking.has(k) ? 'Searching…' : 'Try AI lookup'}
                              </button>
                              <button onClick={() => setLookupFailed((m) => { const n = new Map(m); n.delete(k); return n })} className="text-xs text-slate-500 underline">dismiss</button>
                            </div>
                          )}
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                            {months.map((m) => {
                              const existing = monthly.find((mp) => mp.month === m.month)
                              const mKey = `${draftKey(c.id)}:${m.month}`
                              const monthDetail = detail?.composition?.months.find((x) => x.month === m.month)
                              return (
                                <label key={m.month} className="text-xs flex flex-col gap-0.5">
                                  <span
                                    className={existing && existing.source !== 'manual' ? 'text-violet-700 font-semibold' : existing ? 'text-green-700 font-semibold' : 'text-slate-500'}
                                    title={existing?.note ?? (existing?.source === 'usda' ? 'USDA NASS published (confirmed from the lookup)' : existing?.source === 'ai' ? 'Confirmed from the AI lookup' : existing ? 'Entered manually' : undefined)}
                                  >
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
                          {(() => {
                            const k = draftKey(c.id)
                            const lookup = aiLookups.get(k)
                            if (!lookup) return null
                            const confirmed = aiConfirmed.get(k) ?? new Set<number>()
                            const edits = aiEdits.get(k) ?? new Map<number, string>()
                            const confirmable = lookup.monthly_prices.filter((f) => f.price != null)
                            const confirmCount = confirmable.filter((f) => confirmed.has(f.month)).length
                            const toggle = (month: number) => setAiConfirmed((m) => {
                              const set = new Set(m.get(k) ?? [])
                              if (set.has(month)) set.delete(month); else set.add(month)
                              return new Map(m).set(k, set)
                            })
                            return (
                              <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-2">
                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                  <span className="font-semibold">USDA NASS monthly prices found</span>
                                  {viaAi
                                    ? <span className={`text-xs rounded-full px-1.5 py-0.5 ${lookup.confidence === 'high' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>AI fallback — {lookup.confidence} confidence</span>
                                    : <span className="text-xs rounded-full px-1.5 py-0.5 bg-green-100 text-green-800">NASS published</span>}
                                  <span className="text-xs text-slate-500 flex-1 min-w-[200px]">{lookup.source_description}</span>
                                </div>
                                <p className="text-xs text-slate-500">
                                  Check the months to save (source “{viaAi ? 'ai' : 'usda'}”); edit a value before saving and it becomes “manual”.
                                  Months you already entered start unchecked and are never overwritten without checking them.
                                  NASS revises recent months — the one or two most recent published months are often preliminary.
                                </p>
                                {confirmable.length === 0 ? (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-xs text-amber-800">No published months found — NASS may not have released prices for this marketing year yet.</p>
                                    {!viaAi && (
                                      <button
                                        onClick={() => lookupUsdaPrices(c, { viaAi: true })}
                                        disabled={busy || aiLooking.has(k)}
                                        className="rounded-lg bg-violet-700 text-white px-3 py-1 text-xs font-semibold disabled:opacity-50"
                                      >
                                        Try AI lookup
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    {lookup.monthly_prices.map((f) => {
                                      const existing = monthly.find((mp) => mp.month === f.month)
                                      const label = `${MONTH_ABBR[f.month - 1]} ${String(f.year % 100).padStart(2, '0')}`
                                      if (f.price == null) {
                                        return (
                                          <div key={f.key} className="text-xs text-slate-400 rounded border border-slate-200 bg-white px-2 py-1.5">
                                            {label} — not yet published
                                          </div>
                                        )
                                      }
                                      const differs = existing != null && Number(existing.price) !== f.price
                                      return (
                                        <label key={f.key} className={`text-xs flex flex-col gap-0.5 rounded border px-2 py-1.5 bg-white ${differs ? 'border-amber-300' : 'border-slate-200'}`}>
                                          <span className="flex items-center gap-1.5">
                                            <input type="checkbox" checked={confirmed.has(f.month)} onChange={() => toggle(f.month)} />
                                            <span className="font-semibold">{label}</span>
                                          </span>
                                          <input
                                            type="number" step="0.01" min="0"
                                            value={edits.get(f.month) ?? String(f.price)}
                                            onChange={(e) => setAiEdits((m) => {
                                              const inner = new Map(m.get(k) ?? [])
                                              inner.set(f.month, e.target.value)
                                              return new Map(m).set(k, inner)
                                            })}
                                            className="w-full rounded border border-slate-300 px-1.5 py-1 text-right tabular-nums"
                                          />
                                          {f.note && <span className="text-slate-500" title="Blended in the app from the two NASS series — never by the AI.">{f.note}</span>}
                                          {existing != null && (
                                            <span className={differs ? 'text-amber-700' : 'text-slate-400'}>
                                              {differs ? `differs from your ${fmtPrice(Number(existing.price))}` : 'matches your entry'}
                                            </span>
                                          )}
                                        </label>
                                      )
                                    })}
                                  </div>
                                )}
                                <div className="flex items-center gap-3">
                                  <button
                                    onClick={() => saveConfirmedMonths(c)}
                                    disabled={busy || confirmCount === 0}
                                    className="rounded-lg bg-green-700 text-white px-3 py-1 text-xs font-semibold disabled:opacity-50"
                                  >
                                    Save {confirmCount} confirmed month{confirmCount === 1 ? '' : 's'}
                                  </button>
                                  <button onClick={() => dismissLookup(c.id)} className="text-xs text-slate-500 underline">dismiss</button>
                                </div>
                              </div>
                            )
                          })()}
                          {seedCotton && <SeedCottonShares commodity={c} busy={busy} onSaved={onChanged} />}
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
          Commodities without traded futures (seed cotton, sorghum, oats, …) have no futures-implied months — their
          Auto estimate is the USDA monthly blend alone (use the ↻ lookup or type months in Details). Seed
          cotton&apos;s monthly price is blended in the app from the NASS lint (¢/lb) and cottonseed ($/ton) series.
        </p>
      )}
    </section>
  )
}

// A keyed fragment for the main row + expandable detail row pair.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

// Seed cotton lint/cottonseed weight shares (standard 43/57), persisted on
// covered_commodities and applied by the USDA lookup's in-code blend. Blank =
// the standard defaults.
function SeedCottonShares({ commodity, busy, onSaved }: { commodity: CoveredCommodity; busy: boolean; onSaved: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [lint, setLint] = useState(commodity.lint_share != null ? String(Number(commodity.lint_share)) : '')
  const [seed, setSeed] = useState(commodity.cottonseed_share != null ? String(Number(commodity.cottonseed_share)) : '')
  const [err, setErr] = useState<string | null>(null)
  const lintNum = lint.trim() === '' ? LINT_SHARE : Number(lint)
  const seedNum = seed.trim() === '' ? COTTONSEED_SHARE : Number(seed)
  const offSum = Number.isFinite(lintNum) && Number.isFinite(seedNum) && Math.abs(lintNum + seedNum - 1) > 0.001

  async function save() {
    const l = lint.trim() === '' ? null : Number(lint)
    const s = seed.trim() === '' ? null : Number(seed)
    const bad = (v: number | null) => v != null && (!Number.isFinite(v) || v <= 0 || v > 1)
    if (bad(l) || bad(s)) { setErr('Shares must be between 0 and 1 (e.g. 0.43).'); return }
    const { error } = await supabase.from('covered_commodities')
      .update({ lint_share: l, cottonseed_share: s })
      .eq('id', commodity.id)
    if (error) { setErr(`Could not save the seed cotton shares: ${error.message}`); return }
    setErr(null)
    onSaved()
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-1.5">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <span className="text-slate-500 max-w-sm text-xs">
          Seed cotton monthly prices are blended in the app from the NASS lint (¢/lb) and cottonseed ($/ton)
          series at these weight shares (standard 43/57). Blank = standard.
        </span>
        <label className="flex flex-col gap-0.5 text-xs">
          <span className="text-slate-500">Lint share</span>
          <input type="number" step="0.01" min="0" max="1" placeholder={String(LINT_SHARE)} value={lint}
            onChange={(e) => setLint(e.target.value)} onBlur={save} disabled={busy}
            className="w-20 rounded border border-slate-300 px-2 py-1 text-right tabular-nums" />
        </label>
        <label className="flex flex-col gap-0.5 text-xs">
          <span className="text-slate-500">Seed share</span>
          <input type="number" step="0.01" min="0" max="1" placeholder={String(COTTONSEED_SHARE)} value={seed}
            onChange={(e) => setSeed(e.target.value)} onBlur={save} disabled={busy}
            className="w-20 rounded border border-slate-300 px-2 py-1 text-right tabular-nums" />
        </label>
        {offSum && <span className="text-xs text-amber-700 pb-1.5">Shares don’t sum to 1.00 — check the split.</span>}
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  )
}
