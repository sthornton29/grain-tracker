'use client'

// Freight Math — picked-up vs delivered decisions. THREE inputs (diesel ·
// labor · miles, plus crop and an optional destination that fills the miles)
// and the answer renders instantly: itemized cost per load, the headline
// cost per bushel, and the decision line — how much more a delivered
// contract must pay than a picked-up one to cover the haul. Assumptions
// (payloads, mpg, speed, hours, wear, ownership toggle, the distances
// table + AI estimates) live in the ⚙ slide-over, persisted per org
// (freight_settings/freight_distances, 078). Math in lib/freight-math.ts.
//
// Distances are organized BY BUYER (buyer heading → its delivery
// locations, the Settings → Buyers hierarchy) with one directly-editable
// miles cell per bin site: type a number and it saves at once as 'manual'
// — no address, no estimate needed. "Estimate missing distances (AI)" is an
// optional bulk fill for the blanks only (planDistanceSaves).

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import {
  FREIGHT_DEFAULTS, applyManualDistance, distanceFor, freightCost, groupDistancesByBuyer,
  manualDistanceRow, payloadForCrop, planDistanceSaves, roadMilesEstimate,
  type DistanceEstimate, type FreightDistanceRow, type FreightSettings,
} from '@/lib/freight-math'
import ExportBar from '@/components/export-bar'
import { EmptyState, fmtNum, numCell, theadCls } from '@/components/reports/report-kit'
import type { ExportPayload } from '@/lib/exports'
import type { Crop } from '@/lib/types'

type BinSiteRow = { id: string; name: string; address: string | null; latitude: number | string | null; longitude: number | string | null }
type LocationRow = { id: string; buyer_id: string | null; name: string; address: string | null; latitude: number | string | null; longitude: number | string | null }
type BuyerRow = { id: string; name: string }
type SettingsRow = {
  id: string
  truck_mpg: number | string
  avg_speed_mph: number | string
  load_unload_hours: number | string
  wear_per_mile: number | string
  include_ownership: boolean
  ownership_per_mile: number | string | null
  diesel_price: number | string | null
  labor_rate: number | string | null
  payload_overrides: Record<string, number> | null
}
type DistRow = FreightDistanceRow & { id: string }

const N = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const usd2 = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const QUICK_MILES = [10, 25, 50, 75, 100]

export default function FreightMathPage() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [tablesMissing, setTablesMissing] = useState(false)
  const [crops, setCrops] = useState<Crop[]>([])
  const [binSites, setBinSites] = useState<BinSiteRow[]>([])
  const [locations, setLocations] = useState<LocationRow[]>([])
  const [buyers, setBuyers] = useState<BuyerRow[]>([])
  const [distances, setDistances] = useState<DistRow[]>([])
  const [settingsRow, setSettingsRow] = useState<SettingsRow | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // ---- THE THREE MAIN INPUTS ----
  const [dieselStr, setDieselStr] = usePersistentState('freight:diesel', '3.50')
  const [laborStr, setLaborStr] = usePersistentState('freight:labor', '25')
  const [milesStr, setMilesStr] = usePersistentState('freight:miles', '25')
  const [cropId, setCropId] = usePersistentState('freight:cropId', '')
  const [destinationId, setDestinationId] = useState('')
  const [binSiteId, setBinSiteId] = usePersistentState('freight:binSiteId', '')

  // ---- assumptions (slide-over) ----
  const [panelOpen, setPanelOpen] = useState(false)
  const [mpgStr, setMpgStr] = useState(String(FREIGHT_DEFAULTS.truckMpg))
  const [speedStr, setSpeedStr] = useState(String(FREIGHT_DEFAULTS.avgSpeedMph))
  const [hoursStr, setHoursStr] = useState(String(FREIGHT_DEFAULTS.loadUnloadHours))
  const [wearStr, setWearStr] = useState(String(FREIGHT_DEFAULTS.wearPerMile))
  const [includeOwnership, setIncludeOwnership] = useState(false)
  const [ownershipStr, setOwnershipStr] = useState('')
  const [payloadOverrides, setPayloadOverrides] = useState<Record<string, number>>({})
  const [payloadStr, setPayloadStr] = useState('')
  // Distance estimating flow.
  const [estimating, setEstimating] = useState(false)
  const [estimateReview, setEstimateReview] = useState<Array<DistanceEstimate & { label: string }> | null>(null)
  const [estimateNote, setEstimateNote] = useState<string | null>(null)
  // In-flight typed miles, keyed `${bin_site_id}|${delivery_location_id}`.
  const [editMiles, setEditMiles] = useState<Record<string, string>>({})
  const [justSaved, setJustSaved] = useState<string | null>(null)

  const refetchDistances = useCallback(async () => {
    const { data } = await supabase.from('freight_distances').select('*')
    setDistances(((data ?? []) as DistRow[]))
  }, [supabase])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [c, bs, dl, by, fd, fs] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        supabase.from('bin_sites').select('id, name, address, latitude, longitude').order('name'),
        supabase.from('delivery_locations').select('id, buyer_id, name, address, latitude, longitude').order('name'),
        supabase.from('buyers').select('id, name').order('name'),
        supabase.from('freight_distances').select('*'),
        supabase.from('freight_settings').select('*').maybeSingle(),
      ])
      if (cancelled) return
      setCrops((c.data as Crop[]) || [])
      setBinSites(((bs.data ?? []) as unknown as BinSiteRow[]))
      setLocations(((dl.data ?? []) as unknown as LocationRow[]))
      setBuyers(((by.data ?? []) as BuyerRow[]))
      // 078 not applied yet → the calculator still works with defaults.
      if (fd.error || fs.error) setTablesMissing(true)
      setDistances(((fd.data ?? []) as DistRow[]))
      const s = (fs.data ?? null) as SettingsRow | null
      setSettingsRow(s)
      if (s) {
        setMpgStr(String(N(s.truck_mpg) ?? FREIGHT_DEFAULTS.truckMpg))
        setSpeedStr(String(N(s.avg_speed_mph) ?? FREIGHT_DEFAULTS.avgSpeedMph))
        setHoursStr(String(N(s.load_unload_hours) ?? FREIGHT_DEFAULTS.loadUnloadHours))
        setWearStr(String(N(s.wear_per_mile) ?? FREIGHT_DEFAULTS.wearPerMile))
        setIncludeOwnership(s.include_ownership === true)
        setOwnershipStr(s.ownership_per_mile != null ? String(s.ownership_per_mile) : '')
        setPayloadOverrides((s.payload_overrides ?? {}) as Record<string, number>)
        if (s.diesel_price != null) setDieselStr(String(s.diesel_price))
        if (s.labor_rate != null) setLaborStr(String(s.labor_rate))
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  // Default crop: Corn when present.
  useEffect(() => {
    if (!cropId && crops.length > 0) {
      const corn = crops.find((c) => /corn/i.test(c.name) && !/seed/i.test(c.name))
      setCropId((corn ?? crops[0]).id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crops])

  // Default bin site: the first one.
  useEffect(() => {
    if (!binSiteId && binSites.length > 0) setBinSiteId(binSites[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binSites])

  const crop = crops.find((c) => c.id === cropId) ?? null
  const settings: FreightSettings = useMemo(() => ({
    truckMpg: N(mpgStr) ?? FREIGHT_DEFAULTS.truckMpg,
    avgSpeedMph: N(speedStr) ?? FREIGHT_DEFAULTS.avgSpeedMph,
    loadUnloadHours: N(hoursStr) ?? FREIGHT_DEFAULTS.loadUnloadHours,
    wearPerMile: N(wearStr) ?? FREIGHT_DEFAULTS.wearPerMile,
    includeOwnership,
    ownershipPerMile: N(ownershipStr),
  }), [mpgStr, speedStr, hoursStr, wearStr, includeOwnership, ownershipStr])

  const payloadBu = crop ? payloadForCrop(crop.base_lb_per_bushel, payloadOverrides[crop.id] ?? null) : null
  const diesel = N(dieselStr)
  const labor = N(laborStr)
  const miles = N(milesStr)

  const cost = useMemo(
    () => (diesel != null && labor != null && miles != null && miles > 0
      ? freightCost({ oneWayMiles: miles, dieselPrice: diesel, laborRate: labor, payloadBu, settings })
      : null),
    [diesel, labor, miles, payloadBu, settings],
  )

  // Persist assumptions + last-used inputs per org (078). Best-effort.
  const persist = useCallback(async () => {
    if (tablesMissing) return
    const payload = {
      truck_mpg: N(mpgStr) ?? FREIGHT_DEFAULTS.truckMpg,
      avg_speed_mph: N(speedStr) ?? FREIGHT_DEFAULTS.avgSpeedMph,
      load_unload_hours: N(hoursStr) ?? FREIGHT_DEFAULTS.loadUnloadHours,
      wear_per_mile: N(wearStr) ?? FREIGHT_DEFAULTS.wearPerMile,
      include_ownership: includeOwnership,
      ownership_per_mile: N(ownershipStr),
      diesel_price: diesel,
      labor_rate: labor,
      payload_overrides: payloadOverrides,
    }
    if (settingsRow) {
      await supabase.from('freight_settings').update(payload).eq('id', settingsRow.id)
    } else {
      const { data } = await supabase.from('freight_settings').insert(payload).select('*').maybeSingle()
      if (data) setSettingsRow(data as SettingsRow)
    }
  }, [tablesMissing, mpgStr, speedStr, hoursStr, wearStr, includeOwnership, ownershipStr, diesel, labor, payloadOverrides, settingsRow, supabase])

  // The by-buyer distance model: buyer → locations → a miles cell per bin
  // site. Drives both the destination picker and the assumptions table.
  const groups = useMemo(
    () => groupDistancesByBuyer({ buyers, locations, binSites, distances }),
    [buyers, locations, binSites, distances],
  )
  const buyerNameOf = (buyerId: string | null) => buyers.find((b) => b.id === buyerId)?.name ?? null

  // Destination pick fills the miles from the distance table.
  const destDistance = destinationId && binSiteId ? distanceFor(distances, binSiteId, destinationId) : null
  useEffect(() => {
    if (destDistance) setMilesStr(String(Math.round(destDistance.miles)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationId, binSiteId, distances])

  // ---- distance estimating (AI geocode → haversine × road factor) ----
  async function estimateDistances() {
    setErr(null); setEstimateNote(null); setEstimating(true)
    try {
      const sites = binSites.filter((b) => (b.address ?? '').trim() !== '')
      const dests = locations.filter((l) => (l.address ?? '').trim() !== '')
      if (sites.length === 0 || dests.length === 0) {
        setEstimateNote('Add addresses to your bin sites (Settings → Bin Sites) and delivery locations (Settings → Buyers) first — distances are estimated between addresses.')
        return
      }
      // Geocode only endpoints without cached coordinates.
      const need = [
        ...sites.filter((s) => N(s.latitude) == null).map((s) => ({ key: `bin:${s.id}`, name: s.name, address: s.address! })),
        ...dests.filter((d) => N(d.latitude) == null).map((d) => ({ key: `loc:${d.id}`, name: d.name, address: d.address! })),
      ]
      const coords = new Map<string, { lat: number; lon: number }>()
      for (const s of sites) if (N(s.latitude) != null && N(s.longitude) != null) coords.set(`bin:${s.id}`, { lat: N(s.latitude)!, lon: N(s.longitude)! })
      for (const d of dests) if (N(d.latitude) != null && N(d.longitude) != null) coords.set(`loc:${d.id}`, { lat: N(d.latitude)!, lon: N(d.longitude)! })
      if (need.length > 0) {
        const res = await fetch('/api/geocode-address', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targets: need.slice(0, 40) }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) throw new Error(json?.error ?? `Lookup failed (${res.status}).`)
        for (const r of (json?.data ?? []) as Array<{ key: string; latitude: number | null; longitude: number | null }>) {
          if (r.latitude != null && r.longitude != null) coords.set(r.key, { lat: r.latitude, lon: r.longitude })
        }
        // Cache the coordinates on the endpoints so this runs once per address.
        for (const r of (json?.data ?? []) as Array<{ key: string; latitude: number | null; longitude: number | null }>) {
          if (r.latitude == null || r.longitude == null) continue
          const [kind, id] = r.key.split(':')
          await supabase
            .from(kind === 'bin' ? 'bin_sites' : 'delivery_locations')
            .update({ latitude: r.latitude, longitude: r.longitude })
            .eq('id', id)
        }
      }
      const estimates: Array<DistanceEstimate & { label: string }> = []
      for (const s of sites) {
        const a = coords.get(`bin:${s.id}`)
        if (!a) continue
        for (const d of dests) {
          const b = coords.get(`loc:${d.id}`)
          if (!b) continue
          const buyerName = buyerNameOf(d.buyer_id)
          estimates.push({
            bin_site_id: s.id,
            delivery_location_id: d.id,
            miles: Math.round(roadMilesEstimate(a.lat, a.lon, b.lat, b.lon) * 10) / 10,
            label: `${s.name} → ${d.name}${buyerName ? ` (${buyerName})` : ''}`,
          })
        }
      }
      // Blanks only: anything already on file — typed or estimated — is kept.
      const savable = planDistanceSaves(distances, estimates)
      const savableKeys = new Set(savable.map((e) => `${e.bin_site_id}|${e.delivery_location_id}`))
      const review = estimates.filter((e) => savableKeys.has(`${e.bin_site_id}|${e.delivery_location_id}`))
      if (review.length === 0) {
        setEstimateNote('Nothing to estimate — every pair already has miles on file (yours are never touched), or an endpoint has no address to locate. Type miles for those below.')
      } else {
        setEstimateReview(review)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Distance lookup failed.')
    } finally {
      setEstimating(false)
    }
  }

  async function saveEstimates() {
    if (!estimateReview) return
    setErr(null)
    const { error } = await supabase.from('freight_distances').upsert(
      estimateReview.map((e) => ({
        bin_site_id: e.bin_site_id,
        delivery_location_id: e.delivery_location_id,
        miles: e.miles,
        source: 'estimate',
      })),
      { onConflict: 'org_id,bin_site_id,delivery_location_id' },
    )
    if (error) { setErr(error.message); return }
    setEstimateReview(null)
    setEstimateNote('Estimates saved and labeled as estimates. Type over any of them below and your number sticks.')
    refetchDistances()
  }

  // A typed mileage saves at once as the user's own number — for any
  // location, address or not, whatever was there before. A blank or zero
  // entry just reverts the cell to what's on file.
  async function saveManualMiles(binSiteId: string, locationId: string, value: string) {
    const key = `${binSiteId}|${locationId}`
    const clearEdit = () => setEditMiles((m) => { const next = { ...m }; delete next[key]; return next })
    const manual = manualDistanceRow(binSiteId, locationId, value)
    if (!manual) { clearEdit(); return }
    const current = distanceFor(distances, binSiteId, locationId)
    if (current && current.source === 'manual' && current.miles === manual.miles) { clearEdit(); return }
    setErr(null)
    const { error } = await supabase
      .from('freight_distances')
      .upsert(manual, { onConflict: 'org_id,bin_site_id,delivery_location_id' })
    if (error) { setErr(error.message); return }
    // Optimistic: the cell reads back as "yours" immediately; the refetch
    // brings the real row id.
    setDistances((rows) =>
      applyManualDistance(rows, binSiteId, locationId, manual.miles).map((r) =>
        'id' in r ? (r as DistRow) : { ...r, id: `pending:${key}` },
      ),
    )
    clearEdit()
    setJustSaved(key)
    setTimeout(() => setJustSaved((k) => (k === key ? null : k)), 2000)
    refetchDistances()
  }

  // ---- export ----
  const buildPayload = useCallback((): ExportPayload => {
    const rows = QUICK_MILES.map((mi) => {
      const c = diesel != null && labor != null
        ? freightCost({ oneWayMiles: mi, dieselPrice: diesel, laborRate: labor, payloadBu, settings })
        : null
      return [mi, c?.fuel ?? null, c?.labor ?? null, c?.wear ?? null, c?.totalPerLoad ?? null, c?.centsPerBu ?? null]
    })
    return {
      title: 'Freight Math',
      filters: [
        crop?.name ?? '',
        payloadBu != null ? `${fmtNum(payloadBu, 0)} bu/load` : 'no payload',
        diesel != null ? `diesel $${fmtNum(diesel)}/gal` : '',
        labor != null ? `labor $${fmtNum(labor)}/hr` : '',
        `${fmtNum(settings.truckMpg, 1)} mpg · ${fmtNum(settings.avgSpeedMph, 0)} mph · ${fmtNum(settings.loadUnloadHours, 2)} hr load/unload · wear $${fmtNum(settings.wearPerMile)}/mi`,
      ].filter(Boolean).join(' · '),
      summary: cost ? [
        { label: 'Cost per load', value: usd2(cost.totalPerLoad) },
        { label: 'Cost per bushel', value: cost.centsPerBu != null ? `${fmtNum(cost.centsPerBu, 1)}¢` : '—' },
        { label: 'Delivered must pay at least', value: cost.breakevenCentsPerBu != null ? `+${fmtNum(cost.breakevenCentsPerBu, 1)}¢/bu` : '—' },
      ] : undefined,
      sections: [{
        title: 'Cost by one-way miles',
        columns: [
          { label: 'One-way miles', align: 'right', format: 'int' },
          { label: 'Fuel', align: 'right', format: 'usd2' },
          { label: 'Labor', align: 'right', format: 'usd2' },
          { label: 'Wear', align: 'right', format: 'usd2' },
          { label: 'Per load', align: 'right', format: 'usd2' },
          { label: '¢/bu', align: 'right', format: 'dec1' },
        ],
        rows,
      }],
    }
  }, [cost, crop?.name, payloadBu, diesel, labor, settings])

  if (loading) return <p className="text-sm text-slate-400">Loading…</p>
  if (crops.length === 0) {
    return <EmptyState message="No crops set up yet." linkHref="/settings/crops" linkLabel="Set up crops" />
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm'

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Freight Math</h1>
        <ExportBar buildPayload={buildPayload} />
      </div>
      <p className="text-sm text-slate-600 no-print max-w-3xl">
        What a haul really costs — and how much more a delivered contract must pay than a picked-up one to cover it.
        Operating costs only (fuel, labor, wear): the right basis for deciding <em>where</em> to haul.
      </p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {tablesMissing && (
        <p className="text-sm rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
          The calculator works, but saved assumptions and destination distances need a database update — contact support.
        </p>
      )}

      {/* ---- THE THREE INPUTS ---- */}
      <div className="bg-white rounded-xl shadow p-4 no-print flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-700">
          Diesel $/gal
          <input type="number" step="0.05" value={dieselStr} onChange={(e) => setDieselStr(e.target.value)} onBlur={persist} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
        </label>
        <label className="text-sm text-slate-700">
          Labor $/hr
          <input type="number" step="1" value={laborStr} onChange={(e) => setLaborStr(e.target.value)} onBlur={persist} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
        </label>
        <label className="text-sm text-slate-700">
          Miles (one-way)
          <input type="number" step="1" value={milesStr} onChange={(e) => { setMilesStr(e.target.value); setDestinationId('') }} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
        </label>
        <label className="text-sm text-slate-700">
          Crop
          <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={`block mt-0.5 ${inputCls}`}>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="block text-xs text-slate-500 mt-0.5">
            {payloadBu != null ? `${fmtNum(payloadBu, 0)} bu/load` : 'no bushel payload — per-load cost only'}
          </span>
        </label>
        <label className="text-sm text-slate-700">
          Destination (fills miles)
          <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} className={`block mt-0.5 max-w-64 ${inputCls}`}>
            <option value="">— type miles —</option>
            {groups.filter((g) => g.locations.length > 0).map((g) => (
              <optgroup key={g.buyerId ?? 'other'} label={g.buyerName}>
                {g.locations.map((l) => {
                  const d = binSiteId ? l.milesBySite.get(binSiteId) ?? null : null
                  return (
                    <option key={l.id} value={l.id}>
                      {l.name}{d ? ` — ${fmtNum(d.miles, 1)} mi` : ' — no miles yet'}
                    </option>
                  )
                })}
              </optgroup>
            ))}
          </select>
          {destinationId && binSites.length > 1 && (
            <select value={binSiteId} onChange={(e) => setBinSiteId(e.target.value)} className={`block mt-1 max-w-64 ${inputCls}`}>
              {binSites.map((b) => <option key={b.id} value={b.id}>from {b.name}</option>)}
            </select>
          )}
          {destinationId && (
            <span className="block text-xs text-slate-500 mt-0.5">
              {destDistance
                ? `${fmtNum(destDistance.miles, 1)} mi (${destDistance.source === 'manual' ? 'your number' : 'estimate'})`
                : 'No miles on file yet — type them under ⚙ Assumptions.'}
            </span>
          )}
        </label>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          title="Payloads, mpg, speed, load time, wear, ownership, destination distances"
        >
          ⚙ Assumptions
        </button>
      </div>

      {/* ---- the answer ---- */}
      {cost == null ? (
        <p className="text-sm text-slate-400 bg-white rounded-xl shadow px-4 py-3">Enter diesel, labor, and miles.</p>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow p-5 flex flex-wrap items-center gap-x-10 gap-y-4">
            <div>
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Cost per load ({fmtNum(cost.roundTripMiles, 0)} mi round trip)</div>
              <div className="text-3xl font-bold tabular-nums">{usd2(cost.totalPerLoad)}</div>
              <div className="text-xs text-slate-500 tabular-nums mt-0.5">
                fuel {usd2(cost.fuel)} · labor {usd2(cost.labor)} · wear {usd2(cost.wear)}
                {cost.ownership > 0 ? ` · ownership ${usd2(cost.ownership)}` : ''}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">Cost per bushel{crop ? ` (${fmtNum(payloadBu ?? 0, 0)} bu ${crop.name})` : ''}</div>
              <div className="text-3xl font-bold tabular-nums text-brand-deep">
                {cost.centsPerBu != null ? `${fmtNum(cost.centsPerBu, 1)}¢` : '—'}
              </div>
            </div>
            {cost.customRatePerLoadedMile != null && (
              <div className="text-xs text-slate-500 self-end">
                Custom-rate equivalent: <span className="font-semibold tabular-nums">{usd2(cost.customRatePerLoadedMile)}/loaded mile</span>
                <span className="block">— sanity-check against hired-hauler quotes.</span>
              </div>
            )}
          </div>

          {cost.breakevenCentsPerBu != null && (
            <div className="rounded-xl border border-brand/40 bg-green-50/60 px-4 py-3 text-sm text-green-900">
              A <strong>delivered</strong> contract must pay at least{' '}
              <strong className="tabular-nums">{fmtNum(cost.breakevenCentsPerBu, 1)}¢/bu</strong> more than a{' '}
              <strong>picked-up</strong> contract to cover hauling {fmtNum(miles ?? 0, 0)} miles.
            </div>
          )}

          <div className="overflow-x-auto bg-white rounded-xl shadow">
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  <th className={`${numCell} font-semibold`}>One-way miles</th>
                  <th className={`${numCell} font-semibold`}>Fuel</th>
                  <th className={`${numCell} font-semibold`}>Labor</th>
                  <th className={`${numCell} font-semibold`}>Wear</th>
                  <th className={`${numCell} font-semibold`}>Per load</th>
                  <th className={`${numCell} font-semibold`}>¢/bu</th>
                </tr>
              </thead>
              <tbody>
                {QUICK_MILES.map((mi) => {
                  const c = freightCost({ oneWayMiles: mi, dieselPrice: diesel!, laborRate: labor!, payloadBu, settings })
                  const isCurrent = miles != null && Math.round(miles) === mi
                  return (
                    <tr key={mi} className={`border-t border-slate-100 ${isCurrent ? 'bg-green-50/50 font-medium' : ''}`}>
                      <td className={numCell}>{mi}</td>
                      <td className={numCell}>{usd2(c.fuel)}</td>
                      <td className={numCell}>{usd2(c.labor)}</td>
                      <td className={numCell}>{usd2(c.wear)}</td>
                      <td className={`${numCell} font-semibold`}>{usd2(c.totalPerLoad)}</td>
                      <td className={`${numCell} font-semibold`}>{c.centsPerBu != null ? `${fmtNum(c.centsPerBu, 1)}¢` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---- assumptions slide-over ---- */}
      {panelOpen && (
        <div className="fixed inset-0 z-40 no-print" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => { setPanelOpen(false); persist() }} />
          <div className="absolute inset-y-0 right-0 w-full max-w-lg bg-white shadow-2xl overflow-y-auto p-5 space-y-5">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-lg flex-1">Assumptions</h2>
              <button type="button" onClick={() => { setPanelOpen(false); persist() }} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">Done</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-slate-700">
                Truck mpg (loaded/empty avg)
                <input type="number" step="0.1" value={mpgStr} onChange={(e) => setMpgStr(e.target.value)} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
              </label>
              <label className="text-sm text-slate-700">
                Average speed (mph)
                <input type="number" step="1" value={speedStr} onChange={(e) => setSpeedStr(e.target.value)} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
              </label>
              <label className="text-sm text-slate-700">
                Load/unload + wait (hr per trip)
                <input type="number" step="0.05" value={hoursStr} onChange={(e) => setHoursStr(e.target.value)} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
              </label>
              <label className="text-sm text-slate-700">
                Wear &amp; repairs ($/mi)
                <input type="number" step="0.01" value={wearStr} onChange={(e) => setWearStr(e.target.value)} className={`block mt-0.5 w-24 ${inputCls} text-right`} />
              </label>
            </div>

            <div className="space-y-1">
              <label className="text-sm text-slate-700 flex items-center gap-2">
                <input type="checkbox" checked={includeOwnership} onChange={(e) => setIncludeOwnership(e.target.checked)} />
                Include ownership costs
                {includeOwnership && (
                  <input type="number" step="0.01" value={ownershipStr} onChange={(e) => setOwnershipStr(e.target.value)} placeholder="$/mi" className={`${inputCls} w-24 text-right`} />
                )}
              </label>
              <p className="text-xs text-slate-500">
                Off by default: for comparing <em>where</em> to haul, operating costs are the right basis — depreciation,
                insurance, and housing accrue whether the truck rolls or not (the Iowa State convention). Turn it on to
                approximate a full custom-rate figure.
              </p>
            </div>

            {crop && (
              <div className="space-y-1">
                <div className="text-sm font-semibold">Payload — {crop.name}</div>
                <div className="flex items-end gap-2">
                  <label className="text-sm text-slate-700">
                    Bushels per load
                    <input
                      type="number" step="10" value={payloadStr}
                      onChange={(e) => setPayloadStr(e.target.value)}
                      placeholder={payloadBu != null ? String(payloadBu) : ''}
                      className={`block mt-0.5 w-24 ${inputCls} text-right`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const v = N(payloadStr)
                      setPayloadOverrides((o) => {
                        const next = { ...o }
                        if (v != null && v > 0) next[crop.id] = v
                        else delete next[crop.id]
                        return next
                      })
                      setPayloadStr('')
                    }}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                  >
                    {N(payloadStr) != null ? 'Set' : payloadOverrides[crop.id] != null ? 'Clear override' : 'Set'}
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Default derives from test weight (~53,000 lbs ÷ {fmtNum(N(crop.base_lb_per_bushel) ?? 0, 0)} lb/bu
                  {payloadOverrides[crop.id] != null ? ` — overridden to ${fmtNum(payloadOverrides[crop.id], 0)} bu` : ''}).
                </p>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-sm font-semibold flex-1">Destination distances</div>
                <button
                  type="button"
                  onClick={estimateDistances}
                  disabled={estimating || tablesMissing}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {estimating ? 'Estimating…' : 'Estimate missing distances (AI)'}
                </button>
              </div>
              <p className="text-xs text-slate-500">
                One-way miles from each bin site to each delivery location, by buyer. Type the miles you know — each
                number saves as soon as you leave the box and is marked <em>yours</em>. No address needed. The estimate
                is optional: it fills only the blanks (straight-line × 1.25 between addresses) and never changes a
                number that&rsquo;s already here.
              </p>
              {estimateNote && <p className="text-xs rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-slate-600">{estimateNote}</p>}
              {estimateReview && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                  <p className="text-sm text-amber-800 font-medium">Review before saving — estimates, not measured miles:</p>
                  <ul className="text-sm space-y-0.5">
                    {estimateReview.map((e) => (
                      <li key={`${e.bin_site_id}|${e.delivery_location_id}`} className="tabular-nums">
                        {e.label}: ~{fmtNum(e.miles, 1)} mi
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    <button type="button" onClick={saveEstimates} className="rounded-lg bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-sm font-semibold">Save estimates</button>
                    <button type="button" onClick={() => setEstimateReview(null)} className="rounded-lg border border-amber-400 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100">Cancel</button>
                  </div>
                </div>
              )}
              {binSites.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Add a bin site under <a href="/settings/bin-sites" className="text-brand-deep underline">Settings → Bin Sites</a> to enter distances from it.
                </p>
              ) : groups.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No buyers yet — add buyers and their delivery locations under <a href="/settings/buyers" className="text-brand-deep underline">Settings → Buyers</a>.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-700">
                      <tr>
                        <th className="text-left px-2 py-1.5">Delivery location</th>
                        {binSites.map((b) => (
                          <th key={b.id} className="text-right px-2 py-1.5 whitespace-nowrap">
                            {binSites.length > 1 ? `Miles from ${b.name}` : 'Miles (one-way)'}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <Fragment key={g.buyerId ?? 'other'}>
                          <tr className="bg-slate-100/70">
                            <td colSpan={1 + binSites.length} className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
                              {g.buyerName}
                            </td>
                          </tr>
                          {g.locations.length === 0 && (
                            <tr>
                              <td colSpan={1 + binSites.length} className="px-4 py-1.5 text-xs text-slate-400">No delivery locations.</td>
                            </tr>
                          )}
                          {g.locations.map((loc) => (
                            <tr key={loc.id} className="border-t border-slate-100">
                              <td className="px-2 py-1.5 pl-5 align-top">
                                <div>{loc.name}</div>
                                {!loc.hasAddress && (
                                  <div className="text-[11px] text-slate-400">No address on file — type the miles you know.</div>
                                )}
                              </td>
                              {binSites.map((b) => {
                                const key = `${b.id}|${loc.id}`
                                const saved = loc.milesBySite.get(b.id) ?? null
                                const shown = editMiles[key] ?? (saved ? String(saved.miles) : '')
                                return (
                                  <td key={b.id} className="px-2 py-1.5 text-right whitespace-nowrap align-top">
                                    <input
                                      type="number" step="0.1" min="0" inputMode="decimal"
                                      value={shown}
                                      placeholder="—"
                                      disabled={tablesMissing}
                                      aria-label={`Miles from ${b.name} to ${loc.name}`}
                                      onChange={(e) => setEditMiles((m) => ({ ...m, [key]: e.target.value }))}
                                      onBlur={() => { if (editMiles[key] != null) saveManualMiles(b.id, loc.id, editMiles[key]) }}
                                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                      className={`${inputCls} w-24 text-right tabular-nums disabled:bg-slate-100`}
                                    />
                                    <span className="block text-[10px] uppercase tracking-wide mt-0.5 h-3">
                                      {justSaved === key ? (
                                        <span className="text-green-700">saved</span>
                                      ) : saved ? (
                                        <span className={saved.source === 'manual' ? 'text-sky-800' : 'text-amber-800'}>
                                          {saved.source === 'manual' ? 'yours' : 'estimate'}
                                        </span>
                                      ) : null}
                                    </span>
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
