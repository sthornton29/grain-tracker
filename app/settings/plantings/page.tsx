'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { buildDoubleCropSoySet, cropYearOptionsFromPlantings } from '@/lib/plantings'
import type { Crop, Farm, Field, FieldPlanting } from '@/lib/types'

type Form = {
  field_id: string
  crop_id: string
  season_year: string
  planted_acres: string
  planting_date: string
  notes: string
}

const currentYear = () => new Date().getFullYear()

const empty = (year: number): Form => ({
  field_id: '',
  crop_id: '',
  season_year: String(year),
  planted_acres: '',
  planting_date: '',
  notes: '',
})

function payload(f: Form) {
  return {
    field_id: f.field_id,
    crop_id: f.crop_id,
    season_year: Number(f.season_year),
    planted_acres: f.planted_acres === '' ? 0 : Number(f.planted_acres),
    planting_date: f.planting_date || null,
    notes: f.notes.trim() || null,
  }
}

const INPUT_CLS = 'rounded-lg border border-slate-300 px-3 py-2'

function FormFields({
  value,
  onChange,
  fields,
  crops,
  fieldLabel,
  seasonYearOptions,
}: {
  value: Form
  onChange: (f: Form) => void
  fields: Field[]
  crops: Crop[]
  fieldLabel: (id: string) => string
  seasonYearOptions: number[]
}) {
  const set = <K extends keyof Form>(k: K, v: Form[K]) => onChange({ ...value, [k]: v })
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <select value={value.field_id} onChange={(e) => set('field_id', e.target.value)} className={INPUT_CLS}>
        <option value="">— field —</option>
        {fields.map((f) => <option key={f.id} value={f.id}>{fieldLabel(f.id)}</option>)}
      </select>
      <select value={value.crop_id} onChange={(e) => set('crop_id', e.target.value)} className={INPUT_CLS}>
        <option value="">— crop —</option>
        {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select
        value={value.season_year}
        onChange={(e) => set('season_year', e.target.value)}
        className={INPUT_CLS}
      >
        <option value="">— season year —</option>
        {seasonYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      <input
        type="number"
        step="0.01"
        value={value.planted_acres}
        onChange={(e) => set('planted_acres', e.target.value)}
        placeholder="Planted acres"
        className={INPUT_CLS}
      />
      <input
        type="date"
        value={value.planting_date}
        onChange={(e) => set('planting_date', e.target.value)}
        className={INPUT_CLS}
      />
      <input
        value={value.notes}
        onChange={(e) => set('notes', e.target.value)}
        placeholder="Notes"
        className={INPUT_CLS}
      />
    </div>
  )
}

export default function PlantingsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [year, setYear] = useState<number>(currentYear())
  const [fieldFilter, setFieldFilter] = useState('')
  const [form, setForm] = useState<Form>(empty(currentYear()))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Form>(empty(currentYear()))
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<'field' | 'crop' | 'acres'>('field')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  async function refresh() {
    const [fa, fi, cr, pl] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*').order('season_year', { ascending: false }),
    ])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  // Keep new-row form's year in sync with the active year filter.
  useEffect(() => {
    setForm((f) => ({ ...f, season_year: String(year) }))
  }, [year])

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById  = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const cropById  = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const soybeanCropId = useMemo(() => crops.find((c) => c.name === 'Soybean')?.id ?? null, [crops])
  const doubleCropSoyIds = useMemo(
    () => buildDoubleCropSoySet(plantings, cropById),
    [plantings, cropById],
  )

  const distinctYears = useMemo(() => {
    const s = new Set<number>([currentYear()])
    plantings.forEach((p) => s.add(p.season_year))
    return [...s].sort((a, b) => b - a)
  }, [plantings])

  // Form-level season year options come from existing plantings (with the active
  // filter year added so newly-typed years are immediately pickable).
  const seasonYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year), year),
    [plantings, year],
  )

  const visible = plantings
    .filter((p) => {
      if (p.season_year !== year) return false
      if (fieldFilter && p.field_id !== fieldFilter) return false
      if (q) {
        const hay = [
          fieldLabel(p.field_id), cropById.get(p.crop_id)?.name ?? '',
          String(p.planted_acres), p.planting_date ?? '', p.notes ?? '',
        ].join(' ').toLowerCase()
        if (!hay.includes(q.toLowerCase())) return false
      }
      return true
    })
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'crop') {
        return dir * (cropById.get(a.crop_id)?.name ?? '').localeCompare(cropById.get(b.crop_id)?.name ?? '')
      }
      if (sortKey === 'acres') return dir * (Number(a.planted_acres) - Number(b.planted_acres))
      return dir * fieldLabel(a.field_id).localeCompare(fieldLabel(b.field_id))
    })

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!form.field_id || !form.crop_id || !form.season_year) {
      setErr('Field, crop, and season year are required.')
      return
    }
    const { error } = await supabase.from('field_plantings').insert(payload(form))
    if (error) { setErr(error.message); return }
    setForm(empty(year))
    setErr(null)
    refresh()
  }

  async function save(id: string) {
    if (!editForm.field_id || !editForm.crop_id || !editForm.season_year) {
      setErr('Field, crop, and season year are required.')
      return
    }
    const { error } = await supabase.from('field_plantings').update(payload(editForm)).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null)
    refresh()
  }

  async function remove(id: string) {
    const p = plantings.find((x) => x.id === id)
    if (!p) return
    const msg = p.paired_planting_id
      ? 'Delete this planting? Its double-crop pair will be unlinked but kept.'
      : 'Delete this planting?'
    if (!confirm(msg)) return
    const { error } = await supabase.from('field_plantings').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  async function copyPriorYear() {
    setErr(null)
    const prior = year - 1
    const source = plantings.filter((p) => p.season_year === prior)
    if (source.length === 0) {
      setErr(`No plantings found for ${prior}.`)
      return
    }
    const existing = new Set(
      plantings.filter((p) => p.season_year === year).map((p) => `${p.field_id}|${p.crop_id}`)
    )
    const toInsert = source
      .filter((p) => !existing.has(`${p.field_id}|${p.crop_id}`))
      .map((p) => ({
        field_id: p.field_id,
        crop_id: p.crop_id,
        season_year: year,
        planted_acres: Number(p.planted_acres),
        planting_date: null,
        notes: null,
      }))
    if (toInsert.length === 0) {
      setErr(`All ${prior} plantings already have a ${year} counterpart.`)
      return
    }
    if (!confirm(`Copy ${toInsert.length} planting(s) from ${prior} to ${year}?`)) return
    setBusy(true)
    const { error } = await supabase.from('field_plantings').insert(toInsert)
    setBusy(false)
    if (error) { setErr(error.message); return }
    refresh()
  }

  async function addDoubleCropSoybeans(p: FieldPlanting) {
    setErr(null)
    if (!soybeanCropId) {
      setErr('Soybean crop not found in the crops table.')
      return
    }
    if (p.paired_planting_id) {
      setErr('This planting already has a paired planting.')
      return
    }
    setBusy(true)
    const { data: inserted, error: insErr } = await supabase
      .from('field_plantings')
      .insert({
        field_id: p.field_id,
        crop_id: soybeanCropId,
        season_year: p.season_year,
        planted_acres: Number(p.planted_acres),
        planting_date: null,
        paired_planting_id: p.id,
        notes: 'Double-crop pair',
      })
      .select('id')
      .single()
    if (insErr || !inserted) { setBusy(false); setErr(insErr?.message ?? 'Insert failed'); return }
    const { error: updErr } = await supabase
      .from('field_plantings')
      .update({ paired_planting_id: inserted.id })
      .eq('id', p.id)
    setBusy(false)
    if (updErr) { setErr(updErr.message); return }
    refresh()
  }

  function fieldLabel(id: string) {
    const f = fieldById.get(id)
    if (!f) return '—'
    const farm = f.farm_id ? farmById.get(f.farm_id)?.name : null
    return farm ? `${f.name_or_number} (${farm})` : f.name_or_number
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Field Plantings</h1>
      <p className="text-sm text-slate-500">
        One row per field, per crop, per season. Use the harvest year as the season year.
      </p>

      <CsvImport
        config={{
          tableName: 'field_plantings',
          uniqueKey: ['field_id', 'crop_id', 'season_year'],
          columns: [
            { key: 'field_id', label: 'field', required: true, fk: { table: 'fields', matchColumn: 'name_or_number' } },
            { key: 'crop_id', label: 'crop', required: true, fk: { table: 'crops', matchColumn: 'name' } },
            { key: 'season_year', type: 'number', required: true },
            { key: 'planted_acres', type: 'number' },
            { key: 'planting_date', type: 'date' },
            { key: 'notes' },
          ],
        }}
        onImported={refresh}
      />

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-center">
          <label className="text-sm flex items-center gap-2">
            Season
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={inputCls}>
              {distinctYears.map((y) => <option key={y} value={y}>{y}</option>)}
              {!distinctYears.includes(year) && <option value={year}>{year}</option>}
            </select>
          </label>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className={`w-28 ${inputCls}`}
            placeholder="Or type"
          />
          <label className="text-sm flex items-center gap-2">
            Field
            <select value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} className={inputCls}>
              <option value="">All fields</option>
              {fields.map((f) => <option key={f.id} value={f.id}>{fieldLabel(f.id)}</option>)}
            </select>
          </label>
          <button
            onClick={copyPriorYear}
            disabled={busy}
            className="ml-auto rounded-lg bg-sky-700 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
            title={`Copy plantings from ${year - 1} into ${year}`}
          >
            Copy from {year - 1}
          </button>
        </div>
      </div>

      <form onSubmit={add} className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Add planting</h2>
        <FormFields value={form} onChange={setForm} fields={fields} crops={crops} fieldLabel={fieldLabel} seasonYearOptions={seasonYearOptions} />
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          placeholder="Search field, crop, notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as 'field' | 'crop' | 'acres')}
          className="text-sm rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="field">Sort: Field</option>
          <option value="crop">Sort: Crop</option>
          <option value="acres">Sort: Acres</option>
        </select>
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
        >
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Field', 'Crop', 'Acres', 'Planted', '', 'Notes', '', '', ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No plantings for {year}.</td></tr>
            )}
            {visible.map((p) => {
              const isEditing = editingId === p.id
              const cropNm = cropById.get(p.crop_id)?.name ?? '—'
              const showAddSoy = soybeanCropId
                && (cropNm === 'Wheat' || cropNm === 'Canola')
                && !p.paired_planting_id
              return (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  {isEditing ? (
                    <td colSpan={9} className="px-3 py-3">
                      <FormFields value={editForm} onChange={setEditForm} fields={fields} crops={crops} fieldLabel={fieldLabel} seasonYearOptions={seasonYearOptions} />
                      <div className="flex gap-2 mt-2">
                        <button onClick={() => save(p.id)} className="text-green-700 font-semibold">Save</button>
                        <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2">{fieldLabel(p.field_id)}</td>
                      <td className="px-3 py-2">{cropNm}</td>
                      <td className="px-3 py-2 text-right">{Number(p.planted_acres)}</td>
                      <td className="px-3 py-2">{p.planting_date ?? ''}</td>
                      <td className="px-3 py-2">
                        {doubleCropSoyIds.has(p.id) && (
                          <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">double-crop</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{p.notes ?? ''}</td>
                      <td className="px-3 py-2">
                        {showAddSoy && (
                          <button
                            onClick={() => addDoubleCropSoybeans(p)}
                            disabled={busy}
                            className="text-amber-800 text-sm whitespace-nowrap"
                            title="Create a paired Soybean planting on the same field"
                          >
                            + Soybeans
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => {
                            setEditingId(p.id)
                            setEditForm({
                              field_id: p.field_id,
                              crop_id: p.crop_id,
                              season_year: String(p.season_year),
                              planted_acres: String(p.planted_acres),
                              planting_date: p.planting_date ?? '',
                              notes: p.notes ?? '',
                            })
                          }}
                          className="text-sky-700"
                        >Edit</button>
                      </td>
                      <td className="px-3 py-2"><button onClick={() => remove(p.id)} className="text-red-600">Delete</button></td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
