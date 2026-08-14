'use client'

// Editor for RMA projected (spring) prices per crop per crop year. These live
// in the harvest_price_estimates table (price_type = 'projected') and used to be
// hard-coded in lib/crop-insurance.ts. RMA announces them each February, so we
// store one canonical row per crop/year dated Feb 28; the policy form auto-fills
// the projected price from here when a crop/year is chosen.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { resolveProjectedPrice } from '@/lib/crop-insurance'
import { usePersistentState } from '@/lib/use-persistent-state'
import type { Crop, HarvestPriceEstimate } from '@/lib/types'

export default function ProjectedPricesEditor({
  crops, estimates, onChange,
}: {
  crops: Crop[]
  estimates: HarvestPriceEstimate[]
  onChange: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const currentYear = new Date().getFullYear()

  const years = useMemo(() => {
    const set = new Set<number>(
      estimates.filter((e) => e.price_type === 'projected').map((e) => e.crop_year),
    )
    set.add(currentYear)
    return [...set].sort((a, b) => b - a)
  }, [estimates, currentYear])

  const [year, setYear] = useState<number>(years[0] ?? currentYear)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Reset unsaved drafts whenever the year changes — the fields now show a
  // different year's saved values.
  useEffect(() => { setDrafts({}); setMsg(null) }, [year])

  // "Keep mine" decisions: a manual value deliberately kept over a published
  // RMA value, persisted per crop year. Saving a manual price while an RMA
  // value exists sets it automatically (typing over a known RMA value IS the
  // deliberate choice); "reset to RMA" clears it.
  const [keepByYear, setKeepByYear] = usePersistentState<Record<string, string[]>>('crop-insurance:keepManualProjected', {})
  const keepSet = useMemo(() => new Set(keepByYear[String(year)] ?? []), [keepByYear, year])
  const setKeep = (cropId: string, keep: boolean) =>
    setKeepByYear((prev) => {
      const cur = new Set(prev[String(year)] ?? [])
      if (keep) cur.add(cropId); else cur.delete(cropId)
      return { ...prev, [String(year)]: [...cur] }
    })

  // Source-aware resolution: RMA released > manual (with supersede notice,
  // keep-mine restores) > seed (the relabeled 024 nationals — display-only,
  // never outrank RMA).
  const resolvedFor = (cropId: string) => resolveProjectedPrice(estimates, cropId, year, { keepManual: keepSet.has(cropId) })
  const savedFor = (cropId: string) => resolvedFor(cropId)?.price ?? null
  const rmaRowFor = (cropId: string) =>
    resolveProjectedPrice(estimates, cropId, year)?.source === 'rma' ? resolveProjectedPrice(estimates, cropId, year) : null
  const draftValue = (cropId: string) => {
    if (cropId in drafts) return drafts[cropId]
    const v = savedFor(cropId)
    return v == null ? '' : String(v)
  }

  // Reset to RMA: delete the crop/year's manual + seed rows so the RMA value
  // (already on file) is all that remains.
  async function resetToRma(cropId: string) {
    setMsg(null)
    setSaving(true)
    const { error } = await supabase
      .from('harvest_price_estimates')
      .delete()
      .eq('crop_id', cropId)
      .eq('crop_year', year)
      .eq('price_type', 'projected')
      .in('source', ['manual', 'seed'])
    setSaving(false)
    if (error) { setMsg(error.message); return }
    setKeep(cropId, false)
    setDrafts((d) => { const n = { ...d }; delete n[cropId]; return n })
    onChange()
  }

  async function saveCrop(cropId: string) {
    const raw = draftValue(cropId).trim()
    setMsg(null)
    if (raw === '') { setMsg('Enter a price first.'); return }
    const price = Number(raw)
    if (!Number.isFinite(price) || price <= 0) { setMsg('Enter a positive price.'); return }
    setSaving(true)
    const { error } = await supabase.from('harvest_price_estimates').upsert(
      {
        crop_id: cropId,
        crop_year: year,
        price_type: 'projected',
        price,
        source: 'manual',
        price_date: `${year}-02-28`,
      },
      { onConflict: 'crop_id,crop_year,price_type,price_date' },
    )
    setSaving(false)
    if (error) { setMsg(error.message); return }
    // Typing over a known RMA value is the deliberate override — keep it.
    if (rmaRowFor(cropId)) setKeep(cropId, true)
    setDrafts((d) => { const n = { ...d }; delete n[cropId]; return n })
    onChange()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm w-28 bg-white'

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <button type="button" onClick={() => setOpen((s) => !s)} className="font-semibold flex items-center gap-2">
        <span className="text-slate-400">{open ? '▾' : '▸'}</span> RMA Projected Prices
      </button>
      {open && (
        <>
          <p className="text-sm text-slate-500 max-w-3xl">
            RMA&rsquo;s published projected prices fill in automatically once each state&rsquo;s discovery window
            closes (see Price discovery above) and apply by default. Type a price to override — it&rsquo;s kept
            with a notice, and &ldquo;reset to RMA&rdquo; restores the published value. The policy form and AI
            import auto-fill the projected price from these values.
          </p>
          <label className="text-sm flex items-center gap-2">
            <span className="text-slate-500">Crop year</span>
            <input
              list="projected-price-years"
              type="number"
              value={year}
              onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setYear(n) }}
              className={inputCls}
            />
            <datalist id="projected-price-years">
              {years.map((y) => <option key={y} value={y} />)}
            </datalist>
          </label>
          <div className="divide-y">
            {crops.length === 0 && <p className="text-sm text-slate-400">No crops yet.</p>}
            {crops.map((c) => {
              const dirty = c.id in drafts && drafts[c.id] !== (savedFor(c.id) == null ? '' : String(savedFor(c.id)))
              const res = resolvedFor(c.id)
              const rma = rmaRowFor(c.id)
              const chip = res == null ? null
                : res.source === 'rma' ? { text: 'RMA', cls: 'bg-green-100 text-green-800', title: `RMA published${res.priceDate ? ` (window closed ${res.priceDate})` : ''}` }
                : res.source === 'manual' ? { text: 'manual', cls: 'bg-sky-100 text-sky-800', title: 'You entered this value' }
                : { text: 'seed', cls: 'bg-amber-100 text-amber-800', title: 'Pre-RMA national placeholder — replace or reset to RMA' }
              return (
                <div key={c.id} className="py-2 space-y-1">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 text-sm font-medium">
                      {c.name}
                      {chip && !dirty && (
                        <span title={chip.title} className={`ml-2 text-xs rounded-full px-2 py-0.5 ${chip.cls}`}>{chip.text}</span>
                      )}
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="text-slate-400 text-sm">$</span>
                      <input
                        type="number" step="0.01" min="0" inputMode="decimal"
                        value={draftValue(c.id)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                        placeholder="—"
                        className={inputCls}
                      />
                      <span className="text-slate-400 text-sm">{/cotton/i.test(c.name) ? '/lb' : '/bu'}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => saveCrop(c.id)}
                      disabled={saving || !dirty}
                      className="text-sm text-green-700 font-semibold disabled:opacity-40 disabled:cursor-default"
                    >
                      Save
                    </button>
                  </div>
                  {/* RMA superseded a MANUAL value — say so, never silent.
                      (Seeds demote without a note.) */}
                  {res?.source === 'rma' && res.superseded != null && (
                    <p className="text-xs text-sky-800 flex items-center gap-2">
                      <span>RMA published ${res.price.toFixed(2)} — replaces your ${res.superseded.toFixed(2)}.</span>
                      <button type="button" onClick={() => setKeep(c.id, true)} className="rounded border border-sky-300 px-1.5 py-0.5 font-semibold hover:bg-sky-50">
                        Keep mine (${res.superseded.toFixed(2)})
                      </button>
                    </p>
                  )}
                  {/* Manual kept (or a seed showing) while RMA has a value. */}
                  {res && res.source !== 'rma' && rma && (
                    <p className="text-xs text-slate-500 flex items-center gap-2">
                      <span>RMA published ${rma.price.toFixed(2)}.</span>
                      <button type="button" disabled={saving} onClick={() => resetToRma(c.id)} className="rounded border border-slate-300 px-1.5 py-0.5 font-semibold hover:bg-slate-50 disabled:opacity-50">
                        Reset to RMA
                      </button>
                    </p>
                  )}
                </div>
              )
            })}
          </div>
          {msg && <p className="text-sm text-red-600">{msg}</p>}
        </>
      )}
    </div>
  )
}
