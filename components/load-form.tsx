'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { allocateSplits, validateSplitDrafts, type SplitDraft } from '@/lib/load-splits'
import { relinkSettlementLinesForLoad } from '@/lib/settlement-link'
import type { Bin, Buyer, Contract, Crop, Field, FieldPlanting, Load, LoadSplit, Truck } from '@/lib/types'

type Props = {
  initial?: Partial<Load>
  initialSplits?: LoadSplit[]
  mode: 'create' | 'edit'
}

type SplitRow = { field_id: string; weight: string }

type FormState = {
  date: string
  time: string
  truck_id: string
  crop_id: string
  crop_year: string
  gross_weight: string
  tare_weight: string
  net_weight: string
  moisture: string
  test_weight: string
  dry_bushels_override: string
  from_type: '' | 'field' | 'bin'
  from_field_id: string
  from_bin_id: string
  to_type: '' | 'bin' | 'buyer'
  to_bin_id: string
  to_buyer_id: string
  contract_id: string
  ticket_number: string
}

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}
function nowHHMM() {
  const d = new Date()
  return d.toTimeString().slice(0, 5)
}

function toForm(initial?: Partial<Load>): FormState {
  return {
    date: initial?.date ?? todayISO(),
    time: initial?.time ?? nowHHMM(),
    truck_id: initial?.truck_id ?? '',
    crop_id: initial?.crop_id ?? '',
    crop_year: initial?.crop_year != null ? String(initial.crop_year) : '',
    gross_weight: initial?.gross_weight?.toString() ?? '',
    tare_weight: initial?.tare_weight?.toString() ?? '',
    net_weight: initial?.net_weight?.toString() ?? '',
    moisture: initial?.moisture?.toString() ?? '',
    test_weight: initial?.test_weight?.toString() ?? '',
    dry_bushels_override: initial?.dry_bushels_override?.toString() ?? '',
    from_type: (initial?.from_type as any) ?? '',
    from_field_id: initial?.from_field_id ?? '',
    from_bin_id: initial?.from_bin_id ?? '',
    to_type: (initial?.to_type as any) ?? '',
    to_bin_id: initial?.to_bin_id ?? '',
    to_buyer_id: initial?.to_buyer_id ?? '',
    contract_id: initial?.contract_id ?? '',
    ticket_number: initial?.ticket_number ?? '',
  }
}

function num(s: string): number | null {
  if (s === '' || s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function fmt(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function LoadForm({ initial, initialSplits, mode }: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [form, setForm] = useState<FormState>(toForm(initial))
  const [splitMode, setSplitMode] = useState<boolean>(() => (initialSplits?.length ?? 0) > 0)
  const [splitEntryMode, setSplitEntryMode] = useState<'weight' | 'percentage'>('weight')
  const [splits, setSplits] = useState<SplitRow[]>(() =>
    initialSplits && initialSplits.length > 0
      ? initialSplits.map((s) => ({ field_id: s.field_id, weight: String(s.net_weight) }))
      : [],
  )
  // Tracks whether the user has manually typed into the last split row. When
  // false, the last row auto-fills as (total net − sum of earlier rows). On
  // edit-load (splits pre-populated), every row is user-set, so this is true.
  const [lastSplitManual, setLastSplitManual] = useState<boolean>(
    () => (initialSplits?.length ?? 0) > 0,
  )
  const [trucks, setTrucks] = useState<Truck[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [bins, setBins] = useState<Bin[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [refsLoaded, setRefsLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const [t, c, f, b, by, ct, pl] = await Promise.all([
        supabase.from('trucks').select('*').order('name_or_number'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('fields').select('*').order('name_or_number'),
        supabase.from('bins').select('*').order('name_or_number'),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('contracts').select('*').order('contract_number'),
        supabase.from('field_plantings').select('*'),
      ])
      setTrucks((t.data as Truck[]) || [])
      setCrops((c.data as Crop[]) || [])
      setFields((f.data as Field[]) || [])
      setBins((b.data as Bin[]) || [])
      setBuyers((by.data as Buyer[]) || [])
      setContracts((ct.data as Contract[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setRefsLoaded(true)
    })()
  }, [supabase])

  // On create, pre-fill crop + from/to + contract selections from the most recent load.
  useEffect(() => {
    if (mode !== 'create' || !refsLoaded) return
    ;(async () => {
      const { data } = await supabase
        .from('loads')
        .select('crop_id, crop_year, from_type, from_field_id, from_bin_id, to_type, to_bin_id, to_buyer_id, contract_id')
        .order('date', { ascending: false })
        .order('time', { ascending: false })
        .limit(1)
      const recent = data?.[0] as {
        crop_id: string | null
        crop_year: number | null
        from_type: 'field' | 'bin' | null
        from_field_id: string | null
        from_bin_id: string | null
        to_type: 'bin' | 'buyer' | null
        to_bin_id: string | null
        to_buyer_id: string | null
        contract_id: string | null
      } | undefined
      if (!recent) return
      setForm((f) => ({
        ...f,
        crop_id: f.crop_id || (recent.crop_id ?? ''),
        crop_year: f.crop_year || (recent.crop_year != null ? String(recent.crop_year) : ''),
        from_type: f.from_type || (recent.from_type ?? ''),
        from_field_id: f.from_field_id || (recent.from_field_id ?? ''),
        from_bin_id: f.from_bin_id || (recent.from_bin_id ?? ''),
        to_type: f.to_type || (recent.to_type ?? ''),
        to_bin_id: f.to_bin_id || (recent.to_bin_id ?? ''),
        to_buyer_id: f.to_buyer_id || (recent.to_buyer_id ?? ''),
        contract_id: f.contract_id || (recent.contract_id ?? ''),
      }))
    })()
  }, [refsLoaded, mode, supabase])

  // Auto-compute net = gross - tare whenever either changes (user can still override).
  useEffect(() => {
    const g = num(form.gross_weight)
    const t = num(form.tare_weight)
    if (g != null && t != null) {
      const net = +(g - t).toFixed(2)
      setForm((f) => (f.net_weight === String(net) ? f : { ...f, net_weight: String(net) }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.gross_weight, form.tare_weight])

  const selectedCrop = crops.find((c) => c.id === form.crop_id)
  const { wetBushels, dryBushels, computedDryBushels, overridden } = computeBushels({
    netWeightLb: num(form.net_weight),
    moisturePct: num(form.moisture),
    baseMoisturePct: selectedCrop?.base_moisture_pct ?? null,
    baseLbPerBushel: selectedCrop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: num(form.dry_bushels_override),
  })
  const shrinkBu =
    wetBushels != null && dryBushels != null ? wetBushels - dryBushels : null

  // Contracts must match the picked buyer + crop AND the picked crop year.
  // When no crop year is picked yet, show no contracts (the dropdown asks for
  // a year first) so users don't accidentally attach a load to the wrong year.
  const cropYearNum = form.crop_year === '' ? null : Number(form.crop_year)
  const buyerContracts =
    cropYearNum == null
      ? []
      : contracts.filter(
          (c) =>
            (!form.to_buyer_id || c.buyer_id === form.to_buyer_id) &&
            (!form.crop_id || c.crop_id === form.crop_id) &&
            c.crop_year === cropYearNum
        )

  // Only show bins designated to the selected crop; if no crop yet, show all.
  const filteredBins = useMemo(() => {
    if (!form.crop_id) return bins
    return bins.filter((b) => b.crop_id === form.crop_id)
  }, [bins, form.crop_id])

  // Only show fields with a planting that matches BOTH the selected crop and
  // the selected crop year. Filtering on crop alone surfaced last year's wheat
  // fields when entering 2026 wheat loads.
  const filteredFields = useMemo(() => {
    if (!form.crop_id) return fields
    const yearNum = form.crop_year === '' ? null : Number(form.crop_year)
    const plantedFieldIds = new Set(
      plantings
        .filter((p) => p.crop_id === form.crop_id && (yearNum == null || p.season_year === yearNum))
        .map((p) => p.field_id),
    )
    return fields.filter((f) => plantedFieldIds.has(f.id))
  }, [fields, plantings, form.crop_id, form.crop_year])

  const seasonYearOptions = useMemo(
    () =>
      cropYearOptionsFromPlantings(
        plantings.map((p) => p.season_year),
        form.crop_year === '' ? null : Number(form.crop_year),
      ),
    [plantings, form.crop_year],
  )

  // Drop any previously selected field/bin that no longer matches the crop filter.
  useEffect(() => {
    if (!refsLoaded) return
    setForm((f) => {
      const next = { ...f }
      if (next.from_field_id && !filteredFields.some((x) => x.id === next.from_field_id)) next.from_field_id = ''
      if (next.from_bin_id && !filteredBins.some((x) => x.id === next.from_bin_id)) next.from_bin_id = ''
      if (next.to_bin_id && !filteredBins.some((x) => x.id === next.to_bin_id)) next.to_bin_id = ''
      return next
    })
  }, [refsLoaded, filteredFields, filteredBins])


  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  // First time the user activates Split Load with no prior split rows, seed
  // two rows — prefilling row 1 with the currently selected field when there
  // is one (so conversion in edit mode doesn't drop the existing field).
  useEffect(() => {
    if (!splitMode) return
    if (splits.length > 0) return
    setSplits([
      { field_id: form.from_field_id || '', weight: '' },
      { field_id: '', weight: '' },
    ])
    setLastSplitManual(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitMode])

  // If the crop or crop year changes (which narrows filteredFields), clear
  // any split row whose selected field no longer qualifies.
  useEffect(() => {
    if (!splitMode) return
    setSplits((rs) =>
      rs.map((r) =>
        r.field_id && !filteredFields.some((f) => f.id === r.field_id)
          ? { ...r, field_id: '' }
          : r,
      ),
    )
  }, [splitMode, filteredFields])

  const totalNetLb = num(form.net_weight) ?? 0
  const splitParsedWeights = splits.map((s) => num(s.weight) ?? 0)
  function displayedSplitWeight(i: number): string {
    if (i < splits.length - 1) return splits[i].weight
    if (lastSplitManual) return splits[i].weight
    const otherSum = splitParsedWeights.reduce(
      (a, v, j) => (j === splits.length - 1 ? a : a + v),
      0,
    )
    const remaining = totalNetLb - otherSum
    if (!(remaining > 0)) return ''
    return String(Math.round(remaining * 100) / 100)
  }
  function resolvedSplitWeight(i: number): number {
    return num(displayedSplitWeight(i)) ?? 0
  }
  function displayedSplitPct(i: number): string {
    if (totalNetLb <= 0) return ''
    const w = resolvedSplitWeight(i)
    return String(Math.round((w / totalNetLb) * 1000) / 10)
  }
  function setSplitWeight(i: number, weight: string) {
    setSplits((rs) => rs.map((r, j) => (i === j ? { ...r, weight } : r)))
    if (i === splits.length - 1) setLastSplitManual(true)
  }
  function setSplitPct(i: number, pct: string) {
    if (pct === '') {
      setSplitWeight(i, '')
      return
    }
    const p = Number(pct)
    if (!Number.isFinite(p)) return
    const w = totalNetLb * (p / 100)
    setSplitWeight(i, w > 0 ? String(Math.round(w * 100) / 100) : '')
  }
  function setSplitField(i: number, field_id: string) {
    setSplits((rs) => rs.map((r, j) => (i === j ? { ...r, field_id } : r)))
  }
  function addSplit() {
    setSplits((rs) => [...rs, { field_id: '', weight: '' }])
    setLastSplitManual(false)
  }
  function removeSplit(i: number) {
    if (splits.length <= 2) return
    setSplits((rs) => rs.filter((_, j) => j !== i))
    setLastSplitManual(false)
  }

  const splitsResolved: SplitDraft[] = splits.map((s, i) => ({
    field_id: s.field_id,
    net_weight: resolvedSplitWeight(i),
  }))
  const splitTotalLb = splitsResolved.reduce((a, d) => a + d.net_weight, 0)
  const splitTotalPct = totalNetLb > 0 ? (splitTotalLb / totalNetLb) * 100 : 0
  const splitError = splitMode ? validateSplitDrafts(splitsResolved, totalNetLb) : null

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Synchronous guard against double-submit (iPad double-tap, double-click,
    // Enter+tap). React's `busy` state only disables the button on the next
    // render, so without this a second tap a few ms later passes through and
    // we get duplicate inserts.
    if (submittingRef.current) return

    // Block save when split rows don't add up (or any other split-level
    // validation fails). Run this BEFORE flipping the busy state so the UI
    // doesn't briefly grey out for a save that won't proceed.
    const useSplits = splitMode && form.from_type === 'field'
    if (useSplits) {
      const err = validateSplitDrafts(splitsResolved, totalNetLb)
      if (err) {
        setError(err)
        return
      }
    }

    submittingRef.current = true
    setBusy(true)
    setError(null)

    const payload = {
      date: form.date,
      time: form.time || null,
      truck_id: form.truck_id || null,
      crop_id: form.crop_id || null,
      crop_year: form.crop_year === '' ? null : Number(form.crop_year),
      gross_weight: num(form.gross_weight),
      tare_weight: num(form.tare_weight),
      net_weight: num(form.net_weight),
      moisture: num(form.moisture),
      test_weight: num(form.test_weight),
      bushels: null, // derived at read time from net_weight + moisture + crop base values
      dry_bushels_override: num(form.dry_bushels_override),
      from_type: form.from_type || null,
      // Split loads aggregate across fields — clear the single field pointer.
      from_field_id: useSplits
        ? null
        : form.from_type === 'field'
        ? form.from_field_id || null
        : null,
      from_bin_id: form.from_type === 'bin' ? form.from_bin_id || null : null,
      to_type: form.to_type || null,
      to_bin_id: form.to_type === 'bin' ? form.to_bin_id || null : null,
      to_buyer_id: form.to_type === 'buyer' ? form.to_buyer_id || null : null,
      contract_id: form.to_type === 'buyer' ? form.contract_id || null : null,
      ticket_number: form.ticket_number || null,
    }

    let savedLoadId: string | null = null
    let err: { message: string } | null = null
    if (mode === 'create') {
      const res = await supabase.from('loads').insert(payload).select('id').single()
      err = res.error
      savedLoadId = (res.data as { id: string } | null)?.id ?? null
    } else if (initial?.id) {
      const res = await supabase.from('loads').update(payload).eq('id', initial.id)
      err = res.error
      savedLoadId = initial.id
    }

    if (err) {
      submittingRef.current = false
      setBusy(false)
      setError(err.message)
      return
    }

    // Persist splits. Edit mode wipes any existing rows first so removed
    // splits don't linger, then re-inserts the current set. When the user
    // converted a split load back to single-field, useSplits is false and we
    // only do the delete.
    if (savedLoadId) {
      if (mode === 'edit') {
        const { error: delErr } = await supabase
          .from('load_splits')
          .delete()
          .eq('load_id', savedLoadId)
        if (delErr) {
          submittingRef.current = false
          setBusy(false)
          setError(`Saved load but couldn’t update splits: ${delErr.message}`)
          return
        }
      }
      if (useSplits && payload.crop_id) {
        const allocated = allocateSplits(
          {
            crop_id: payload.crop_id,
            net_weight: payload.net_weight ?? 0,
            moisture: payload.moisture,
          },
          splitsResolved,
          selectedCrop ?? null,
        )
        const rows = allocated.map((a) => ({ ...a, load_id: savedLoadId }))
        const { error: insErr } = await supabase.from('load_splits').insert(rows)
        if (insErr) {
          submittingRef.current = false
          setBusy(false)
          setError(`Saved load but couldn’t save splits: ${insErr.message}`)
          return
        }
      }
    }
    // Back-fill load_id on any settlement line that was waiting on this load's
    // ticket (e.g. the settlement was entered before the load, or the ticket
    // was just corrected here). Best-effort: the load already saved, and the
    // settlement views resolve unmatched lines by ticket at read time, so a
    // failure here isn't worth blocking navigation over.
    if (savedLoadId) {
      try {
        await relinkSettlementLinesForLoad(supabase, {
          id: savedLoadId,
          to_type: payload.to_type,
          to_buyer_id: payload.to_buyer_id,
          ticket_number: payload.ticket_number,
        })
      } catch {
        /* ignore — view-time resolution still covers display */
      }
    }

    // Leave submittingRef = true; we're navigating away. Resetting it here
    // would briefly re-enable the button before the route change commits.
    router.push('/loads')
    router.refresh()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base bg-white'
  const labelCls = 'block text-sm text-slate-700'

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <h1 className="text-2xl font-bold">{mode === 'create' ? 'New Load' : 'Edit Load'}</h1>

      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Date
          <input type="date" required value={form.date} onChange={(e) => set('date', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Time
          <input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} className={inputCls} />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={labelCls}>
          Truck
          <select value={form.truck_id} onChange={(e) => set('truck_id', e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.name_or_number}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          Crop
          <select value={form.crop_id} onChange={(e) => set('crop_id', e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      <label className={labelCls}>
        Crop year <span className="text-xs text-slate-400">from set-up seasons</span>
        <select
          value={form.crop_year}
          onChange={(e) => setForm((f) => ({ ...f, crop_year: e.target.value, contract_id: '' }))}
          className={inputCls}
        >
          <option value="">— select —</option>
          {seasonYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>

      <fieldset className="border border-slate-200 rounded-xl p-3 space-y-3">
        <legend className="px-2 text-sm font-semibold">From</legend>
        <div className="flex gap-2">
          {(['field', 'bin'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set('from_type', t)}
              className={`flex-1 py-2 rounded-lg border ${
                form.from_type === t ? 'bg-green-700 text-white border-green-700' : 'bg-white'
              }`}
            >
              {t === 'field' ? 'Field' : 'Bin'}
            </button>
          ))}
        </div>
        {form.from_type === 'field' && !splitMode && (
          <>
            <select value={form.from_field_id} onChange={(e) => set('from_field_id', e.target.value)} className={inputCls}>
              <option value="">— select field —</option>
              {filteredFields.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
            </select>
            {form.crop_id && filteredFields.length === 0 && (
              <p className="text-xs text-amber-700">
                No fields have a planting recorded for this crop. Add one under Settings → Field Plantings.
              </p>
            )}
            <button
              type="button"
              onClick={() => setSplitMode(true)}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2 w-full sm:w-auto"
            >
              Split load across multiple fields
            </button>
          </>
        )}
        {form.from_type === 'field' && splitMode && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-700 flex-1">
                Split across {splits.length} field{splits.length === 1 ? '' : 's'}
              </span>
              <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                {(['weight', 'percentage'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSplitEntryMode(m)}
                    className={`px-3 py-2 text-sm ${splitEntryMode === m ? 'bg-green-700 text-white' : 'bg-white'}`}
                  >
                    {m === 'weight' ? 'By weight' : 'By percentage'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSplitMode(false)}
                className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
              >
                Use single field
              </button>
            </div>

            {splitEntryMode === 'percentage' && totalNetLb <= 0 && (
              <p className="text-xs text-amber-700">
                Enter the load’s net weight above before allocating by percentage.
              </p>
            )}

            {splits.map((row, i) => {
              const isLast = i === splits.length - 1
              const weightVal = displayedSplitWeight(i)
              const pctVal = displayedSplitPct(i)
              const isAutoFilled = isLast && !lastSplitManual && !!weightVal
              return (
                <div key={i} className="rounded-lg border border-slate-200 p-2 space-y-2 bg-slate-50">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 w-16">Field {i + 1}</span>
                    <select
                      value={row.field_id}
                      onChange={(e) => setSplitField(i, e.target.value)}
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base bg-white"
                    >
                      <option value="">— select field —</option>
                      {filteredFields.map((f) => <option key={f.id} value={f.id}>{f.name_or_number}</option>)}
                    </select>
                    {splits.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeSplit(i)}
                        className="text-red-600 text-sm px-2"
                        aria-label="Remove split"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {splitEntryMode === 'weight' ? (
                      <>
                        <label className="text-xs text-slate-500 w-16">Net lb</label>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          value={weightVal}
                          onChange={(e) => setSplitWeight(i, e.target.value)}
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base bg-white"
                          placeholder={isAutoFilled ? 'auto' : ''}
                        />
                        <span className="text-xs text-slate-500 w-20 text-right">
                          {pctVal ? `${pctVal}%` : ''}
                        </span>
                      </>
                    ) : (
                      <>
                        <label className="text-xs text-slate-500 w-16">%</label>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          value={pctVal}
                          onChange={(e) => setSplitPct(i, e.target.value)}
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base bg-white"
                          disabled={totalNetLb <= 0}
                        />
                        <span className="text-xs text-slate-500 w-24 text-right font-mono">
                          {weightVal ? `${Number(weightVal).toLocaleString()} lb` : ''}
                        </span>
                      </>
                    )}
                  </div>
                  {isAutoFilled && (
                    <p className="text-[11px] text-slate-500">Auto-filled from remainder — type a value to override.</p>
                  )}
                </div>
              )
            })}

            <button
              type="button"
              onClick={addSplit}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
            >
              + Add another field
            </button>

            <div className={`rounded-lg p-2 text-sm ${splitError ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700'}`}>
              <div className="flex justify-between font-mono">
                <span>Total:</span>
                <span>
                  {splitTotalLb.toLocaleString(undefined, { maximumFractionDigits: 0 })} / {totalNetLb.toLocaleString(undefined, { maximumFractionDigits: 0 })} lb
                  {' · '}
                  {splitTotalPct.toFixed(1)}%
                </span>
              </div>
              {splitError && <div className="mt-1 text-xs">{splitError}</div>}
            </div>
          </div>
        )}
        {form.from_type === 'bin' && (
          <>
            <select value={form.from_bin_id} onChange={(e) => set('from_bin_id', e.target.value)} className={inputCls}>
              <option value="">— select bin —</option>
              {filteredBins.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
            </select>
            {form.crop_id && filteredBins.length === 0 && (
              <p className="text-xs text-amber-700">
                No bins are assigned to this crop. Assign one under Settings → Bins.
              </p>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="border border-slate-200 rounded-xl p-3 space-y-3">
        <legend className="px-2 text-sm font-semibold">To</legend>
        <div className="flex gap-2">
          {(['bin', 'buyer'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set('to_type', t)}
              className={`flex-1 py-2 rounded-lg border ${
                form.to_type === t ? 'bg-green-700 text-white border-green-700' : 'bg-white'
              }`}
            >
              {t === 'bin' ? 'Bin' : 'Buyer'}
            </button>
          ))}
        </div>
        {form.to_type === 'bin' && (
          <>
            <select value={form.to_bin_id} onChange={(e) => set('to_bin_id', e.target.value)} className={inputCls}>
              <option value="">— select bin —</option>
              {filteredBins.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
            </select>
            {form.crop_id && filteredBins.length === 0 && (
              <p className="text-xs text-amber-700">
                No bins are assigned to this crop. Assign one under Settings → Bins.
              </p>
            )}
          </>
        )}
        {form.to_type === 'buyer' && (
          <>
            <select value={form.to_buyer_id} onChange={(e) => { set('to_buyer_id', e.target.value); set('contract_id', '') }} className={inputCls}>
              <option value="">— select buyer —</option>
              {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <label className={labelCls}>
              Contract (filtered to buyer + crop + crop year)
              <select
                value={form.contract_id}
                onChange={(e) => set('contract_id', e.target.value)}
                className={inputCls}
                disabled={cropYearNum == null}
              >
                <option value="">
                  {cropYearNum == null ? 'Select crop year first' : '— none —'}
                </option>
                {buyerContracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.contract_number}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Gross (lb)
          <input type="number" inputMode="decimal" step="0.01" value={form.gross_weight} onChange={(e) => set('gross_weight', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Tare (lb)
          <input type="number" inputMode="decimal" step="0.01" value={form.tare_weight} onChange={(e) => set('tare_weight', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Net (lb) <span className="text-xs text-slate-400">auto</span>
          <input type="number" inputMode="decimal" step="0.01" value={form.net_weight} onChange={(e) => set('net_weight', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Moisture %
          <input type="number" inputMode="decimal" step="0.01" value={form.moisture} onChange={(e) => set('moisture', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Test Weight
          <input type="number" inputMode="decimal" step="0.01" value={form.test_weight} onChange={(e) => set('test_weight', e.target.value)} className={inputCls} />
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
        <div className="text-sm font-semibold text-slate-700">
          Bushels {selectedCrop ? `— base ${selectedCrop.base_moisture_pct ?? '?'}% MC, ${selectedCrop.base_lb_per_bushel ?? '?'} lb/bu` : ''}
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">Wet</div>
            <div className="font-mono text-lg">{fmt(wetBushels)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Dry (auto)</div>
            <div className="font-mono text-lg">{fmt(computedDryBushels)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Shrink</div>
            <div className="font-mono text-lg">{fmt(shrinkBu)}</div>
          </div>
        </div>

        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-sm text-slate-700 flex-1 min-w-[10rem]">
            Dry bushels override <span className="text-xs text-slate-400">optional</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={form.dry_bushels_override}
              onChange={(e) => set('dry_bushels_override', e.target.value)}
              placeholder={computedDryBushels != null ? fmt(computedDryBushels) : ''}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base bg-white"
            />
          </label>
          {form.dry_bushels_override !== '' && (
            <button
              type="button"
              onClick={() => set('dry_bushels_override', '')}
              className="rounded-lg bg-white border border-slate-300 px-3 py-3 text-sm"
            >
              Clear
            </button>
          )}
        </div>

        <div className="text-sm">
          <span className="text-slate-500">Used for reports: </span>
          <span className="font-mono font-semibold">{fmt(dryBushels)} bu</span>
          {overridden && <span className="text-amber-700 text-xs ml-2">(manual override)</span>}
        </div>

        {selectedCrop && selectedCrop.base_lb_per_bushel == null && (
          <p className="text-xs text-amber-700">
            This crop has no base lb/bushel set — auto calc unavailable; enter a dry bushels override.
          </p>
        )}
      </div>

      <label className={labelCls}>
        Ticket #
        <input type="text" value={form.ticket_number} onChange={(e) => set('ticket_number', e.target.value)} className={inputCls} />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-3 sticky bottom-3">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-xl bg-green-700 text-white font-semibold py-4 shadow disabled:opacity-60"
        >
          {busy ? 'Saving…' : mode === 'create' ? 'Save Load' : 'Update Load'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-xl bg-white border border-slate-300 px-4 py-4"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
