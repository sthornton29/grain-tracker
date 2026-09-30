'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { entitiesImportConfig } from '@/lib/import-configs'
import SettingsDocImport from '@/components/settings-doc-import'
import { useFarmLink } from '@/lib/use-farm-link'
import { landImportBlockedMessage, landRowEditable, LAND_MANAGED_MESSAGE } from '@/lib/farm-link'
import { FarmLinkBanner, ManagedChip, NotLinkedChip } from '@/components/farm-link-banner'
import { reportError } from '@/lib/friendly-error'
import { useDialogs, plural } from '@/components/use-dialogs'
import type { Entity, County, EntityCounty } from '@/lib/types'

type Role = 'farming' | 'marketing_agent'
type Form = { name: string; notes: string; persons: string; role: Role }
const empty: Form = { name: '', notes: '', persons: '1', role: 'farming' }

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
  const { confirm, dialogs } = useDialogs()
  // 087: managed in Turnrow Farm → rows that came from there are read-only here.
  const farmLink = useFarmLink(supabase, 'entities')
  const managed = farmLink.managed
  const canEdit = (row: Entity) => landRowEditable(row, managed)

  async function refresh() {
    const [en, co, ec] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entity_counties').select('*'),
    ])
    if (en.error) { setErr(reportError(en.error, { action: 'load your entities', noun: 'entity' })); return }
    // Archived by the Turnrow Farm link (087) → out of the list.
    setRows(((en.data as Entity[]) || []).filter((r) => !r.archived_at))
    setCounties((co.data as County[]) || [])
    setEntityCounties((ec.data as EntityCounty[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  // entity_role arrives with migration 051 — before it, hide the role UI and
  // save without the column so nothing breaks.
  const roleSupported = rows.length === 0 || 'entity_role' in rows[0]
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
    if (managed) { setErr(`${LAND_MANAGED_MESSAGE} Add the entity in Turnrow Farm.`); return }
    if (!form.name.trim()) return
    if (rows.some((r) => r.name.trim().toLowerCase() === form.name.trim().toLowerCase())) { setErr(`An entity named “${form.name.trim()}” already exists.`); return }
    if (formCountyIds.size === 0) {
      setErr('Select at least one county before saving.')
      return
    }
    const persons = parsePersons(form.persons)
    if (persons == null) { setErr('Payment-limit persons must be a whole number of at least 1.'); return }
    const payload: Record<string, unknown> = { name: form.name.trim(), notes: form.notes.trim() || null, payment_limit_persons: persons }
    if (roleSupported) payload.entity_role = form.role
    const { data, error } = await supabase
      .from('entities')
      .insert(payload)
      .select('id')
      .single()
    if (error) { setErr(reportError(error, { action: 'add the entity', noun: 'entity', name: form.name.trim() })); return }
    try {
      await syncEntityCounties((data as { id: string }).id, formCountyIds)
    } catch (e) {
      setErr(reportError(e as Error, { action: 'save the entity’s counties', noun: 'county' })); return
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
    const payload: Record<string, unknown> = {
      name: editForm.name.trim(),
      notes: editForm.notes.trim() || null,
      payment_limit_persons: persons,
    }
    if (roleSupported) payload.entity_role = editForm.role
    if (rows.some((r) => r.id !== id && r.name.trim().toLowerCase() === editForm.name.trim().toLowerCase())) { setErr(`An entity named “${editForm.name.trim()}” already exists.`); return }
    const { error } = await supabase.from('entities').update(payload).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'save the entity', noun: 'entity', name: editForm.name.trim() })); return }
    try {
      await syncEntityCounties(id, editCountyIds)
    } catch (e) {
      setErr(reportError(e as Error, { action: 'save the entity’s counties', noun: 'county' })); return
    }
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(en: Entity) {
    setErr(null)
    const [fa, lo] = await Promise.all([
      supabase.from('farms').select('id', { count: 'exact', head: true }).eq('entity_id', en.id),
      supabase.from('loads').select('id', { count: 'exact', head: true }).eq('entity_id', en.id),
    ])
    const farms = fa.count ?? 0
    const loads = lo.count ?? 0
    if (loads > 0) {
      setErr(`${en.name} has ${plural(loads, 'load')} recorded against it, so it can’t be deleted. Rename it if the name is wrong.`)
      return
    }
    const ok = await confirm({
      title: `Delete ${en.name}?`,
      body: farms > 0
        ? `${plural(farms, 'farm')} will be left without an entity — they aren’t deleted, but reports group by entity, so reassign them afterwards. This can’t be undone.`
        : 'Nothing points at this entity yet, so it can be removed. This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const { error } = await supabase.from('entities').delete().eq('id', en.id)
    if (error) { setErr(reportError(error, { action: 'delete the entity', noun: 'entity', name: en.name })); return }
    refresh()
  }

  function startEdit(e: Entity) {
    setEditingId(e.id)
    setEditForm({
      name: e.name, notes: e.notes ?? '', persons: String(e.payment_limit_persons ?? 1),
      role: e.entity_role === 'marketing_agent' ? 'marketing_agent' : 'farming',
    })
    setEditCountyIds(new Set(entityCountyIds.get(e.id) ?? []))
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full'
  const labelCls = 'block text-sm text-slate-700'
  const btnCls = 'min-h-11 px-3 rounded-lg text-sm font-semibold'

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

      <FarmLinkBanner status={farmLink} noun="Entities" />

      <SettingsDocImport primaryTarget="entities" title="Upload a document with your entities" onSaved={refresh} />

      <CsvImport config={entitiesImportConfig()} onImported={refresh} blockedReason={managed ? landImportBlockedMessage('entities') : null} />

      {managed && (
        <div className="bg-white p-4 rounded-xl shadow text-sm text-slate-600">
          {LAND_MANAGED_MESSAGE} New entities are added in Turnrow Farm and come across from there. County assignments and the payment-limit persons stay editable here on every entity.
        </div>
      )}

      <form onSubmit={add} className="space-y-3 bg-white p-4 rounded-xl shadow">
        <h2 className="font-semibold">Add an entity</h2>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
          <label className={labelCls}>
            Entity name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Prairie Farms LLC"
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className={labelCls}>
            Notes <span className="text-slate-400">(optional)</span>
            <input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>
        <label className="text-sm flex items-center gap-2 flex-wrap">
          <span className="font-semibold">Payment-limit persons</span>
          <input
            type="number" min="1" step="1"
            value={form.persons}
            onChange={(e) => setForm({ ...form, persons: e.target.value })}
            className={`${inputCls} w-20`}
            aria-label="Payment-limit persons"
          />
          <span className="text-slate-500">
            Eligible persons for FSA payment limits — total ARC/PLC limit = persons × the program year&apos;s
            per-person limit (Program Parameters). Set once; edit if the entity&apos;s structure changes.
          </span>
        </label>
        {roleSupported && <RolePicker value={form.role} onChange={(role) => setForm({ ...form, role })} />}
        <div>
          <div className="text-sm font-semibold mb-1">Counties <span className="text-red-600">*</span></div>
          <CountyMultiPicker
            counties={counties}
            selectedIds={formCountyIds}
            onChange={setFormCountyIds}
          />
        </div>
        <div className="flex justify-end">
          <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">Add entity</button>
        </div>
      </form>

      {!roleSupported && (
        <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
          Entity roles (farming vs marketing agent) aren&rsquo;t available for your account yet — contact support. Once they are, you can
          mark the marketing entity so its contracts and hedges flow down to the farming entities in the
          entity-filtered reports.
        </p>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {rows.length === 0 && <li className="px-4 py-6 text-center text-slate-500">{managed ? 'No entities yet — they arrive from Turnrow Farm on its next update.' : 'No entities yet — add the first one above, or upload your FSA farm records.'}</li>}
        {rows.map((e) => {
          const ids = entityCountyIds.get(e.id) ?? []
          return (
            <li key={e.id} className="px-4 py-3">
              {editingId === e.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
                    <label className={labelCls}>
                      Entity name
                      <input
                        value={editForm.name}
                        onChange={(ev) => setEditForm({ ...editForm, name: ev.target.value })}
                        className={`${inputCls} mt-1`}
                        disabled={!canEdit(e)}
                        title={!canEdit(e) ? `${LAND_MANAGED_MESSAGE} Rename it in Turnrow Farm.` : undefined}
                      />
                    </label>
                    <label className={labelCls}>
                      Notes <span className="text-slate-400">(optional)</span>
                      <input
                        value={editForm.notes}
                        onChange={(ev) => setEditForm({ ...editForm, notes: ev.target.value })}
                        className={`${inputCls} mt-1`}
                      />
                    </label>
                  </div>
                  <label className="text-sm flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">Payment-limit persons</span>
                    <input
                      type="number" min="1" step="1"
                      value={editForm.persons}
                      onChange={(ev) => setEditForm({ ...editForm, persons: ev.target.value })}
                      className={`${inputCls} w-20`}
                      aria-label="Payment-limit persons"
                    />
                    <span className="text-slate-500">× the program year&apos;s per-person limit = the entity&apos;s total ARC/PLC cap.</span>
                  </label>
                  {roleSupported && <RolePicker value={editForm.role} onChange={(role) => setEditForm({ ...editForm, role })} />}
                  <div>
                    <div className="text-sm font-semibold mb-1">Counties <span className="text-red-600">*</span></div>
                    <CountyMultiPicker
                      counties={counties}
                      selectedIds={editCountyIds}
                      onChange={setEditCountyIds}
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setEditingId(null)} className={`${btnCls} border border-slate-300 bg-white text-slate-700`}>Cancel</button>
                    <button type="button" onClick={() => save(e.id)} className={`${btnCls} bg-brand hover:bg-brand-deep text-white px-4`}>Save</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">
                      {e.name}
                      {managed && (canEdit(e) ? <NotLinkedChip /> : <ManagedChip />)}
                      {e.entity_role === 'marketing_agent' && (
                        <span className="ml-2 rounded-full bg-violet-100 text-violet-800 text-xs font-medium px-2 py-0.5 align-middle" title="Markets on behalf of the farming entities — its contracts/hedges flow down by acre share in the entity-filtered reports">
                          marketing agent
                        </span>
                      )}
                    </div>
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
                  <button type="button" onClick={() => startEdit(e)} className={`${btnCls} text-brand-deep`}>{canEdit(e) ? 'Edit' : 'Counties & limits'}</button>
                  {canEdit(e) && <button type="button" onClick={() => remove(e)} className={`${btnCls} text-red-600`}>Delete</button>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {dialogs}
    </div>
  )
}

function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <label className="text-sm flex items-center gap-2 flex-wrap">
      <span className="font-semibold">Role</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Role)}
        className="rounded-lg border border-slate-300 px-3 py-2 bg-white min-h-11"
      >
        <option value="farming">Farming entity</option>
        <option value="marketing_agent">Marketing agent</option>
      </select>
      <span className="text-slate-500">
        A marketing agent is an entity that holds the contracts and hedge account on behalf of your farming entities
        and shifts the income down — in the entity-filtered reports its marketing flows to each farming entity by that
        entity&apos;s acre share of the crop. A farming entity that markets in its own name keeps those contracts whole.
      </span>
    </label>
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

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11'
  const selectedList = [...selectedIds]
    .map((id) => countyById.get(id))
    .filter(Boolean) as County[]
  selectedList.sort((a, b) => a.state_code.localeCompare(b.state_code) || a.name.localeCompare(b.name))

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr_auto] gap-2">
        <select
          value={stateCode}
          aria-label="State"
          onChange={(e) => { setStateCode(e.target.value); setCountyId('') }}
          className={inputCls}
        >
          <option value="">— state —</option>
          {states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
        <select
          value={countyId}
          aria-label="County"
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
          className="rounded-lg bg-sky-700 text-white px-4 min-h-11 font-semibold disabled:opacity-40"
        >
          Add county
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
                className="text-brand-deep hover:text-red-600 font-bold min-h-11 min-w-8 -my-2"
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
