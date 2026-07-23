'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
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

  const monthOptions = useMemo(() => contractMonthOptions(commodity), [commodity])
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

    const sideLabel = side === 'short' ? 'Short' : 'Long'
    const confirmMsg = `${sideLabel} ${n} ${contractMonth} ${commodity} (${symbol}) at ${fmtCommodityPrice(commodity, parsedPrice)} — Crop Year ${cropYear}. Exposure: ${bushels.toLocaleString()} ${contractUnit(commodity)}.`
    if (!editing && !window.confirm(confirmMsg)) return

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
    if (res.error) {
      setErr(res.error.message)
      return
    }
    onSaved()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base bg-white'
  const labelCls = 'block text-sm text-slate-700'

  return (
    <Modal onClose={onClose} title={editing ? 'Edit Position' : 'New Position'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className={labelCls}>
          Entity
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
            <option value="">— none —</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
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
          Contract Month
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
          Crop Year
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <span className="text-xs text-slate-500">Which crop year’s production is this hedge protecting?</span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Number of Contracts
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
            Trade Price ({contractUnit(commodity) === 'lbs' ? '$/lb — e.g. 0.7265 (legacy 72.65 also works)' : '$/bu'})
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
            Trade Date
            <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}>
            Commission &amp; Fees <span className="text-xs text-slate-400">optional</span>
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
            {busy ? 'Saving…' : editing ? 'Update Position' : 'Save Position'}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-3">
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

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
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-5xl' : 'max-w-lg'} my-8`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 sticky top-0 bg-white rounded-t-xl">
          <h2 className="font-bold text-lg flex-1">{title}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
