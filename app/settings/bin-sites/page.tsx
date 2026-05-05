'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import type {
  Bin, BinSite, Crop, Entity, County, EntityCounty, BinInventoryAdjustment,
} from '@/lib/types'

type Form = {
  name: string
  entityId: string
  countyId: string
  address: string
  notes: string
}
const empty: Form = { name: '', entityId: '', countyId: '', address: '', notes: '' }

type LoadRow = {
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  from_type: string | null
  from_bin_id: string | null
  to_type: string | null
  to_bin_id: string | null
}

function fmtBu(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function BinSitesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [sites, setSites] = useState<BinSite[]>([])
  const [bins, setBins] = useState<Bin[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [entityCounties, setEntityCounties] = useState<EntityCounty[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [adjustments, setAdjustments] = useState<BinInventoryAdjustment[]>([])
  const [form, setForm] = useState<Form>(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Form>(empty)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const today = new Date().toISOString().slice(0, 10)
    const [si, bi, en, co, ec, cr, lo, ad] = await Promise.all([
      supabase.from('bin_sites').select('*').order('name'),
      supabase.from('bins').select('*').order('name_or_number'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entity_counties').select('*'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('loads').select('net_weight, moisture, crop_id, dry_bushels_override, from_type, from_bin_id, to_type, to_bin_id'),
      supabase.from('bin_inventory_adjustments').select('*').lte('as_of_date', today),
    ])
    setSites((si.data as BinSite[]) || [])
    setBins((bi.data as Bin[]) || [])
    setEntities((en.data as Entity[]) || [])
    setCounties((co.data as County[]) || [])
    setEntityCounties((ec.data as EntityCounty[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setLoads((lo.data as LoadRow[]) || [])
    setAdjustments((ad.data as BinInventoryAdjustment[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])
  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
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

  // bin_id -> total dry bushels on hand
  const bushelsByBin = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of loads) {
      if (!l.crop_id) continue
      const crop = cropById.get(l.crop_id)
      const { dryBushels } = computeBushels({
        netWeightLb: l.net_weight,
        moisturePct: l.moisture,
        baseMoisturePct: crop?.base_moisture_pct ?? null,
        baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
        dryBushelsOverride: l.dry_bushels_override,
      })
      if (!dryBushels) continue
      if (l.to_type === 'bin' && l.to_bin_id) m.set(l.to_bin_id, (m.get(l.to_bin_id) ?? 0) + dryBushels)
      if (l.from_type === 'bin' && l.from_bin_id) m.set(l.from_bin_id, (m.get(l.from_bin_id) ?? 0) - dryBushels)
    }
    for (const a of adjustments) {
      const sign = a.adjustment_type === 'beginning_inventory' ? 1 : -1
      m.set(a.bin_id, (m.get(a.bin_id) ?? 0) + sign * Number(a.bushels))
    }
    return m
  }, [loads, adjustments, cropById])

  const binsBySite = useMemo(() => {
    const m = new Map<string, Bin[]>()
    for (const b of bins) {
      if (!b.bin_site_id) continue
      const list = m.get(b.bin_site_id) ?? []
      list.push(b)
      m.set(b.bin_site_id, list)
    }
    for (const [, list] of m) list.sort((a, b) => a.name_or_number.localeCompare(b.name_or_number))
    return m
  }, [bins])

  const unsited = useMemo(() => bins.filter((b) => !b.bin_site_id), [bins])

  function validate(f: Form): string | null {
    if (!f.name.trim()) return 'Name is required.'
    if (!f.entityId) return 'Entity is required.'
    return null
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const v = validate(form)
    if (v) { setErr(v); return }
    const { error } = await supabase.from('bin_sites').insert({
      name: form.name.trim(),
      entity_id: form.entityId,
      county_id: form.countyId || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
    })
    if (error) { setErr(error.message); return }
    setForm(empty); setErr(null); refresh()
  }

  async function save(id: string) {
    const v = validate(editForm)
    if (v) { setErr(v); return }
    const { error } = await supabase.from('bin_sites').update({
      name: editForm.name.trim(),
      entity_id: editForm.entityId,
      county_id: editForm.countyId || null,
      address: editForm.address.trim() || null,
      notes: editForm.notes.trim() || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(id: string) {
    const list = binsBySite.get(id) ?? []
    if (list.length > 0) {
      if (!confirm(`Delete this site? ${list.length} bin${list.length === 1 ? '' : 's'} will be unassigned.`)) return
    } else {
      if (!confirm('Delete this site?')) return
    }
    const { error } = await supabase.from('bin_sites').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'
  const formCountyOptions = form.entityId ? (countiesForEntity.get(form.entityId) ?? []) : []
  const editCountyOptions = editForm.entityId ? (countiesForEntity.get(editForm.entityId) ?? []) : []

  function siteStats(siteId: string) {
    const list = binsBySite.get(siteId) ?? []
    const total = list.reduce((s, b) => s + (bushelsByBin.get(b.id) ?? 0), 0)
    return { count: list.length, total }
  }

  const hasDefaultSite = sites.some((s) => s.name === 'Default Site')

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Bin Sites</h1>
      <p className="text-sm text-slate-500">
        A bin site is a physical location grouping multiple bins under an entity (e.g., &ldquo;Home Place Bins&rdquo;, &ldquo;North Farm Site&rdquo;).
      </p>

      {hasDefaultSite && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Existing bins were placed in a &ldquo;Default Site&rdquo; during the migration. Rename or split these into the actual physical sites you use.
        </div>
      )}

      {unsited.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>{unsited.length}</strong> bin{unsited.length === 1 ? '' : 's'} not assigned to a site. Edit them under{' '}
          <a className="underline" href="/settings/bins">Bins</a>.
        </div>
      )}

      <form onSubmit={add} className="space-y-2 bg-white p-4 rounded-xl shadow">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Site name"
            className={inputCls}
          />
          <select
            value={form.entityId}
            onChange={(e) => setForm({ ...form, entityId: e.target.value, countyId: '' })}
            className={inputCls}
          >
            <option value="">— entity —</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <select
            value={form.countyId}
            onChange={(e) => setForm({ ...form, countyId: e.target.value })}
            className={inputCls}
            disabled={!form.entityId}
          >
            <option value="">{form.entityId ? '— county (optional) —' : 'pick entity for counties'}</option>
            {formCountyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
          </select>
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            placeholder="Address (optional)"
            className={inputCls}
          />
        </div>
        <input
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Notes (optional)"
          className={inputCls + ' w-full'}
        />
        <div className="flex justify-end">
          <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add Site</button>
        </div>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {sites.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No bin sites yet.</li>}
        {sites.map((s) => {
          const ent = entityById.get(s.entity_id)
          const cty = s.county_id ? countyById.get(s.county_id) : null
          const stats = siteStats(s.id)
          const list = binsBySite.get(s.id) ?? []
          const isExpanded = expandedId === s.id
          return (
            <li key={s.id} className="px-4 py-3">
              {editingId === s.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className={inputCls}
                    />
                    <select
                      value={editForm.entityId}
                      onChange={(e) => setEditForm({ ...editForm, entityId: e.target.value, countyId: '' })}
                      className={inputCls}
                    >
                      <option value="">— entity —</option>
                      {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <select
                      value={editForm.countyId}
                      onChange={(e) => setEditForm({ ...editForm, countyId: e.target.value })}
                      className={inputCls}
                      disabled={!editForm.entityId}
                    >
                      <option value="">{editForm.entityId ? '— county (optional) —' : 'pick entity for counties'}</option>
                      {editCountyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
                    </select>
                    <input
                      value={editForm.address}
                      onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                      placeholder="Address (optional)"
                      className={inputCls}
                    />
                  </div>
                  <input
                    value={editForm.notes}
                    onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                    placeholder="Notes (optional)"
                    className={inputCls + ' w-full'}
                  />
                  <div className="flex gap-3">
                    <button onClick={() => save(s.id)} className="text-green-700 font-semibold">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold">{s.name}</div>
                      <div className="text-sm text-slate-500">
                        {ent?.name ?? '(no entity)'}
                        {cty && <> · {cty.name}, {cty.state_code}</>}
                        {s.address && <> · {s.address}</>}
                      </div>
                      <div className="text-sm text-slate-500 mt-1">
                        {stats.count} bin{stats.count === 1 ? '' : 's'} · {fmtBu(stats.total)} bu on hand
                      </div>
                      {s.notes && <div className="text-xs text-slate-400 mt-1">{s.notes}</div>}
                    </div>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : s.id)}
                      className="text-slate-600 text-sm"
                    >
                      {isExpanded ? 'Hide bins' : 'Show bins'}
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(s.id)
                        setEditForm({
                          name: s.name,
                          entityId: s.entity_id,
                          countyId: s.county_id ?? '',
                          address: s.address ?? '',
                          notes: s.notes ?? '',
                        })
                      }}
                      className="text-sky-700"
                    >Edit</button>
                    <button onClick={() => remove(s.id)} className="text-red-600">Delete</button>
                  </div>
                  {isExpanded && (
                    <div className="mt-2 ml-2 border-l-2 border-slate-200 pl-3">
                      {list.length === 0 ? (
                        <p className="text-sm text-slate-400 py-2">No bins assigned.</p>
                      ) : (
                        <table className="w-full text-sm">
                          <thead className="text-slate-500">
                            <tr>
                              <th className="text-left py-1">Bin</th>
                              <th className="text-left py-1">Crop</th>
                              <th className="text-right py-1">On hand (bu)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {list.map((b) => (
                              <tr key={b.id} className="border-t border-slate-100">
                                <td className="py-1">{b.name_or_number}</td>
                                <td className="py-1">{b.crop_id ? cropById.get(b.crop_id)?.name ?? '—' : '—'}</td>
                                <td className="py-1 text-right font-mono">{fmtBu(bushelsByBin.get(b.id) ?? 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
