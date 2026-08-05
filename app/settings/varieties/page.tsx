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

// Settings → Varieties. The PRIMARY content is the full variety list — every
// distinct variety name grouped by crop with its usage count (# plantings),
// sorted crop then name, with rename (merging into an existing spelling when
// the new name collides) and delete (blocked with the count while in use —
// varieties only exist as rows on plantings, so an in-use name must be renamed
// or its plantings edited, never silently dropped).
//
// The "Find similar varieties" dedupe tool is a section below: suspected
// duplicate spellings within a crop, decided PAIR BY PAIR. Matching is strict —
// two spellings pair only when they normalize equal or differ solely in the
// brand prefix ("68-35" ↔ "DK 68-35"); a difference in any digit or trait
// letter is a different product and never flags. With clean data that section
// is EMPTY.

type CropPairs = {
  crop: Crop
  pairs: VarietyPair[]
  rowsByName: Map<string, VarietyRowRef[]>
}

type VarietyListRow = { name: string; plantings: number; totalAcres: number }
type CropVarieties = { crop: Crop; rowsByName: Map<string, VarietyRowRef[]>; list: VarietyListRow[] }

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
  // Inline rename state: `${cropId}|${name}` of the row being edited + draft.
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [busyRow, setBusyRow] = useState<string | null>(null)

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

  // ---------- shared: rows per crop per variety name ----------

  const rowsByCrop = useMemo(() => {
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
    return byCrop
  }, [plantings, varieties])

  // ---------- the variety list (primary content) ----------

  const cropVarieties: CropVarieties[] = useMemo(() =>
    crops
      .map((crop) => {
        const rowsByName = rowsByCrop.get(crop.id) ?? new Map<string, VarietyRowRef[]>()
        const list: VarietyListRow[] = [...rowsByName.entries()]
          .map(([name, rows]) => ({
            name,
            plantings: new Set(rows.map((r) => r.plantingId)).size,
            totalAcres: rows.reduce((s, r) => s + r.acres, 0),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        return { crop, rowsByName, list }
      })
      .filter((g) => g.list.length > 0),
    [crops, rowsByCrop])

  const totalVarieties = cropVarieties.reduce((s, g) => s + g.list.length, 0)

  async function renameVariety(g: CropVarieties, oldName: string) {
    const rowKey = `${g.crop.id}|${oldName}`
    const newName = editDraft.trim()
    if (!newName || newName === oldName) { setEditing(null); return }
    const oldRows = g.rowsByName.get(oldName) ?? []
    const collision = [...g.rowsByName.keys()].find((n) => n !== oldName && n === newName)
    setBusyRow(rowKey); setErr(null); setBanner(null)
    try {
      if (collision) {
        // Renaming onto an existing spelling is a MERGE — combine per planting
        // like the dedupe tool so acres/bushels sum instead of duplicating.
        const rows = [...oldRows, ...(g.rowsByName.get(collision) ?? [])]
        const plan = buildVarietyMergePlan(rows, newName)
        const ok = confirm(
          `“${newName}” already exists for ${g.crop.name}. Merge “${oldName}” into it?\n\n` +
          `${plan.affectedPlantings} planting${plan.affectedPlantings === 1 ? '' : 's'} will be updated` +
          (plan.deletes.length > 0 ? `; ${plan.deletes.length} redundant row${plan.deletes.length === 1 ? '' : 's'} combined.` : '.'),
        )
        if (!ok) return
        for (const u of plan.updates) {
          const { error } = await supabase.from('field_planting_varieties')
            .update({ variety: u.variety, acres: u.acres, bushels: u.bushels }).eq('id', u.id)
          if (error) throw new Error(error.message)
        }
        if (plan.deletes.length > 0) {
          const { error } = await supabase.from('field_planting_varieties').delete().in('id', plan.deletes)
          if (error) throw new Error(error.message)
        }
        setBanner(`Merged “${oldName}” into “${newName}” (${g.crop.name}).`)
      } else {
        const { error } = await supabase.from('field_planting_varieties')
          .update({ variety: newName }).in('id', oldRows.map((r) => r.id))
        if (error) throw new Error(error.message)
        setBanner(`Renamed “${oldName}” to “${newName}” (${g.crop.name}).`)
      }
      setEditing(null)
      await refresh()
    } catch (e: any) {
      setErr(`Rename failed: ${e?.message ?? 'unknown error'}`)
    } finally {
      setBusyRow(null)
    }
  }

  async function deleteVariety(g: CropVarieties, row: VarietyListRow) {
    // Blocked while in use — the button is disabled with the count, so this
    // path only runs for a zero-usage name (shouldn't occur; belt-and-braces).
    if (row.plantings > 0) return
    const rows = g.rowsByName.get(row.name) ?? []
    if (rows.length === 0) return
    if (!confirm(`Delete “${row.name}” (${g.crop.name})?`)) return
    const key = `${g.crop.id}|${row.name}`
    setBusyRow(key); setErr(null)
    try {
      const { error } = await supabase.from('field_planting_varieties').delete().in('id', rows.map((r) => r.id))
      if (error) throw new Error(error.message)
      setBanner(`Deleted “${row.name}” (${g.crop.name}).`)
      await refresh()
    } catch (e: any) {
      setErr(`Delete failed: ${e?.message ?? 'unknown error'}`)
    } finally {
      setBusyRow(null)
    }
  }

  // ---------- the dedupe tool (secondary section) ----------

  const dismissedByCrop = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const d of dismissals) {
      const set = m.get(d.crop_id) ?? new Set<string>()
      set.add(dismissalKey(d.key_a, d.key_b))
      m.set(d.crop_id, set)
    }
    return m
  }, [dismissals])

  const cropPairs: CropPairs[] = useMemo(() =>
    crops
      .map((crop) => {
        const rowsByName = rowsByCrop.get(crop.id) ?? new Map<string, VarietyRowRef[]>()
        const usages: VarietyUsage[] = [...rowsByName.entries()]
          .map(([name, rows]) => ({ name, plantings: new Set(rows.map((r) => r.plantingId)).size }))
        return { crop, rowsByName, pairs: findSimilarVarietyPairs(usages, dismissedByCrop.get(crop.id)) }
      })
      .filter((g) => g.pairs.length > 0),
    [crops, rowsByCrop, dismissedByCrop])

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
      setErr(`Could not record the decision: ${e?.message ?? 'unknown error'}. If this keeps happening, contact support.`)
    } finally {
      setBusyPair(null)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Varieties</h1>
      <p className="text-sm text-slate-600 max-w-3xl">
        Every variety on file, grouped by crop, with how many plantings use it. Rename fixes a spelling everywhere at
        once (renaming onto an existing name merges the two). A variety in use can&apos;t be deleted — it exists only
        on its plantings.
      </p>

      {banner && <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {!loaded && <p className="text-sm text-slate-400">Loading…</p>}

      {loaded && totalVarieties === 0 && (
        <div className="bg-white rounded-xl shadow p-6 text-center text-slate-500">
          <div className="text-lg font-semibold text-slate-700">No varieties yet</div>
          <div className="text-sm mt-1">Varieties appear here as they&apos;re recorded on plantings.</div>
        </div>
      )}

      {loaded && cropVarieties.map((g) => (
        <section key={g.crop.id} className="bg-white rounded-xl shadow p-4 space-y-2">
          <h2 className="font-semibold text-slate-700">{g.crop.name} <span className="text-xs font-normal text-slate-400">({g.list.length} variet{g.list.length === 1 ? 'y' : 'ies'})</span></h2>
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="text-left font-normal py-1">Variety</th>
                <th className="text-right font-normal py-1">Plantings</th>
                <th className="text-right font-normal py-1">Acres</th>
                <th className="text-right font-normal py-1 w-40"></th>
              </tr>
            </thead>
            <tbody>
              {g.list.map((row) => {
                const rowKey = `${g.crop.id}|${row.name}`
                const isEditing = editing === rowKey
                const busy = busyRow === rowKey
                return (
                  <tr key={row.name} className="border-t border-slate-100">
                    <td className="py-1.5 font-mono">
                      {isEditing ? (
                        <input
                          autoFocus
                          type="text"
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void renameVariety(g, row.name)
                            if (e.key === 'Escape') setEditing(null)
                          }}
                          className="rounded border border-slate-300 px-2 py-1 w-56 font-mono"
                        />
                      ) : row.name}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{row.plantings}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.totalAcres.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      {isEditing ? (
                        <span className="inline-flex gap-2">
                          <button type="button" disabled={busy} onClick={() => renameVariety(g, row.name)}
                            className="text-sm rounded bg-brand hover:bg-brand-deep text-white px-2 py-0.5 font-semibold disabled:opacity-50">
                            {busy ? 'Saving…' : 'Save'}
                          </button>
                          <button type="button" disabled={busy} onClick={() => setEditing(null)}
                            className="text-sm rounded border border-slate-300 bg-white px-2 py-0.5">Cancel</button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-3">
                          <button type="button" className="text-brand-deep text-sm underline decoration-dotted"
                            onClick={() => { setEditing(rowKey); setEditDraft(row.name) }}>
                            Rename
                          </button>
                          <button
                            type="button"
                            disabled={row.plantings > 0 || busy}
                            title={row.plantings > 0 ? `In use on ${row.plantings} planting${row.plantings === 1 ? '' : 's'} — rename it or edit those plantings instead.` : 'Delete this variety'}
                            onClick={() => deleteVariety(g, row)}
                            className="text-sm text-red-600 underline decoration-dotted disabled:text-slate-300 disabled:no-underline disabled:cursor-not-allowed"
                          >
                            Delete{row.plantings > 0 ? ` (${row.plantings})` : ''}
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}

      {/* ---------- Find similar varieties (dedupe tool) ---------- */}
      {loaded && (
        <section className="space-y-3 pt-2">
          <h2 className="text-lg font-bold">Find similar varieties</h2>
          <p className="text-sm text-slate-600 max-w-3xl">
            Two spellings pair up only when they&apos;re the <strong>same product</strong> written differently — identical once
            spacing/punctuation is ignored, or differing only in the brand prefix (&ldquo;68-35&rdquo; ↔ &ldquo;DK 68-35&rdquo;). Different
            numbers or trait letters (&ldquo;DK 65-95&rdquo; vs &ldquo;DK 68-35&rdquo;, &ldquo;47XF2&rdquo; vs &ldquo;47XF6&rdquo;) are different products and are never
            suggested. Decide each pair: merge onto one spelling, or keep both (remembered — the pair won&apos;t come back here
            or in import prompts).
          </p>

          {totalPairs === 0 && (
            <div className="bg-white rounded-xl shadow p-6 text-center text-slate-500">
              <div className="text-lg font-semibold text-slate-700">No suspected duplicates</div>
              <div className="text-sm mt-1">Variety names look clean — this is the normal state.</div>
            </div>
          )}

          {cropPairs.map((g) => (
            <div key={g.crop.id} className="space-y-2">
              <h3 className="font-semibold text-slate-700">{g.crop.name}</h3>
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
                      &ldquo;{pair.a.name}&rdquo; on {pair.a.plantings} planting{pair.a.plantings === 1 ? '' : 's'} ·{' '}
                      &ldquo;{pair.b.name}&rdquo; on {pair.b.plantings} planting{pair.b.plantings === 1 ? '' : 's'}
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
                        className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                      >
                        {busy ? 'Working…' : <>Same variety — merge into &ldquo;{canonical}&rdquo;</>}
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
        </section>
      )}
    </div>
  )
}
