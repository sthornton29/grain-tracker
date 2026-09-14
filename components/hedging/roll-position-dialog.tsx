'use client'

// "Roll…" on an open position (083): close this leg and open the next
// contract month in ONE step — new month, close price, new open price, date,
// fees — executed through the real workflows in one database transaction
// (hedge_execute_roll), so the closed leg and the new leg are linked, the
// new leg inherits the crop year and entity, and the history trail records
// both halves as one roll.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from './position-form'
import { executeRoll, rollRealized } from '@/lib/hedge-roll'
import { effectiveEntry } from '@/lib/hedge-lineage'
import {
  contractMonthOptions,
  contractUnit,
  fmtCommodityPrice,
  fmtPnl,
  parseCottonPriceInput,
  parsePrice,
  roundPrice,
  fmtQuantity,
} from '@/lib/hedging'
import type { FuturesPosition } from '@/lib/types'

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

type Props = {
  position: FuturesPosition
  /** Every position (for the lineage / effective price preview). */
  allPositions: FuturesPosition[]
  onClose: () => void
  onSaved: () => void
}

export default function RollPositionDialog({ position, allPositions, onClose, onSaved }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [toMonth, setToMonth] = useState('')
  const [qty, setQty] = useState(String(position.num_contracts))
  const [closePriceInput, setClosePriceInput] = useState('')
  const [openPriceInput, setOpenPriceInput] = useState('')
  const [date, setDate] = useState(todayISO())
  const [fees, setFees] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const monthOptions = useMemo(
    () => contractMonthOptions(position.commodity).filter((m) => m.label !== position.contract_month),
    [position.commodity, position.contract_month],
  )
  const isCotton = position.commodity === 'Cotton'
  const parse = (s: string) => (isCotton ? parseCottonPriceInput(s) : parsePrice(s))
  const closePrice = parse(closePriceInput)
  const openPrice = parse(openPriceInput)
  const qtyNum = Number(qty)
  const qtyOk = Number.isInteger(qtyNum) && qtyNum > 0 && qtyNum <= position.num_contracts
  const partial = qtyOk && qtyNum < position.num_contracts
  const feesNum = parsePrice(fees) ?? 0

  const realized = closePrice != null && qtyOk
    ? rollRealized({ side: position.side, commodity: position.commodity, tradePrice: Number(position.trade_price), closePrice, quantity: qtyNum })
    : null
  const spread = closePrice != null && openPrice != null ? roundPrice(openPrice - closePrice) : null
  // Effective entry so far (this leg may itself be a rolled-into leg) + this roll's spread.
  const soFar = useMemo(() => effectiveEntry(position, allPositions), [position, allPositions])
  const effectiveAfter = spread != null ? roundPrice(soFar.effectivePrice + spread) : null

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!toMonth) return setErr('Pick the contract month to roll into.')
    if (!qtyOk) return setErr(`Contracts to roll must be between 1 and ${position.num_contracts}.`)
    if (closePrice == null || closePrice <= 0) return setErr('Enter the price this leg closed at.')
    if (openPrice == null || openPrice <= 0) return setErr('Enter the price the new leg opened at.')
    if (!date) return setErr('Pick the roll date.')
    setBusy(true)
    const { error } = await executeRoll(supabase, {
      source: 'roll_action',
      closePrice,
      closeDate: date,
      fees: feesNum,
      closedLegs: [{
        positionId: position.id,
        quantity: qtyNum,
        side: position.side,
        commodity: position.commodity,
        tradePrice: Number(position.trade_price),
      }],
      open: {
        row: { contract_month: toMonth, num_contracts: qtyNum, trade_price: openPrice, trade_date: date, commission: 0 },
      },
    })
    setBusy(false)
    if (error) { setErr(error); return }
    onSaved()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base bg-white'
  const labelCls = 'block text-sm text-slate-700'
  const unitHint = contractUnit(position.commodity) === 'lbs' ? '$/lb — e.g. 0.6800' : '$/bu — e.g. 5.43 1/2'

  return (
    <Modal onClose={onClose} title={`Roll ${position.contract_month} ${position.commodity} (${position.side})`}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-slate-500">Position</span>
            <span className="font-semibold capitalize">{position.side} {position.num_contracts} {position.contract_month} {position.commodity}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Entry price</span>
            <span className="font-mono">{fmtCommodityPrice(position.commodity, position.trade_price)}</span></div>
          {soFar.steps.length > 0 && (
            <div className="flex justify-between"><span className="text-slate-500">Effective since {soFar.originalMonth} @ {fmtCommodityPrice(position.commodity, soFar.originalEntry)}</span>
              <span className="font-mono">{fmtCommodityPrice(position.commodity, soFar.effectivePrice)}</span></div>
          )}
          <div className="flex justify-between"><span className="text-slate-500">Crop year</span>
            <span className="font-semibold">{position.crop_year} <span className="text-xs font-normal text-slate-500">— the new leg keeps it</span></span></div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Roll into
            <select value={toMonth} onChange={(e) => setToMonth(e.target.value)} className={inputCls}>
              <option value="">— month —</option>
              {monthOptions.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Contracts to roll
            <input type="number" min="1" step="1" max={position.num_contracts} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
            <span className="text-xs text-slate-500">of {position.num_contracts}{partial ? ' — the rest stays open' : ''}</span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Close {position.contract_month} at ({unitHint})
            <input type="text" inputMode="decimal" value={closePriceInput} onChange={(e) => setClosePriceInput(e.target.value)} className={inputCls} />
            {closePriceInput && <span className={`text-xs ${closePrice == null ? 'text-red-600' : 'text-slate-500'}`}>{closePrice == null ? 'Unrecognized price' : `= ${fmtCommodityPrice(position.commodity, closePrice)}`}</span>}
          </label>
          <label className={labelCls}>
            Open {toMonth || 'new month'} at
            <input type="text" inputMode="decimal" value={openPriceInput} onChange={(e) => setOpenPriceInput(e.target.value)} className={inputCls} />
            {openPriceInput && <span className={`text-xs ${openPrice == null ? 'text-red-600' : 'text-slate-500'}`}>{openPrice == null ? 'Unrecognized price' : `= ${fmtCommodityPrice(position.commodity, openPrice)}`}</span>}
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Roll date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}>
            Commission &amp; fees <span className="text-xs text-slate-400">both legs, optional</span>
            <input type="number" step="0.01" inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} className={inputCls} />
          </label>
        </div>

        {(realized != null || spread != null) && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
            {qtyOk && (
              <div className="flex justify-between"><span className="text-slate-500">Quantity rolling</span>
                <span className="font-mono">{fmtQuantity(position.commodity, qtyNum)}</span></div>
            )}
            {realized != null && (
              <div className="flex justify-between"><span className="text-slate-500">Realized on {position.contract_month} (before fees)</span>
                <span className={`font-mono ${realized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(realized)}</span></div>
            )}
            {spread != null && (
              <div className="flex justify-between"><span className="text-slate-500">Roll spread (new open − close)</span>
                <span className="font-mono">{spread >= 0 ? '+' : ''}{fmtCommodityPrice(position.commodity, spread)}</span></div>
            )}
            {effectiveAfter != null && (
              <div className="flex justify-between font-semibold border-t border-slate-200 pt-1"><span>Effective price since {soFar.originalMonth}</span>
                <span className="font-mono">{fmtCommodityPrice(position.commodity, effectiveAfter)}</span></div>
            )}
          </div>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="flex-1 rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold py-3 disabled:opacity-60">
            {busy ? 'Saving…' : `Roll ${qtyOk ? qtyNum : ''} into ${toMonth || '…'}`}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-3">Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
