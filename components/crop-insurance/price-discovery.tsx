'use client'

// The unified "Crop Insurance Price Discovery" window — ONE place for every
// insurance price: one row per crop the org grows (× state where offers
// differ), showing the offer identity, its base contract, and both prices
// with explicit phases. Absorbs the old ProjectedPricesEditor (inline manual
// override + reset-to-RMA + keep-mine) and the RMA status card.
//
// Refresh is WRITE-THEN-SWAP (lib mergeRmaResults): new data replaces the
// display only after it validates; failures keep the prior values with a
// visible "showing values as of…" error — a refresh can never blank the
// window. Downstream (Claims Monitor, Income Sensitivity, …) reads the same
// resolution functions — this component is presentation only.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtPrice } from '@/lib/hedging'
import { usePersistentState } from '@/lib/use-persistent-state'
import { mergeRmaResults, type RmaLookupResult } from '@/lib/rma-price-discovery'
import { resolveHarvestPriceByCrop, type LiveHarvest } from '@/lib/crop-insurance'
import { harvestTierLabel } from '@/lib/insurance-price-rows'
import { buildPriceDiscoveryRows, type PriceDiscoveryRow } from '@/lib/insurance-price-rows'
import type { County, Crop, CropInsurancePolicy, FieldPlanting, HarvestPriceEstimate } from '@/lib/types'

const chipCls: Record<string, string> = {
  rma: 'bg-green-100 text-green-800',
  manual: 'bg-sky-100 text-sky-800',
  seed: 'bg-amber-100 text-amber-800',
  in: 'bg-sky-100 text-sky-800',
  post: 'bg-green-100 text-green-800',
  pre: 'bg-slate-200 text-slate-600',
}

export default function PriceDiscovery({
  cropYear,
  crops,
  plantings,
  policies,
  counties,
  estimates,
  onChanged,
}: {
  cropYear: number
  crops: readonly Crop[]
  plantings: readonly FieldPlanting[]
  policies: readonly CropInsurancePolicy[]
  counties: readonly County[]
  estimates: readonly HarvestPriceEstimate[]
  /** Re-reads the page's estimates after RMA mirrors rows or a manual save. */
  onChanged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [results, setResults] = useState<RmaLookupResult[]>([])
  const [liveQuotes, setLiveQuotes] = useState<Map<string, { price: number; priceDate: string | null }>>(new Map())
  const [busy, setBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  const grownCrops = useMemo(() => {
    const ids = new Set<string>([
      ...plantings.filter((p) => p.season_year === cropYear).map((p) => p.crop_id),
      ...policies.filter((p) => p.crop_year === cropYear).map((p) => p.crop_id),
    ])
    return crops.filter((c) => ids.has(c.id))
  }, [crops, plantings, policies, cropYear])
  const states = useMemo(
    () => [...new Set(policies
      .filter((p) => p.crop_year === cropYear && p.county_id)
      .map((p) => countyById.get(p.county_id!)?.state_code)
      .filter((s): s is string => !!s))],
    [policies, cropYear, countyById],
  )

  // The as-of stamp for the failure message: the newest data actually shown.
  const asOf = useMemo(() => {
    const ts = results.map((r) => r.fetched_at).sort()
    return ts.length > 0 ? ts[ts.length - 1].slice(0, 10) : null
  }, [results])

  // Harvest keep-mine — SHARED with the Claims Monitor (same localStorage
  // key), so keeping a manual final here is honored everywhere.
  const [harvestKeepByYear, setHarvestKeepByYear] = usePersistentState<Record<string, string[]>>('ci-claims:keepManualHarvest', {})
  const harvestKeepSet = useMemo(() => new Set(harvestKeepByYear[String(cropYear)] ?? []), [harvestKeepByYear, cropYear])
  const setHarvestKeep = (cropId: string, keep: boolean) =>
    setHarvestKeepByYear((prev) => {
      const cur = new Set(prev[String(cropYear)] ?? [])
      if (keep) cur.add(cropId); else cur.delete(cropId)
      return { ...prev, [String(cropYear)]: [...cur] }
    })
  const [harvestDrafts, setHarvestDrafts] = useState<Record<string, string>>({})

  // The SAME resolution every downstream consumer reads (RMA final > manual
  // final w/ keep-mine > RMA discovery avg > live estimate > stored estimate
  // > projected) — the harvest cell displays and edits against it.
  const harvestResByCrop = useMemo(() => {
    const liveByCrop = new Map<string, LiveHarvest>()
    for (const [id, q] of liveQuotes) liveByCrop.set(id, { price: q.price, stale: false, priceDate: q.priceDate })
    return resolveHarvestPriceByCrop({
      cropIds: grownCrops.map((c) => c.id), cropYear,
      policies: policies.filter((p) => p.crop_year === cropYear),
      estimates, liveByCrop, crops: grownCrops,
      keepManualCropIds: harvestKeepSet,
    })
  }, [grownCrops, cropYear, policies, estimates, liveQuotes, harvestKeepSet])

  async function saveManualHarvest(row: PriceDiscoveryRow) {
    const raw = (harvestDrafts[row.cropId] ?? '').trim()
    setMsg(null)
    const price = Number(raw)
    if (raw === '' || !Number.isFinite(price) || price <= 0) { setMsg('Enter a positive harvest price.'); return }
    setSaving(true)
    const { error: e } = await supabase.from('harvest_price_estimates').upsert(
      { crop_id: row.cropId, crop_year: cropYear, price_type: 'harvest_final', price, source: 'manual', price_date: new Date().toISOString().slice(0, 10) },
      { onConflict: 'crop_id,crop_year,price_type,price_date' },
    )
    setSaving(false)
    if (e) { setMsg(e.message); return }
    // Typing over a published RMA final is the deliberate override — keep it.
    if (harvestResByCrop.get(row.cropId)?.rmaFinal) setHarvestKeep(row.cropId, true)
    setHarvestDrafts((d) => { const n = { ...d }; delete n[row.cropId]; return n })
    onChanged()
  }
  async function resetHarvestToRma(row: PriceDiscoveryRow) {
    setMsg(null)
    setSaving(true)
    const { error: e } = await supabase
      .from('harvest_price_estimates')
      .delete()
      .eq('crop_id', row.cropId).eq('crop_year', cropYear).eq('price_type', 'harvest_final')
      .eq('source', 'manual')
    setSaving(false)
    if (e) { setMsg(e.message); return }
    setHarvestKeep(row.cropId, false)
    setHarvestDrafts((d) => { const n = { ...d }; delete n[row.cropId]; return n })
    onChanged()
  }

  // "Keep mine" (manual projected kept over a published RMA value), per year.
  const [keepByYear, setKeepByYear] = usePersistentState<Record<string, string[]>>('crop-insurance:keepManualProjected', {})
  const keepSet = useMemo(() => new Set(keepByYear[String(cropYear)] ?? []), [keepByYear, cropYear])
  const setKeep = (cropId: string, keep: boolean) =>
    setKeepByYear((prev) => {
      const cur = new Set(prev[String(cropYear)] ?? [])
      if (keep) cur.add(cropId); else cur.delete(cropId)
      return { ...prev, [String(cropYear)]: [...cur] }
    })

  async function fetchRma(force: boolean, onlyCropId: string | null) {
    if (grownCrops.length === 0 || states.length === 0) return
    const cropsPayload = (onlyCropId ? grownCrops.filter((c) => c.id === onlyCropId) : grownCrops)
      .map((c) => ({ crop_id: c.id, crop_name: c.name, harvest_category: c.harvest_category, rma_type_override: c.rma_type_override }))
    if (cropsPayload.length === 0) return
    setError(null)
    if (onlyCropId) setRowBusy(onlyCropId); else setBusy(true)
    try {
      const res = await fetch('/api/rma-price-discovery', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ crop_year: cropYear, crops: cropsPayload, states, force }),
      })
      const json = await res.json().catch(() => null)
      // Write-then-swap: only validated data replaces what's on screen.
      const merged = mergeRmaResults(results, json, { partial: onlyCropId != null })
      setResults(merged.results)
      setNote(merged.note)
      if (merged.error) {
        const failedNames = [...new Set(merged.results.filter((r) => r.fetch_failed).map((r) => grownCrops.find((c) => c.id === r.crop_id)?.name ?? r.crop_id))]
        const named = failedNames.length > 0 ? merged.error.replace(/\d+ crops?/, failedNames.join(', ')) : merged.error
        setError(asOf ? `${named} Showing values as of ${asOf}.` : named)
      } else {
        // The route mirrored fresh rows into harvest_price_estimates.
        onChanged()
      }
    } catch (e) {
      setError(`Refresh failed — ${e instanceof Error ? e.message : 'network error'}.${asOf ? ` Showing values as of ${asOf}.` : ''}`)
    } finally {
      if (onlyCropId) setRowBusy(null); else setBusy(false)
    }
  }

  useEffect(() => {
    void fetchRma(refreshNonce > 0, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropYear, grownCrops.map((c) => c.id).join('|'), states.join('|'), refreshNonce])

  // Live quotes of each offer's base contract, for the pre-window estimate
  // phase. Runs after RMA results land (the symbols come from the offers).
  useEffect(() => {
    if (grownCrops.length === 0) return
    const cropsPayload = grownCrops.map((c) => ({
      crop_id: c.id, crop_name: c.name,
      symbol_override: results.find((r) => r.crop_id === c.id)?.harvest_market_symbol ?? null,
    }))
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/harvest-price-estimate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ crop_year: cropYear, crops: cropsPayload }),
        })
        const json = await res.json().catch(() => null)
        if (cancelled || !json) return
        const m = new Map<string, { price: number; priceDate: string | null }>()
        for (const e of (json.estimates ?? []) as Array<{ crop_id: string; price: number | null; price_date: string | null }>) {
          if (e.price != null) m.set(e.crop_id, { price: Number(e.price), priceDate: e.price_date })
        }
        setLiveQuotes(m)
      } catch {
        /* no live quote — the pre-phase cell says so */
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropYear, grownCrops.map((c) => c.id).join('|'), results])

  const rows: PriceDiscoveryRow[] = useMemo(
    () => buildPriceDiscoveryRows({
      crops: grownCrops, plantings, policies, cropYear,
      rmaResults: results, estimates, keepManualProjected: keepSet, liveQuotes,
    }),
    [grownCrops, plantings, policies, cropYear, results, estimates, keepSet, liveQuotes],
  )

  // ---- Inline manual projected override (absorbed from the old editor) ----
  const draftFor = (row: PriceDiscoveryRow) => {
    if (row.cropId in drafts) return drafts[row.cropId]
    const v = row.projected.resolution?.price
    return v == null ? '' : String(v)
  }
  async function saveManual(row: PriceDiscoveryRow) {
    const raw = draftFor(row).trim()
    setMsg(null)
    const price = Number(raw)
    if (raw === '' || !Number.isFinite(price) || price <= 0) { setMsg('Enter a positive price.'); return }
    setSaving(true)
    const { error: e } = await supabase.from('harvest_price_estimates').upsert(
      { crop_id: row.cropId, crop_year: cropYear, price_type: 'projected', price, source: 'manual', price_date: `${cropYear}-02-28` },
      { onConflict: 'crop_id,crop_year,price_type,price_date' },
    )
    setSaving(false)
    if (e) { setMsg(e.message); return }
    // Typing over a known RMA value is the deliberate override — keep it.
    if (row.projected.resolution?.source === 'rma' || results.some((r) => r.crop_id === row.cropId && r.projected_status === 'released')) {
      setKeep(row.cropId, true)
    }
    setDrafts((d) => { const n = { ...d }; delete n[row.cropId]; return n })
    onChanged()
  }
  async function resetToRma(row: PriceDiscoveryRow) {
    setMsg(null)
    setSaving(true)
    const { error: e } = await supabase
      .from('harvest_price_estimates')
      .delete()
      .eq('crop_id', row.cropId).eq('crop_year', cropYear).eq('price_type', 'projected')
      .in('source', ['manual', 'seed'])
    setSaving(false)
    if (e) { setMsg(e.message); return }
    setKeep(row.cropId, false)
    setDrafts((d) => { const n = { ...d }; delete n[row.cropId]; return n })
    onChanged()
  }

  if (grownCrops.length === 0) return null

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold flex-1">Crop Insurance Price Discovery</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRefreshNonce((n) => n + 1)}
          title="Pull the latest RMA prices now"
          className="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm font-semibold text-brand-deep hover:bg-slate-50 disabled:opacity-50"
        >
          <span className={busy ? 'inline-block animate-spin' : ''}>↻</span> Refresh from RMA
        </button>
      </div>
      <p className="text-sm text-slate-500 max-w-3xl">
        Projected and harvest prices straight from RMA&rsquo;s published discovery data, keyed by your
        policies&rsquo; states and each offer&rsquo;s own base contract. RMA values apply by default — type a
        projected price to override it (kept with a notice; &ldquo;reset to RMA&rdquo; restores).
      </p>
      {error && <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-900">{error}</div>}
      {note && !error && <p className="text-sm text-amber-700">{note}</p>}
      {msg && <p className="text-sm text-red-600">{msg}</p>}
      {busy && rows.every((r) => r.stateCode == null) && <p className="text-sm text-slate-400">Checking RMA…</p>}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-slate-500">
            <tr>{['Crop', 'Offer', 'Base contract', 'Projected price', 'Harvest price', ''].map((h, i) => (
              <th key={i} className="text-left px-2 py-1">{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const res = row.projected.resolution
              const dirty = row.cropId in drafts && drafts[row.cropId] !== (res?.price == null ? '' : String(res.price))
              const rmaAvailable = results.find((r) => r.crop_id === row.cropId && r.projected_status === 'released' && r.projected_price != null)
              return (
                <tr key={`${row.cropId}|${row.stateCode ?? ''}`} className="border-t border-slate-100 align-top">
                  <td className="px-2 py-2 font-medium whitespace-nowrap">
                    {row.cropName}
                    {row.volatility != null && <span className="block text-[10px] text-slate-400 font-normal">volatility {row.volatility.toFixed(2)}</span>}
                  </td>
                  <td className="px-2 py-2 text-xs text-slate-500 max-w-[16rem]">
                    {row.noOffer
                      ? `No RMA offer found for ${row.stateCode ?? 'your state'} — estimates and manual entry still apply.`
                      : row.fetchFailed
                        ? 'RMA unreachable — retry with ↻; estimates apply meanwhile.'
                        : row.offerIdentity ?? (row.stateCode ?? '—')}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap font-mono text-xs">
                    {row.baseContract ?? '—'}
                    {row.exchange && <span className="block text-[10px] text-slate-400 font-sans">{row.exchange}</span>}
                  </td>
                  <td className="px-2 py-2 min-w-[15rem]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-slate-400">$</span>
                      <input
                        type="number" step="0.01" min="0" inputMode="decimal"
                        value={draftFor(row)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [row.cropId]: e.target.value }))}
                        placeholder="—"
                        className="rounded-lg border border-slate-300 px-2 py-1 text-sm w-24 bg-white"
                      />
                      <span className="text-slate-400 text-xs">{/cotton/i.test(row.cropName) ? '/lb' : '/bu'}</span>
                      {dirty ? (
                        <button type="button" disabled={saving} onClick={() => saveManual(row)} className="text-sm text-green-700 font-semibold disabled:opacity-40">Save</button>
                      ) : res ? (
                        <span className={`text-xs rounded-full px-2 py-0.5 ${chipCls[res.source]}`}>
                          {res.source === 'rma' ? 'RMA released' : res.source}
                        </span>
                      ) : null}
                    </div>
                    {row.projected.windowLabel && (
                      <span className="block text-[10px] text-slate-400">
                        window {row.projected.windowLabel}
                        {row.projected.status === 'in_discovery' ? ' · in discovery' : row.projected.status === 'yet_to_start' ? ' · not started' : ''}
                      </span>
                    )}
                    {res?.source === 'rma' && res.superseded != null && (
                      <span className="block text-xs text-sky-800">
                        RMA published {fmtPrice(res.price)} — replaces your {fmtPrice(res.superseded)}.{' '}
                        <button type="button" onClick={() => setKeep(row.cropId, true)} className="underline font-semibold">Keep mine</button>
                      </span>
                    )}
                    {res && res.source !== 'rma' && rmaAvailable && (
                      <span className="block text-xs text-slate-500">
                        RMA published {fmtPrice(rmaAvailable.projected_price!)}.{' '}
                        <button type="button" disabled={saving} onClick={() => resetToRma(row)} className="underline font-semibold disabled:opacity-50">Reset to RMA</button>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 min-w-[16rem]">
                    {(() => {
                      const res = harvestResByCrop.get(row.cropId)
                      const hDraft = row.cropId in harvestDrafts ? harvestDrafts[row.cropId] : (res?.price != null && res.price > 0 ? String(res.price) : '')
                      const hDirty = row.cropId in harvestDrafts && harvestDrafts[row.cropId] !== (res?.price != null && res.price > 0 ? String(res.price) : '')
                      const tier = harvestTierLabel(res ? {
                        isFinal: res.source === 'final', rmaFinal: res.rmaFinal, source: res.source,
                        rmaLabel: row.harvest.phase === 'in' ? row.harvest.label : null,
                        contractLabel: row.baseContract,
                      } : null)
                      return (
                        <>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-slate-400">$</span>
                            <input
                              type="number" step="0.01" min="0" inputMode="decimal"
                              value={hDraft}
                              onChange={(e) => setHarvestDrafts((d) => ({ ...d, [row.cropId]: e.target.value }))}
                              placeholder="—"
                              className="rounded-lg border border-slate-300 px-2 py-1 text-sm w-24 bg-white"
                            />
                            <span className="text-slate-400 text-xs">{/cotton/i.test(row.cropName) ? '/lb' : '/bu'}</span>
                            {hDirty ? (
                              <button type="button" disabled={saving} onClick={() => saveManualHarvest(row)} className="text-sm text-green-700 font-semibold disabled:opacity-40">Save</button>
                            ) : (
                              <span className={`text-xs rounded-full px-2 py-0.5 ${tier.cls}`}>{tier.text}</span>
                            )}
                          </div>
                          {row.harvest.windowLabel && (
                            <span className="block text-[10px] text-slate-400">window {row.harvest.windowLabel}</span>
                          )}
                          {res?.rmaFinal && res.supersededManual != null && (
                            <span className="block text-xs text-sky-800">
                              RMA final {fmtPrice(res.price)} — replaces your manual {fmtPrice(res.supersededManual)}.{' '}
                              <button type="button" onClick={() => setHarvestKeep(row.cropId, true)} className="underline font-semibold">Keep mine</button>
                            </span>
                          )}
                          {res && res.source === 'final' && !res.rmaFinal && (
                            <span className="block text-xs text-slate-500">
                              {harvestKeepSet.has(row.cropId) ? 'Using your manual final (an RMA final is published).' : 'Manual final.'}{' '}
                              <button type="button" disabled={saving} onClick={() => resetHarvestToRma(row)} className="underline font-semibold disabled:opacity-50">Reset to RMA</button>
                            </span>
                          )}
                        </>
                      )
                    })()}
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      disabled={busy || rowBusy === row.cropId}
                      onClick={() => void fetchRma(true, row.cropId)}
                      title={`Refresh ${row.cropName} from RMA now`}
                      aria-label={`Refresh ${row.cropName} from RMA`}
                      className="text-brand-deep hover:text-brand disabled:text-slate-300"
                    >
                      <span className={rowBusy === row.cropId ? 'inline-block animate-spin' : ''}>↻</span>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
