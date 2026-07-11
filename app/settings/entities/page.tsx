'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import type { Entity, County, EntityCounty } from '@/lib/types'

type Form = { name: string; notes: string; persons: string }
const empty: Form = { name: '', notes: '', persons: '1' }

function parsePersons(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : null
}

export default function EntitiesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Entity[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [entityCounties, setEntityCounties] = useState<EntityCounty[]>([])
  const [form, setForm] = useState<Form>(empty)
  const [formCountyIds, setFormCountyIds] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Form>(empty)
  const [editCountyIds, setEditCountyIds] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const [en, co, ec] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entity_counties').select('*'),
    ])
    if (en.error) { setErr(en.error.message); return }
    setRows((en.data as Entity[]) || [])
    setCounties((co.data as County[]) || [])
    setEntityCounties((ec.data as EntityCounty[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  const entityCountyIds = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const ec of entityCounties) {
      const list = m.get(ec.entity_id) ?? []
      list.push(ec.county_id)
      m.set(ec.entity_id, list)
    }
    return m
  }, [entityCounties])

  async function syncEntityCounties(entityId: string, nextIds: Set<string>) {
    const existing = new Set(entityCountyIds.get(entityId) ?? [])
    const toAdd = [...nextIds].filter((id) => !existing.has(id))
    const toRemove = [...existing].filter((id) => !nextIds.has(id))
    if (toAdd.length) {
      const { error } = await supabase.from('entity_counties').insert(
        toAdd.map((county_id) => ({ entity_id: entityId, county_id })),
      )
      if (error) throw new Error(error.message)
    }
    if (toRemove.length) {
      const { error } = await supabase
        .from('entity_counties')
        .delete()
        .eq('entity_id', entityId)
        .in('county_id', toRemove)
      if (error) throw new Error(error.message)
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    if (formCountyIds.size === 0) {
      setErr('Select at least one county before saving.')
      return
    }
    const persons = parsePersons(form.persons)
    if (persons == null) { setErr('Payment-limit persons must be a whole number of at least 1.'); return }
    const { data, error } = await supabase
      .from('entities')
      .insert({ name: form.name.trim(), notes: form.notes.trim() || null, payment_limit_persons: persons })
      .select('id')
      .single()
    if (error) { setErr(error.message); return }
    try {
      await syncEntityCounties((data as { id: string }).id, formCountyIds)
    } catch (e) {
      setErr((e as Error).message); return
    }
    setForm(empty); setFormCountyIds(new Set()); setErr(null); refresh()
  }

  async function save(id: string) {
    if (!editForm.name.trim()) return
    if (editCountyIds.size === 0) {
      setErr('Select at least one county before saving.')
      return
    }
    const persons = parsePersons(editForm.persons)
    if (persons == null) { setErr('Payment-limit persons must be a whole number of at least 1.'); return }
    const { error } = await supabase.from('entities').update({
      name: editForm.name.trim(),
      notes: editForm.notes.trim() || null,
      payment_limit_persons: persons,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    try {
      await syncEntityCounties(id, editCountyIds)
    } catch (e) {
      setErr((e as Error).message); return
    }
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this entity? Farms will be unassigned but not deleted.')) return
    const { error } = await supabase.from('entities').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  function startEdit(e: Entity) {
    setEditingId(e.id)
    setEditForm({ name: e.name, notes: e.notes ?? '', persons: String(e.payment_limit_persons ?? 1) })
    setEditCountyIds(new Set(entityCountyIds.get(e.id) ?? []))
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  function renderCountyList(ids: Iterable<string>) {
    const list = [...ids]
      .map((id) => countyById.get(id))
      .filter(Boolean) as County[]
    list.sort((a, b) => a.state_code.localeCompare(b.state_code) || a.name.localeCompare(b.name))
    return list
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Entities</h1>
      <p className="text-sm text-slate-500">
        Farming business entities (LLCs, partnerships, corporations) that own or operate the farms.
      </p>

      <CsvImport
        config={{
          tableName: 'entities',
          uniqueKey: 'name',
          columns: [
            { key: 'name', required: true },
            { key: 'notes' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="space-y-3 bg-white p-4 rounded-xl shadow">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Entity name"
            className={inputCls}
          />
          <input
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Notes (optional)"
            className={inputCls}
          />
        </div>
        <label className="text-sm flex items-center gap-2 flex-wrap">
          <span className="font-semibold">Payment-limit persons</span>
          <input
            type="number" min="1" step="1"
            value={form.persons}
            onChange={(e) => setForm({ ...form, persons: e.target.value })}
            className={`${inputCls} w-20`}
          />
          <span className="text-slate-500">
            Eligible persons for FSA payment limits — total ARC/PLC limit = persons × the program year&apos;s
            per-person limit (Program Parameters). Set once; edit if the entity&apos;s structure changes.
          </span>
        </label>
        <div>
          <div className="text-sm font-semibold mb-1">Counties <span className="text-red-600">*</span></div>
          <CountyMultiPicker
            counties={counties}
            selectedIds={formCountyIds}
            onChange={setFormCountyIds}
          />
        </div>
        <div className="flex justify-end">
          <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add Entity</button>
        </div>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {rows.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No entities yet.</li>}
        {rows.map((e) => {
          const ids = entityCountyIds.get(e.id) ?? []
          return (
            <li key={e.id} className="px-4 py-3">
              {editingId === e.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
                    <input
                      value={editForm.name}
                      onChange={(ev) => setEditForm({ ...editForm, name: ev.target.value })}
                      className={inputCls}
                    />
                    <input
                      value={editForm.notes}
                      onChange={(ev) => setEditForm({ ...editForm, notes: ev.target.value })}
                      className={inputCls}
                      placeholder="Notes"
                    />
                  </div>
                  <label className="text-sm flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">Payment-limit persons</span>
                    <input
                      type="number" min="1" step="1"
                      value={editForm.persons}
                      onChange={(ev) => setEditForm({ ...editForm, persons: ev.target.value })}
                      className={`${inputCls} w-20`}
                    />
                    <span className="text-slate-500">× the program year&apos;s per-person limit = the entity&apos;s total ARC/PLC cap.</span>
                  </label>
                  <div>
                    <div className="text-sm font-semibold mb-1">Counties <span className="text-red-600">*</span></div>
                    <CountyMultiPicker
                      counties={counties}
                      selectedIds={editCountyIds}
                      onChange={setEditCountyIds}
                    />
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => save(e.id)} className="text-green-700 font-semibold">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">{e.name}</div>
                    {e.notes && <div className="text-sm text-slate-500">{e.notes}</div>}
                    <div className="text-sm text-slate-500">
                      Payment limit: {e.payment_limit_persons ?? 1} person{(e.payment_limit_persons ?? 1) === 1 ? '' : 's'} × the program year&apos;s per-person limit
                    </div>
                    <div className="text-sm text-slate-500 mt-1">
                      {ids.length === 0 ? (
                        <span className="text-amber-700">No counties assigned</span>
                      ) : (
                        renderCountyList(ids)
                          .map((c) => `${c.name}, ${c.state_code}`)
                          .join(' · ')
                      )}
                    </div>
                  </div>
                  <button onClick={() => startEdit(e)} className="text-sky-700">Edit</button>
                  <button onClick={() => remove(e.id)} className="text-red-600">Delete</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CountyMultiPicker({
  counties,
  selectedIds,
  onChange,
}: {
  counties: County[]
  selectedIds: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [stateCode, setStateCode] = useState('')
  const [countyId, setCountyId] = useState('')

  const states = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of counties) if (!seen.has(c.state_code)) seen.set(c.state_code, c.state)
    return [...seen.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [counties])

  const inState = useMemo(
    () => counties.filter((c) => c.state_code === stateCode && !selectedIds.has(c.id)),
    [counties, stateCode, selectedIds],
  )

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])

  function addCounty() {
    if (!countyId) return
    const next = new Set(selectedIds)
    next.add(countyId)
    onChange(next)
    setCountyId('')
  }
  function removeCounty(id: string) {
    const next = new Set(selectedIds)
    next.delete(id)
    onChange(next)
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const selectedList = [...selectedIds]
    .map((id) => countyById.get(id))
    .filter(Boolean) as County[]
  selectedList.sort((a, b) => a.state_code.localeCompare(b.state_code) || a.name.localeCompare(b.name))

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr_auto] gap-2">
        <select
          value={stateCode}
          onChange={(e) => { setStateCode(e.target.value); setCountyId('') }}
          className={inputCls}
        >
          <option value="">— state —</option>
          {states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
        <select
          value={countyId}
          onChange={(e) => setCountyId(e.target.value)}
          className={inputCls}
          disabled={!stateCode}
        >
          <option value="">{stateCode ? '— county —' : 'pick state first'}</option>
          {inState.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button
          type="button"
          onClick={addCounty}
          disabled={!countyId}
          className="rounded-lg bg-sky-700 text-white px-4 py-2 font-semibold disabled:opacity-40"
        >
          Add
        </button>
      </div>
      {selectedList.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedList.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 border border-sky-200 px-3 py-1 text-sm"
            >
              <span>{c.name}, {c.state_code}</span>
              <button
                type="button"
                onClick={() => removeCounty(c.id)}
                className="text-sky-700 hover:text-red-600 font-bold"
                aria-label={`Remove ${c.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
