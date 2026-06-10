'use client'

// Editor for RMA projected (spring) prices per crop per crop year. These live
// in the harvest_price_estimates table (price_type = 'projected') and used to be
// hard-coded in lib/crop-insurance.ts. RMA announces them each February, so we
// store one canonical row per crop/year dated Feb 28; the policy form auto-fills
// the projected price from here when a crop/year is chosen.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { projectedPriceFromEstimates } from '@/lib/crop-insurance'
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

  const savedFor = (cropId: string) => projectedPriceFromEstimates(estimates, cropId, year)
  const draftValue = (cropId: string) => {
    if (cropId in drafts) return drafts[cropId]
    const v = savedFor(cropId)
    return v == null ? '' : String(v)
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
            RMA announces the spring projected price for each crop in February. Enter them here per crop
            year — the policy form and AI import auto-fill the projected price from these values.
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
              return (
                <div key={c.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1 text-sm font-medium">{c.name}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-slate-400 text-sm">$</span>
                    <input
                      type="number" step="0.01" min="0" inputMode="decimal"
                      value={draftValue(c.id)}
                      onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                      placeholder="—"
                      className={inputCls}
                    />
                    <span className="text-slate-400 text-sm">/bu</span>
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
              )
            })}
          </div>
          {msg && <p className="text-sm text-red-600">{msg}</p>}
        </>
      )}
    </div>
  )
}
