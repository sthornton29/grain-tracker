'use client'

// Crops settings editor — add/rename/delete crops and set each crop's harvest
// category (Fall or Spring). The category drives double-crop classification: a
// fall-harvest crop on a field that also has a spring-harvest crop that season
// is a double-crop. Replaces the generic name-only SimpleCrud for crops.

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { createClient } from '@/lib/supabase/client'
import type { Crop } from '@/lib/types'

type RmaType = 'winter' | 'spring' | 'durum'

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
  // The Edit dialog: name + the crop insurance type (normally automatic).
  const [editing, setEditing] = useState<Crop | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingType, setEditingType] = useState<RmaType | ''>('')
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

  function openEdit(c: Crop) {
    setEditing(c)
    setEditingName(c.name)
    setEditingType(c.rma_type_override ?? '')
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editing) return
    const n = editingName.trim()
    if (!n) return
    const { error } = await supabase
      .from('crops')
      .update({ name: n, rma_type_override: editingType === '' ? null : editingType })
      .eq('id', editing.id)
    if (error) { setErr(error.message); return }
    setEditing(null); setErr(null); refresh()
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
            {(
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
                <button onClick={() => openEdit(r)} className="text-brand-deep">Edit</button>
                <button onClick={() => remove(r.id)} className="text-red-600">Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <EditCropModal
          crop={editing}
          name={editingName}
          onName={setEditingName}
          insuranceType={editingType}
          onInsuranceType={setEditingType}
          onSave={saveEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// Portaled to document.body (the inline-modal rule): a fixed overlay inside a
// list row would inherit the row's layout and any ancestor label/form
// activation. Holds the rename and the one insurance setting that is NOT on
// the list — the winter/spring type — because it only matters in a state
// that offers both and is otherwise set automatically from the harvest
// category (the Price Discovery window asks on its own when it matters).
function EditCropModal({ crop, name, onName, insuranceType, onInsuranceType, onSave, onClose }: {
  crop: Crop
  name: string
  onName: (v: string) => void
  insuranceType: RmaType | ''
  onInsuranceType: (v: RmaType | '') => void
  onSave: (e: React.FormEvent) => void
  onClose: () => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  const auto = crop.harvest_category === 'spring' ? 'Winter' : 'Spring'
  return createPortal(
    <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4 no-print" onClick={onClose}>
      <form onSubmit={onSave} className="bg-white rounded-xl shadow-xl p-4 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-lg">Edit {crop.name}</h3>
        <label className="block text-sm text-slate-700">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => onName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm text-slate-700">
          Crop insurance type (winter/spring)
          <select
            value={insuranceType}
            onChange={(e) => onInsuranceType(e.target.value === '' ? '' : (e.target.value as RmaType))}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
          >
            <option value="">Automatic ({auto})</option>
            <option value="winter">Winter</option>
            <option value="spring">Spring</option>
            <option value="durum">Durum</option>
          </select>
          <span className="block text-xs text-slate-500 mt-1">
            Only matters if your state offers both; normally set automatically.
          </span>
        </label>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">Cancel</button>
          <button type="submit" className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 text-sm font-semibold">Save</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
