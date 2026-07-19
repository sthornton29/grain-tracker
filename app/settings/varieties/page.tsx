'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  buildVarietyMergePlan,
  dismissalKey,
  findSimilarVarietyPairs,
  varietyKey,
  type VarietyPair,
  type VarietyRowRef,
  type VarietyUsage,
} from '@/lib/variety-resolution'
import type { Crop, FieldPlanting, FieldPlantingVariety, VarietyMatchDismissal } from '@/lib/types'

// Settings → Varieties: suspected duplicate variety spellings within a crop,
// decided PAIR BY PAIR. Matching is strict — two spellings pair only when they
// normalize equal or differ solely in the brand prefix ("68-35" ↔ "DK 68-35");
// a difference in any digit or trait letter is a different product and never
// flags. Each pair offers exactly two actions:
//   · Same variety — merge every planting's rows onto the chosen spelling
//     (acres/bushels summed where a planting recorded both spellings).
//   · Different varieties — keep both, recorded as a dismissal so the pair
//     never re-flags here or in the import-time possible-match prompts.
// With clean data the normal state of this page is EMPTY.

type CropPairs = {
  crop: Crop
  pairs: VarietyPair[]
  rowsByName: Map<string, VarietyRowRef[]>
}

export default function VarietiesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [varieties, setVarieties] = useState<FieldPlantingVariety[]>([])
  const [dismissals, setDismissals] = useState<VarietyMatchDismissal[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  // Chosen surviving spelling per pair, keyed `${crop_id}|${dismissalKey}`.
  // Defaults to the more-used spelling.
  const [survivorPick, setSurvivorPick] = useState<Record<string, string>>({})
  const [busyPair, setBusyPair] = useState<string | null>(null)

  async function refresh() {
    const [cr, pl, vv, dm] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('id, crop_id, season_year'),
      supabase.from('field_planting_varieties').select('*'),
      supabase.from('variety_match_dismissals').select('*'),
    ])
    const firstErr = cr.error ?? pl.error ?? vv.error
    if (firstErr) { setErr(firstErr.message); return }
    // A missing dismissals table (043 not applied yet) degrades to none —
    // decisions just won't persist until the migration runs.
    setCrops((cr.data as Crop[]) || [])
    setPlantings(((pl.data as unknown) as FieldPlanting[]) || [])
    setVarieties((vv.data as FieldPlantingVariety[]) || [])
    setDismissals((dm.data as VarietyMatchDismissal[]) || [])
    setLoaded(true)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const dismissedByCrop = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const d of dismissals) {
      const set = m.get(d.crop_id) ?? new Set<string>()
      set.add(dismissalKey(d.key_a, d.key_b))
      m.set(d.crop_id, set)
    }
    return m
  }, [dismissals])

  const cropPairs: CropPairs[] = useMemo(() => {
    const plantingCrop = new Map(plantings.map((p) => [p.id, p.crop_id]))
    const byCrop = new Map<string, Map<string, VarietyRowRef[]>>()
    for (const v of varieties) {
      const cropId = plantingCrop.get(v.planting_id)
      const name = v.variety?.trim()
      if (!cropId || !name) continue
      const rowsByName = byCrop.get(cropId) ?? new Map<string, VarietyRowRef[]>()
      const list = rowsByName.get(name) ?? []
      list.push({
        id: v.id,
        plantingId: v.planting_id,
        name,
        acres: Number(v.acres) || 0,
        bushels: v.bushels == null ? null : Number(v.bushels),
      })
      rowsByName.set(name, list)
      byCrop.set(cropId, rowsByName)
    }
    return crops
      .map((crop) => {
        const rowsByName = byCrop.get(crop.id) ?? new Map<string, VarietyRowRef[]>()
        const usages: VarietyUsage[] = [...rowsByName.entries()]
          .map(([name, rows]) => ({ name, plantings: new Set(rows.map((r) => r.plantingId)).size }))
        return { crop, rowsByName, pairs: findSimilarVarietyPairs(usages, dismissedByCrop.get(crop.id)) }
      })
      .filter((g) => g.pairs.length > 0)
  }, [crops, plantings, varieties, dismissedByCrop])

  const totalPairs = cropPairs.reduce((s, g) => s + g.pairs.length, 0)

  const pairId = (cropId: string, pair: VarietyPair) =>
    `${cropId}|${dismissalKey(varietyKey(pair.a.name), varietyKey(pair.b.name))}`

  async function merge(g: CropPairs, pair: VarietyPair) {
    const id = pairId(g.crop.id, pair)
    const canonical = survivorPick[id] ?? pair.a.name
    const loser = canonical === pair.a.name ? pair.b.name : pair.a.name
    const rows = [...(g.rowsByName.get(pair.a.name) ?? []), ...(g.rowsByName.get(pair.b.name) ?? [])]
    const plan = buildVarietyMergePlan(rows, canonical)
    if (plan.updates.length === 0 && plan.deletes.length === 0) return
    const ok = confirm(
      `Merge “${loser}” into “${canonical}” for ${g.crop.name}?\n\n` +
      `${plan.affectedPlantings} planting${plan.affectedPlantings === 1 ? '' : 's'} will be updated` +
      (plan.deletes.length > 0 ? `; ${plan.deletes.length} redundant variety row${plan.deletes.length === 1 ? '' : 's'} removed (acres/bushels combined).` : '.'),
    )
    if (!ok) return
    setBusyPair(id); setErr(null); setBanner(null)
    try {
      for (const u of plan.updates) {
        const { error } = await supabase
          .from('field_planting_varieties')
          .update({ variety: u.variety, acres: u.acres, bushels: u.bushels })
          .eq('id', u.id)
        if (error) throw new Error(error.message)
      }
      if (plan.deletes.length > 0) {
        const { error } = await supabase.from('field_planting_varieties').delete().in('id', plan.deletes)
        if (error) throw new Error(error.message)
      }
      setBanner(`Merged “${loser}” into “${canonical}” (${g.crop.name}).`)
      await refresh()
    } catch (e: any) {
      setErr(`Merge failed: ${e?.message ?? 'unknown error'} — reload and check the rows before retrying.`)
      await refresh()
    } finally {
      setBusyPair(null)
    }
  }

  async function keepBoth(g: CropPairs, pair: VarietyPair) {
    const id = pairId(g.crop.id, pair)
    const [ka, kb] = [varietyKey(pair.a.name), varietyKey(pair.b.name)].sort()
    setBusyPair(id); setErr(null); setBanner(null)
    try {
      const { error } = await supabase
        .from('variety_match_dismissals')
        .upsert({ crop_id: g.crop.id, key_a: ka, key_b: kb }, { onConflict: 'crop_id,key_a,key_b', ignoreDuplicates: true })
      if (error) throw new Error(error.message)
      setBanner(`Kept both “${pair.a.name}” and “${pair.b.name}” — this pair won’t be suggested again.`)
      await refresh()
    } catch (e: any) {
      setErr(`Could not record the decision: ${e?.message ?? 'unknown error'}. (Has migration 043 been applied?)`)
    } finally {
      setBusyPair(null)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Varieties — Suspected Duplicates</h1>
      <p className="text-sm text-slate-600 max-w-3xl">
        Two spellings pair up only when they’re the <strong>same product</strong> written differently — identical once
        spacing/punctuation is ignored, or differing only in the brand prefix (“68-35” ↔ “DK 68-35”). Different
        numbers or trait letters (“DK 65-95” vs “DK 68-35”, “47XF2” vs “47XF6”) are different products and are never
        suggested. Decide each pair: merge onto one spelling, or keep both (remembered — the pair won’t come back here
        or in import prompts).
      </p>

      {banner && <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {!loaded && <p className="text-sm text-slate-400">Loading…</p>}

      {loaded && totalPairs === 0 && (
        <div className="bg-white rounded-xl shadow p-6 text-center text-slate-500">
          <div className="text-lg font-semibold text-slate-700">No suspected duplicates</div>
          <div className="text-sm mt-1">Variety names look clean — this is the normal state.</div>
        </div>
      )}

      {cropPairs.map((g) => (
        <div key={g.crop.id} className="space-y-2">
          <h2 className="font-semibold text-slate-700">{g.crop.name}</h2>
          {g.pairs.map((pair) => {
            const id = pairId(g.crop.id, pair)
            const canonical = survivorPick[id] ?? pair.a.name
            const busy = busyPair === id
            return (
              <div key={id} className="bg-white rounded-xl shadow p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono font-semibold">{pair.a.name}</span>
                  <span className="text-slate-400">↔</span>
                  <span className="font-mono font-semibold">{pair.b.name}</span>
                  <span className={`text-xs rounded-full px-2 py-0.5 ${pair.exact ? 'bg-slate-200 text-slate-600' : 'bg-amber-100 text-amber-800'}`}>
                    {pair.exact ? 'format variants' : 'brand-prefix variant'}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  “{pair.a.name}” on {pair.a.plantings} planting{pair.a.plantings === 1 ? '' : 's'} ·{' '}
                  “{pair.b.name}” on {pair.b.plantings} planting{pair.b.plantings === 1 ? '' : 's'}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-slate-500">Keep spelling:</span>
                  {[pair.a.name, pair.b.name].map((n) => (
                    <label key={n} className="flex items-center gap-1 text-sm">
                      <input
                        type="radio"
                        name={`survivor-${id}`}
                        checked={canonical === n}
                        onChange={() => setSurvivorPick((m) => ({ ...m, [id]: n }))}
                      />
                      <span className="font-mono">{n}</span>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => merge(g, pair)}
                    className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                  >
                    {busy ? 'Working…' : <>Same variety — merge into “{canonical}”</>}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => keepBoth(g, pair)}
                    className="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    Different varieties — keep both
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
