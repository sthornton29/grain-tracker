'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from './position-form'
import { contractUnit, fmtCommodityPrice, pnlSizeFor,
  parsePrice,
  parseCottonPriceInput,
  realizedPnl,
  bushelsFor,
  fmtPrice,
  fmtPnl,
  COMMODITY_SPECS,
  type Commodity,
} from '@/lib/hedging'
import type { FuturesPosition } from '@/lib/types'

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

type Props = {
  position: FuturesPosition
  onClose: () => void
  onSaved: () => void
}

export default function ClosePositionDialog({ position, onClose, onSaved }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [closePriceInput, setClosePriceInput] = useState('')
  const [closeDate, setCloseDate] = useState(todayISO())
  const [closeCommission, setCloseCommission] = useState('')
  const [qty, setQty] = useState(String(position.num_contracts))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // P&L size per 1.00 of price (cotton is quoted in cents/lb -> size / 100).
  const sizeBu = pnlSizeFor(position.commodity)
  const closePrice = position.commodity === 'Cotton' ? parseCottonPriceInput(closePriceInput) : parsePrice(closePriceInput)
  const qtyNum = Number(qty)
  const partial = Number.isInteger(qtyNum) && qtyNum > 0 && qtyNum < position.num_contracts
  const closeComm = parsePrice(closeCommission) ?? 0
  // Prorate the original open commission across the contracts being closed.
  const proratedOpenComm =
    qtyNum > 0 ? round2((position.commission ?? 0) * (qtyNum / position.num_contracts)) : 0
  const totalComm = round2(proratedOpenComm + closeComm)

  const preview =
    closePrice != null && Number.isInteger(qtyNum) && qtyNum > 0 && qtyNum <= position.num_contracts
      ? realizedPnl({
          side: position.side,
          tradePrice: position.trade_price,
          closePrice,
          numContracts: qtyNum,
          contractSizeBu: sizeBu,
          commission: totalComm,
        })
      : null

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (closePrice == null || closePrice <= 0) return setErr('Enter a valid close price (e.g. 4.81 or 4.81 1/2).')
    if (!closeDate) return setErr('Pick a close date.')
    if (!Number.isInteger(qtyNum) || qtyNum <= 0 || qtyNum > position.num_contracts) {
      return setErr(`Contracts to close must be between 1 and ${position.num_contracts}.`)
    }

    const gross = realizedPnl({
      side: position.side,
      tradePrice: position.trade_price,
      closePrice,
      numContracts: qtyNum,
      contractSizeBu: sizeBu,
    }).gross

    setBusy(true)
    if (!partial) {
      // Full close — flip this row to closed.
      const { error } = await supabase
        .from('futures_positions')
        .update({
          status: 'closed',
          close_price: closePrice,
          close_date: closeDate,
          realized_pnl: gross,
          commission: round2((position.commission ?? 0) + closeComm),
        })
        .eq('id', position.id)
      if (error) { setBusy(false); setErr(error.message); return }
    } else {
      // Partial close — spin off a new closed row for the closed quantity and
      // leave the remainder open, splitting the open commission proportionally.
      const remainingComm = round2((position.commission ?? 0) - proratedOpenComm)
      const insertRes = await supabase.from('futures_positions').insert({
        entity_id: position.entity_id,
        commodity: position.commodity,
        contract_month: position.contract_month,
        contract_symbol: position.contract_symbol,
        crop_year: position.crop_year,
        side: position.side,
        num_contracts: qtyNum,
        trade_price: position.trade_price,
        trade_date: position.trade_date,
        status: 'closed',
        close_price: closePrice,
        close_date: closeDate,
        realized_pnl: gross,
        commission: totalComm,
        notes: position.notes,
        source: position.source,
      })
      if (insertRes.error) { setBusy(false); setErr(insertRes.error.message); return }
      const updRes = await supabase
        .from('futures_positions')
        .update({ num_contracts: position.num_contracts - qtyNum, commission: remainingComm })
        .eq('id', position.id)
      if (updRes.error) { setBusy(false); setErr(`Closed portion saved, but updating the remainder failed: ${updRes.error.message}`); return }
    }
    setBusy(false)
    onSaved()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base bg-white'
  const labelCls = 'block text-sm text-slate-700'

  return (
    <Modal onClose={onClose} title={`Close ${position.contract_symbol} (${position.side})`}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-slate-500">Position</span>
            <span className="font-semibold capitalize">{position.side} {position.num_contracts} {position.contract_month} {position.commodity}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Entry price</span>
            <span className="font-mono">{fmtCommodityPrice(position.commodity, position.trade_price)}</span></div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Contracts to Close
            <input
              type="number"
              min="1"
              step="1"
              max={position.num_contracts}
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={inputCls}
            />
            <span className="text-xs text-slate-500">
              of {position.num_contracts}{partial ? ' — partial close leaves the rest open' : ''}
            </span>
          </label>
          <label className={labelCls}>
            Close Price ({contractUnit(position.commodity) === 'lbs' ? '$/lb — e.g. 0.6800 (legacy 68.00 also works)' : '$/bu'})
            <input
              type="text"
              inputMode="decimal"
              placeholder="4.81 or 4.81 1/2"
              value={closePriceInput}
              onChange={(e) => setClosePriceInput(e.target.value)}
              className={inputCls}
            />
            {closePriceInput && (
              <span className={`text-xs ${closePrice == null ? 'text-red-600' : 'text-slate-500'}`}>
                {closePrice == null ? 'Unrecognized price' : `= ${fmtCommodityPrice(position.commodity, closePrice)}`}
              </span>
            )}
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Close Date
            <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}>
            Commission &amp; Fees <span className="text-xs text-slate-400">optional</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              value={closeCommission}
              onChange={(e) => setCloseCommission(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>

        {preview && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-500">Bushels closing</span>
              <span className="font-mono">{bushelsFor(qtyNum, sizeBu).toLocaleString()} bu</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Realized P&amp;L (gross)</span>
              <span className={`font-mono ${preview.gross >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(preview.gross)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Commission (open + close)</span>
              <span className="font-mono">{fmtPnl(totalComm)}</span>
            </div>
            <div className="flex justify-between font-semibold border-t border-slate-200 pt-1">
              <span>Net realized P&amp;L</span>
              <span className={`font-mono ${preview.net >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(preview.net)}</span>
            </div>
          </div>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="flex-1 rounded-xl bg-green-700 text-white font-semibold py-3 disabled:opacity-60">
            {busy ? 'Saving…' : partial ? `Close ${qtyNum} Contract${qtyNum === 1 ? '' : 's'}` : 'Close Position'}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-3">
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
