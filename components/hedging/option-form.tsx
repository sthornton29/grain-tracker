'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from './position-form'
import {
  COMMODITIES,
  type Commodity,
  type OptionType,
  type OptionSide,
  buildContractSymbol,
  contractMonthOptions,
  parsePrice,
  parseFractional,
  optionPremiumTotal,
  fmtPrice,
  fmtCents,
  COMMODITY_SPECS,
} from '@/lib/hedging'
import type { Entity, OptionPosition } from '@/lib/types'

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}
function cropYearOptions(): number[] {
  const y = new Date().getFullYear()
  return [y - 1, y, y + 1, y + 2]
}
function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
// Farmers typically buy puts for downside protection and sell calls for income.
function defaultSideFor(type: OptionType): OptionSide {
  return type === 'put' ? 'buy' : 'sell'
}

type Props = {
  entities: Entity[]
  initial?: OptionPosition
  onClose: () => void
  onSaved: () => void
}

export default function OptionForm({ entities, initial, onClose, onSaved }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const editing = !!initial

  const [entityId, setEntityId] = useState(initial?.entity_id ?? '')
  const [commodity, setCommodity] = useState<Commodity>((initial?.commodity as Commodity) ?? 'Corn')
  const [optionType, setOptionType] = useState<OptionType>(initial?.option_type ?? 'put')
  const [side, setSide] = useState<OptionSide>(initial?.side ?? 'buy')
  const [month, setMonth] = useState(initial?.underlying_contract_month ?? '')
  const [strikeInput, setStrikeInput] = useState(initial?.strike_price != null ? String(initial.strike_price) : '')
  const [numContracts, setNumContracts] = useState(initial?.num_contracts != null ? String(initial.num_contracts) : '')
  const [premiumInput, setPremiumInput] = useState(initial?.premium_cents != null ? String(initial.premium_cents) : '')
  const [tradeDate, setTradeDate] = useState(initial?.trade_date ?? todayISO())
  const [expiration, setExpiration] = useState(initial?.expiration_date ?? '')
  const [cropYear, setCropYear] = useState(initial?.crop_year != null ? String(initial.crop_year) : '')
  const [commission, setCommission] = useState(initial?.commission ? String(initial.commission) : '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const monthOptions = useMemo(() => contractMonthOptions(commodity), [commodity])
  const strike = parsePrice(strikeInput)
  const premiumCents = parseFractional(premiumInput)
  const n = Number(numContracts)
  const symbol = month ? buildContractSymbol(commodity, month) : ''
  const sizeBu = COMMODITY_SPECS[commodity]?.contractSizeBu ?? 5000
  const total = premiumCents != null && Number.isInteger(n) && n > 0 ? optionPremiumTotal(premiumCents, n, sizeBu) : null

  function onTypeChange(t: OptionType) {
    setOptionType(t)
    if (!editing) setSide(defaultSideFor(t))
  }
  function onCommodityChange(c: Commodity) {
    setCommodity(c)
    setMonth('')
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!month) return setErr('Pick the underlying contract month.')
    if (strike == null || strike <= 0) return setErr('Enter a valid strike price (e.g. 4.80 or 4.80 1/2).')
    if (!Number.isInteger(n) || n <= 0) return setErr('Enter a whole number of contracts.')
    if (premiumCents == null || premiumCents < 0) return setErr('Enter a valid premium in cents (e.g. 15.5 or 15 1/2).')
    if (!cropYear) return setErr('Pick the crop year this hedge protects.')
    if (!tradeDate) return setErr('Pick a trade date.')

    const sideCap = side === 'buy' ? 'Buy' : 'Sell'
    const typeCap = optionType === 'put' ? 'Put' : 'Call'
    const confirmMsg = `${sideCap} ${n} ${month} ${commodity} ${fmtPrice(strike)} ${typeCap}s at ${fmtCents(premiumCents)}/bu — Total premium: ${fmtUsd(total ?? 0)} — Crop Year ${cropYear}`
    if (!editing && !window.confirm(confirmMsg)) return

    setBusy(true)
    const payload = {
      entity_id: entityId || null,
      commodity,
      option_type: optionType,
      side,
      underlying_contract_month: month,
      underlying_symbol: symbol,
      strike_price: strike,
      num_contracts: n,
      premium_cents: premiumCents,
      trade_date: tradeDate,
      expiration_date: expiration || null,
      crop_year: Number(cropYear),
      commission: parseFractional(commission) ?? 0,
      notes: notes.trim() || null,
      source: initial?.source ?? 'manual',
    }
    const res = editing
      ? await supabase.from('options_positions').update(payload).eq('id', initial!.id)
      : await supabase.from('options_positions').insert(payload)
    setBusy(false)
    if (res.error) { setErr(res.error.message); return }
    onSaved()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base bg-white'
  const labelCls = 'block text-sm text-slate-700'

  return (
    <Modal onClose={onClose} title={editing ? 'Edit Option Position' : 'New Option Position'}>
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>Option Type</span>
            <div className="mt-1 flex gap-2">
              {(['put', 'call'] as const).map((t) => (
                <button key={t} type="button" onClick={() => onTypeChange(t)}
                  className={`flex-1 py-2 rounded-lg border capitalize ${optionType === t ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className={labelCls}>Side</span>
            <div className="mt-1 flex gap-2">
              {(['buy', 'sell'] as const).map((s) => (
                <button key={s} type="button" onClick={() => setSide(s)}
                  className={`flex-1 py-2 rounded-lg border capitalize ${side === s ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white border-slate-300'}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className={labelCls}>
          Underlying Contract Month
          <select value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {initial?.underlying_contract_month && !monthOptions.some((m) => m.label === initial.underlying_contract_month) && (
              <option value={initial.underlying_contract_month}>{initial.underlying_contract_month}</option>
            )}
            {monthOptions.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Strike Price ($/bu)
            <input type="text" inputMode="decimal" placeholder="4.80 or 4.80 1/2" value={strikeInput} onChange={(e) => setStrikeInput(e.target.value)} className={inputCls} />
            {strikeInput && <span className={`text-xs ${strike == null ? 'text-red-600' : 'text-slate-500'}`}>{strike == null ? 'Unrecognized' : `= ${fmtPrice(strike)}`}</span>}
          </label>
          <label className={labelCls}>
            Number of Contracts
            <input type="number" min="1" step="1" inputMode="numeric" value={numContracts} onChange={(e) => setNumContracts(e.target.value)} className={inputCls} />
          </label>
        </div>

        <label className={labelCls}>
          Premium (¢/bu)
          <input type="text" inputMode="decimal" placeholder="15.5 or 15 1/2" value={premiumInput} onChange={(e) => setPremiumInput(e.target.value)} className={inputCls} />
          {premiumCents != null && Number.isInteger(n) && n > 0 ? (
            <span className="text-xs text-slate-600">
              Total premium: <b>{fmtUsd(total ?? 0)}</b> ({fmtCents(premiumCents)} × {n} contracts × {sizeBu.toLocaleString()} bu)
            </span>
          ) : premiumInput && premiumCents == null ? (
            <span className="text-xs text-red-600">Unrecognized premium</span>
          ) : null}
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Trade Date
            <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}>
            Expiration <span className="text-xs text-slate-400">optional</span>
            <input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} className={inputCls} />
          </label>
        </div>

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
            Commission &amp; Fees <span className="text-xs text-slate-400">optional</span>
            <input type="number" step="0.01" inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}>
            Notes <span className="text-xs text-slate-400">optional</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
          </label>
        </div>

        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm flex justify-between">
          <span className="text-slate-500">Underlying symbol</span>
          <span className="font-mono font-semibold">{symbol || '—'}</span>
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="flex-1 rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold py-3 disabled:opacity-60">
            {busy ? 'Saving…' : editing ? 'Update Option' : 'Save Option'}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-3">Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
