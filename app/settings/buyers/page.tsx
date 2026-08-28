'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { buyersImportConfig } from '@/lib/import-configs'
import SettingsDocImport from '@/components/settings-doc-import'
import DiscountScheduleImport from '@/components/discount-schedule-import'
import { usePersistentState } from '@/lib/use-persistent-state'
import { matchExistingBuyer, BUYER_FINDER_RADII, type BuyerFinderHit } from '@/lib/ai-lookups'
import type { Buyer, BuyerDiscountSchedule, DeliveryLocation } from '@/lib/types'

type LocForm = { name: string; address: string }
const emptyLoc: LocForm = { name: '', address: '' }

// One row of the AI finder's review checklist. The name is editable before
// import; checked entries are created through the same insert path as the
// manual form above.
type FinderRow = { hit: BuyerFinderHit; name: string; checked: boolean }

export default function BuyersPage() {
  const supabase = useMemo(() => createClient(), [])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [locs, setLocs] = useState<DeliveryLocation[]>([])
  const [cropList, setCropList] = useState<Array<{ id: string; name: string }>>([])
  // Discount schedules (074) live WITH the buyer — listed and uploaded per
  // buyer here; the Buyer Discount Comparison report and the Dryer Math tool
  // read from this one home.
  const [schedules, setSchedules] = useState<BuyerDiscountSchedule[]>([])
  const [scheduleRuleCounts, setScheduleRuleCounts] = useState<Map<string, number>>(new Map())
  const [uploadOpenBuyerId, setUploadOpenBuyerId] = useState<string | null>(null)
  // AI buyer finder state. Zip + radius persist so the next search starts
  // where the last one left off.
  const [finderOpen, setFinderOpen] = useState(false)
  const [finderZip, setFinderZip] = usePersistentState('buyers:finderZip', '')
  const [finderRadius, setFinderRadius] = usePersistentState<number>('buyers:finderRadius', 50)
  const [finderBusy, setFinderBusy] = useState(false)
  const [finderErr, setFinderErr] = useState<string | null>(null)
  const [finderRows, setFinderRows] = useState<FinderRow[] | null>(null)
  const [finderSource, setFinderSource] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const [newBuyerName, setNewBuyerName] = useState('')
  const [editingBuyerId, setEditingBuyerId] = useState<string | null>(null)
  const [editBuyerName, setEditBuyerName] = useState('')
  const [expandedBuyerId, setExpandedBuyerId] = useState<string | null>(null)
  const [newLocByBuyer, setNewLocByBuyer] = useState<Record<string, LocForm>>({})
  const [editingLocId, setEditingLocId] = useState<string | null>(null)
  const [editLocForm, setEditLocForm] = useState<LocForm>(emptyLoc)
  const [err, setErr] = useState<string | null>(null)

  async function refresh() {
    const [b, l, c, s, r] = await Promise.all([
      supabase.from('buyers').select('*').order('name'),
      supabase.from('delivery_locations').select('*').order('name'),
      supabase.from('crops').select('id, name').order('name'),
      supabase.from('buyer_discount_schedules').select('*').order('effective_date', { ascending: false }),
      supabase.from('buyer_discount_schedule_rules').select('id, schedule_id'),
    ])
    setBuyers((b.data as Buyer[]) || [])
    setLocs((l.data as DeliveryLocation[]) || [])
    setCropList((c.data as Array<{ id: string; name: string }>) || [])
    setSchedules((s.data as BuyerDiscountSchedule[]) || [])
    const counts = new Map<string, number>()
    for (const row of ((r.data as Array<{ schedule_id: string }>) || [])) {
      counts.set(row.schedule_id, (counts.get(row.schedule_id) ?? 0) + 1)
    }
    setScheduleRuleCounts(counts)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropNames = useMemo(() => cropList.map((c) => c.name), [cropList])
  const cropNameById = useMemo(() => new Map(cropList.map((c) => [c.id, c.name])), [cropList])
  const schedulesByBuyer = useMemo(() => {
    const m = new Map<string, BuyerDiscountSchedule[]>()
    for (const s of schedules) {
      const arr = m.get(s.buyer_id) ?? []
      arr.push(s)
      m.set(s.buyer_id, arr)
    }
    return m
  }, [schedules])

  async function removeSchedule(s: BuyerDiscountSchedule) {
    if (!confirm('Delete this discount schedule? Its rules are deleted too, and the reports stop auditing against it.')) return
    const { error } = await supabase.from('buyer_discount_schedules').delete().eq('id', s.id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const locsByBuyer = useMemo(() => {
    const m = new Map<string, DeliveryLocation[]>()
    for (const l of locs) {
      const list = m.get(l.buyer_id) ?? []
      list.push(l)
      m.set(l.buyer_id, list)
    }
    return m
  }, [locs])

  async function addBuyer(e: React.FormEvent) {
    e.preventDefault()
    if (!newBuyerName.trim()) return
    const { error } = await supabase.from('buyers').insert({ name: newBuyerName.trim() })
    if (error) { setErr(error.message); return }
    setNewBuyerName('')
    setErr(null)
    refresh()
  }

  async function saveBuyer(id: string) {
    if (!editBuyerName.trim()) return
    const { error } = await supabase.from('buyers').update({ name: editBuyerName.trim() }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingBuyerId(null)
    setErr(null)
    refresh()
  }

  async function removeBuyer(id: string) {
    const list = locsByBuyer.get(id) ?? []
    const msg = list.length > 0
      ? `Delete this buyer? ${list.length} delivery location${list.length === 1 ? '' : 's'} will also be deleted.`
      : 'Delete this buyer?'
    if (!confirm(msg)) return
    const { error } = await supabase.from('buyers').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  function getNewLoc(buyerId: string): LocForm {
    return newLocByBuyer[buyerId] ?? emptyLoc
  }
  function setNewLoc(buyerId: string, val: LocForm) {
    setNewLocByBuyer((s) => ({ ...s, [buyerId]: val }))
  }

  async function addLoc(buyerId: string, e: React.FormEvent) {
    e.preventDefault()
    const f = getNewLoc(buyerId)
    if (!f.name.trim()) return
    const { error } = await supabase.from('delivery_locations').insert({
      buyer_id: buyerId,
      name: f.name.trim(),
      address: f.address.trim() || null,
    })
    if (error) { setErr(error.message); return }
    setNewLoc(buyerId, emptyLoc)
    setErr(null)
    refresh()
  }

  async function saveLoc(id: string) {
    if (!editLocForm.name.trim()) return
    const { error } = await supabase.from('delivery_locations').update({
      name: editLocForm.name.trim(),
      address: editLocForm.address.trim() || null,
    }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingLocId(null)
    setErr(null)
    refresh()
  }

  async function removeLoc(id: string) {
    if (!confirm('Delete this delivery location? Contracts using it will have their location cleared.')) return
    const { error } = await supabase.from('delivery_locations').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  // ---- AI buyer finder --------------------------------------------------

  async function runFinder(e: React.FormEvent) {
    e.preventDefault()
    setFinderErr(null)
    setImportSummary(null)
    setFinderBusy(true)
    setFinderRows(null)
    try {
      const res = await fetch('/api/buyer-finder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ zip: finderZip.trim(), radius_miles: finderRadius, crops: cropNames }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.data) {
        setFinderErr(json?.error ?? 'The search didn’t go through — try again in a minute.')
        return
      }
      const data = json.data as { results: BuyerFinderHit[]; sourceDescription: string }
      setFinderRows(data.results.map((hit) => ({ hit, name: hit.name, checked: false })))
      setFinderSource(data.sourceDescription)
    } catch {
      setFinderErr('The search didn’t go through — check your connection and try again.')
    } finally {
      setFinderBusy(false)
    }
  }

  function setFinderRow(i: number, patch: Partial<FinderRow>) {
    setFinderRows((rows) => (rows ? rows.map((r, j) => (i === j ? { ...r, ...patch } : r)) : rows))
  }

  // Create the ticked results through the SAME path as the manual form:
  // insert into buyers, then the found location/address as the buyer's first
  // delivery location. The case-insensitive duplicate guard re-checks at
  // import time (the user may have edited a name into an existing one) —
  // matches are skipped, never doubled up.
  async function importFinderRows() {
    if (!finderRows) return
    setImportBusy(true)
    setFinderErr(null)
    let created = 0
    let skipped = 0
    for (const row of finderRows) {
      if (!row.checked) continue
      const name = row.name.trim()
      if (!name || matchExistingBuyer(buyers, name)) { skipped++; continue }
      const { data: inserted, error } = await supabase
        .from('buyers')
        .insert({ name })
        .select('*')
        .single()
      if (error) { setFinderErr(error.message); break }
      created++
      const buyerId = (inserted as Buyer).id
      const locName = row.hit.location ?? name
      if (locName) {
        const { error: locErr } = await supabase.from('delivery_locations').insert({
          buyer_id: buyerId,
          name: locName,
          address: row.hit.address,
        })
        if (locErr) { setFinderErr(`Added ${name} but couldn’t save its location: ${locErr.message}`); break }
      }
    }
    setImportBusy(false)
    if (created > 0 || skipped > 0) {
      setImportSummary(
        `${created} buyer${created === 1 ? '' : 's'} added${skipped > 0 ? ` · ${skipped} already in your list` : ''}.`,
      )
      setFinderRows(null)
      refresh()
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Buyers &amp; Delivery Locations</h1>
      <p className="text-sm text-slate-500">
        Each buyer can have one or more delivery locations (e.g., separate elevators). Expand a buyer to manage its locations.
      </p>

      <SettingsDocImport primaryTarget="buyers" title="Upload a Buyer List (AI)" onSaved={refresh} />

      <CsvImport config={buyersImportConfig()} onImported={refresh} />

      <form onSubmit={addBuyer} className="bg-white rounded-xl shadow p-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <input
          value={newBuyerName}
          onChange={(e) => setNewBuyerName(e.target.value)}
          placeholder="Buyer name"
          className={inputCls}
        />
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold">Add Buyer</button>
      </form>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="font-semibold">Find buyers near me</div>
            <div className="text-sm text-slate-500">
              Searches the web for elevators, terminals, and other buyers for your crops near a zip code.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFinderOpen((v) => !v)}
            className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm"
          >
            {finderOpen ? 'Hide' : 'Find buyers'}
          </button>
        </div>

        {finderOpen && (
          <div className="space-y-3">
            <form onSubmit={runFinder} className="flex flex-wrap items-end gap-2">
              <label className="text-sm text-slate-700">
                Zip code
                <input
                  value={finderZip}
                  onChange={(e) => setFinderZip(e.target.value)}
                  inputMode="numeric"
                  pattern="\d{5}"
                  placeholder="35601"
                  className={`mt-1 block w-28 ${inputCls}`}
                />
              </label>
              <label className="text-sm text-slate-700">
                Within
                <select
                  value={finderRadius}
                  onChange={(e) => setFinderRadius(Number(e.target.value))}
                  className={`mt-1 block ${inputCls}`}
                >
                  {BUYER_FINDER_RADII.map((r) => <option key={r} value={r}>{r} miles</option>)}
                </select>
              </label>
              <button
                disabled={finderBusy || !/^\d{5}$/.test(finderZip.trim())}
                className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
              >
                {finderBusy ? 'Searching…' : 'Search'}
              </button>
            </form>
            {finderBusy && (
              <p className="text-sm text-slate-500">Looking for buyers near {finderZip.trim()} — this can take up to a minute.</p>
            )}
            {finderErr && <p className="text-sm text-red-600">{finderErr}</p>}
            {importSummary && (
              <p className="text-sm rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-green-900">{importSummary}</p>
            )}

            {finderRows && finderRows.length === 0 && (
              <p className="text-sm text-slate-500">
                Nothing turned up within {finderRadius} miles of {finderZip.trim()}. Try a wider radius — or add your buyers manually above.
              </p>
            )}

            {finderRows && finderRows.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900">
                  AI-found from public sources — verify details before hauling. Tick the ones you actually sell to;
                  everything else is discarded. You can edit a name before adding it.
                </p>
                <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {finderRows.map((row, i) => {
                    const existing = matchExistingBuyer(buyers, row.name)
                    return (
                      <li key={i} className="px-3 py-2 flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={row.checked && !existing}
                          disabled={!!existing}
                          onChange={(e) => setFinderRow(i, { checked: e.target.checked })}
                          className="mt-1.5 h-4 w-4"
                        />
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <input
                              value={row.name}
                              onChange={(e) => setFinderRow(i, { name: e.target.value })}
                              className={`${inputCls} text-sm font-medium min-w-0 flex-1 max-w-xs`}
                            />
                            {existing && (
                              <span className="text-xs rounded px-2 py-0.5 bg-slate-100 text-slate-600">already in your list</span>
                            )}
                            {row.hit.confidence === 'low' && !existing && (
                              <span className="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800" title="The search couldn’t confirm this from a direct source — double-check before hauling">
                                unverified
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-slate-600">
                            {[row.hit.buyerType, row.hit.location, row.hit.distanceMiles != null ? `~${row.hit.distanceMiles} mi` : null]
                              .filter(Boolean).join(' · ')}
                          </div>
                          {row.hit.address && <div className="text-xs text-slate-500">{row.hit.address}</div>}
                          {row.hit.crops.length > 0 && (
                            <div className="text-xs text-slate-500">Handles: {row.hit.crops.join(', ')}</div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {finderSource && <p className="text-xs text-slate-400">{finderSource}</p>}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    disabled={importBusy || !finderRows.some((r) => r.checked && !matchExistingBuyer(buyers, r.name))}
                    onClick={importFinderRows}
                    className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
                  >
                    {importBusy
                      ? 'Adding…'
                      : `Add ${finderRows.filter((r) => r.checked && !matchExistingBuyer(buyers, r.name)).length} selected`}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setFinderRows(null); setFinderSource('') }}
                    className="text-sm text-slate-500"
                  >
                    Discard results
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {buyers.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No buyers yet.</li>}
        {buyers.map((b) => {
          const list = locsByBuyer.get(b.id) ?? []
          const isExpanded = expandedBuyerId === b.id
          const newLoc = getNewLoc(b.id)
          return (
            <li key={b.id} className="px-4 py-3">
              {editingBuyerId === b.id ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    value={editBuyerName}
                    onChange={(e) => setEditBuyerName(e.target.value)}
                    className={`flex-1 min-w-0 ${inputCls}`}
                  />
                  <button onClick={() => saveBuyer(b.id)} className="text-green-700 font-semibold">Save</button>
                  <button onClick={() => setEditingBuyerId(null)} className="text-slate-500">Cancel</button>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">{b.name}</div>
                    <div className="text-sm text-slate-500">
                      {list.length} delivery location{list.length === 1 ? '' : 's'}
                      {(schedulesByBuyer.get(b.id)?.length ?? 0) > 0 && (
                        <> · {schedulesByBuyer.get(b.id)!.length} discount schedule{schedulesByBuyer.get(b.id)!.length === 1 ? '' : 's'}</>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => { setExpandedBuyerId(isExpanded ? null : b.id); setUploadOpenBuyerId(null) }}
                    className="text-slate-600 text-sm"
                  >
                    {isExpanded ? 'Hide details' : 'Locations & schedules'}
                  </button>
                  <button
                    onClick={() => { setEditingBuyerId(b.id); setEditBuyerName(b.name) }}
                    className="text-brand-deep"
                  >Edit</button>
                  <button onClick={() => removeBuyer(b.id)} className="text-red-600">Delete</button>
                </div>
              )}

              {isExpanded && (
                <div className="mt-3 ml-2 border-l-2 border-slate-200 pl-3 space-y-2">
                  <form
                    onSubmit={(e) => addLoc(b.id, e)}
                    className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2"
                  >
                    <input
                      value={newLoc.name}
                      onChange={(e) => setNewLoc(b.id, { ...newLoc, name: e.target.value })}
                      placeholder="Location name"
                      className={inputCls}
                    />
                    <input
                      value={newLoc.address}
                      onChange={(e) => setNewLoc(b.id, { ...newLoc, address: e.target.value })}
                      placeholder="Address (optional)"
                      className={inputCls}
                    />
                    <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 font-semibold text-sm">
                      Add location
                    </button>
                  </form>

                  {list.length === 0 ? (
                    <p className="text-sm text-slate-400 py-2">No delivery locations.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {list.map((l) => (
                        <li key={l.id} className="py-2">
                          {editingLocId === l.id ? (
                            <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto_auto] gap-2">
                              <input
                                value={editLocForm.name}
                                onChange={(e) => setEditLocForm({ ...editLocForm, name: e.target.value })}
                                className={inputCls}
                              />
                              <input
                                value={editLocForm.address}
                                onChange={(e) => setEditLocForm({ ...editLocForm, address: e.target.value })}
                                placeholder="Address"
                                className={inputCls}
                              />
                              <button onClick={() => saveLoc(l.id)} className="text-green-700 font-semibold">Save</button>
                              <button onClick={() => setEditingLocId(null)} className="text-slate-500">Cancel</button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium">{l.name}</div>
                                {l.address && <div className="text-sm text-slate-500">{l.address}</div>}
                              </div>
                              <button
                                onClick={() => { setEditingLocId(l.id); setEditLocForm({ name: l.name, address: l.address ?? '' }) }}
                                className="text-brand-deep text-sm"
                              >Edit</button>
                              <button onClick={() => removeLoc(l.id)} className="text-red-600 text-sm">Delete</button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Discount schedules attached to THIS buyer (074) — the one
                      home the comparison report and dryer tool read from. */}
                  <div className="pt-2 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-sm font-semibold flex-1">Discount schedules</div>
                      <button
                        type="button"
                        onClick={() => setUploadOpenBuyerId(uploadOpenBuyerId === b.id ? null : b.id)}
                        className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-1.5"
                      >
                        {uploadOpenBuyerId === b.id ? 'Hide upload' : 'Upload discount schedule (AI)'}
                      </button>
                    </div>
                    {(schedulesByBuyer.get(b.id) ?? []).length === 0 ? (
                      <p className="text-sm text-slate-400">
                        None on file — upload the buyer&rsquo;s posted discount sheet and Turnrow reads its rules. The
                        Buyer Discount Comparison report and the Grain Dryer Math tool use them.
                      </p>
                    ) : (
                      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                        {(schedulesByBuyer.get(b.id) ?? []).map((s) => (
                          <li key={s.id} className="px-3 py-2 flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm">
                                {cropNameById.get(s.crop_id) ?? 'Crop'}
                                <span className="text-slate-500 font-normal"> · effective {s.effective_date}</span>
                              </div>
                              <div className="text-xs text-slate-500">
                                {scheduleRuleCounts.get(s.id) ?? 0} rule{(scheduleRuleCounts.get(s.id) ?? 0) === 1 ? '' : 's'}
                                {s.source_pdf_url && (
                                  <> · <a href={s.source_pdf_url} target="_blank" rel="noreferrer" className="text-brand-deep">original ↗</a></>
                                )}
                              </div>
                              {s.schedule_text && (
                                <details className="text-xs text-slate-500 mt-1">
                                  <summary className="cursor-pointer">Schedule text</summary>
                                  <pre className="whitespace-pre-wrap font-sans mt-1">{s.schedule_text}</pre>
                                </details>
                              )}
                            </div>
                            <button type="button" onClick={() => removeSchedule(s)} className="text-red-600 text-sm">Delete</button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {uploadOpenBuyerId === b.id && (
                      <DiscountScheduleImport
                        bare
                        lockedBuyerId={b.id}
                        onChanged={() => { setUploadOpenBuyerId(null); refresh() }}
                      />
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
