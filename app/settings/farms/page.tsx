'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import type { Entity, Farm, County, EntityCounty } from '@/lib/types'

const LAST_COUNTY_KEY = 'lastFarmCountyId'

export default function FarmsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [farms, setFarms] = useState<Farm[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [entityCounties, setEntityCounties] = useState<EntityCounty[]>([])
  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [countyId, setCountyId] = useState('')
  const [fsaNumber, setFsaNumber] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editEntityId, setEditEntityId] = useState('')
  const [editCountyId, setEditCountyId] = useState('')
  const [editFsaNumber, setEditFsaNumber] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  async function refresh() {
    const [fa, en, co, ec] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entity_counties').select('*'),
    ])
    setFarms((fa.data as Farm[]) || [])
    setEntities((en.data as Entity[]) || [])
    setCounties((co.data as County[]) || [])
    setEntityCounties((ec.data as EntityCounty[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  const entityName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? ''

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

  // Pick a default county when the entity changes on the create form.
  function pickDefaultCounty(eId: string): string {
    if (!eId) return ''
    const list = countiesForEntity.get(eId) ?? []
    if (list.length === 0) return ''
    if (list.length === 1) return list[0].id
    if (typeof window !== 'undefined') {
      const last = sessionStorage.getItem(LAST_COUNTY_KEY)
      if (last && list.some((c) => c.id === last)) return last
    }
    return ''
  }

  function onEntityChange(eId: string) {
    setEntityId(eId)
    setCountyId(pickDefaultCounty(eId))
  }

  function onEditEntityChange(eId: string) {
    setEditEntityId(eId)
    const list = countiesForEntity.get(eId) ?? []
    if (list.length === 1) setEditCountyId(list[0].id)
    else setEditCountyId('')
  }

  function rememberCounty(id: string) {
    if (typeof window !== 'undefined' && id) {
      sessionStorage.setItem(LAST_COUNTY_KEY, id)
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    if (!entityId) { setErr('Pick an entity before saving.'); return }
    if (!countyId) { setErr('Pick a county before saving.'); return }
    const { error } = await supabase.from('farms').insert({
      name: name.trim(),
      entity_id: entityId,
      county_id: countyId,
      fsa_number: fsaNumber.trim() || null,
    })
    if (error) { setErr(error.message); return }
    rememberCounty(countyId)
    setName(''); setFsaNumber(''); setErr(null); refresh()
    // Keep entityId + countyId so the next farm starts in the same county.
  }

  async function save(id: string) {
    if (!editName.trim()) return
    if (!editEntityId) { setErr('Pick an entity before saving.'); return }
    if (!editCountyId) { setErr('Pick a county before saving.'); return }
    const { error } = await supabase.from('farms').update({
      name: editName.trim(),
      entity_id: editEntityId,
      county_id: editCountyId,
      fsa_number: editFsaNumber.trim() || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    rememberCounty(editCountyId)
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this farm? Fields under it will also be deleted.')) return
    const { error } = await supabase.from('farms').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const farmsMissingCounty = farms.filter((f) => !f.county_id).length
  const createCountyList = entityId ? (countiesForEntity.get(entityId) ?? []) : []
  const editCountyList = editEntityId ? (countiesForEntity.get(editEntityId) ?? []) : []

  function countyLabel(c: County) {
    return `${c.name}, ${c.state_code}`
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Farms</h1>

      {farmsMissingCounty > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <strong>{farmsMissingCounty}</strong> farm{farmsMissingCounty === 1 ? '' : 's'} missing county assignments. Please update them.
        </div>
      )}

      <CsvImport
        config={{
          tableName: 'farms',
          uniqueKey: 'name',
          columns: [
            { key: 'name', required: true },
            { key: 'entity_id', label: 'entity', fk: { table: 'entities', matchColumn: 'name' } },
            { key: 'fsa_number', label: 'fsa_number' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="space-y-2 bg-white p-4 rounded-xl shadow">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Farm name"
            className={inputCls}
          />
          <select value={entityId} onChange={(e) => onEntityChange(e.target.value)} className={inputCls}>
            <option value="">— entity —</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px_auto] gap-2">
          {entityId && createCountyList.length === 1 ? (
            <div className={`${inputCls} bg-slate-50 text-slate-600`}>
              {countyLabel(createCountyList[0])}
            </div>
          ) : (
            <select
              value={countyId}
              onChange={(e) => setCountyId(e.target.value)}
              className={inputCls}
              disabled={!entityId}
            >
              <option value="">
                {!entityId
                  ? 'pick entity first'
                  : createCountyList.length === 0
                    ? 'entity has no counties — add some first'
                    : '— county —'}
              </option>
              {createCountyList.map((c) => <option key={c.id} value={c.id}>{countyLabel(c)}</option>)}
            </select>
          )}
          <input
            value={fsaNumber}
            onChange={(e) => setFsaNumber(e.target.value)}
            placeholder="FSA #"
            className={inputCls}
          />
          <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
        </div>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          placeholder="Search farms…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]"
        />
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
        >
          Name {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {(() => {
        const visible = farms
          .filter((f) => {
            if (!q) return true
            const c = f.county_id ? countyById.get(f.county_id) : null
            const hay = [
              f.name,
              entityName(f.entity_id),
              f.fsa_number ?? '',
              c ? `${c.name} ${c.state_code}` : '',
            ].join(' ').toLowerCase()
            return hay.includes(q.toLowerCase())
          })
          .sort((a, b) => (sortDir === 'asc' ? 1 : -1) * a.name.localeCompare(b.name))
        return (
      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && <li className="px-4 py-6 text-center text-slate-400">{farms.length === 0 ? 'No farms yet.' : 'No farms match.'}</li>}
        {visible.map((f) => {
          const c = f.county_id ? countyById.get(f.county_id) : null
          return (
          <li key={f.id} className="px-4 py-2">
            {editingId === f.id ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-2">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className={inputCls}
                  />
                  <select
                    value={editEntityId}
                    onChange={(e) => onEditEntityChange(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">— entity —</option>
                    {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px_auto_auto] gap-2 items-center">
                  {editEntityId && editCountyList.length === 1 ? (
                    <div className={`${inputCls} bg-slate-50 text-slate-600`}>
                      {countyLabel(editCountyList[0])}
                    </div>
                  ) : (
                    <select
                      value={editCountyId}
                      onChange={(e) => setEditCountyId(e.target.value)}
                      className={inputCls}
                      disabled={!editEntityId}
                    >
                      <option value="">
                        {!editEntityId
                          ? 'pick entity first'
                          : editCountyList.length === 0
                            ? 'entity has no counties'
                            : '— county —'}
                      </option>
                      {editCountyList.map((c) => <option key={c.id} value={c.id}>{countyLabel(c)}</option>)}
                    </select>
                  )}
                  <input
                    value={editFsaNumber}
                    onChange={(e) => setEditFsaNumber(e.target.value)}
                    placeholder="FSA #"
                    className={inputCls}
                  />
                  <button onClick={() => save(f.id)} className="text-green-700 font-semibold">Save</button>
                  <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="flex-1">
                  {f.name}
                  {f.entity_id && <span className="text-slate-400 text-sm"> · {entityName(f.entity_id)}</span>}
                  {c
                    ? <span className="text-slate-400 text-sm"> · {countyLabel(c)}</span>
                    : <span className="text-amber-700 text-sm"> · no county</span>}
                  {f.fsa_number && <span className="text-slate-400 text-sm"> · FSA #{f.fsa_number}</span>}
                </span>
                <button
                  onClick={() => {
                    setEditingId(f.id)
                    setEditName(f.name)
                    setEditEntityId(f.entity_id ?? '')
                    setEditCountyId(f.county_id ?? '')
                    setEditFsaNumber(f.fsa_number ?? '')
                  }}
                  className="text-sky-700"
                >Edit</button>
                <button onClick={() => remove(f.id)} className="text-red-600">Delete</button>
              </div>
            )}
          </li>
          )
        })}
      </ul>
      ) })()}
    </div>
  )
}
