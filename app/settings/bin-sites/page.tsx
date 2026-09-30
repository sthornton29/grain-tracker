'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import CsvImport from '@/components/csv-import'
import { binsImportConfig } from '@/lib/import-configs'
import SettingsDocImport from '@/components/settings-doc-import'
import EntitySelect from '@/components/entity-select'
import { computeBushels } from '@/lib/shrink'
import { reportError } from '@/lib/friendly-error'
import { useDialogs, plural } from '@/components/use-dialogs'
import type {
  Bin, BinSite, Crop, Entity, County, EntityCounty, BinInventoryAdjustment,
} from '@/lib/types'

type SiteForm = {
  name: string
  entityId: string
  countyId: string
  address: string
  notes: string
  /** Comma/semicolon-separated bin names created WITH the site (create only). */
  bins: string
}
const emptySite: SiteForm = { name: '', entityId: '', countyId: '', address: '', notes: '', bins: '' }

type BinForm = { name: string; cropId: string; capacity: string }
const emptyBin: BinForm = { name: '', cropId: '', capacity: '' }

/** '' → null; anything else must be a positive number of bushels. */
function parseCapacity(raw: string): { value: number | null; error?: string } {
  const s = raw.trim().replace(/,/g, '')
  if (!s) return { value: null }
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: 'Capacity must be a positive number of bushels.' }
  return { value: n }
}

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

  const [siteForm, setSiteForm] = useState<SiteForm>(emptySite)
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null)
  const [editSiteForm, setEditSiteForm] = useState<SiteForm>(emptySite)
  const [expandedSiteId, setExpandedSiteId] = useState<string | null>(null)

  const [newBinBySite, setNewBinBySite] = useState<Record<string, BinForm>>({})
  const [editingBinId, setEditingBinId] = useState<string | null>(null)
  const [editBinForm, setEditBinForm] = useState<{ name: string; cropId: string; siteId: string; capacity: string }>({ name: '', cropId: '', siteId: '', capacity: '' })

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
      fetchAllRows((f, t) => supabase.from('loads').select('net_weight, moisture, crop_id, dry_bushels_override, from_type, from_bin_id, to_type, to_bin_id').order('id').range(f, t)),
      fetchAllRows((f, t) => supabase.from('bin_inventory_adjustments').select('*').lte('as_of_date', today).order('id').range(f, t)),
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

  function validateSite(f: SiteForm): string | null {
    if (!f.name.trim()) return 'Site name is required.'
    if (!f.entityId) return 'Entity is required.'
    return null
  }

  async function addSite(e: React.FormEvent) {
    e.preventDefault()
    const v = validateSite(siteForm)
    if (v) { setErr(v); return }
    const { data: created, error } = await supabase.from('bin_sites').insert({
      name: siteForm.name.trim(),
      entity_id: siteForm.entityId,
      county_id: siteForm.countyId || null,
      address: siteForm.address.trim() || null,
      notes: siteForm.notes.trim() || null,
    }).select('id').single()
    if (error) { setErr(reportError(error, { action: 'add the bin site', noun: 'bin site', name: siteForm.name.trim() })); return }
    // Bins named on the create form land at the new site in the same step.
    const binNames = [...new Set(siteForm.bins.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean))]
    if (binNames.length > 0 && created?.id) {
      const { error: binErr } = await supabase.from('bins').insert(
        binNames.map((n) => ({ name_or_number: n, bin_site_id: created.id })),
      )
      if (binErr) { setErr(`The site was saved, but its bins weren’t. ${reportError(binErr, { action: 'add the bins', noun: 'bin' })}`); refresh(); return }
    }
    setSiteForm(emptySite); setErr(null); refresh()
  }

  async function saveSite(id: string) {
    const v = validateSite(editSiteForm)
    if (v) { setErr(v); return }
    const { error } = await supabase.from('bin_sites').update({
      name: editSiteForm.name.trim(),
      entity_id: editSiteForm.entityId,
      county_id: editSiteForm.countyId || null,
      address: editSiteForm.address.trim() || null,
      notes: editSiteForm.notes.trim() || null,
    }).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'save the bin site', noun: 'bin site', name: editSiteForm.name.trim() })); return }
    setEditingSiteId(null); setErr(null); refresh()
  }

  async function removeSite(s: BinSite) {
    setErr(null)
    const list = binsBySite.get(s.id) ?? []
    const ok = await confirm({
      title: list.length > 0 ? `Delete ${s.name} and leave its ${plural(list.length, 'bin')} without a site?` : `Delete ${s.name}?`,
      body: list.length > 0
        ? 'The bins and everything in them stay — they just show up as “not assigned to a site” until you pick a new one. This can’t be undone.'
        : 'This site has no bins. This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const { error } = await supabase.from('bin_sites').delete().eq('id', s.id)
    if (error) { setErr(reportError(error, { action: 'delete the bin site', noun: 'bin site', name: s.name })); return }
    refresh()
  }

  function getNewBin(siteId: string): BinForm {
    return newBinBySite[siteId] ?? emptyBin
  }
  function setNewBin(siteId: string, val: BinForm) {
    setNewBinBySite((s) => ({ ...s, [siteId]: val }))
  }

  async function addBin(siteId: string, e: React.FormEvent) {
    e.preventDefault()
    const f = getNewBin(siteId)
    if (!f.name.trim()) return
    const cap = parseCapacity(f.capacity)
    if (cap.error) { setErr(cap.error); return }
    const { error } = await supabase.from('bins').insert({
      name_or_number: f.name.trim(),
      crop_id: f.cropId || null,
      bin_site_id: siteId,
      capacity_bushels: cap.value,
    })
    if (error) { setErr(reportError(error, { action: 'add the bin', noun: 'bin', name: f.name.trim() })); return }
    setNewBin(siteId, emptyBin)
    setErr(null)
    refresh()
  }

  async function saveBin(id: string) {
    if (!editBinForm.name.trim()) return
    if (!editBinForm.siteId) { setErr('Pick a bin site before saving.'); return }
    const cap = parseCapacity(editBinForm.capacity)
    if (cap.error) { setErr(cap.error); return }
    const { error } = await supabase.from('bins').update({
      name_or_number: editBinForm.name.trim(),
      crop_id: editBinForm.cropId || null,
      bin_site_id: editBinForm.siteId,
      capacity_bushels: cap.value,
    }).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'save the bin', noun: 'bin', name: editBinForm.name.trim() })); return }
    setEditingBinId(null); setErr(null); refresh()
  }

  async function removeBin(b: Bin) {
    setErr(null)
    const { count } = await supabase.from('loads').select('id', { count: 'exact', head: true }).or(`to_bin_id.eq.${b.id},from_bin_id.eq.${b.id}`)
    const loads = count ?? 0
    if (loads > 0) {
      setErr(`${b.name_or_number} has ${plural(loads, 'load')} in or out of it, so it can’t be deleted. Rename it, or move it to another site, if it’s no longer in use.`)
      return
    }
    const ok = await confirm({ title: `Delete ${b.name_or_number}?`, body: 'No loads have gone in or out of this bin. This can’t be undone.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    const { error } = await supabase.from('bins').delete().eq('id', b.id)
    if (error) { setErr(reportError(error, { action: 'delete the bin', noun: 'bin', name: b.name_or_number })); return }
    refresh()
  }

  async function assignBinToSite(binId: string, siteId: string) {
    if (!siteId) return
    const { error } = await supabase.from('bins').update({ bin_site_id: siteId }).eq('id', binId)
    if (error) { setErr(reportError(error, { action: 'move the bin to that site', noun: 'bin' })); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full'
  const labelCls = 'block text-sm text-slate-700'
  const btnCls = 'min-h-11 px-3 rounded-lg text-sm font-semibold'
  const { confirm, dialogs } = useDialogs()
  const formCountyOptions = siteForm.entityId ? (countiesForEntity.get(siteForm.entityId) ?? []) : []
  const editCountyOptions = editSiteForm.entityId ? (countiesForEntity.get(editSiteForm.entityId) ?? []) : []

  function siteStats(siteId: string) {
    const list = binsBySite.get(siteId) ?? []
    const total = list.reduce((s, b) => s + (bushelsByBin.get(b.id) ?? 0), 0)
    return { count: list.length, total }
  }

  const hasDefaultSite = sites.some((s) => s.name === 'Default Site')

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Bin Sites &amp; Bins</h1>
      <p className="text-sm text-slate-500">
        A bin site is a physical location grouping bins under an entity (e.g., &ldquo;Home Place Bins&rdquo;). Expand a site to manage its bins.
      </p>

      {hasDefaultSite && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Your existing bins were grouped under a &ldquo;Default Site&rdquo; automatically. Rename or split these into the actual physical sites you use.
        </div>
      )}

      {unsited.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 space-y-2">
          <div>
            <strong>{unsited.length}</strong> bin{unsited.length === 1 ? '' : 's'} not assigned to a site. Pick one for each:
          </div>
          <ul className="space-y-1">
            {unsited.map((b) => (
              <li key={b.id} className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{b.name_or_number}</span>
                <select
                  defaultValue=""
                  onChange={(e) => assignBinToSite(b.id, e.target.value)}
                  className={inputCls}
                >
                  <option value="" disabled>— pick a site —</option>
                  {sites.map((s) => {
                    const ent = entityById.get(s.entity_id)
                    return <option key={s.id} value={s.id}>{s.name}{ent ? ` · ${ent.name}` : ''}</option>
                  })}
                </select>
                <button type="button" onClick={() => removeBin(b)} className={`${btnCls} text-red-600`}>Delete bin</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={addSite} className="space-y-3 bg-white p-4 rounded-xl shadow">
        <h2 className="font-semibold">Add a bin site</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className={labelCls}>
            Site name
            <input
              value={siteForm.name}
              onChange={(e) => setSiteForm({ ...siteForm, name: e.target.value })}
              placeholder="e.g. Home Place Bins"
              className={`${inputCls} mt-1`}
            />
          </label>
          <EntitySelect
            label="Entity"
            entities={entities}
            value={siteForm.entityId}
            onChange={(id) => setSiteForm({ ...siteForm, entityId: id, countyId: '' })}
            className={inputCls}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className={labelCls}>
            County <span className="text-slate-400">(optional)</span>
            <select
              value={siteForm.countyId}
              onChange={(e) => setSiteForm({ ...siteForm, countyId: e.target.value })}
              className={`${inputCls} mt-1`}
              disabled={!siteForm.entityId}
            >
              <option value="">{siteForm.entityId ? '—' : 'pick the entity first'}</option>
              {formCountyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Address <span className="text-slate-400">(optional)</span>
            <input
              value={siteForm.address}
              onChange={(e) => setSiteForm({ ...siteForm, address: e.target.value })}
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>
        <label className={labelCls}>
          Notes <span className="text-slate-400">(optional)</span>
          <input
            value={siteForm.notes}
            onChange={(e) => setSiteForm({ ...siteForm, notes: e.target.value })}
            className={`${inputCls} mt-1`}
          />
        </label>
        <label className={labelCls}>
          Bins at this site <span className="text-slate-400">(optional — separate names with commas)</span>
          <input
            value={siteForm.bins}
            onChange={(e) => setSiteForm({ ...siteForm, bins: e.target.value })}
            placeholder="e.g. Bin 1, Bin 2, Bin 3"
            className={`${inputCls} mt-1`}
          />
        </label>
        <div className="flex justify-end">
          <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">Add site</button>
        </div>
      </form>

      <SettingsDocImport primaryTarget="bin_sites" title="Upload a bin list" onSaved={refresh} />

      <CsvImport config={binsImportConfig()} onImported={refresh} />

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {sites.length === 0 && <li className="px-4 py-6 text-center text-slate-500">No bin sites yet — add the first one above. A site is a place with bins, like the home place or a rented elevator.</li>}
        {sites.map((s) => {
          const ent = entityById.get(s.entity_id)
          const cty = s.county_id ? countyById.get(s.county_id) : null
          const stats = siteStats(s.id)
          const list = binsBySite.get(s.id) ?? []
          const isExpanded = expandedSiteId === s.id
          const newBin = getNewBin(s.id)
          return (
            <li key={s.id} className="px-4 py-3">
              {editingSiteId === s.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className={labelCls}>
                      Site name
                      <input
                        value={editSiteForm.name}
                        onChange={(e) => setEditSiteForm({ ...editSiteForm, name: e.target.value })}
                        className={`${inputCls} mt-1`}
                      />
                    </label>
                    <EntitySelect
                      label="Entity"
                      entities={entities}
                      value={editSiteForm.entityId}
                      onChange={(id) => setEditSiteForm({ ...editSiteForm, entityId: id, countyId: '' })}
                      className={inputCls}
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className={labelCls}>
                      County <span className="text-slate-400">(optional)</span>
                      <select
                        value={editSiteForm.countyId}
                        onChange={(e) => setEditSiteForm({ ...editSiteForm, countyId: e.target.value })}
                        className={`${inputCls} mt-1`}
                        disabled={!editSiteForm.entityId}
                      >
                        <option value="">{editSiteForm.entityId ? '—' : 'pick the entity first'}</option>
                        {editCountyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
                      </select>
                    </label>
                    <label className={labelCls}>
                      Address <span className="text-slate-400">(optional)</span>
                      <input
                        value={editSiteForm.address}
                        onChange={(e) => setEditSiteForm({ ...editSiteForm, address: e.target.value })}
                        className={`${inputCls} mt-1`}
                      />
                    </label>
                  </div>
                  <label className={labelCls}>
                    Notes <span className="text-slate-400">(optional)</span>
                    <input
                      value={editSiteForm.notes}
                      onChange={(e) => setEditSiteForm({ ...editSiteForm, notes: e.target.value })}
                      className={`${inputCls} mt-1`}
                    />
                  </label>
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setEditingSiteId(null)} className={`${btnCls} border border-slate-300 bg-white text-slate-700`}>Cancel</button>
                    <button type="button" onClick={() => saveSite(s.id)} className={`${btnCls} bg-brand hover:bg-brand-deep text-white px-4`}>Save</button>
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
                      type="button"
                      onClick={() => setExpandedSiteId(isExpanded ? null : s.id)}
                      className={`${btnCls} text-slate-600 font-normal`}
                    >
                      {isExpanded ? 'Hide bins' : 'Show bins'}
                    </button>
                    <button
                      onClick={() => {
                        setEditingSiteId(s.id)
                        setEditSiteForm({
                          bins: '',
                          name: s.name,
                          entityId: s.entity_id,
                          countyId: s.county_id ?? '',
                          address: s.address ?? '',
                          notes: s.notes ?? '',
                        })
                      }}
                      className={`${btnCls} text-brand-deep`}
                    >Edit</button>
                    <button type="button" onClick={() => removeSite(s)} className={`${btnCls} text-red-600`}>Delete</button>
                  </div>
                  {isExpanded && (
                    <div className="mt-3 ml-2 border-l-2 border-slate-200 pl-3 space-y-2">
                      <form
                        onSubmit={(e) => addBin(s.id, e)}
                        className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end"
                      >
                        <label className={labelCls}>
                          Bin name or number
                          <input
                            value={newBin.name}
                            onChange={(e) => setNewBin(s.id, { ...newBin, name: e.target.value })}
                            className={`${inputCls} mt-1`}
                          />
                        </label>
                        <label className={labelCls}>
                          Crop <span className="text-slate-400">(optional)</span>
                          <select
                            value={newBin.cropId}
                            onChange={(e) => setNewBin(s.id, { ...newBin, cropId: e.target.value })}
                            className={`${inputCls} mt-1`}
                          >
                            <option value="">—</option>
                            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </label>
                        <label className={labelCls}>
                          Capacity, bu <span className="text-slate-400">(optional)</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="1"
                            value={newBin.capacity}
                            onChange={(e) => setNewBin(s.id, { ...newBin, capacity: e.target.value })}
                            className={`${inputCls} mt-1`}
                          />
                        </label>
                        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-11 font-semibold text-sm">
                          Add bin
                        </button>
                      </form>

                      {list.length === 0 ? (
                        <p className="text-sm text-slate-500 py-2">No bins at this site yet — add one above.</p>
                      ) : (
                        <ul className="divide-y divide-slate-100">
                          {list.map((b) => (
                            <li key={b.id} className="py-2">
                              {editingBinId === b.id ? (
                                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] gap-2 items-end">
                                  <label className={labelCls}>
                                    Bin name or number
                                  <input
                                    value={editBinForm.name}
                                    onChange={(e) => setEditBinForm({ ...editBinForm, name: e.target.value })}
                                    className={`${inputCls} mt-1`}
                                  />
                                  </label>
                                  <label className={labelCls}>
                                    Site
                                  <select
                                    value={editBinForm.siteId}
                                    onChange={(e) => setEditBinForm({ ...editBinForm, siteId: e.target.value })}
                                    className={`${inputCls} mt-1`}
                                  >
                                    {sites.map((opt) => {
                                      const en = entityById.get(opt.entity_id)
                                      return <option key={opt.id} value={opt.id}>{opt.name}{en ? ` · ${en.name}` : ''}</option>
                                    })}
                                  </select>
                                  </label>
                                  <label className={labelCls}>
                                    Crop
                                  <select
                                    value={editBinForm.cropId}
                                    onChange={(e) => setEditBinForm({ ...editBinForm, cropId: e.target.value })}
                                    className={`${inputCls} mt-1`}
                                  >
                                    <option value="">— no crop —</option>
                                    {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                  </select>
                                  </label>
                                  <label className={labelCls}>
                                    Capacity, bu
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="1"
                                    value={editBinForm.capacity}
                                    onChange={(e) => setEditBinForm({ ...editBinForm, capacity: e.target.value })}
                                    className={`${inputCls} mt-1`}
                                  />
                                  </label>
                                  <button type="button" onClick={() => setEditingBinId(null)} className={`${btnCls} border border-slate-300 bg-white text-slate-700`}>Cancel</button>
                                  <button type="button" onClick={() => saveBin(b.id)} className={`${btnCls} bg-brand hover:bg-brand-deep text-white px-4`}>Save</button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <div className="flex-1 min-w-0">
                                    <div className="font-medium">{b.name_or_number}</div>
                                    <div className="text-xs text-slate-500">
                                      {b.crop_id
                                        ? cropById.get(b.crop_id)?.name
                                        : <span className="text-amber-600">no crop assigned</span>}
                                      {' · '}
                                      <span className="font-mono">{fmtBu(bushelsByBin.get(b.id) ?? 0)} bu</span>
                                      {b.capacity_bushels != null && b.capacity_bushels > 0 && (
                                        <> · <span className="text-slate-400">capacity {fmtBu(b.capacity_bushels)} bu</span></>
                                      )}
                                    </div>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setEditingBinId(b.id)
                                      setEditBinForm({
                                        name: b.name_or_number,
                                        cropId: b.crop_id ?? '',
                                        siteId: b.bin_site_id ?? s.id,
                                        capacity: b.capacity_bushels != null ? String(b.capacity_bushels) : '',
                                      })
                                    }}
                                    className={`${btnCls} text-brand-deep`}
                                  >Edit</button>
                                  <button type="button" onClick={() => removeBin(b)} className={`${btnCls} text-red-600`}>Delete</button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ul>
      {dialogs}
    </div>
  )
}
