'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import type { Bin, BinSite, Crop, Entity } from '@/lib/types'

const LAST_SITE_KEY = 'lastBinSiteId'

export default function BinsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [bins, setBins] = useState<Bin[]>([])
  const [sites, setSites] = useState<BinSite[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [name, setName] = useState('')
  const [cropId, setCropId] = useState('')
  const [siteId, setSiteId] = useState('')
  const [filterEntityId, setFilterEntityId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCropId, setEditCropId] = useState('')
  const [editSiteId, setEditSiteId] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const [b, s, e, c] = await Promise.all([
      supabase.from('bins').select('*').order('name_or_number'),
      supabase.from('bin_sites').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('crops').select('*').order('name'),
    ])
    setBins((b.data as Bin[]) || [])
    setSites((s.data as BinSite[]) || [])
    setEntities((e.data as Entity[]) || [])
    setCrops((c.data as Crop[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  // Restore last-selected site once the sites list is in.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (siteId) return
    const last = sessionStorage.getItem(LAST_SITE_KEY)
    if (last && sites.some((s) => s.id === last)) setSiteId(last)
  }, [sites, siteId])

  function rememberSite(id: string) {
    if (typeof window !== 'undefined' && id) sessionStorage.setItem(LAST_SITE_KEY, id)
  }

  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites])
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])

  // Sites available in the create form: filtered by the entity filter when set.
  const formSiteOptions = useMemo(() => (
    filterEntityId ? sites.filter((s) => s.entity_id === filterEntityId) : sites
  ), [sites, filterEntityId])

  // Sites in the edit form: keep the bin's current site selectable even if it's
  // off the current entity filter, so editing isn't blocked.
  function editSiteOptionsFor(currentSiteId: string): BinSite[] {
    const base = filterEntityId ? sites.filter((s) => s.entity_id === filterEntityId) : sites
    if (currentSiteId && !base.some((s) => s.id === currentSiteId)) {
      const cur = siteById.get(currentSiteId)
      return cur ? [cur, ...base] : base
    }
    return base
  }

  // If the entity filter pares the create-form site dropdown to one option, auto-fill.
  useEffect(() => {
    if (!filterEntityId) return
    if (formSiteOptions.length === 1 && siteId !== formSiteOptions[0].id) setSiteId(formSiteOptions[0].id)
    else if (formSiteOptions.length === 0 && siteId) setSiteId('')
    else if (siteId && !formSiteOptions.some((s) => s.id === siteId)) setSiteId('')
  }, [filterEntityId, formSiteOptions, siteId])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    if (!siteId) { setErr('Pick a bin site before saving.'); return }
    const { error } = await supabase.from('bins').insert({
      name_or_number: name.trim(),
      crop_id: cropId || null,
      bin_site_id: siteId,
    })
    if (error) { setErr(error.message); return }
    rememberSite(siteId)
    setName(''); setErr(null); refresh()
  }

  async function save(id: string) {
    if (!editName.trim()) return
    if (!editSiteId) { setErr('Pick a bin site before saving.'); return }
    const { error } = await supabase.from('bins').update({
      name_or_number: editName.trim(),
      crop_id: editCropId || null,
      bin_site_id: editSiteId,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    rememberSite(editSiteId)
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this bin?')) return
    const { error } = await supabase.from('bins').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const cropName = (id: string | null) => crops.find((c) => c.id === id)?.name ?? ''
  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  const visibleBins = useMemo(() => {
    if (!filterEntityId) return bins
    return bins.filter((b) => {
      const s = b.bin_site_id ? siteById.get(b.bin_site_id) : null
      return s?.entity_id === filterEntityId
    })
  }, [bins, filterEntityId, siteById])

  const unsited = bins.filter((b) => !b.bin_site_id).length

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Bins</h1>
      <p className="text-sm text-slate-500">
        Each bin lives at a bin site (under an entity). Designate a default crop so the load entry screen only shows matching bins when that crop is selected.
      </p>

      {unsited > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>{unsited}</strong> bin{unsited === 1 ? '' : 's'} not assigned to a site. Edit them to pick one.
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-sm text-slate-600 flex items-center gap-2">
          Entity
          <select
            value={filterEntityId}
            onChange={(e) => setFilterEntityId(e.target.value)}
            className={inputCls}
          >
            <option value="">All</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      </div>

      <CsvImport
        config={{
          tableName: 'bins',
          uniqueKey: 'name_or_number',
          columns: [
            { key: 'name_or_number', label: 'name', required: true },
            { key: 'crop_id', label: 'crop', fk: { table: 'crops', matchColumn: 'name' } },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bin name or number"
          className={inputCls}
        />
        <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={inputCls}>
          <option value="">— bin site —</option>
          {formSiteOptions.map((s) => {
            const ent = entityById.get(s.entity_id)
            return (
              <option key={s.id} value={s.id}>
                {s.name}{ent ? ` · ${ent.name}` : ''}
              </option>
            )
          })}
        </select>
        <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
          <option value="">— crop (optional) —</option>
          {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {visibleBins.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No bins{filterEntityId ? ' for this entity' : ''}.</li>}
        {visibleBins.map((b) => {
          const site = b.bin_site_id ? siteById.get(b.bin_site_id) : null
          const ent = site ? entityById.get(site.entity_id) : null
          const editOptions = editingId === b.id ? editSiteOptionsFor(editSiteId) : []
          return (
          <li key={b.id} className="px-4 py-2 flex items-center gap-2 flex-wrap">
            {editingId === b.id ? (
              <>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className={`flex-1 min-w-0 ${inputCls}`}
                />
                <select value={editSiteId} onChange={(e) => setEditSiteId(e.target.value)} className={inputCls}>
                  <option value="">— bin site —</option>
                  {editOptions.map((s) => {
                    const en = entityById.get(s.entity_id)
                    return <option key={s.id} value={s.id}>{s.name}{en ? ` · ${en.name}` : ''}</option>
                  })}
                </select>
                <select value={editCropId} onChange={(e) => setEditCropId(e.target.value)} className={inputCls}>
                  <option value="">— no crop —</option>
                  {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button onClick={() => save(b.id)} className="text-green-700 font-semibold">Save</button>
                <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1">
                  {b.name_or_number}
                  {site
                    ? <span className="text-slate-400 text-sm"> · {site.name}{ent ? ` (${ent.name})` : ''}</span>
                    : <span className="text-red-600 text-xs"> · no site</span>}
                  {b.crop_id
                    ? <span className="text-slate-400 text-sm"> · {cropName(b.crop_id)}</span>
                    : <span className="text-amber-600 text-xs"> · no crop assigned</span>}
                </span>
                <button
                  onClick={() => {
                    setEditingId(b.id)
                    setEditName(b.name_or_number)
                    setEditCropId(b.crop_id ?? '')
                    setEditSiteId(b.bin_site_id ?? '')
                  }}
                  className="text-sky-700"
                >Edit</button>
                <button onClick={() => remove(b.id)} className="text-red-600">Delete</button>
              </>
            )}
          </li>
          )
        })}
      </ul>
    </div>
  )
}
