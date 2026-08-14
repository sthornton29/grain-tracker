'use client'

// Crops settings editor — add/rename/delete crops and set each crop's harvest
// category (Fall or Spring). The category drives double-crop classification: a
// fall-harvest crop on a field that also has a spring-harvest crop that season
// is a double-crop. Replaces the generic name-only SimpleCrud for crops.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Crop } from '@/lib/types'

type HarvestCategory = 'fall' | 'spring'
const CATEGORIES: Array<{ value: HarvestCategory; label: string }> = [
  { value: 'fall', label: 'Fall harvest' },
  { value: 'spring', label: 'Spring harvest' },
]

export default function CropsEditor() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Crop[]>([])
  const [name, setName] = useState('')
  const [category, setCategory] = useState<HarvestCategory>('fall')
  const [dc, setDc] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const { data, error } = await supabase.from('crops').select('*').order('name')
    if (error) { setErr(error.message); return }
    setRows((data as Crop[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    const { error } = await supabase.from('crops').insert({ name: n, harvest_category: category, double_crop: dc })
    if (error) { setErr(error.message); return }
    setName(''); setCategory('fall'); setDc(false); setErr(null); refresh()
  }

  async function saveName(id: string) {
    const n = editingName.trim()
    if (!n) return
    const { error } = await supabase.from('crops').update({ name: n }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); setErr(null); refresh()
  }

  async function setHarvestCategory(id: string, harvest_category: HarvestCategory) {
    // Optimistic update so the select reflects the choice instantly.
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, harvest_category } : r)))
    const { error } = await supabase.from('crops').update({ harvest_category }).eq('id', id)
    if (error) { setErr(error.message); refresh() }
  }

  async function setDoubleCrop(id: string, double_crop: boolean) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, double_crop } : r)))
    const { error } = await supabase.from('crops').update({ double_crop }).eq('id', id)
    if (error) { setErr(error.message); refresh() }
  }

  // RMA insurance type (066) — only matters where a state carries BOTH
  // Winter and Spring offers of a commodity; Auto follows harvest category.
  async function setRmaType(id: string, raw: string) {
    const rma_type_override = raw === '' ? null : (raw as 'winter' | 'spring' | 'durum')
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, rma_type_override } : r)))
    const { error } = await supabase.from('crops').update({ rma_type_override }).eq('id', id)
    if (error) { setErr(error.message); refresh() }
  }

  async function remove(id: string) {
    if (!confirm('Delete this crop?')) return
    const { error } = await supabase.from('crops').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const selectCls = 'rounded-lg border border-slate-300 px-3 py-2 bg-white'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Crops</h1>
      <p className="text-sm text-slate-500">
        Set each crop&apos;s harvest category and whether it&apos;s grown as a double-crop. A field that has a{' '}
        <strong>spring</strong>-harvest crop that season is double-cropped; a crop marked{' '}
        <strong>Double-crop</strong> on that field (e.g. soybeans after wheat) is counted as double-crop acres.
      </p>

      <form onSubmit={add} className="flex gap-2 flex-wrap items-center">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Crop name"
          className="flex-1 min-w-[10rem] rounded-lg border border-slate-300 px-3 py-2"
        />
        <select value={category} onChange={(e) => setCategory(e.target.value as HarvestCategory)} className={selectCls}>
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <label className="text-sm flex items-center gap-1 text-slate-600">
          <input type="checkbox" checked={dc} onChange={(e) => setDc(e.target.checked)} />
          Double-crop
        </label>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {rows.length === 0 && <li className="px-4 py-6 text-center text-slate-400">None yet.</li>}
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-2 flex items-center gap-2 flex-wrap">
            {editingId === r.id ? (
              <>
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  className="flex-1 min-w-[8rem] rounded-lg border border-slate-300 px-3 py-2"
                />
                <button onClick={() => saveName(r.id)} className="text-green-700 font-semibold">Save</button>
                <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1 min-w-[8rem] font-medium">{r.name}</span>
                <select
                  value={r.harvest_category}
                  onChange={(e) => setHarvestCategory(r.id, e.target.value as HarvestCategory)}
                  className={`text-sm ${selectCls}`}
                  aria-label={`${r.name} harvest category`}
                >
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <label className="text-sm flex items-center gap-1 text-slate-600">
                  <input
                    type="checkbox"
                    checked={r.double_crop}
                    onChange={(e) => setDoubleCrop(r.id, e.target.checked)}
                    aria-label={`${r.name} double-crop`}
                  />
                  Double-crop
                </label>
                <select
                  value={r.rma_type_override ?? ''}
                  onChange={(e) => setRmaType(r.id, e.target.value)}
                  className={`text-sm ${selectCls}`}
                  aria-label={`${r.name} RMA insurance type`}
                  title="RMA insurance type for price discovery — Auto follows the harvest category (spring-harvested crops use the Winter/fall offer)"
                >
                  <option value="">RMA type: Auto{r.harvest_category === 'spring' ? ' (Winter)' : ''}</option>
                  <option value="winter">Winter</option>
                  <option value="spring">Spring</option>
                  <option value="durum">Durum</option>
                </select>
                <button
                  onClick={() => { setEditingId(r.id); setEditingName(r.name) }}
                  className="text-brand-deep"
                >Edit</button>
                <button onClick={() => remove(r.id)} className="text-red-600">Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
