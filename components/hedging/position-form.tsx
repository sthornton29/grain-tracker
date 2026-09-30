'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createClient } from '@/lib/supabase/client'
import EntitySelect from '@/components/entity-select'
import { defaultEntityId } from '@/lib/entity-default'
import { ConfirmDialog } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'
import {
  COMMODITIES,
  type Commodity,
  type Side,
  buildContractSymbol,
  contractMonthOptions,
  parsePrice,
  parseCottonPriceInput,
  bushelsFor,
  contractUnit,
  fmtCommodityPrice,
  fmtPrice,
  COMMODITY_SPECS,
} from '@/lib/hedging'
import type { Entity, FuturesPosition } from '@/lib/types'

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

function cropYearOptions(): number[] {
  const y = new Date().getFullYear()
  return [y - 1, y, y + 1, y + 2]
}

type Props = {
  entities: Entity[]
  initial?: FuturesPosition // when present, edit instead of insert
  onClose: () => void
  onSaved: () => void
}

export default function PositionForm({ entities, initial, onClose, onSaved }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const editing = !!initial

  const [entityId, setEntityId] = useState(initial?.entity_id ?? '')
  const [commodity, setCommodity] = useState<Commodity>((initial?.commodity as Commodity) ?? 'Corn')
  const [side, setSide] = useState<Side>(initial?.side ?? 'short')
  const [contractMonth, setContractMonth] = useState(initial?.contract_month ?? '')
  const [cropYear, setCropYear] = useState(initial?.crop_year != null ? String(initial.crop_year) : '')
  const [numContracts, setNumContracts] = useState(initial?.num_contracts != null ? String(initial.num_contracts) : '')
  const [tradePriceInput, setTradePriceInput] = useState(initial?.trade_price != null ? String(initial.trade_price) : '')
  const [tradeDate, setTradeDate] = useState(initial?.trade_date ?? todayISO())
  const [commission, setCommission] = useState(initial?.commission ? String(initial.commission) : '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const monthOptions = useMemo(() => contractMonthOptions(commodity), [commodity])
  // Single-entity operation → the entity is auto-assigned by EntitySelect
  // (it renders nothing); hide the wrapper label in step so no orphan
  // "Entity" text remains. Derived from the live entities prop every render.
  const autoEntity = defaultEntityId(entities)
  const entityHidden = autoEntity != null && (!entityId || entityId === autoEntity)
  // Cotton stores ¢/lb but accepts dollar-style entry (0.7265) as well as
  // legacy cents (72.65) via the smart-magnitude guard.
  const parsedPrice = commodity === 'Cotton' ? parseCottonPriceInput(tradePriceInput) : parsePrice(tradePriceInput)
  const n = Number(numContracts)
  const symbol = contractMonth ? buildContractSymbol(commodity, contractMonth) : ''
  const sizeBu = COMMODITY_SPECS[commodity]?.contractSizeBu ?? 5000
  const bushels = Number.isFinite(n) && n > 0 ? bushelsFor(n, sizeBu) : 0

  function onCommodityChange(c: Commodity) {
    setCommodity(c)
    // Clear month — the available cycle differs per commodity.
    setContractMonth('')
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!commodity) return setErr('Pick a commodity.')
    if (!contractMonth) return setErr('Pick a contract month.')
    if (!cropYear) return setErr('Pick the crop year this hedge protects.')
    if (!Number.isInteger(n) || n <= 0) return setErr('Enter a whole number of contracts (1 or more).')
    if (parsedPrice == null || parsedPrice <= 0) return setErr('Enter a valid trade price (e.g. 4.9325 or 4.93 1/4).')
    if (!tradeDate) return setErr('Pick a trade date.')

    // A new position gets a read-back before it is recorded.
    if (!editing) { setConfirmOpen(true); return }
    await doSave()
  }

  async function doSave() {
    setBusy(true)
    const payload = {
      entity_id: entityId || null,
      commodity,
      contract_month: contractMonth,
      contract_symbol: symbol,
      crop_year: Number(cropYear),
      side,
      num_contracts: n,
      trade_price: parsedPrice,
      trade_date: tradeDate,
      commission: parsePrice(commission) ?? 0,
      notes: notes.trim() || null,
      source: initial?.source ?? 'manual',
    }

    const res = editing
      ? await supabase.from('futures_positions').update(payload).eq('id', initial!.id)
      : await supabase.from('futures_positions').insert(payload)
    setBusy(false)
    setConfirmOpen(false)
    if (res.error) {
      setErr(reportError(res.error, { action: editing ? 'save this position' : 'record this position', noun: 'position' }))
      return
    }
    onSaved()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base bg-white min-h-11'
  const labelCls = 'block text-sm text-slate-700'
  const sideLabel = side === 'short' ? 'Short (sold)' : 'Long (bought)'

  return (
    <Modal onClose={onClose} title={editing ? 'Edit position' : 'New position'}>
      <ConfirmDialog
        open={confirmOpen}
        title="Record this position?"
        body={
          <p>
            <b>{sideLabel} {n} {contractMonth} {commodity}</b> ({symbol}) at <b>{fmtCommodityPrice(commodity, parsedPrice)}</b> — crop year {cropYear}.
            Covers {bushels.toLocaleString()} {contractUnit(commodity)}.
          </p>
        }
        confirmLabel="Record position"
        busy={busy}
        onConfirm={() => void doSave()}
        onCancel={() => setConfirmOpen(false)}
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <label className={entityHidden ? 'hidden' : labelCls}>
          Entity
          <EntitySelect entities={entities} value={entityId} onChange={setEntityId} className={inputCls} placeholder="— none —" />
        </label>

        <label className={labelCls}>
          Commodity
          <select value={commodity} onChange={(e) => onCommodityChange(e.target.value as Commodity)} className={inputCls}>
            {COMMODITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        <div>
          <span className={labelCls}>Side</span>
          <div className="mt-1 flex gap-2">
            {(['short', 'long'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`flex-1 py-2 rounded-lg border capitalize ${
                  side === s ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1">Farmers usually sell (short) to hedge production.</p>
        </div>

        <label className={labelCls}>
          Contract month
          <select value={contractMonth} onChange={(e) => setContractMonth(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {/* Keep the original month available when editing even if it has rolled off the 2-year window. */}
            {initial?.contract_month && !monthOptions.some((m) => m.label === initial.contract_month) && (
              <option value={initial.contract_month}>{initial.contract_month}</option>
            )}
            {monthOptions.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
          </select>
        </label>

        <label className={labelCls}>
          Crop year
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <span className="text-xs text-slate-500">Which crop year’s production is this hedge protecting?</span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Number of contracts
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={numContracts}
              onChange={(e) => setNumContracts(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Trade price ({contractUnit(commodity) === 'lbs' ? '$/lb — e.g. 0.7265 (72.65 also works)' : '$/bu'})
            <input
              type="text"
              inputMode="decimal"
              placeholder="4.9325 or 4.93 1/4"
              value={tradePriceInput}
              onChange={(e) => setTradePriceInput(e.target.value)}
              className={inputCls}
            />
            {tradePriceInput && (
              <span className={`text-xs ${parsedPrice == null ? 'text-red-600' : 'text-slate-500'}`}>
                {parsedPrice == null ? 'Unrecognized price' : `= ${fmtCommodityPrice(commodity, parsedPrice)}`}
              </span>
            )}
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Trade date
            <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}>
            Commission &amp; fees <span className="text-xs text-slate-400">optional</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>

        <label className={labelCls}>
          Notes <span className="text-xs text-slate-400">optional</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">Contract symbol</span>
            <span className="font-mono font-semibold">{symbol || '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Exposure</span>
            <span className="font-mono">{bushels ? bushels.toLocaleString() : '—'} {contractUnit(commodity)}</span>
          </div>
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold py-3 disabled:opacity-60"
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Save position'}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-3">
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

// The hedging dialogs' shell — the same contract as components/app-dialog's
// AppModal (portaled to document.body, role="dialog", aria-modal, Escape
// closes, Tab stays inside, focus restored on close) with its own widths:
// `wide` gives the statement-import review room for its tables. Sits BELOW
// the app dialogs' z-40 so a ConfirmDialog opened from inside it shows on top.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}) {
  const [mounted, setMounted] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const restore = useRef<HTMLElement | null>(null)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    restore.current = (document.activeElement as HTMLElement | null) ?? null
    function onKey(e: KeyboardEvent) {
      // Only the topmost dialog answers the keyboard — a ConfirmDialog opened
      // from inside this one takes Escape/Tab for itself.
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== panel.current) return
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      restore.current?.focus?.()
    }
  }, [onClose])

  if (!mounted) return null
  return createPortal(
    <div className="fixed inset-0 z-30 bg-black/40 flex items-start justify-center overflow-y-auto p-4 no-print" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hedging-dialog-title"
        className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-5xl' : 'max-w-lg'} my-8`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 sticky top-0 bg-white rounded-t-xl z-10">
          <h2 id="hedging-dialog-title" className="font-bold text-lg flex-1">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 text-2xl leading-none min-h-10 min-w-10">×</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
