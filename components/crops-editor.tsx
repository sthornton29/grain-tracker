'use client'

// Crops settings editor — add/rename/delete crops and set each crop's harvest
// category (Fall or Spring). The category drives double-crop classification: a
// fall-harvest crop on a field that also has a spring-harvest crop that season
// is a double-crop. Replaces the generic name-only SimpleCrud for crops.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/friendly-error'
import { AppModal } from '@/components/app-dialog'
import { useDialogs, plural } from '@/components/use-dialogs'
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
  const { confirm, dialogs } = useDialogs()

  async function refresh() {
    const { data, error } = await supabase.from('crops').select('*').order('name')
    if (error) { setErr(reportError(error, { action: 'load your crops', noun: 'crop' })); return }
    setRows((data as Crop[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const nameTaken = (n: string, exceptId?: string) =>
    rows.some((r) => r.id !== exceptId && r.name.trim().toLowerCase() === n.toLowerCase())

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    if (nameTaken(n)) { setErr(`A crop named “${n}” already exists.`); return }
    const { error } = await supabase.from('crops').insert({ name: n, harvest_category: category, double_crop: dc })
    if (error) { setErr(reportError(error, { action: 'add the crop', noun: 'crop', name: n })); return }
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
    if (nameTaken(n, editing.id)) { setErr(`A crop named “${n}” already exists.`); return }
    const { error } = await supabase
      .from('crops')
      .update({ name: n, rma_type_override: editingType === '' ? null : editingType })
      .eq('id', editing.id)
    if (error) { setErr(reportError(error, { action: 'save the crop', noun: 'crop', name: n })); return }
    setEditing(null); setErr(null); refresh()
  }

  async function setHarvestCategory(id: string, harvest_category: HarvestCategory) {
    // Optimistic update so the select reflects the choice instantly.
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, harvest_category } : r)))
    const { error } = await supabase.from('crops').update({ harvest_category }).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'change the harvest season', noun: 'crop' })); refresh() }
  }

  async function setDoubleCrop(id: string, double_crop: boolean) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, double_crop } : r)))
    const { error } = await supabase.from('crops').update({ double_crop }).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'change the double-crop setting', noun: 'crop' })); refresh() }
  }

  async function remove(c: Crop) {
    setErr(null)
    // Count what depends on the crop before offering to delete it.
    const [pl, lo] = await Promise.all([
      supabase.from('field_plantings').select('id', { count: 'exact', head: true }).eq('crop_id', c.id),
      supabase.from('loads').select('id', { count: 'exact', head: true }).eq('crop_id', c.id),
    ])
    const plantings = pl.count ?? 0
    const loads = lo.count ?? 0
    if (plantings > 0 || loads > 0) {
      const parts = [plantings > 0 ? plural(plantings, 'planting') : null, loads > 0 ? plural(loads, 'load') : null].filter(Boolean)
      setErr(`${c.name} has ${parts.join(' and ')} recorded, so it can’t be deleted. Rename it if the name is wrong.`)
      return
    }
    const ok = await confirm({ title: `Delete ${c.name}?`, body: 'Nothing is recorded against this crop yet, so it can be removed.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    const { error } = await supabase.from('crops').delete().eq('id', c.id)
    if (error) { setErr(reportError(error, { action: 'delete the crop', noun: 'crop', name: c.name })); return }
    refresh()
  }

  const selectCls = 'rounded-lg border border-slate-300 px-3 py-2 bg-white min-h-11'
  const btnCls = 'min-h-11 px-3 rounded-lg text-sm font-semibold'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Crops</h1>
      <p className="text-sm text-slate-500">
        Set each crop&apos;s harvest season and whether it&apos;s grown as a double-crop. A field that has a{' '}
        <strong>spring</strong>-harvest crop that season is double-cropped; a crop marked{' '}
        <strong>Double-crop</strong> on that field (e.g. soybeans after wheat) is counted as double-crop acres.
      </p>

      <form onSubmit={add} className="flex gap-2 flex-wrap items-end bg-white p-4 rounded-xl shadow">
        <label className="flex-1 min-w-[10rem] block text-sm text-slate-700">
          Crop name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Corn"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-11"
          />
        </label>
        <label className="block text-sm text-slate-700">
          Harvest season
          <select value={category} onChange={(e) => setCategory(e.target.value as HarvestCategory)} className={`mt-1 block ${selectCls}`}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="text-sm flex items-center gap-2 text-slate-600 min-h-11">
          <input type="checkbox" checked={dc} onChange={(e) => setDc(e.target.checked)} className="h-5 w-5" />
          Double-crop
        </label>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {rows.length === 0 && <li className="px-4 py-6 text-center text-slate-500">No crops yet — add the first one above.</li>}
        {rows.map((r) => (
          <li key={r.id} className="px-3 sm:px-4 py-2 flex items-center gap-2 flex-wrap">
            <span className="flex-1 min-w-[8rem] font-medium">{r.name}</span>
            <select
              value={r.harvest_category}
              onChange={(e) => setHarvestCategory(r.id, e.target.value as HarvestCategory)}
              className={`text-sm ${selectCls}`}
              aria-label={`${r.name} harvest season`}
            >
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <label className="text-sm flex items-center gap-1.5 text-slate-600 min-h-11">
              <input
                type="checkbox"
                checked={r.double_crop}
                onChange={(e) => setDoubleCrop(r.id, e.target.checked)}
                aria-label={`${r.name} double-crop`}
                className="h-5 w-5"
              />
              Double-crop
            </label>
            <button type="button" onClick={() => openEdit(r)} className={`${btnCls} text-brand-deep`}>Edit</button>
            <button type="button" onClick={() => remove(r)} className={`${btnCls} text-red-600`}>Delete</button>
          </li>
        ))}
      </ul>

      <AppModal open={editing != null} title={editing ? `Edit ${editing.name}` : ''} onClose={() => setEditing(null)} size="sm">
        {editing && (
          <form onSubmit={saveEdit} className="space-y-3">
            <label className="block text-sm text-slate-700">
              Name
              <input
                data-autofocus
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-11"
              />
            </label>
            <label className="block text-sm text-slate-700">
              Crop insurance type (winter/spring)
              <select
                value={editingType}
                onChange={(e) => setEditingType(e.target.value === '' ? '' : (e.target.value as RmaType))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 bg-white min-h-11"
              >
                <option value="">Automatic ({editing.harvest_category === 'spring' ? 'Winter' : 'Spring'})</option>
                <option value="winter">Winter</option>
                <option value="spring">Spring</option>
                <option value="durum">Durum</option>
              </select>
              <span className="block text-xs text-slate-500 mt-1">
                Only matters if your state offers both; normally set automatically.
              </span>
            </label>
            <div className="flex gap-2 justify-end pt-1">
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-slate-300 px-4 min-h-11 text-sm">Cancel</button>
              <button type="submit" className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold">Save</button>
            </div>
          </form>
        )}
      </AppModal>
      {dialogs}
    </div>
  )
}
