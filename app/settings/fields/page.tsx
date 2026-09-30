'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import CsvImport from '@/components/csv-import'
import { fieldsImportConfig } from '@/lib/import-configs'
import SettingsDocImport from '@/components/settings-doc-import'
import { buildDoubleCropSet } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useFarmLink } from '@/lib/use-farm-link'
import { landImportBlockedMessage, landRowEditable, LAND_MANAGED_MESSAGE } from '@/lib/farm-link'
import { FarmLinkBanner, ManagedChip, NotLinkedChip } from '@/components/farm-link-banner'
import { reportError } from '@/lib/friendly-error'
import { useDialogs, plural } from '@/components/use-dialogs'
import type { Crop, Farm, Field, FieldPlanting, County, EntityCounty } from '@/lib/types'

function parseAcres(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Live derivation used while typing: empty Total is treated as 0 so we can
// still produce a Dryland number, but the persisted value stays null.
function dryFromInputs(totalStr: string, irrStr: string): number {
  const t = Number(totalStr || 0) || 0
  const i = Number(irrStr || 0) || 0
  return Math.max(0, t - i)
}

function irrigatedExceedsTotal(totalStr: string, irrStr: string): boolean {
  const t = Number(totalStr || 0) || 0
  const i = Number(irrStr || 0) || 0
  return i > t
}

function irrigatedNegative(irrStr: string): boolean {
  return Number(irrStr || 0) < 0
}

export default function FieldsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [entityCounties, setEntityCounties] = useState<EntityCounty[]>([])
  const [name, setName] = useState('')
  const [farmId, setFarmId] = useState('')
  const [countyId, setCountyId] = useState('')
  const [totalAcres, setTotalAcres] = useState('')
  const [irrigatedAcres, setIrrigatedAcres] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editFarmId, setEditFarmId] = useState('')
  const [editCountyId, setEditCountyId] = useState('')
  const [editAcres, setEditAcres] = useState('')
  const [editIrrigated, setEditIrrigated] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const { confirm, dialogs } = useDialogs()
  // Farm filter for the list, persisted like the app's other filters ('' = all).
  const [farmFilter, setFarmFilter] = usePersistentState<string>('fields-settings:farm', '')
  const [sortKey, setSortKey] = useState<'name' | 'farm' | 'acres' | 'county'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  // 087: managed in Turnrow Farm → synced rows are read-only here.
  const farmLink = useFarmLink(supabase, 'fields')
  const managed = farmLink.managed
  const canEdit = (f: Field) => landRowEditable(f, managed)

  async function refresh() {
    const [fa, fi, cr, pl, co, ec] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      fetchAllRows((f, t) => supabase.from('field_plantings').select('*').order('season_year', { ascending: false }).order('id').range(f, t)),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entity_counties').select('*'),
    ])
    if (fi.error) { setErr(reportError(fi.error, { action: 'load your fields', noun: 'field' })); return }
    // Archived (by the Turnrow Farm link or from here) → out of the lists.
    setFarms(((fa.data as Farm[]) || []).filter((f) => !f.archived_at))
    setFields(((fi.data as Field[]) || []).filter((f) => !f.archived_at))
    setCrops((cr.data as Crop[]) || [])
    setPlantings(((pl.data as FieldPlanting[]) || []).filter((p) => !p.archived_at))
    setCounties((co.data as County[]) || [])
    setEntityCounties((ec.data as EntityCounty[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const farmById = useMemo(() => new Map(farms.map((f) => [f.id, f])), [farms])
  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])

  // entity_id -> County[]
  const countiesForEntity = useMemo(() => {
    const m = new Map<string, County[]>()
    for (const ec of entityCounties) {
      const c = countyById.get(ec.county_id)
      if (!c) continue
      const list = m.get(ec.entity_id) ?? []
      list.push(c)
      m.set(ec.entity_id, list)
    }
    for (const [, list] of m) {
      list.sort((a, b) => a.state_code.localeCompare(b.state_code) || a.name.localeCompare(b.name))
    }
    return m
  }, [entityCounties, countyById])

  function countiesForFarm(fId: string): County[] {
    const farm = farmById.get(fId)
    if (!farm || !farm.entity_id) return []
    return countiesForEntity.get(farm.entity_id) ?? []
  }

  function onFarmChange(fId: string) {
    setFarmId(fId)
    const farm = farmById.get(fId)
    setCountyId(farm?.county_id ?? '')
  }

  function onEditFarmChange(fId: string) {
    setEditFarmId(fId)
    const farm = farmById.get(fId)
    setEditCountyId(farm?.county_id ?? '')
  }

  const addInvalid =
    irrigatedExceedsTotal(totalAcres, irrigatedAcres) || irrigatedNegative(irrigatedAcres)
  const editInvalid =
    irrigatedExceedsTotal(editAcres, editIrrigated) || irrigatedNegative(editIrrigated)

  const nameTaken = (n: string, fId: string, exceptId?: string) =>
    fields.some((f) => f.id !== exceptId && (f.farm_id ?? '') === (fId ?? '') && f.name_or_number.trim().toLowerCase() === n.toLowerCase())

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (managed) { setErr(`${LAND_MANAGED_MESSAGE} Add the field in Turnrow Farm.`); return }
    const n = name.trim()
    if (!n) return
    if (addInvalid) return
    if (nameTaken(n, farmId)) { setErr(`A field named “${n}” already exists on that farm.`); return }
    const total = parseAcres(totalAcres)
    const irr = parseAcres(irrigatedAcres) ?? 0
    const dry = total != null ? Math.max(0, total - irr) : 0
    const { error } = await supabase.from('fields').insert({
      name_or_number: n,
      farm_id: farmId || null,
      county_id: countyId || null,
      total_acres: total,
      irrigated_acres: irr,
      dryland_acres: dry,
    })
    if (error) { setErr(reportError(error, { action: 'add the field', noun: 'field', name: n })); return }
    setName(''); setTotalAcres(''); setIrrigatedAcres(''); setErr(null); refresh()
    // Keep farmId + countyId so adding a sibling field is one-click.
  }

  async function save(id: string) {
    if (editInvalid) return
    const n = editName.trim()
    if (!n) return
    if (nameTaken(n, editFarmId, id)) { setErr(`A field named “${n}” already exists on that farm.`); return }
    const total = parseAcres(editAcres)
    const irr = parseAcres(editIrrigated) ?? 0
    const dry = total != null ? Math.max(0, total - irr) : 0
    const { error } = await supabase.from('fields').update({
      name_or_number: n,
      farm_id: editFarmId || null,
      county_id: editCountyId || null,
      total_acres: total,
      irrigated_acres: irr,
      dryland_acres: dry,
    }).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'save the field', noun: 'field', name: n })); return }
    setEditingId(null); setErr(null); refresh()
  }

  async function archive(f: Field) {
    setErr(null)
    const ok = await confirm({
      title: `Archive ${f.name_or_number}?`,
      body: 'The field disappears from this list and from new-record pickers. Its plantings, loads, and yields stay exactly as they are.',
      confirmLabel: 'Archive',
    })
    if (!ok) return
    setBusyId(f.id)
    const { error } = await supabase.from('fields').update({ archived_at: new Date().toISOString() }).eq('id', f.id)
    setBusyId(null)
    if (error) { setErr(reportError(error, { action: 'archive the field', noun: 'field', name: f.name_or_number })); return }
    refresh()
  }

  async function remove(f: Field) {
    setErr(null)
    setBusyId(f.id)
    const { count } = await supabase.from('loads').select('id', { count: 'exact', head: true }).eq('from_field_id', f.id)
    setBusyId(null)
    const loads = count ?? 0
    if (loads > 0) {
      setErr(`${f.name_or_number} has ${plural(loads, 'load')} recorded, so it can’t be deleted. Archive it instead — the loads and yields stay.`)
      return
    }
    const nPlantings = plantings.filter((p) => p.field_id === f.id).length
    const ok = await confirm({
      title: nPlantings > 0 ? `Delete ${f.name_or_number} and its ${plural(nPlantings, 'planting')}?` : `Delete ${f.name_or_number}?`,
      body: nPlantings > 0 ? 'The plantings recorded on this field are deleted with it. This can’t be undone.' : 'This can’t be undone. If you might need it again, archive it instead.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    setBusyId(f.id)
    const { error } = await supabase.from('fields').delete().eq('id', f.id)
    setBusyId(null)
    if (error) { setErr(reportError(error, { action: 'delete the field', noun: 'field', name: f.name_or_number })); return }
    refresh()
  }

  const farmName = (id: string | null) => farms.find((f) => f.id === id)?.name ?? ''
  const cropName = (id: string) => crops.find((c) => c.id === id)?.name ?? '—'
  const countyLabel = (id: string | null) => {
    if (!id) return ''
    const c = countyById.get(id)
    return c ? `${c.name}, ${c.state_code}` : ''
  }
  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const doubleCropIds = useMemo(
    () => buildDoubleCropSet(plantings, cropById),
    [plantings, cropById],
  )
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full'
  const readonlyCls = 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 min-h-11 w-full text-slate-600'
  const labelCls = 'block text-sm text-slate-700'
  const btnCls = 'min-h-11 px-3 rounded-lg text-sm font-semibold'

  const createCountyOptions = farmId ? countiesForFarm(farmId) : []
  const editCountyOptions = editFarmId ? countiesForFarm(editFarmId) : []

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Fields</h1>
        <Link href="/settings/plantings" className="text-sm rounded-lg bg-white border border-slate-300 px-3 min-h-11 inline-flex items-center">
          Manage plantings →
        </Link>
      </div>

      <FarmLinkBanner status={farmLink} noun="Fields" />

      <CsvImport config={fieldsImportConfig()} onImported={refresh} blockedReason={managed ? landImportBlockedMessage('fields') : null} />

      <SettingsDocImport primaryTarget="fields" title="Upload a field list" onSaved={refresh} />

      {managed && (
        <div className="bg-white p-4 rounded-xl shadow text-sm text-slate-600">
          {LAND_MANAGED_MESSAGE} New fields are added in Turnrow Farm and come across from there. Fields marked &ldquo;not linked&rdquo; were created here and can still be edited until you match them in Turnrow Farm.
        </div>
      )}

      {!managed && (
      <form onSubmit={add} className="space-y-3 bg-white p-4 rounded-xl shadow">
        <h2 className="font-semibold">Add a field</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className={labelCls}>
            Field name or number
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. North 40" className={`${inputCls} mt-1`} />
          </label>
          <label className={labelCls}>
            Farm
            <select value={farmId} onChange={(e) => onFarmChange(e.target.value)} className={`${inputCls} mt-1`}>
              <option value="">— no farm yet —</option>
              {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            County
            <select
              value={countyId}
              onChange={(e) => setCountyId(e.target.value)}
              className={`${inputCls} mt-1`}
              disabled={!farmId}
            >
              <option value="">
                {!farmId ? 'pick the farm first' : createCountyOptions.length === 0 ? 'the farm’s entity has no counties yet' : '— county —'}
              </option>
              {createCountyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
          <label className={labelCls}>
            Total acres
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={totalAcres}
              onChange={(e) => setTotalAcres(e.target.value)}
              placeholder="0"
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className={labelCls}>
            Irrigated acres
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={irrigatedAcres}
              onChange={(e) => setIrrigatedAcres(e.target.value)}
              placeholder="0"
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className={labelCls}>
            Dryland acres
            <input
              type="text"
              value={totalAcres === '' && irrigatedAcres === '' ? '' : String(dryFromInputs(totalAcres, irrigatedAcres))}
              readOnly
              tabIndex={-1}
              className={`${readonlyCls} mt-1`}
            />
          </label>
          <button
            disabled={addInvalid}
            className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50"
          >
            Add field
          </button>
        </div>
        {addInvalid && (
          <p className="text-sm text-red-600">
            {irrigatedNegative(irrigatedAcres)
              ? 'Irrigated acres cannot be negative'
              : 'Irrigated acres cannot exceed total acres'}
          </p>
        )}
      </form>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          aria-label="Search fields"
          placeholder="Search fields…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 min-h-11 flex-1 min-w-[12rem]"
        />
        <label className="text-sm flex items-center gap-2">
          Farm
          <select
            value={farmFilter}
            onChange={(e) => setFarmFilter(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 min-h-11"
          >
            <option value="">All farms</option>
            {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <select
          value={sortKey}
          aria-label="Sort by"
          onChange={(e) => setSortKey(e.target.value as 'name' | 'farm' | 'acres' | 'county')}
          className="text-sm rounded-lg border border-slate-300 px-3 py-2 min-h-11"
        >
          <option value="name">Sort: Name</option>
          <option value="farm">Sort: Farm</option>
          <option value="county">Sort: County</option>
          <option value="acres">Sort: Acres</option>
        </select>
        <button
          type="button"
          aria-label={sortDir === 'asc' ? 'Sorted ascending — switch to descending' : 'Sorted descending — switch to ascending'}
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          className="text-sm rounded-lg bg-white border border-slate-300 px-3 min-h-11 min-w-11"
        >
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {(() => {
        const visible = fields
          .filter((f) => {
            if (farmFilter && f.farm_id !== farmFilter) return false
            if (!q) return true
            const hay = [
              f.name_or_number,
              farmName(f.farm_id),
              countyLabel(f.county_id),
              f.total_acres != null ? String(f.total_acres) : '',
            ].join(' ').toLowerCase()
            return hay.includes(q.toLowerCase())
          })
          .sort((a, b) => {
            const dir = sortDir === 'asc' ? 1 : -1
            if (sortKey === 'farm') return dir * (farmName(a.farm_id) || '').localeCompare(farmName(b.farm_id) || '')
            if (sortKey === 'county') return dir * (countyLabel(a.county_id) || '').localeCompare(countyLabel(b.county_id) || '')
            if (sortKey === 'acres') {
              const av = a.total_acres ?? -1; const bv = b.total_acres ?? -1
              return dir * (Number(av) - Number(bv))
            }
            return dir * a.name_or_number.localeCompare(b.name_or_number)
          })
        return (
      <div className="space-y-2">
      <p className="text-sm text-slate-500">
        {visible.length} of {fields.length} field{fields.length === 1 ? '' : 's'}
        {' · '}{farmFilter ? (farmById.get(farmFilter)?.name ?? 'Farm') : 'All farms'}
      </p>
      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              <th className="text-left px-3 py-2">Field</th>
              <th className="text-left px-3 py-2">Farm</th>
              <th className="text-left px-3 py-2">County</th>
              <th className="text-right px-3 py-2">Total ac</th>
              <th className="text-right px-3 py-2">Irrigated ac</th>
              <th className="text-right px-3 py-2">Dryland ac</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                {fields.length === 0
                  ? (managed ? 'No fields yet — they arrive from Turnrow Farm on its next update.' : 'No fields yet — add the first one above, or upload a field list.')
                  : farmFilter ? 'No fields on that farm match. Try “All farms”.' : 'No fields match that search.'}
              </td></tr>
            )}
            {visible.map((f) => {
              const fieldPlantings = plantings.filter((p) => p.field_id === f.id)
              const isExpanded = expandedId === f.id
              const isEditing = editingId === f.id
              const editOptions = isEditing ? editCountyOptions : []
              return (
                <Fragment key={f.id}>
                  <tr className="border-t border-slate-100 align-top">
                    {isEditing ? (
                      <td colSpan={7} className="px-3 py-3">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                          <label className={labelCls}>
                            Field name or number
                            <input value={editName} onChange={(e) => setEditName(e.target.value)} className={`${inputCls} mt-1`} />
                          </label>
                          <label className={labelCls}>
                            Farm
                            <select value={editFarmId} onChange={(e) => onEditFarmChange(e.target.value)} className={`${inputCls} mt-1`}>
                              <option value="">— no farm —</option>
                              {farms.map((fm) => <option key={fm.id} value={fm.id}>{fm.name}</option>)}
                            </select>
                          </label>
                          <label className={labelCls}>
                            County
                            <select
                              value={editCountyId}
                              onChange={(e) => setEditCountyId(e.target.value)}
                              className={`${inputCls} mt-1`}
                              disabled={!editFarmId}
                            >
                              <option value="">
                                {!editFarmId ? 'pick the farm first' : editOptions.length === 0 ? 'no counties on that farm’s entity' : '— county —'}
                              </option>
                              {editOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
                            </select>
                          </label>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mb-2">
                          <label className={labelCls}>
                            Total acres
                            <input
                              type="number"
                              inputMode="decimal"
                              step="0.01"
                              min="0"
                              value={editAcres}
                              onChange={(e) => setEditAcres(e.target.value)}
                              placeholder="0"
                              className={`${inputCls} mt-1`}
                            />
                          </label>
                          <label className={labelCls}>
                            Irrigated acres
                            <input
                              type="number"
                              inputMode="decimal"
                              step="0.01"
                              min="0"
                              value={editIrrigated}
                              onChange={(e) => setEditIrrigated(e.target.value)}
                              placeholder="0"
                              className={`${inputCls} mt-1`}
                            />
                          </label>
                          <label className={labelCls}>
                            Dryland acres
                            <input
                              type="text"
                              value={editAcres === '' && editIrrigated === '' ? '' : String(dryFromInputs(editAcres, editIrrigated))}
                              readOnly
                              tabIndex={-1}
                              className={`${readonlyCls} mt-1`}
                            />
                          </label>
                        </div>
                        {editInvalid && (
                          <p className="text-sm text-red-600 mb-2">
                            {irrigatedNegative(editIrrigated)
                              ? 'Irrigated acres cannot be negative'
                              : 'Irrigated acres cannot exceed total acres'}
                          </p>
                        )}
                        <div className="flex gap-2 justify-end">
                          <button type="button" onClick={() => setEditingId(null)} className={`${btnCls} border border-slate-300 bg-white text-slate-700`}>Cancel</button>
                          <button
                            type="button"
                            onClick={() => save(f.id)}
                            disabled={editInvalid}
                            className={`${btnCls} bg-brand hover:bg-brand-deep text-white px-4 disabled:opacity-50`}
                          >Save</button>
                        </div>
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-2">{f.name_or_number}{managed && (canEdit(f) ? <NotLinkedChip /> : <ManagedChip />)}</td>
                        <td className="px-3 py-2 text-slate-500">{farmName(f.farm_id)}</td>
                        <td className="px-3 py-2 text-slate-500">{countyLabel(f.county_id)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {f.total_acres != null ? Number(f.total_acres).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {Number(f.irrigated_acres) > 0 ? Number(f.irrigated_acres).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {Number(f.dryland_acres) > 0 ? Number(f.dryland_acres).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}
                        </td>
                        <td className="px-1 py-1 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : f.id)}
                            className={`${btnCls} text-slate-600 font-normal`}
                          >
                            {isExpanded ? 'Hide' : `Plantings (${fieldPlantings.length})`}
                          </button>
                          {!canEdit(f) ? (
                            <span className="text-xs text-slate-400 px-2" title={LAND_MANAGED_MESSAGE}>edit in Turnrow Farm</span>
                          ) : (<>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(f.id)
                              setEditName(f.name_or_number)
                              setEditFarmId(f.farm_id ?? '')
                              setEditCountyId(f.county_id ?? '')
                              setEditAcres(f.total_acres != null ? String(f.total_acres) : '')
                              setEditIrrigated(Number(f.irrigated_acres) > 0 ? String(f.irrigated_acres) : '')
                            }}
                            className={`${btnCls} text-brand-deep`}
                          >Edit</button>
                          <button type="button" disabled={busyId === f.id} onClick={() => archive(f)} className={`${btnCls} text-slate-600 disabled:opacity-50`}>Archive</button>
                          <button type="button" disabled={busyId === f.id} onClick={() => remove(f)} className={`${btnCls} text-red-600 disabled:opacity-50`}>Delete</button>
                          </>)}
                        </td>
                      </>
                    )}
                  </tr>
                  {!isEditing && isExpanded && (
                    <tr className="bg-slate-50">
                      <td colSpan={7} className="px-3 py-2">
                        {fieldPlantings.length === 0 ? (
                          <p className="text-sm text-slate-500">
                            No plantings recorded for this field yet.{' '}
                            <Link href="/settings/plantings" className="text-brand-deep underline">Add one</Link>.
                          </p>
                        ) : (
                          <table className="w-full text-sm">
                            <thead className="text-slate-500">
                              <tr>
                                <th className="text-left py-1">Year</th>
                                <th className="text-left py-1">Crop</th>
                                <th className="text-right py-1">Acres</th>
                                <th className="text-left py-1">Planted</th>
                                <th className="text-left py-1"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {fieldPlantings.map((p) => (
                                <tr key={p.id} className="border-t border-slate-100">
                                  <td className="py-1">{p.season_year}</td>
                                  <td className="py-1">{cropName(p.crop_id)}</td>
                                  <td className="py-1 text-right tabular-nums">{Number(p.planted_acres).toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                                  <td className="py-1">{p.planting_date ?? ''}</td>
                                  <td className="py-1">
                                    {doubleCropIds.has(p.id) && (
                                      <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">double-crop</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      </div>
      ) })()}
      {dialogs}
    </div>
  )
}
