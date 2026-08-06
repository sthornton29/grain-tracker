'use client'

import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { estimateTransferBushels, overInventoryMessage } from '@/lib/bin-inventory'
import type { BinTransfer } from '@/lib/types'

export type TransferBinOption = {
  id: string
  name: string
  siteName: string | null
  cropId: string | null
}

type SharedProps = {
  bins: TransferBinOption[]
  crops: { id: string; name: string }[]
  /** bin_id → crop_id → dry bushels currently on hand (for the over-inventory warning + crop default). */
  onHand: Record<string, Record<string, number>>
}

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${m}/${d}/${y}`
}

function fmtBu(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** The from-bin's crop with the most grain in it; falls back to the bin's assigned crop. */
function dominantCropId(binId: string, onHand: SharedProps['onHand'], bins: TransferBinOption[]): string {
  const inner = onHand[binId]
  if (inner) {
    let best = ''
    let bestBu = 0
    for (const [cid, bu] of Object.entries(inner)) {
      if (bu > bestBu) { best = cid; bestBu = bu }
    }
    if (best) return best
  }
  return bins.find((b) => b.id === binId)?.cropId ?? ''
}

function TransferPanel({
  bins, crops, onHand, existing, initialFromBinId, onDone,
}: SharedProps & {
  existing?: BinTransfer
  initialFromBinId?: string
  onDone: () => void
}) {
  const router = useRouter()
  const startFrom = existing?.from_bin_id ?? initialFromBinId ?? ''
  const [fromBinId, setFromBinId] = useState(startFrom)
  const [toBinId, setToBinId] = useState(existing?.to_bin_id ?? '')
  const [cropId, setCropId] = useState(existing?.crop_id ?? (startFrom ? dominantCropId(startFrom, onHand, bins) : ''))
  const [date, setDate] = useState(existing?.transfer_date ?? todayISO())
  const [mode, setMode] = useState<'entered' | 'estimated'>(existing?.method ?? 'entered')
  const [throughput, setThroughput] = useState(existing?.throughput_bu_per_hr != null ? String(existing.throughput_bu_per_hr) : '')
  const [hours, setHours] = useState(existing?.hours_run != null ? String(existing.hours_run) : '')
  const [bushels, setBushels] = useState(existing ? String(existing.bushels) : '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Radio-group name must be unique per open panel (several bin cards can
  // have their panels open at once).
  const modeGroup = useId()

  // Remember the last throughput used: prefer this from-bin's most recent
  // estimated transfer, fall back to the operation's most recent one.
  useEffect(() => {
    if (existing || throughput !== '') return
    let cancelled = false
    async function loadLast() {
      const supabase = createClient()
      const { data } = await supabase
        .from('bin_transfers')
        .select('from_bin_id, throughput_bu_per_hr')
        .eq('method', 'estimated')
        .not('throughput_bu_per_hr', 'is', null)
        .order('created_at', { ascending: false })
        .limit(25)
      if (cancelled || !data || data.length === 0) return
      const forBin = fromBinId ? data.find((r) => r.from_bin_id === fromBinId) : null
      const pick = forBin ?? data[0]
      if (pick?.throughput_bu_per_hr != null) setThroughput(String(pick.throughput_bu_per_hr))
    }
    loadLast()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromBinId])

  function pickFrom(id: string) {
    setFromBinId(id)
    if (id && id === toBinId) setToBinId('')
    setCropId(id ? dominantCropId(id, onHand, bins) : '')
  }

  const estimate = estimateTransferBushels(
    throughput === '' ? null : Number(throughput),
    hours === '' ? null : Number(hours),
  )

  function applyEstimate(nextThroughput: string, nextHours: string) {
    const est = estimateTransferBushels(
      nextThroughput === '' ? null : Number(nextThroughput),
      nextHours === '' ? null : Number(nextHours),
    )
    if (est != null) setBushels(String(est))
  }

  async function save() {
    setErr(null)
    if (!fromBinId) { setErr('Pick the bin the grain came from.'); return }
    if (!toBinId) { setErr('Pick the bin the grain went to.'); return }
    if (fromBinId === toBinId) { setErr('From and To must be different bins.'); return }
    if (!cropId) { setErr('Pick a crop.'); return }
    if (!date) { setErr('Pick a date.'); return }
    const bu = Number(bushels)
    if (!Number.isFinite(bu) || bu <= 0) { setErr('Bushels must be positive.'); return }

    // Over-inventory check: warn clearly, but let the user proceed — bin
    // inventory is an estimate and the operator may know better.
    const fromBin = bins.find((b) => b.id === fromBinId)
    const cropName = crops.find((c) => c.id === cropId)?.name ?? 'grain'
    let available = onHand[fromBinId]?.[cropId] ?? 0
    if (existing && existing.from_bin_id === fromBinId && existing.crop_id === cropId) {
      // When editing, the saved transfer already reduced the source — judge
      // the new amount against inventory as if this transfer didn't exist.
      available += Number(existing.bushels)
    }
    const warning = overInventoryMessage({
      moving: bu,
      onHandBu: available,
      fromBinName: fromBin?.name ?? 'this bin',
      cropName,
    })
    if (warning && !confirm(warning)) return

    setBusy(true)
    const supabase = createClient()
    const payload = {
      from_bin_id: fromBinId,
      to_bin_id: toBinId,
      crop_id: cropId,
      bushels: bu,
      transfer_date: date,
      method: mode,
      throughput_bu_per_hr: mode === 'estimated' && throughput !== '' ? Number(throughput) : null,
      hours_run: mode === 'estimated' && hours !== '' ? Number(hours) : null,
      notes: notes.trim() || null,
    }
    const { error } = existing
      ? await supabase.from('bin_transfers').update(payload).eq('id', existing.id)
      : await supabase.from('bin_transfers').insert(payload)
    setBusy(false)
    if (error) { setErr(error.message); return }
    onDone()
    router.refresh()
  }

  const inputCls = 'w-full rounded-lg border border-slate-300 px-2 py-1 text-sm'
  const binLabel = (b: TransferBinOption) => `${b.name}${b.siteName ? ` · ${b.siteName}` : ''}`

  return (
    <div className="w-full mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
      <div className="text-sm font-semibold">{existing ? 'Edit transfer' : 'Transfer grain between bins'}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-slate-700">
          From bin
          <select value={fromBinId} onChange={(e) => pickFrom(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {bins.map((b) => <option key={b.id} value={b.id}>{binLabel(b)}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">
          To bin
          <select value={toBinId} onChange={(e) => setToBinId(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {bins.filter((b) => b.id !== fromBinId).map((b) => <option key={b.id} value={b.id}>{binLabel(b)}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">
          Crop
          <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        </label>
      </div>

      <div className="flex gap-4 text-xs text-slate-700 pt-1">
        <label className="flex items-center gap-1">
          <input type="radio" name={modeGroup} checked={mode === 'entered'} onChange={() => setMode('entered')} />
          Enter bushels
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name={modeGroup} checked={mode === 'estimated'} onChange={() => setMode('estimated')} />
          Estimate from run time
        </label>
      </div>

      {mode === 'estimated' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="text-xs text-slate-700">
            Throughput (bu/hr)
            <input
              type="number" inputMode="decimal" step="1" min="0"
              value={throughput}
              onChange={(e) => { setThroughput(e.target.value); applyEstimate(e.target.value, hours) }}
              placeholder="e.g. 850"
              className={inputCls}
            />
          </label>
          <label className="text-xs text-slate-700">
            Hours run
            <input
              type="number" inputMode="decimal" step="0.1" min="0"
              value={hours}
              onChange={(e) => { setHours(e.target.value); applyEstimate(throughput, e.target.value) }}
              placeholder="e.g. 2.5"
              className={inputCls}
            />
          </label>
          {estimate != null && (
            <p className="sm:col-span-2 text-xs text-slate-600">
              {fmtBu(Number(throughput))} bu/hr × {fmtBu(Number(hours))} hr ≈ <strong>{fmtBu(estimate)} bu</strong> — adjust below if needed.
            </p>
          )}
        </div>
      )}

      <label className="text-xs text-slate-700 block">
        Bushels (dry)
        <input
          type="number" inputMode="decimal" step="0.01" min="0"
          value={bushels}
          onChange={(e) => setBushels(e.target.value)}
          placeholder="e.g. 2125"
          className={inputCls}
        />
      </label>
      <label className="text-xs text-slate-700 block">
        Notes <span className="text-slate-400">(optional)</span>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder='e.g. "Moved after drying"'
          className={inputCls}
        />
      </label>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="text-xs rounded-lg bg-brand hover:bg-brand-deep text-white font-semibold px-3 py-1 disabled:opacity-50"
        >
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Record transfer'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-xs rounded-lg bg-white border border-slate-300 px-3 py-1"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function TransferGrainButton({
  bins, crops, onHand, defaultFromBinId, prominent,
}: SharedProps & { defaultFromBinId?: string; prominent?: boolean }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={prominent
          ? 'rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50'
          : 'text-xs rounded-lg bg-white border border-slate-300 px-2 py-1 hover:bg-slate-50'}
        title="Record grain moved from one bin to another"
      >
        Transfer grain
      </button>
    )
  }
  return (
    <TransferPanel
      bins={bins}
      crops={crops}
      onHand={onHand}
      initialFromBinId={defaultFromBinId}
      onDone={() => setOpen(false)}
    />
  )
}

export function BinTransferHistory({
  binId, transfers, bins, crops, onHand,
}: SharedProps & {
  binId: string
  /** Transfers involving this bin, newest first. */
  transfers: BinTransfer[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  if (transfers.length === 0) return null

  const binName = (id: string) => bins.find((b) => b.id === id)?.name ?? '(deleted bin)'
  const cropName = (id: string) => crops.find((c) => c.id === id)?.name ?? '—'

  async function remove(t: BinTransfer) {
    const dir = t.to_bin_id === binId ? `in from ${binName(t.from_bin_id)}` : `out to ${binName(t.to_bin_id)}`
    if (!confirm(`Delete this transfer of ${fmtBu(Number(t.bushels))} bu ${dir}? Inventory in both bins will be recalculated.`)) return
    const supabase = createClient()
    const { error } = await supabase.from('bin_transfers').delete().eq('id', t.id)
    if (error) { setErr(error.message); return }
    setErr(null)
    router.refresh()
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-xs text-slate-600 underline decoration-dotted"
      >
        {open ? 'Hide transfers' : `Transfers (${transfers.length})`}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 text-xs text-slate-600 border-l-2 border-slate-200 pl-2">
          {transfers.map((t) => {
            const incoming = t.to_bin_id === binId
            return (
              <li key={t.id}>
                {editing === t.id ? (
                  <TransferPanel
                    bins={bins}
                    crops={crops}
                    onHand={onHand}
                    existing={t}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  <div className="flex items-start gap-2 flex-wrap">
                    <span className="flex-1 min-w-0">
                      {fmtDate(t.transfer_date)} · <strong>{incoming ? 'In' : 'Out'}</strong>{' '}
                      {fmtBu(Number(t.bushels))} bu {cropName(t.crop_id)}{' '}
                      {incoming ? `from ${binName(t.from_bin_id)}` : `to ${binName(t.to_bin_id)}`}
                      {t.method === 'estimated' && (
                        <span className="text-slate-400">
                          {' '}— estimated{t.throughput_bu_per_hr != null && t.hours_run != null
                            ? ` (${fmtBu(Number(t.throughput_bu_per_hr))} bu/hr × ${fmtBu(Number(t.hours_run))} hr)`
                            : ''}
                        </span>
                      )}
                      {t.notes && <span className="text-slate-400"> — {t.notes}</span>}
                    </span>
                    <button type="button" onClick={() => setEditing(t.id)} className="text-brand-deep">Edit</button>
                    <button type="button" onClick={() => remove(t)} className="text-red-600">Delete</button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
    </div>
  )
}
