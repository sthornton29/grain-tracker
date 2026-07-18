'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  buildVarietyMergePlan,
  findSimilarVarietyGroups,
  type VarietyRowRef,
  type VarietyUsage,
} from '@/lib/variety-resolution'
import type { Crop, FieldPlanting, FieldPlantingVariety } from '@/lib/types'

// Settings → Varieties: find suspected duplicate variety names within a crop
// (normalized-equal or near-equal spellings) and merge them onto one canonical
// name. A merge re-points every planting's variety rows to the canonical
// spelling, coalescing a planting that recorded several spellings into one row
// with summed acres/bushels.

type CropGroup = {
  crop: Crop
  usages: VarietyUsage[]
  rowsByName: Map<string, VarietyRowRef[]>
  groups: VarietyUsage[][]
}

export default function VarietiesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [varieties, setVarieties] = useState<FieldPlantingVariety[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  // Chosen canonical name per duplicate group, keyed `${crop_id}|${first name}`.
  const [canonicalPick, setCanonicalPick] = useState<Record<string, string>>({})
  const [merging, setMerging] = useState<string | null>(null)

  async function refresh() {
    const [cr, pl, vv] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('id, crop_id, season_year'),
      supabase.from('field_planting_varieties').select('*'),
    ])
    const firstErr = cr.error ?? pl.error ?? vv.error
    if (firstErr) { setErr(firstErr.message); return }
    setCrops((cr.data as Crop[]) || [])
    setPlantings(((pl.data as unknown) as FieldPlanting[]) || [])
    setVarieties((vv.data as FieldPlantingVariety[]) || [])
    setLoaded(true)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropGroups: CropGroup[] = useMemo(() => {
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
          .sort((a, b) => a.name.localeCompare(b.name))
        return { crop, usages, rowsByName, groups: findSimilarVarietyGroups(usages) }
      })
      .filter((g) => g.usages.length > 0)
  }, [crops, plantings, varieties])

  const suspectedGroups = cropGroups.reduce((n, g) => n + g.groups.length, 0)

  async function merge(cg: CropGroup, group: VarietyUsage[]) {
    const groupKey = `${cg.crop.id}|${group[0].name}`
    const canonical = canonicalPick[groupKey] ?? group[0].name
    const rows = group.flatMap((u) => cg.rowsByName.get(u.name) ?? [])
    const plan = buildVarietyMergePlan(rows, canonical)
    if (plan.updates.length === 0 && plan.deletes.length === 0) return
    const others = group.filter((u) => u.name !== canonical)
    const otherPlantings = others.reduce((n, u) => n + u.plantings, 0)
    const ok = confirm(
      `Merge ${others.map((u) => `“${u.name}”`).join(', ')} into “${canonical}” for ${cg.crop.name}?\n\n` +
      `${otherPlantings} planting${otherPlantings === 1 ? '' : 's'} will be re-linked to “${canonical}” ` +
      `(${plan.affectedPlantings} row group${plan.affectedPlantings === 1 ? '' : 's'} touched in total). This cannot be undone.`,
    )
    if (!ok) return
    setMerging(groupKey)
    setErr(null)
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
      setBanner(
        `Merged ${others.length} name${others.length === 1 ? '' : 's'} into “${canonical}” — ` +
        `${plan.affectedPlantings} planting${plan.affectedPlantings === 1 ? '' : 's'} updated.`,
      )
      await refresh()
    } catch (e: any) {
      setErr(`Merge incomplete: ${e?.message ?? 'unknown error'}. Re-run it — already-merged rows are unaffected.`)
      await refresh()
    } finally {
      setMerging(null)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Varieties</h1>
      <p className="text-sm text-slate-500">
        Every variety recorded on a planting, grouped by crop. Suspected duplicates — the same variety under
        different spellings like “DG 3644 B3XF” and “DG3644B3XF” — can be merged onto one canonical name.
      </p>

      {banner && <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Find similar varieties</h2>
        {!loaded && <p className="text-sm text-slate-400">Loading…</p>}
        {loaded && suspectedGroups === 0 && (
          <p className="text-sm text-slate-500">No suspected duplicates — every variety name is distinct within its crop.</p>
        )}
        {cropGroups.map((cg) =>
          cg.groups.map((group) => {
            const groupKey = `${cg.crop.id}|${group[0].name}`
            const canonical = canonicalPick[groupKey] ?? group[0].name
            return (
              <div key={groupKey} className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                <div className="text-sm font-semibold text-slate-700">{cg.crop.name}</div>
                <div className="space-y-1">
                  {group.map((u) => (
                    <label key={u.name} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={groupKey}
                        checked={canonical === u.name}
                        onChange={() => setCanonicalPick((m) => ({ ...m, [groupKey]: u.name }))}
                      />
                      <span className={canonical === u.name ? 'font-semibold' : ''}>{u.name}</span>
                      <span className="text-xs text-slate-500">
                        {u.plantings} planting{u.plantings === 1 ? '' : 's'}
                      </span>
                      {canonical === u.name && (
                        <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">canonical</span>
                      )}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => merge(cg, group)}
                  disabled={merging != null}
                  className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                >
                  {merging === groupKey ? 'Merging…' : `Merge into “${canonical}”`}
                </button>
              </div>
            )
          }),
        )}
      </div>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">All varieties</h2>
        {loaded && cropGroups.length === 0 && (
          <p className="text-sm text-slate-500">No varieties recorded yet — they come from plantings (Settings → Field Plantings).</p>
        )}
        {cropGroups.map((cg) => (
          <div key={cg.crop.id}>
            <h3 className="text-sm font-semibold text-slate-700 mb-1">{cg.crop.name}</h3>
            <table className="min-w-[20rem] text-sm">
              <tbody>
                {cg.usages.map((u) => (
                  <tr key={u.name} className="border-t border-slate-100">
                    <td className="py-1 pr-6">{u.name}</td>
                    <td className="py-1 text-right text-slate-500">
                      {u.plantings} planting{u.plantings === 1 ? '' : 's'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}
