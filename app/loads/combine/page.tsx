'use client'

// Yield from Combine (062) — harvest entry for fields without scale tickets.
// Records a field × crop × crop-year's production as the combine monitor
// states it (dry basis), either as total bushels or yield/acre. An optional
// ± bu/ac calibration adjustment (remembered per crop) produces the adjusted
// total the app uses everywhere. One entry per field × crop × year — saving
// again revises. The netting against weighed loads is computed live through
// the SAME engine the Yields page uses (fieldCropAggregates), so the preview
// here always matches what the reports will show.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { fieldCropAggregates, practiceOf, combineEntryTotals, combineNegativeNetMessage } from '@/lib/yields'
import { rememberHarvestEntryPath } from '@/lib/harvest-entry-path'
import { FieldPicker } from '@/components/field-picker'
import type { CombineYieldEntry, Crop, Farm, Field, FieldPlanting, LoadSplit } from '@/lib/types'

type LoadRow = {
  id: string
  date: string
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  crop_year: number | null
  from_type: string | null
  from_field_id: string | null
  practice: 'irrigated' | 'dryland' | null
}

const currentYear = () => new Date().getFullYear()
const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtNum(n: number, d = 0) {
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

export default function CombineYieldPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [bins, setBins] = useState<Array<{ id: string; name_or_number: string }>>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [entries, setEntries] = useState<CombineYieldEntry[]>([])
  const [loading, setLoading] = useState(true)

  // Form state.
  const [cropYear, setCropYear] = useState<number>(currentYear())
  const [fieldId, setFieldId] = useState('')
  const [plantingId, setPlantingId] = useState('') // disambiguates multi-crop fields
  const [mode, setMode] = useState<'total_bushels' | 'yield_per_acre'>('yield_per_acre')
  const [statedStr, setStatedStr] = useState('')
  const [adjStr, setAdjStr] = useState('')
  const [adjTouched, setAdjTouched] = useState(false)
  const [irrStr, setIrrStr] = useState('')
  const [dryStr, setDryStr] = useState('')
  const [binId, setBinId] = useState('')
  const [harvestComplete, setHarvestComplete] = useState(true)
  const [entryDate, setEntryDate] = useState(todayISO())
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const [fa, fi, cr, pl, bi, lo, sp, ce] = await Promise.all([
        supabase.from('farms').select('id, name, entity_id').order('name'),
        supabase.from('fields').select('*').order('name_or_number'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('field_plantings').select('*'),
        supabase.from('bins').select('id, name_or_number').order('name_or_number'),
        fetchAllRows((f, t) => supabase.from('loads').select('id, date, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, practice').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
        // Tolerate the table not existing yet (062 pending) — no entries.
        fetchAllRows((f, t) => supabase.from('combine_yield_entries').select('*').order('id').range(f, t)),
      ])
      setFarms((fa.data as Farm[]) || [])
      setFields((fi.data as Field[]) || [])
      setCrops((cr.data as Crop[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setBins((bi.data as Array<{ id: string; name_or_number: string }>) || [])
      setLoads((lo.data as LoadRow[]) || [])
      setSplits((sp.data as LoadSplit[]) || [])
      setEntries((ce.data as CombineYieldEntry[]) || [])
      setLoading(false)
    })()
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])

  const yearOptions = useMemo(() => {
    const s = new Set<number>([currentYear()])
    plantings.forEach((p) => s.add(p.season_year))
    return [...s].sort((a, b) => b - a)
  }, [plantings])

  // Fields with a planting for the chosen year; the shared FieldPicker
  // handles the farm grouping + search.
  const yearPlantings = useMemo(() => plantings.filter((p) => p.season_year === cropYear), [plantings, cropYear])
  const plantedFieldIds = useMemo(() => new Set(yearPlantings.map((p) => p.field_id)), [yearPlantings])
  const plantedFields = useMemo(
    () => fields.filter((f) => plantedFieldIds.has(f.id)),
    [fields, plantedFieldIds],
  )

  const fieldPlantings = useMemo(
    () => yearPlantings.filter((p) => p.field_id === fieldId),
    [yearPlantings, fieldId],
  )
  const planting = fieldPlantings.length === 1
    ? fieldPlantings[0]
    : fieldPlantings.find((p) => p.id === plantingId) ?? null
  const crop = planting ? cropById.get(planting.crop_id) ?? null : null
  const acres = planting ? Number(planting.planted_acres) || 0 : 0
  const mixed = planting ? practiceOf(planting) === 'mixed' : false

  const existing = useMemo(
    () => (planting ? entries.find((e) => e.field_id === planting.field_id && e.crop_id === planting.crop_id && e.crop_year === cropYear) ?? null : null),
    [entries, planting, cropYear],
  )

  // Prefill from the existing entry (revision) or the crop's remembered
  // adjustment default. adjTouched keeps a user's cleared value cleared.
  useEffect(() => {
    setErr(null)
    setAdjTouched(false)
    if (existing) {
      setMode(existing.entry_mode)
      setStatedStr(existing.entry_mode === 'yield_per_acre'
        ? String(Number(existing.stated_yield_per_acre ?? 0))
        : String(Number(existing.stated_total_bushels)))
      setAdjStr(existing.adjustment_bu_per_acre != null ? String(Number(existing.adjustment_bu_per_acre)) : '')
      setIrrStr(existing.stated_irrigated_bushels != null ? String(Number(existing.stated_irrigated_bushels)) : '')
      setDryStr(existing.stated_dryland_bushels != null ? String(Number(existing.stated_dryland_bushels)) : '')
      setBinId(existing.destination_bin_id ?? '')
      setHarvestComplete(existing.harvest_complete)
      setEntryDate(existing.entry_date)
      setNotes(existing.notes ?? '')
    } else {
      setStatedStr('')
      setAdjStr(crop?.combine_adjustment_bu_per_acre != null ? String(Number(crop.combine_adjustment_bu_per_acre)) : '')
      setIrrStr(''); setDryStr('')
      setBinId(''); setHarvestComplete(true); setEntryDate(todayISO()); setNotes('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id, planting?.id])

  const stated = statedStr === '' ? null : Number(statedStr)
  const adjustment = adjStr === '' ? null : Number(adjStr)
  const totals = combineEntryTotals({
    entryMode: mode,
    statedYieldPerAcre: mode === 'yield_per_acre' ? stated : null,
    statedTotalBushels: mode === 'total_bushels' ? stated : null,
    adjustmentBuPerAcre: adjustment,
    acres,
  })

  // Live netting through the real engine: aggregate with THIS entry as the
  // (hypothetical) combine entry and read the netting off the result.
  const netting = useMemo(() => {
    if (!planting || totals.adjustedTotalBu <= 0) return null
    const agg = fieldCropAggregates(loads, splits, cropById, {
      combineEntries: [{
        id: existing?.id ?? 'draft',
        field_id: planting.field_id,
        crop_id: planting.crop_id,
        crop_year: cropYear,
        stated_total_bushels: totals.statedTotalBu,
        adjusted_total_bushels: totals.adjustedTotalBu,
        adjustment_bu_per_acre: adjustment,
        destination_bin_id: binId || null,
        harvest_complete: harvestComplete,
        entry_date: entryDate,
      }],
    })
    return agg.get(`${planting.field_id}|${planting.crop_id}|${cropYear}`)?.combine ?? null
  }, [planting, totals.statedTotalBu, totals.adjustedTotalBu, adjustment, binId, harvestComplete, entryDate, cropYear, loads, splits, cropById, existing?.id])

  const negativeNet = netting ? combineNegativeNetMessage(netting) : null

  // Mixed-field sub-entry: type one side, the other completes to the adjusted
  // total (same behavior as the yields-page breakout editor).
  const irr = irrStr === '' ? null : Number(irrStr)
  const dry = dryStr === '' ? null : Number(dryStr)
  const subEntryActive = irrStr !== '' || dryStr !== ''
  const subEntrySumOk = !subEntryActive
    || (irr != null && dry != null && Math.abs(irr + dry - totals.adjustedTotalBu) < 0.01)
  function completeOther(side: 'irr' | 'dry', value: string) {
    if (side === 'irr') {
      setIrrStr(value)
      const v = Number(value)
      if (value !== '' && Number.isFinite(v)) setDryStr(String(Math.max(0, Math.round((totals.adjustedTotalBu - v) * 100) / 100)))
    } else {
      setDryStr(value)
      const v = Number(value)
      if (value !== '' && Number.isFinite(v)) setIrrStr(String(Math.max(0, Math.round((totals.adjustedTotalBu - v) * 100) / 100)))
    }
  }

  async function save() {
    setErr(null)
    if (!planting || !crop) { setErr('Pick a field first.'); return }
    if (stated == null || !Number.isFinite(stated) || stated < 0) {
      setErr(mode === 'yield_per_acre' ? 'Enter the yield the combine shows (bu/ac).' : 'Enter the total dry bushels the combine shows.')
      return
    }
    if (mode === 'yield_per_acre' && acres <= 0) { setErr('This planting has no acres — set them under Settings → Field Plantings.'); return }
    if (totals.adjustedTotalBu < 0) { setErr('The adjustment takes the total below zero — check the sign.'); return }
    if (subEntryActive && !subEntrySumOk) { setErr('The irrigated + dryland figures must add up to the adjusted total.'); return }
    if (negativeNet && !confirm(`${negativeNet}\n\nSave anyway?`)) return
    setBusy(true)

    const payload = {
      field_id: planting.field_id,
      crop_id: planting.crop_id,
      crop_year: cropYear,
      entry_mode: mode,
      stated_yield_per_acre: mode === 'yield_per_acre' ? stated : null,
      stated_total_bushels: totals.statedTotalBu,
      adjustment_bu_per_acre: adjustment,
      adjusted_total_bushels: totals.adjustedTotalBu,
      stated_irrigated_bushels: subEntryActive ? irr : null,
      stated_dryland_bushels: subEntryActive ? dry : null,
      destination_bin_id: binId || null,
      harvest_complete: harvestComplete,
      entry_date: entryDate,
      notes: notes.trim() || null,
      source: 'manual' as const,
    }
    const { error } = await supabase
      .from('combine_yield_entries')
      .upsert(payload, { onConflict: 'field_id,crop_id,crop_year' })
    if (error) { setBusy(false); setErr(error.message); return }

    // The adjustment becomes the crop's default for the next combine entry;
    // clearing it clears the default.
    if ((crop.combine_adjustment_bu_per_acre ?? null) !== adjustment) {
      await supabase.from('crops').update({ combine_adjustment_bu_per_acre: adjustment }).eq('id', crop.id)
    }

    // Mixed-field sub-entry writes through to the planting's manual breakout —
    // the same allocation the yields page's editor would save.
    if (subEntryActive && subEntrySumOk) {
      await supabase.from('field_plantings').update({
        irrigated_bushels: irr,
        dryland_bushels: dry,
        yield_breakout_entered: true,
      }).eq('id', planting.id)
    }

    rememberHarvestEntryPath('combine')
    router.push('/yields')
  }

  const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2'
  const modeBtn = (active: boolean) =>
    `rounded-lg px-3 py-2 text-sm font-semibold border ${active ? 'bg-brand text-white border-brand' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <h1 className="text-2xl font-bold flex-1">Yield from Combine</h1>
        <Link href="/loads/new" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Weighed load entry</Link>
        <Link href="/loads" className="text-slate-500 text-sm py-2">Cancel</Link>
      </div>
      <p className="text-sm text-slate-500">
        No scale tickets? Record a field&rsquo;s production straight off the combine monitor. Any loads you did
        weigh from the field are netted out automatically — before or after this entry — so nothing double-counts.
      </p>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="font-semibold">Crop year</span>
            <select value={cropYear} onChange={(e) => { setCropYear(Number(e.target.value)); setFieldId(''); setPlantingId('') }} className={inputCls}>
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Field</span>
            <FieldPicker
              value={fieldId}
              onChange={(id) => { setFieldId(id); setPlantingId('') }}
              fields={plantedFields}
              farms={farms}
              placeholder="— pick a field —"
              className={inputCls}
            />
          </label>
        </div>
        {fieldId && fieldPlantings.length > 1 && (
          <label className="block text-sm">
            <span className="font-semibold">Crop</span>
            <select value={plantingId} onChange={(e) => setPlantingId(e.target.value)} className={inputCls}>
              <option value="">— which crop? —</option>
              {fieldPlantings.map((p) => (
                <option key={p.id} value={p.id}>{cropById.get(p.crop_id)?.name ?? '—'}</option>
              ))}
            </select>
          </label>
        )}
        {fieldId && fieldPlantings.length === 0 && (
          <p className="text-sm text-amber-700">No planting for this field in {cropYear} — add one under Settings → Field Plantings.</p>
        )}
        {planting && crop && (
          <p className="text-sm text-slate-600">
            <b>{crop.name}</b> · {fmtNum(acres, 1)} planted acres{mixed ? ' · irrigated + dryland' : ''}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" className={modeBtn(mode === 'yield_per_acre')} onClick={() => setMode('yield_per_acre')}>Yield per acre</button>
          <button type="button" className={modeBtn(mode === 'total_bushels')} onClick={() => setMode('total_bushels')}>Total dry bushels</button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="font-semibold">{mode === 'yield_per_acre' ? 'Combine yield (bu/ac)' : 'Combine total (dry bu)'}</span>
            <input type="number" inputMode="decimal" step="any" min="0" value={statedStr} onChange={(e) => setStatedStr(e.target.value)} className={inputCls} />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Adjustment (± bu/ac, optional)</span>
            <input type="number" inputMode="decimal" step="any" value={adjStr} onChange={(e) => { setAdjStr(e.target.value); setAdjTouched(true) }} className={inputCls} />
            <span className="text-xs text-slate-500">If your yield maps run consistently high or low. Remembered per crop for the next entry.</span>
          </label>
        </div>

        {planting && stated != null && (
          <p className="text-sm rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 tabular-nums">
            {mode === 'yield_per_acre' ? (
              <>Combine says {fmtNum(stated, 1)} bu/ac{adjustment != null && adjustment !== 0 ? ` ${adjustment > 0 ? '+' : '−'} ${fmtNum(Math.abs(adjustment), 1)} adjustment = ${fmtNum(stated + adjustment, 1)} bu/ac` : ''} · {fmtNum(acres, 0)} ac → <b>{fmtNum(totals.adjustedTotalBu)} bu</b></>
            ) : (
              <>Combine says {fmtNum(totals.statedTotalBu)} bu{adjustment != null && adjustment !== 0 ? ` ${adjustment > 0 ? '+' : '−'} ${fmtNum(Math.abs(adjustment), 1)} bu/ac × ${fmtNum(acres, 0)} ac` : ''} → <b>{fmtNum(totals.adjustedTotalBu)} bu</b></>
            )}
          </p>
        )}

        {netting && netting.weighedBu > 0 && (
          <p className="text-sm text-slate-600 tabular-nums">
            Weighed loads already recorded from this field: {fmtNum(netting.weighedBu)} bu →{' '}
            {netting.remainderBu >= 0 ? <b>{fmtNum(netting.remainderBu)} bu</b> : <b>0 bu</b>} left as the netted remainder.
          </p>
        )}
        {negativeNet && <p className="text-sm text-amber-700">{negativeNet}</p>}

        {mixed && planting && (
          <fieldset className="rounded-lg border border-slate-200 p-3 space-y-2">
            <legend className="text-sm font-semibold px-1">Irrigated / dryland split (optional)</legend>
            <p className="text-xs text-slate-500">
              If the monitor shows the split, enter it here — it saves as this field&rsquo;s allocation. Leave blank to
              allocate later on the Yields page, just like load-based fields.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="font-semibold">Irrigated (bu)</span>
                <input type="number" inputMode="decimal" step="any" min="0" value={irrStr} onChange={(e) => completeOther('irr', e.target.value)} className={inputCls} />
              </label>
              <label className="block text-sm">
                <span className="font-semibold">Dryland (bu)</span>
                <input type="number" inputMode="decimal" step="any" min="0" value={dryStr} onChange={(e) => completeOther('dry', e.target.value)} className={inputCls} />
              </label>
            </div>
            {subEntryActive && !subEntrySumOk && (
              <p className="text-xs text-amber-700">The two sides must add up to {fmtNum(totals.adjustedTotalBu)} bu.</p>
            )}
          </fieldset>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="font-semibold">Destination bin (optional)</span>
            <select value={binId} onChange={(e) => setBinId(e.target.value)} className={inputCls}>
              <option value="">— none / not stored —</option>
              {bins.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
            </select>
            <span className="text-xs text-slate-500">The netted remainder (not the gross total) shows in this bin.</span>
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Date</span>
            <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className={inputCls} />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={harvestComplete} onChange={(e) => setHarvestComplete(e.target.checked)} className="h-5 w-5" />
          <span><b>Harvest complete for this field</b> — count it in yields and downstream numbers now.</span>
        </label>

        <label className="block text-sm">
          <span className="font-semibold">Notes</span>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        {existing && (
          <p className="text-xs text-slate-500">
            This field already has a combine entry for {cropYear} — saving revises it.
          </p>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || loading || !planting}
            onClick={save}
            className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50"
          >
            {existing ? 'Save changes' : 'Save combine entry'}
          </button>
        </div>
      </div>
    </div>
  )
}
