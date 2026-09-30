'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import SettingsDocImport from '@/components/settings-doc-import'
import EntitySelect from '@/components/entity-select'
import LandownerPicker from '@/components/landowner-picker'
import { farmsImportConfig } from '@/lib/import-configs'
import { useFarmLink } from '@/lib/use-farm-link'
import { landImportBlockedMessage, landRowEditable, LAND_MANAGED_MESSAGE } from '@/lib/farm-link'
import { FarmLinkBanner, ManagedChip, NotLinkedChip } from '@/components/farm-link-banner'
import { reportError } from '@/lib/friendly-error'
import { useDialogs, plural } from '@/components/use-dialogs'
import type { Entity, Farm, County, EntityCounty, Landowner } from '@/lib/types'

const LAST_COUNTY_KEY = 'lastFarmCountyId'

export default function FarmsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [farms, setFarms] = useState<Farm[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [entityCounties, setEntityCounties] = useState<EntityCounty[]>([])
  const [landowners, setLandowners] = useState<Landowner[]>([])
  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [countyId, setCountyId] = useState('')
  const [fsaNumber, setFsaNumber] = useState('')
  const [landownerId, setLandownerId] = useState('')
  const [isShareRent, setIsShareRent] = useState(false)
  const [landlordSharePct, setLandlordSharePct] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editEntityId, setEditEntityId] = useState('')
  const [editCountyId, setEditCountyId] = useState('')
  const [editFsaNumber, setEditFsaNumber] = useState('')
  const [editLandownerId, setEditLandownerId] = useState('')
  const [editIsShareRent, setEditIsShareRent] = useState(false)
  const [editLandlordSharePct, setEditLandlordSharePct] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [busyId, setBusyId] = useState<string | null>(null)
  const { confirm, dialogs } = useDialogs()
  // 087: managed in Turnrow Farm → synced rows are read-only here.
  const farmLink = useFarmLink(supabase, 'farms')
  const managed = farmLink.managed
  const canEdit = (f: Farm) => landRowEditable(f, managed)

  async function refresh() {
    const [fa, en, co, ec, lo] = await Promise.all([
      supabase.from('farms').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entity_counties').select('*'),
      supabase.from('landowners').select('*').order('name'),
    ])
    if (fa.error) { setErr(reportError(fa.error, { action: 'load your farms', noun: 'farm' })); return }
    // Archived (by the Turnrow Farm link or from here) → out of the list.
    setFarms(((fa.data as Farm[]) || []).filter((f) => !f.archived_at))
    setEntities((en.data as Entity[]) || [])
    setCounties((co.data as County[]) || [])
    setEntityCounties((ec.data as EntityCounty[]) || [])
    setLandowners((lo.data as Landowner[]) || [])
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

  // Keep countyId in sync with the visual auto-fill when the entity has exactly
  // one county. Covers the case where entity_counties loads after onEntityChange
  // already ran with empty data.
  useEffect(() => {
    if (!entityId) return
    const list = countiesForEntity.get(entityId) ?? []
    if (list.length === 1 && countyId !== list[0].id) setCountyId(list[0].id)
  }, [entityId, countiesForEntity, countyId])

  // Same for edit mode: legacy farms initialize editCountyId = '' but the UI
  // shows the auto-filled label; this keeps the state matching the display.
  useEffect(() => {
    if (!editingId || !editEntityId) return
    const list = countiesForEntity.get(editEntityId) ?? []
    if (list.length === 1 && editCountyId !== list[0].id) setEditCountyId(list[0].id)
  }, [editingId, editEntityId, countiesForEntity, editCountyId])

  function parsePct(s: string): number | null {
    if (s === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }

  function validateShareRent(active: boolean, pct: string): string | null {
    if (!active) return null
    const n = parsePct(pct)
    if (n == null) return 'Enter the landlord share percentage.'
    if (n <= 0 || n > 100) return 'Landlord share must be between 0 and 100.'
    return null
  }

  const nameTaken = (n: string, exceptId?: string) =>
    farms.some((f) => f.id !== exceptId && f.name.trim().toLowerCase() === n.toLowerCase())

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    if (!entityId) { setErr('Pick an entity before saving.'); return }
    if (!countyId) { setErr('Pick a county before saving.'); return }
    if (nameTaken(n)) { setErr(`A farm named “${n}” already exists.`); return }
    const shareErr = validateShareRent(isShareRent, landlordSharePct)
    if (shareErr) { setErr(shareErr); return }
    const { error } = await supabase.from('farms').insert({
      name: n,
      entity_id: entityId,
      county_id: countyId,
      fsa_number: fsaNumber.trim() || null,
      landowner_id: landownerId || null,
      is_share_rent: isShareRent,
      landlord_share_percentage: isShareRent ? parsePct(landlordSharePct) : null,
    })
    if (error) { setErr(reportError(error, { action: 'add the farm', noun: 'farm', name: n })); return }
    rememberCounty(countyId)
    setName(''); setFsaNumber(''); setLandownerId(''); setIsShareRent(false); setLandlordSharePct('')
    setErr(null); refresh()
    // Keep entityId + countyId so the next farm starts in the same county.
  }

  async function save(id: string) {
    const n = editName.trim()
    if (!n) return
    if (!editEntityId) { setErr('Pick an entity before saving.'); return }
    if (!editCountyId) { setErr('Pick a county before saving.'); return }
    if (nameTaken(n, id)) { setErr(`A farm named “${n}” already exists.`); return }
    const shareErr = validateShareRent(editIsShareRent, editLandlordSharePct)
    if (shareErr) { setErr(shareErr); return }
    const { error } = await supabase.from('farms').update({
      name: n,
      entity_id: editEntityId,
      county_id: editCountyId,
      fsa_number: editFsaNumber.trim() || null,
      landowner_id: editLandownerId || null,
      is_share_rent: editIsShareRent,
      landlord_share_percentage: editIsShareRent ? parsePct(editLandlordSharePct) : null,
    }).eq('id', id)
    if (error) { setErr(reportError(error, { action: 'save the farm', noun: 'farm', name: n })); return }
    rememberCounty(editCountyId)
    setEditingId(null); setErr(null); refresh()
  }

  /** What hangs off a farm: its fields, their plantings, and loads from those fields. */
  async function dependents(farmId: string) {
    const { data: fieldRows } = await supabase.from('fields').select('id').eq('farm_id', farmId)
    const fieldIds = ((fieldRows as Array<{ id: string }> | null) ?? []).map((r) => r.id)
    if (fieldIds.length === 0) return { fields: 0, plantings: 0, loads: 0 }
    const [pl, lo] = await Promise.all([
      supabase.from('field_plantings').select('id', { count: 'exact', head: true }).in('field_id', fieldIds),
      supabase.from('loads').select('id', { count: 'exact', head: true }).in('from_field_id', fieldIds),
    ])
    return { fields: fieldIds.length, plantings: pl.count ?? 0, loads: lo.count ?? 0 }
  }

  async function archive(f: Farm) {
    setErr(null)
    const ok = await confirm({
      title: `Archive ${f.name}?`,
      body: 'The farm disappears from this list and from new-record pickers. Everything already recorded against it — fields, plantings, loads — stays exactly as it is.',
      confirmLabel: 'Archive',
    })
    if (!ok) return
    setBusyId(f.id)
    const { error } = await supabase.from('farms').update({ archived_at: new Date().toISOString() }).eq('id', f.id)
    setBusyId(null)
    if (error) { setErr(reportError(error, { action: 'archive the farm', noun: 'farm', name: f.name })); return }
    refresh()
  }

  async function remove(f: Farm) {
    setErr(null)
    setBusyId(f.id)
    const d = await dependents(f.id)
    setBusyId(null)
    if (d.loads > 0) {
      setErr(`${f.name} has ${plural(d.loads, 'load')} recorded on its fields, so it can’t be deleted. Archive it instead — the loads and yields stay.`)
      return
    }
    const parts = [d.fields > 0 ? plural(d.fields, 'field') : null, d.plantings > 0 ? plural(d.plantings, 'planting') : null].filter(Boolean)
    const ok = await confirm({
      title: parts.length > 0 ? `Delete ${f.name} and its ${parts.join(' and ')}?` : `Delete ${f.name}?`,
      body: parts.length > 0 ? 'The fields and plantings under this farm are deleted with it. This can’t be undone.' : 'This can’t be undone. If you might need it again, archive it instead.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    setBusyId(f.id)
    const { error } = await supabase.from('farms').delete().eq('id', f.id)
    setBusyId(null)
    if (error) { setErr(reportError(error, { action: 'delete the farm', noun: 'farm', name: f.name })); return }
    refresh()
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 min-h-11 w-full'
  const labelCls = 'block text-sm text-slate-700'
  const btnCls = 'min-h-11 px-3 rounded-lg text-sm font-semibold'
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

      <FarmLinkBanner status={farmLink} noun="Farms" />

      <SettingsDocImport primaryTarget="farms" title="Upload FSA farm records or a lease" onSaved={refresh} />

      <CsvImport config={farmsImportConfig(entities)} onImported={refresh} blockedReason={managed ? landImportBlockedMessage('farms') : null} />

      {managed && (
        <div className="bg-white p-4 rounded-xl shadow text-sm text-slate-600">
          {LAND_MANAGED_MESSAGE} New farms are added in Turnrow Farm and come across from there.
        </div>
      )}
      {!managed && (
      <form onSubmit={add} className="space-y-3 bg-white p-4 rounded-xl shadow">
        <h2 className="font-semibold">Add a farm</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className={labelCls}>
            Farm name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Home Place" className={`${inputCls} mt-1`} />
          </label>
          <EntitySelect label="Entity" entities={entities} value={entityId} onChange={onEntityChange} className={inputCls} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px] gap-2">
          <label className={labelCls}>
            County
            {entityId && createCountyList.length === 1 ? (
              <div className={`${inputCls} mt-1 bg-slate-50 text-slate-600 flex items-center`}>
                {countyLabel(createCountyList[0])}
              </div>
            ) : (
              <select
                value={countyId}
                onChange={(e) => setCountyId(e.target.value)}
                className={`${inputCls} mt-1`}
                disabled={!entityId}
              >
                <option value="">
                  {!entityId
                    ? 'pick the entity first'
                    : createCountyList.length === 0
                      ? 'this entity has no counties yet — add some under Entities'
                      : '— county —'}
                </option>
                {createCountyList.map((c) => <option key={c.id} value={c.id}>{countyLabel(c)}</option>)}
              </select>
            )}
          </label>
          <label className={labelCls}>
            FSA farm #
            <input value={fsaNumber} onChange={(e) => setFsaNumber(e.target.value)} placeholder="optional" className={`${inputCls} mt-1`} />
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_160px] gap-2 items-end">
          <div className={labelCls}>
            <span>Landowner</span>
            <LandownerPicker
              value={landownerId}
              onChange={setLandownerId}
              landowners={landowners}
              farms={farms}
              onCreated={(l) => setLandowners((rs) => [...rs, l].sort((a, b) => a.name.localeCompare(b.name)))}
              className="w-full mt-1"
            />
          </div>
          <label className="text-sm flex items-center gap-2 select-none min-h-11">
            <input
              type="checkbox"
              checked={isShareRent}
              onChange={(e) => {
                const next = e.target.checked
                setIsShareRent(next)
                if (!next) setLandlordSharePct('')
              }}
              className="h-5 w-5"
            />
            Share rent
          </label>
          {isShareRent ? (
            <label className={labelCls}>
              Landlord share %
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                max={100}
                value={landlordSharePct}
                onChange={(e) => setLandlordSharePct(e.target.value)}
                placeholder="e.g. 33.33"
                className={`${inputCls} mt-1`}
              />
            </label>
          ) : (
            <div />
          )}
        </div>
        {isShareRent && (
          <p className="text-xs text-slate-500">
            Enter the percentage of production the landowner is entitled to (0–100).
          </p>
        )}
        <div className="flex justify-end">
          <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">Add farm</button>
        </div>
      </form>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          aria-label="Search farms"
          placeholder="Search farms…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 min-h-11 flex-1 min-w-[12rem]"
        />
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          className="text-sm rounded-lg bg-white border border-slate-300 px-3 min-h-11"
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
        {visible.length === 0 && (
          <li className="px-4 py-6 text-center text-slate-500">
            {farms.length === 0
              ? (managed ? 'No farms yet — they arrive from Turnrow Farm on its next update.' : 'No farms yet — add the first one above, or upload your FSA farm records.')
              : 'No farms match that search.'}
          </li>
        )}
        {visible.map((f) => {
          const c = f.county_id ? countyById.get(f.county_id) : null
          return (
          <li key={f.id} className="px-3 sm:px-4 py-2">
            {editingId === f.id ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className={labelCls}>
                    Farm name
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} className={`${inputCls} mt-1`} />
                  </label>
                  <EntitySelect label="Entity" entities={entities} value={editEntityId} onChange={onEditEntityChange} className={inputCls} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px] gap-2">
                  <label className={labelCls}>
                    County
                    {editEntityId && editCountyList.length === 1 ? (
                      <div className={`${inputCls} mt-1 bg-slate-50 text-slate-600 flex items-center`}>
                        {countyLabel(editCountyList[0])}
                      </div>
                    ) : (
                      <select
                        value={editCountyId}
                        onChange={(e) => setEditCountyId(e.target.value)}
                        className={`${inputCls} mt-1`}
                        disabled={!editEntityId}
                      >
                        <option value="">
                          {!editEntityId
                            ? 'pick the entity first'
                            : editCountyList.length === 0
                              ? 'this entity has no counties yet'
                              : '— county —'}
                        </option>
                        {editCountyList.map((c) => <option key={c.id} value={c.id}>{countyLabel(c)}</option>)}
                      </select>
                    )}
                  </label>
                  <label className={labelCls}>
                    FSA farm #
                    <input value={editFsaNumber} onChange={(e) => setEditFsaNumber(e.target.value)} placeholder="optional" className={`${inputCls} mt-1`} />
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_160px] gap-2 items-end">
                  <div className={labelCls}>
                    <span>Landowner</span>
                    <LandownerPicker
                      value={editLandownerId}
                      onChange={setEditLandownerId}
                      landowners={landowners}
                      farms={farms}
                      onCreated={(l) => setLandowners((rs) => [...rs, l].sort((a, b) => a.name.localeCompare(b.name)))}
                      className="w-full mt-1"
                    />
                  </div>
                  <label className="text-sm flex items-center gap-2 select-none min-h-11">
                    <input
                      type="checkbox"
                      checked={editIsShareRent}
                      onChange={(e) => {
                        const next = e.target.checked
                        setEditIsShareRent(next)
                        if (!next) setEditLandlordSharePct('')
                      }}
                      className="h-5 w-5"
                    />
                    Share rent
                  </label>
                  {editIsShareRent ? (
                    <label className={labelCls}>
                      Landlord share %
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min={0}
                        max={100}
                        value={editLandlordSharePct}
                        onChange={(e) => setEditLandlordSharePct(e.target.value)}
                        placeholder="e.g. 33.33"
                        className={`${inputCls} mt-1`}
                      />
                    </label>
                  ) : (
                    <div />
                  )}
                </div>
                {editIsShareRent && (
                  <p className="text-xs text-slate-500">
                    Enter the percentage of production the landowner is entitled to (0–100).
                  </p>
                )}
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => setEditingId(null)} className={`${btnCls} border border-slate-300 bg-white text-slate-700`}>Cancel</button>
                  <button type="button" onClick={() => save(f.id)} className={`${btnCls} bg-brand hover:bg-brand-deep text-white px-4`}>Save</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="flex-1 min-w-[12rem] py-1">
                  {f.name}
                  {f.entity_id && <span className="text-slate-400 text-sm"> · {entityName(f.entity_id)}</span>}
                  {c
                    ? <span className="text-slate-400 text-sm"> · {countyLabel(c)}</span>
                    : <span className="text-amber-700 text-sm"> · no county</span>}
                  {f.fsa_number && <span className="text-slate-400 text-sm"> · FSA #{f.fsa_number}</span>}
                  {f.landowner_id && (
                    <span className="text-slate-400 text-sm"> · landowner: {landowners.find((l) => l.id === f.landowner_id)?.name ?? '—'}</span>
                  )}
                  {f.is_share_rent && (
                    <span className="ml-2 text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">
                      Share {f.landlord_share_percentage ?? '?'}%
                    </span>
                  )}
                  {managed && (canEdit(f) ? <NotLinkedChip /> : <ManagedChip />)}
                </span>
                {!canEdit(f) ? (
                  <span className="text-xs text-slate-400" title={LAND_MANAGED_MESSAGE}>edit in Turnrow Farm</span>
                ) : (<>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(f.id)
                    setEditName(f.name)
                    setEditEntityId(f.entity_id ?? '')
                    setEditCountyId(f.county_id ?? '')
                    setEditFsaNumber(f.fsa_number ?? '')
                    setEditLandownerId(f.landowner_id ?? '')
                    setEditIsShareRent(!!f.is_share_rent)
                    setEditLandlordSharePct(
                      f.landlord_share_percentage != null ? String(f.landlord_share_percentage) : '',
                    )
                  }}
                  className={`${btnCls} text-brand-deep`}
                >Edit</button>
                <button type="button" disabled={busyId === f.id} onClick={() => archive(f)} className={`${btnCls} text-slate-600 disabled:opacity-50`}>Archive</button>
                <button type="button" disabled={busyId === f.id} onClick={() => remove(f)} className={`${btnCls} text-red-600 disabled:opacity-50`}>Delete</button>
                </>)}
              </div>
            )}
          </li>
          )
        })}
      </ul>
      ) })()}
      {dialogs}
    </div>
  )
}
