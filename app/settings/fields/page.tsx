'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { buildDoubleCropSoySet } from '@/lib/plantings'
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
  const [sortKey, setSortKey] = useState<'name' | 'farm' | 'acres' | 'county'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  async function refresh() {
    const [fa, fi, cr, pl, co, ec] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('fields').select('*').order('name_or_number'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('field_plantings').select('*').order('season_year', { ascending: false }),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entity_counties').select('*'),
    ])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
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

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    if (addInvalid) return
    const total = parseAcres(totalAcres)
    const irr = parseAcres(irrigatedAcres) ?? 0
    const dry = total != null ? Math.max(0, total - irr) : 0
    const { error } = await supabase.from('fields').insert({
      name_or_number: name.trim(),
      farm_id: farmId || null,
      county_id: countyId || null,
      total_acres: total,
      irrigated_acres: irr,
      dryland_acres: dry,
    })
    if (error) { setErr(error.message); return }
    setName(''); setTotalAcres(''); setIrrigatedAcres(''); setErr(null); refresh()
    // Keep farmId + countyId so adding a sibling field is one-click.
  }

  async function save(id: string) {
    if (editInvalid) return
    const total = parseAcres(editAcres)
    const irr = parseAcres(editIrrigated) ?? 0
    const dry = total != null ? Math.max(0, total - irr) : 0
    const { error } = await supabase.from('fields').update({
      name_or_number: editName.trim(),
      farm_id: editFarmId || null,
      county_id: editCountyId || null,
      total_acres: total,
      irrigated_acres: irr,
      dryland_acres: dry,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this field? All of its plantings will also be deleted.')) return
    const { error } = await supabase.from('fields').delete().eq('id', id)
    if (error) { setErr(error.message); return }
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
  const doubleCropSoyIds = useMemo(
    () => buildDoubleCropSoySet(plantings, cropById),
    [plantings, cropById],
  )
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const readonlyCls = 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600'

  const createCountyOptions = farmId ? countiesForFarm(farmId) : []
  const editCountyOptions = editFarmId ? countiesForFarm(editFarmId) : []

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Fields</h1>
        <Link href="/settings/plantings" className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
          Manage plantings →
        </Link>
      </div>

      <CsvImport
        config={{
          tableName: 'fields',
          uniqueKey: 'name_or_number',
          columns: [
            { key: 'name_or_number', label: 'name', required: true },
            { key: 'farm_id', label: 'farm', fk: { table: 'farms', matchColumn: 'name' } },
            { key: 'total_acres', type: 'number' },
            { key: 'irrigated_acres', type: 'number' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Field name or number"
            className={inputCls}
          />
          <select value={farmId} onChange={(e) => onFarmChange(e.target.value)} className={inputCls}>
            <option value="">— farm (optional) —</option>
            {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select
            value={countyId}
            onChange={(e) => setCountyId(e.target.value)}
            className={inputCls}
            disabled={!farmId}
          >
            <option value="">
              {!farmId ? 'pick farm first' : createCountyOptions.length === 0 ? 'farm entity has no counties' : '— county —'}
            </option>
            {createCountyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-start">
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Total acres
            <input
              type="number"
              step="0.01"
              min="0"
              value={totalAcres}
              onChange={(e) => setTotalAcres(e.target.value)}
              placeholder="0"
              className={inputCls}
            />
          </label>
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Irrigated acres
            <input
              type="number"
              step="0.01"
              min="0"
              value={irrigatedAcres}
              onChange={(e) => setIrrigatedAcres(e.target.value)}
              placeholder="0"
              className={inputCls}
            />
          </label>
          <label className="text-xs text-slate-500 flex flex-col gap-1">
            Dryland acres
            <input
              type="text"
              value={totalAcres === '' && irrigatedAcres === '' ? '' : String(dryFromInputs(totalAcres, irrigatedAcres))}
              readOnly
              tabIndex={-1}
              className={readonlyCls}
            />
          </label>
          <button
            disabled={addInvalid}
            className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold self-end disabled:opacity-50"
          >
            Add
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

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          placeholder="Search fields…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as 'name' | 'farm' | 'acres' | 'county')}
          className="text-sm rounded-lg border border-slate-300 px-3 py-2"
        >
          <option value="name">Sort: Name</option>
          <option value="farm">Sort: Farm</option>
          <option value="county">Sort: County</option>
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

      {(() => {
        const visible = fields
          .filter((f) => {
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
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                {fields.length === 0 ? 'No fields yet.' : 'No fields match.'}
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
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className={inputCls}
                          />
                          <select
                            value={editFarmId}
                            onChange={(e) => onEditFarmChange(e.target.value)}
                            className={inputCls}
                          >
                            <option value="">— no farm —</option>
                            {farms.map((fm) => <option key={fm.id} value={fm.id}>{fm.name}</option>)}
                          </select>
                          <select
                            value={editCountyId}
                            onChange={(e) => setEditCountyId(e.target.value)}
                            className={inputCls}
                            disabled={!editFarmId}
                          >
                            <option value="">
                              {!editFarmId ? 'pick farm' : editOptions.length === 0 ? 'no counties' : '— county —'}
                            </option>
                            {editOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
                          </select>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mb-2">
                          <label className="text-xs text-slate-500 flex flex-col gap-1">
                            Total acres
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editAcres}
                              onChange={(e) => setEditAcres(e.target.value)}
                              placeholder="0"
                              className={inputCls}
                            />
                          </label>
                          <label className="text-xs text-slate-500 flex flex-col gap-1">
                            Irrigated acres
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editIrrigated}
                              onChange={(e) => setEditIrrigated(e.target.value)}
                              placeholder="0"
                              className={inputCls}
                            />
                          </label>
                          <label className="text-xs text-slate-500 flex flex-col gap-1">
                            Dryland acres
                            <input
                              type="text"
                              value={editAcres === '' && editIrrigated === '' ? '' : String(dryFromInputs(editAcres, editIrrigated))}
                              readOnly
                              tabIndex={-1}
                              className={readonlyCls}
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
                        <div className="flex gap-3">
                          <button
                            onClick={() => save(f.id)}
                            disabled={editInvalid}
                            className="text-green-700 font-semibold disabled:opacity-50"
                          >Save</button>
                          <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                        </div>
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-2">{f.name_or_number}</td>
                        <td className="px-3 py-2 text-slate-500">{farmName(f.farm_id)}</td>
                        <td className="px-3 py-2 text-slate-500">{countyLabel(f.county_id)}</td>
                        <td className="px-3 py-2 text-right">
                          {f.total_acres != null ? Number(f.total_acres) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {Number(f.irrigated_acres) > 0 ? Number(f.irrigated_acres) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {Number(f.dryland_acres) > 0 ? Number(f.dryland_acres) : '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : f.id)}
                            className="text-slate-600 text-sm mr-3"
                          >
                            {isExpanded ? 'Hide' : `Plantings (${fieldPlantings.length})`}
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(f.id)
                              setEditName(f.name_or_number)
                              setEditFarmId(f.farm_id ?? '')
                              setEditCountyId(f.county_id ?? '')
                              setEditAcres(f.total_acres != null ? String(f.total_acres) : '')
                              setEditIrrigated(Number(f.irrigated_acres) > 0 ? String(f.irrigated_acres) : '')
                            }}
                            className="text-sky-700 mr-3"
                          >Edit</button>
                          <button onClick={() => remove(f.id)} className="text-red-600">Delete</button>
                        </td>
                      </>
                    )}
                  </tr>
                  {!isEditing && isExpanded && (
                    <tr className="bg-slate-50">
                      <td colSpan={7} className="px-3 py-2">
                        {fieldPlantings.length === 0 ? (
                          <p className="text-sm text-slate-400">
                            No plantings recorded.{' '}
                            <Link href="/settings/plantings" className="text-sky-700 underline">Add one</Link>.
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
                                  <td className="py-1 text-right">{Number(p.planted_acres)}</td>
                                  <td className="py-1">{p.planting_date ?? ''}</td>
                                  <td className="py-1">
                                    {doubleCropSoyIds.has(p.id) && (
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
      ) })()}
    </div>
  )
}
