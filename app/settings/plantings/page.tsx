'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import CsvImport from '@/components/csv-import'
import SettingsDocImport from '@/components/settings-doc-import'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { plantingsImportConfig } from '@/lib/import-configs'
import { usePersistentState } from '@/lib/use-persistent-state'
import { dismissalKey } from '@/lib/variety-resolution'
import type { Crop, Farm, Field, FieldPlanting, FieldPlantingVariety, VarietyMatchDismissal } from '@/lib/types'

type VarietyInput = { variety: string; acres: string }

type Form = {
  field_id: string
  crop_id: string
  season_year: string
  planted_acres: string
  irrigated_acres: string
  planting_date: string
  varieties: VarietyInput[]
  notes: string
}

const currentYear = () => new Date().getFullYear()

const empty = (year: number): Form => ({
  field_id: '',
  crop_id: '',
  season_year: String(year),
  planted_acres: '',
  irrigated_acres: '',
  planting_date: '',
  varieties: [],
  notes: '',
})

function dryFromInputs(plantedStr: string, irrStr: string): number {
  const p = Number(plantedStr || 0) || 0
  const i = Number(irrStr || 0) || 0
  return Math.max(0, p - i)
}

function irrigatedExceedsPlanted(plantedStr: string, irrStr: string): boolean {
  const p = Number(plantedStr || 0) || 0
  const i = Number(irrStr || 0) || 0
  return i > p
}

function irrigatedNegative(irrStr: string): boolean {
  return Number(irrStr || 0) < 0
}

function varietyAcresSum(vs: VarietyInput[]): number {
  return vs.reduce((s, v) => s + (Number(v.acres) || 0), 0)
}

function varietyAcresExceedPlanted(f: Form): boolean {
  const planted = Number(f.planted_acres) || 0
  if (planted === 0) return false
  // 0.01 fudge for float display.
  return varietyAcresSum(f.varieties) > planted + 0.01
}

function varietyMissingName(vs: VarietyInput[]): boolean {
  return vs.some((v) => !v.variety.trim() && (Number(v.acres) || 0) > 0)
}

function payload(f: Form) {
  const planted = f.planted_acres === '' ? 0 : Number(f.planted_acres)
  const irr = f.irrigated_acres === '' ? 0 : Number(f.irrigated_acres)
  return {
    field_id: f.field_id,
    crop_id: f.crop_id,
    season_year: Number(f.season_year),
    planted_acres: planted,
    irrigated_acres: irr,
    dryland_acres: Math.max(0, planted - irr),
    planting_date: f.planting_date || null,
    notes: f.notes.trim() || null,
  }
}

// Variety rows ready for insert. Drops blank-name rows so a half-typed row
// doesn't poison the save.
function varietyInserts(plantingId: string, vs: VarietyInput[]) {
  return vs
    .map((v) => ({ variety: v.variety.trim(), acres: Number(v.acres) || 0 }))
    .filter((v) => v.variety !== '')
    .map((v) => ({ planting_id: plantingId, variety: v.variety, acres: v.acres }))
}

const INPUT_CLS = 'rounded-lg border border-slate-300 px-3 py-2'
const READONLY_CLS = 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600'

function FormFields({
  value,
  onChange,
  fields,
  crops,
  fieldLabel,
  seasonYearOptions,
  varietyOptionsByCrop,
  plantings,
  excludePlantingId,
}: {
  value: Form
  onChange: (f: Form) => void
  fields: Field[]
  crops: Crop[]
  fieldLabel: (id: string) => string
  seasonYearOptions: number[]
  varietyOptionsByCrop: Map<string, string[]>
  /** All plantings, for the same-field-same-year informational line. */
  plantings: FieldPlanting[]
  /** On the edit form: the planting being edited (excluded from the line). */
  excludePlantingId?: string | null
}) {
  const set = <K extends keyof Form>(k: K, v: Form[K]) => onChange({ ...value, [k]: v })
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const cropNameById = useMemo(() => new Map(crops.map((c) => [c.id, c.name])), [crops])
  // Previously-used varieties for the selected crop, offered as a datalist so
  // the user can pick one or type a brand-new variety. Unique id per form
  // instance (add + edit forms can be on screen at once).
  const datalistId = `${useId()}-varieties`
  const varietyOptions = value.crop_id ? varietyOptionsByCrop.get(value.crop_id) ?? [] : []

  // Picking a field seeds planted_acres from the field's total acres (a
  // planting usually covers the whole field) and irrigated_acres from
  // min(field.irrigated_acres, planted_acres) — but only into inputs the user
  // hasn't typed in yet. Once they type, we stop touching the value.
  function onPickField(id: string) {
    const next: Form = { ...value, field_id: id }
    const f = id ? fieldById.get(id) : undefined
    if (value.planted_acres === '' && f && Number(f.total_acres) > 0) {
      next.planted_acres = String(Number(f.total_acres))
    }
    if (value.irrigated_acres === '' && f) {
      const fieldIrr = Number(f.irrigated_acres) || 0
      const planted = Number(next.planted_acres || 0) || 0
      const seed = planted > 0 ? Math.min(fieldIrr, planted) : fieldIrr
      if (seed > 0) next.irrigated_acres = String(seed)
    }
    onChange(next)
  }

  // The pre-fill hint stays visible while the value still equals the field's
  // acres (typing anything else hides it).
  const selectedField = value.field_id ? fieldById.get(value.field_id) : undefined
  const plantedIsFieldSeed =
    selectedField != null &&
    value.planted_acres !== '' &&
    Number(selectedField.total_acres) > 0 &&
    Number(value.planted_acres) === Number(selectedField.total_acres)

  // Other plantings already on this field for the picked season year. Shown as
  // information, not a conflict — two crops on one field the same year is the
  // normal double-crop shape, and both may claim the full acres.
  const sameYearPlantings = useMemo(() => {
    if (!value.field_id || value.season_year === '') return []
    return plantings.filter(
      (p) =>
        p.field_id === value.field_id &&
        String(p.season_year) === value.season_year &&
        p.id !== excludePlantingId,
    )
  }, [plantings, value.field_id, value.season_year, excludePlantingId])

  function onChangePlanted(v: string) {
    const next: Form = { ...value, planted_acres: v }
    const f = value.field_id ? fieldById.get(value.field_id) : null
    const fieldIrr = f ? Number(f.irrigated_acres) || 0 : 0
    const currentIrr = Number(value.irrigated_acres || 0) || 0
    const planted = Number(v || 0) || 0
    if (currentIrr === fieldIrr && planted > 0 && currentIrr > planted) {
      next.irrigated_acres = String(planted)
    }
    onChange(next)
  }

  function updateVariety(i: number, patch: Partial<VarietyInput>) {
    const next = value.varieties.map((v, j) => (i === j ? { ...v, ...patch } : v))
    onChange({ ...value, varieties: next })
  }
  function addVariety() {
    onChange({ ...value, varieties: [...value.varieties, { variety: '', acres: '' }] })
  }
  function removeVariety(i: number) {
    onChange({ ...value, varieties: value.varieties.filter((_, j) => j !== i) })
  }

  const dryShown =
    value.planted_acres === '' && value.irrigated_acres === ''
      ? ''
      : String(dryFromInputs(value.planted_acres, value.irrigated_acres))

  const invalid =
    irrigatedExceedsPlanted(value.planted_acres, value.irrigated_acres) ||
    irrigatedNegative(value.irrigated_acres)

  const varietyExceeds = varietyAcresExceedPlanted(value)
  const varietyBlank = varietyMissingName(value.varieties)

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select value={value.field_id} onChange={(e) => onPickField(e.target.value)} className={INPUT_CLS}>
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
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Planted acres
          <input
            type="number"
            step="0.01"
            min="0"
            value={value.planted_acres}
            onChange={(e) => onChangePlanted(e.target.value)}
            placeholder="0"
            className={INPUT_CLS}
          />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Irrigated acres
          <input
            type="number"
            step="0.01"
            min="0"
            value={value.irrigated_acres}
            onChange={(e) => set('irrigated_acres', e.target.value)}
            placeholder="0"
            className={INPUT_CLS}
          />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Dryland acres
          <input
            type="text"
            value={dryShown}
            readOnly
            tabIndex={-1}
            className={READONLY_CLS}
          />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Planting date
          <input
            type="date"
            value={value.planting_date}
            onChange={(e) => set('planting_date', e.target.value)}
            className={INPUT_CLS}
          />
        </label>
      </div>
      {plantedIsFieldSeed && (
        <p className="text-[11px] text-slate-500">
          Planted acres pre-filled from the field&rsquo;s acres — type a value to override.
        </p>
      )}
      {sameYearPlantings.length > 0 && (
        <p className="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
          This field already has{' '}
          {sameYearPlantings
            .map((p) => `${cropNameById.get(p.crop_id) ?? 'a crop'} (${Number(p.planted_acres)} ac)`)
            .join(' and ')}{' '}
          for {value.season_year} — adding another crop is normal for double-crop; acres may overlap.
        </p>
      )}
      {invalid && (
        <p className="text-sm text-red-600">
          {irrigatedNegative(value.irrigated_acres)
            ? 'Irrigated acres cannot be negative'
            : 'Irrigated acres cannot exceed planted acres'}
        </p>
      )}

      <div className="space-y-1">
        <div className="text-xs text-slate-500">
          Varieties (optional)
          {value.crop_id && varietyOptions.length > 0 && (
            <span className="text-slate-400"> — pick a previous one or type a new</span>
          )}
        </div>
        <datalist id={datalistId}>
          {varietyOptions.map((name) => <option key={name} value={name} />)}
        </datalist>
        {value.varieties.map((v, i) => (
          <div key={i} className="grid grid-cols-[1fr_7rem_auto] gap-2 items-center">
            <input
              value={v.variety}
              onChange={(e) => updateVariety(i, { variety: e.target.value })}
              placeholder={value.crop_id && varietyOptions.length > 0 ? 'Variety / hybrid — pick or type new' : 'Variety / hybrid'}
              list={datalistId}
              className={INPUT_CLS}
            />
            <input
              type="number"
              step="0.01"
              min="0"
              value={v.acres}
              onChange={(e) => updateVariety(i, { acres: e.target.value })}
              placeholder="acres"
              className={INPUT_CLS}
            />
            <button
              type="button"
              onClick={() => removeVariety(i)}
              className="text-red-600 px-2 text-lg leading-none"
              aria-label="Remove variety"
            >×</button>
          </div>
        ))}
        <button
          type="button"
          onClick={addVariety}
          className="text-sm text-brand-deep"
        >
          + Add variety
        </button>
        {varietyExceeds && (
          <p className="text-xs text-red-600">Variety acres exceed planted acres</p>
        )}
        {varietyBlank && (
          <p className="text-xs text-red-600">Variety name required when acres are set</p>
        )}
      </div>

      <input
        value={value.notes}
        onChange={(e) => set('notes', e.target.value)}
        placeholder="Notes"
        className={`${INPUT_CLS} w-full`}
      />
    </div>
  )
}

function formInvalid(f: Form): boolean {
  return (
    irrigatedExceedsPlanted(f.planted_acres, f.irrigated_acres) ||
    irrigatedNegative(f.irrigated_acres) ||
    varietyAcresExceedPlanted(f) ||
    varietyMissingName(f.varieties)
  )
}

export default function PlantingsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [varieties, setVarieties] = useState<FieldPlantingVariety[]>([])
  const [dismissals, setDismissals] = useState<VarietyMatchDismissal[]>([])
  const [year, setYear] = useState<number>(currentYear())
  // Farm filter persists across visits (app filter-persistence pattern); it also
  // narrows the Field dropdown below.
  const [farmFilter, setFarmFilter] = usePersistentState<string>('plantings-settings:farm', '')
  const [fieldFilter, setFieldFilter] = useState('')
  const [harvestFilter, setHarvestFilter] = useState<'' | 'fall' | 'spring'>('')
  const [form, setForm] = useState<Form>(empty(currentYear()))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Form>(empty(currentYear()))
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<'field' | 'crop' | 'acres'>('field')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  async function refresh() {
    const [fa, fi, cr, pl, vv, dm] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      fetchAllRows((f, t) => supabase.from('field_plantings').select('*').order('season_year', { ascending: false }).order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('field_planting_varieties').select('*').order('variety').order('id').range(f, t)),
      // "Keep both" decisions — tolerate a missing table (043 not applied yet).
      supabase.from('variety_match_dismissals').select('*'),
    ])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setVarieties((vv.data as FieldPlantingVariety[]) || [])
    setDismissals((dm.data as VarietyMatchDismissal[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  // Keep new-row form's year in sync with the active year filter.
  useEffect(() => {
    setForm((f) => ({ ...f, season_year: String(year) }))
  }, [year])

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const farmById  = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const cropById  = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])

  // Grouped varieties by planting id, in display/insert order.
  const varietiesByPlanting = useMemo(() => {
    const m = new Map<string, FieldPlantingVariety[]>()
    for (const v of varieties) {
      const list = m.get(v.planting_id) ?? []
      list.push(v)
      m.set(v.planting_id, list)
    }
    return m
  }, [varieties])

  // Variety NAMES per planting id (drives the AI import's Update classification).
  const varietyNamesByPlanting = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const [pid, list] of varietiesByPlanting) m.set(pid, list.map((v) => v.variety))
    return m
  }, [varietiesByPlanting])

  // "Keep both" dismissal pairs per crop id, for import-time possible-match
  // suppression (dismissalKey format — key_a|key_b, already stored sorted).
  const dismissedPairsByCrop = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const d of dismissals) {
      const set = m.get(d.crop_id) ?? new Set<string>()
      set.add(dismissalKey(d.key_a, d.key_b))
      m.set(d.crop_id, set)
    }
    return m
  }, [dismissals])

  // Distinct previously-used variety names per crop, for the variety datalist.
  const varietyOptionsByCrop = useMemo(() => {
    const plantingCrop = new Map(plantings.map((p) => [p.id, p.crop_id]))
    const byCrop = new Map<string, Set<string>>()
    for (const v of varieties) {
      const cropId = plantingCrop.get(v.planting_id)
      const name = v.variety?.trim()
      if (!cropId || !name) continue
      if (!byCrop.has(cropId)) byCrop.set(cropId, new Set())
      byCrop.get(cropId)!.add(name)
    }
    const out = new Map<string, string[]>()
    for (const [cropId, set] of byCrop) out.set(cropId, [...set].sort((a, b) => a.localeCompare(b)))
    return out
  }, [plantings, varieties])

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

  function varietySummary(pid: string): string {
    const vs = varietiesByPlanting.get(pid) ?? []
    if (vs.length === 0) return ''
    return vs.map((v) => Number(v.acres) > 0 ? `${v.variety} (${Number(v.acres)})` : v.variety).join(', ')
  }

  const visible = plantings
    .filter((p) => {
      if (p.season_year !== year) return false
      if (farmFilter && fieldById.get(p.field_id)?.farm_id !== farmFilter) return false
      if (fieldFilter && p.field_id !== fieldFilter) return false
      if (harvestFilter && cropById.get(p.crop_id)?.harvest_category !== harvestFilter) return false
      if (q) {
        const hay = [
          fieldLabel(p.field_id), cropById.get(p.crop_id)?.name ?? '',
          String(p.planted_acres), p.planting_date ?? '',
          varietySummary(p.id), p.notes ?? '',
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

  async function saveVarieties(plantingId: string, vs: VarietyInput[]) {
    const inserts = varietyInserts(plantingId, vs)
    return supabase.from('field_planting_varieties').insert(inserts)
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!form.field_id || !form.crop_id || !form.season_year) {
      setErr('Field, crop, and season year are required.')
      return
    }
    if (formInvalid(form)) {
      setErr('Fix the highlighted fields before saving.')
      return
    }
    const { data, error } = await supabase
      .from('field_plantings')
      .insert(payload(form))
      .select('id')
      .single()
    if (error || !data) { setErr(error?.message ?? 'Insert failed'); return }
    const inserts = varietyInserts(data.id, form.varieties)
    if (inserts.length > 0) {
      const { error: vErr } = await supabase.from('field_planting_varieties').insert(inserts)
      if (vErr) { setErr(`Planting saved but variety save failed: ${vErr.message}`); refresh(); return }
    }
    setForm(empty(year))
    setErr(null)
    refresh()
  }

  async function save(id: string) {
    if (!editForm.field_id || !editForm.crop_id || !editForm.season_year) {
      setErr('Field, crop, and season year are required.')
      return
    }
    if (formInvalid(editForm)) {
      setErr('Fix the highlighted fields before saving.')
      return
    }
    const { error } = await supabase.from('field_plantings').update(payload(editForm)).eq('id', id)
    if (error) { setErr(error.message); return }
    // Replace varieties for this planting. Done in two steps because the JS
    // client has no diff/upsert flow for child rows; the brief window with no
    // variety rows is acceptable for a single-user farm app.
    const { error: delErr } = await supabase
      .from('field_planting_varieties')
      .delete()
      .eq('planting_id', id)
    if (delErr) { setErr(delErr.message); return }
    const inserts = varietyInserts(id, editForm.varieties)
    if (inserts.length > 0) {
      const { error: vErr } = await supabase.from('field_planting_varieties').insert(inserts)
      if (vErr) { setErr(vErr.message); refresh(); return }
    }
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
        defaultOpen
        recommended
        config={plantingsImportConfig({
          fields,
          currentYear: currentYear(),
          varietyOptionsByCrop,
          dismissedPairsByCrop,
        })}
        onImported={refresh}
      />

      <SettingsDocImport primaryTarget="plantings" title="Upload an Acreage / Planting Report (AI)" onSaved={refresh} />

      <form onSubmit={add} className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Add planting</h2>
        <FormFields value={form} onChange={setForm} fields={fields} crops={crops} fieldLabel={fieldLabel} seasonYearOptions={seasonYearOptions} varietyOptionsByCrop={varietyOptionsByCrop} plantings={plantings} />
        <button
          disabled={formInvalid(form)}
          className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
        >
          Add
        </button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

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
            Farm
            <select
              value={farmFilter}
              onChange={(e) => {
                const next = e.target.value
                setFarmFilter(next)
                // Keep the field filter consistent: clear it when the selected
                // field isn't on the newly-chosen farm.
                if (next && fieldFilter && fieldById.get(fieldFilter)?.farm_id !== next) setFieldFilter('')
              }}
              className={inputCls}
            >
              <option value="">All farms</option>
              {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className="text-sm flex items-center gap-2">
            Field
            <select value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} className={inputCls}>
              <option value="">All fields</option>
              {fields.filter((f) => !farmFilter || f.farm_id === farmFilter).map((f) => <option key={f.id} value={f.id}>{fieldLabel(f.id)}</option>)}
            </select>
          </label>
          <label className="text-sm flex items-center gap-2">
            Harvest Timing
            <select
              value={harvestFilter}
              onChange={(e) => setHarvestFilter(e.target.value as '' | 'fall' | 'spring')}
              className={inputCls}
            >
              <option value="">All</option>
              <option value="fall">Fall</option>
              <option value="spring">Spring</option>
            </select>
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          placeholder="Search field, crop, variety, notes…"
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

      <p className="text-sm text-slate-500">
        {visible.length} planting{visible.length === 1 ? '' : 's'} · {year}
        {' · '}{farmFilter ? (farmById.get(farmFilter)?.name ?? 'Farm') : 'All farms'}
        {harvestFilter ? ` · ${harvestFilter === 'fall' ? 'Fall' : 'Spring'} harvest` : ''}
      </p>

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Field', 'Crop', 'Varieties', 'Planted ac', 'Irrigated ac', 'Dryland ac', 'Planted', 'Notes', '', ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">No plantings for {year}.</td></tr>
            )}
            {visible.map((p) => {
              const isEditing = editingId === p.id
              const cropNm = cropById.get(p.crop_id)?.name ?? '—'
              const cropCat = cropById.get(p.crop_id)?.harvest_category
              return (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  {isEditing ? (
                    <td colSpan={10} className="px-3 py-3">
                      <FormFields value={editForm} onChange={setEditForm} fields={fields} crops={crops} fieldLabel={fieldLabel} seasonYearOptions={seasonYearOptions} varietyOptionsByCrop={varietyOptionsByCrop} plantings={plantings} excludePlantingId={p.id} />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => save(p.id)}
                          disabled={formInvalid(editForm)}
                          className="text-green-700 font-semibold disabled:opacity-50"
                        >Save</button>
                        <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2">{fieldLabel(p.field_id)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {cropNm}
                        {cropCat && <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-400">{cropCat}</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{varietySummary(p.id)}</td>
                      <td className="px-3 py-2 text-right">{Number(p.planted_acres)}</td>
                      <td className="px-3 py-2 text-right">
                        {Number(p.irrigated_acres) > 0 ? Number(p.irrigated_acres) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {Number(p.dryland_acres) > 0 ? Number(p.dryland_acres) : '—'}
                      </td>
                      <td className="px-3 py-2">{p.planting_date ?? ''}</td>
                      <td className="px-3 py-2 text-slate-500">{p.notes ?? ''}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => {
                            const vs = varietiesByPlanting.get(p.id) ?? []
                            setEditingId(p.id)
                            setEditForm({
                              field_id: p.field_id,
                              crop_id: p.crop_id,
                              season_year: String(p.season_year),
                              planted_acres: String(p.planted_acres),
                              irrigated_acres: Number(p.irrigated_acres) > 0 ? String(p.irrigated_acres) : '',
                              planting_date: p.planting_date ?? '',
                              varieties: vs.map((v) => ({
                                variety: v.variety,
                                acres: Number(v.acres) > 0 ? String(Number(v.acres)) : '',
                              })),
                              notes: p.notes ?? '',
                            })
                          }}
                          className="text-brand-deep"
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
