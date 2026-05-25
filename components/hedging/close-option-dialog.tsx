'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from './position-form'
import {
  parseFractional,
  optionOffsetPnl,
  optionFullPremiumPnl,
  optionPremiumTotal,
  exerciseFuturesSide,
  fmtPrice,
  fmtCents,
  fmtPnl,
  COMMODITY_SPECS,
  type Commodity,
} from '@/lib/hedging'
import type { OptionPosition } from '@/lib/types'

type Scenario = 'offset' | 'expired' | 'exercise'

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}
function round2(n: number) {
  return Math.round(n * 100) / 100
}
function fmtUsd(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type Props = {
  position: OptionPosition
  onClose: () => void
  onSaved: () => void
}

export default function CloseOptionDialog({ position, onClose, onSaved }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const sizeBu = COMMODITY_SPECS[position.commodity as Commodity]?.contractSizeBu ?? 5000

  const [scenario, setScenario] = useState<Scenario>('offset')
  const [qty, setQty] = useState(String(position.num_contracts))
  const [closeCentsInput, setCloseCentsInput] = useState('')
  const [closeDate, setCloseDate] = useState(todayISO())
  const [commissionInput, setCommissionInput] = useState('')
  const [expirationDate, setExpirationDate] = useState(position.expiration_date ?? todayISO())
  const [exerciseDate, setExerciseDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const qtyNum = Number(qty)
  const validQty = Number.isInteger(qtyNum) && qtyNum > 0 && qtyNum <= position.num_contracts
  const partial = validQty && qtyNum < position.num_contracts
  const closeCents = parseFractional(closeCentsInput)
  const closeComm = parseFractional(commissionInput) ?? 0
  const proratedOpenComm = validQty ? round2((position.commission ?? 0) * (qtyNum / position.num_contracts)) : 0

  const futuresSide = exerciseFuturesSide(position.option_type, position.side)
  const premiumTotalForQty = validQty ? optionPremiumTotal(position.premium_cents, qtyNum, sizeBu) : 0

  // Realized P&L preview for the selected scenario.
  const preview: number | null = (() => {
    if (!validQty) return null
    if (scenario === 'offset') {
      if (closeCents == null) return null
      return optionOffsetPnl({
        side: position.side,
        premiumCents: position.premium_cents,
        closeCents,
        numContracts: qtyNum,
        contractSizeBu: sizeBu,
        commission: proratedOpenComm + closeComm,
      })
    }
    return optionFullPremiumPnl({
      side: position.side,
      premiumCents: position.premium_cents,
      numContracts: qtyNum,
      contractSizeBu: sizeBu,
      commission: proratedOpenComm,
    })
  })()

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!validQty) return setErr(`Contracts to close must be between 1 and ${position.num_contracts}.`)
    if (scenario === 'offset' && (closeCents == null || closeCents < 0)) return setErr('Enter a valid closing premium in cents (e.g. 4.5 or 4 1/2).')
    if (scenario === 'offset' && !closeDate) return setErr('Pick a close date.')
    if (scenario === 'expired' && !expirationDate) return setErr('Pick the expiration date.')
    if (scenario === 'exercise' && !exerciseDate) return setErr('Pick the exercise date.')

    const realized = preview ?? 0

    if (scenario === 'exercise') {
      const verb = position.side === 'buy' ? 'cost' : 'income'
      const msg = `Exercising this ${position.option_type} will create a ${futuresSide.toUpperCase()} futures position in ${position.underlying_contract_month} ${position.commodity} at ${fmtPrice(position.strike_price)} (the strike price). The premium of ${fmtCents(position.premium_cents)}/bu (${fmtUsd(premiumTotalForQty)}) will be recorded as a realized ${verb}. Continue?`
      if (!window.confirm(msg)) return
    }

    setBusy(true)

    // Exercise creates a futures position first so we can link it.
    let exercisedPositionId: string | null = null
    if (scenario === 'exercise') {
      const { data, error } = await supabase
        .from('futures_positions')
        .insert({
          entity_id: position.entity_id,
          commodity: position.commodity,
          contract_month: position.underlying_contract_month,
          contract_symbol: position.underlying_symbol,
          crop_year: position.crop_year,
          side: futuresSide,
          num_contracts: qtyNum,
          trade_price: position.strike_price,
          trade_date: exerciseDate,
          status: 'open',
          commission: 0,
          notes: `Exercised from ${position.option_type} option, strike ${fmtPrice(position.strike_price)}, original premium ${position.premium_cents}¢/bu`,
          source: 'manual',
        })
        .select('id')
        .single()
      if (error || !data) { setBusy(false); setErr(`Could not create futures position: ${error?.message ?? 'unknown error'}`); return }
      exercisedPositionId = (data as { id: string }).id
    }

    const status = scenario === 'offset' ? 'closed_offset' : scenario === 'expired' ? 'expired_worthless' : 'exercised'
    const closedDateForRow = scenario === 'offset' ? closeDate : scenario === 'expired' ? expirationDate : exerciseDate

    if (!partial) {
      const update: Record<string, unknown> = {
        status,
        close_date: closedDateForRow,
        realized_pnl: realized,
        exercised_position_id: exercisedPositionId,
      }
      if (scenario === 'offset') {
        update.close_price_cents = closeCents
        update.commission = round2((position.commission ?? 0) + closeComm)
      }
      const { error } = await supabase.from('options_positions').update(update).eq('id', position.id)
      if (error) { setBusy(false); setErr(error.message); return }
    } else {
      // Spin off a new closed row for the closed quantity; reduce the remainder.
      const newComm = scenario === 'offset' ? round2(proratedOpenComm + closeComm) : proratedOpenComm
      const insRes = await supabase.from('options_positions').insert({
        entity_id: position.entity_id,
        commodity: position.commodity,
        option_type: position.option_type,
        side: position.side,
        underlying_contract_month: position.underlying_contract_month,
        underlying_symbol: position.underlying_symbol,
        strike_price: position.strike_price,
        num_contracts: qtyNum,
        premium_cents: position.premium_cents,
        trade_date: position.trade_date,
        expiration_date: position.expiration_date,
        crop_year: position.crop_year,
        status,
        close_price_cents: scenario === 'offset' ? closeCents : null,
        close_date: closedDateForRow,
        realized_pnl: realized,
        commission: newComm,
        exercised_position_id: exercisedPositionId,
        notes: position.notes,
        source: position.source,
      })
      if (insRes.error) { setBusy(false); setErr(insRes.error.message); return }
      const { error: updErr } = await supabase
        .from('options_positions')
        .update({ num_contracts: position.num_contracts - qtyNum, commission: round2((position.commission ?? 0) - proratedOpenComm) })
        .eq('id', position.id)
      if (updErr) { setBusy(false); setErr(`Closed portion saved, but updating the remainder failed: ${updErr.message}`); return }
    }
    setBusy(false)
    onSaved()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base bg-white'
  const labelCls = 'block text-sm text-slate-700'
  const scenarios: { key: Scenario; label: string }[] = [
    { key: 'offset', label: 'Offset (traded back)' },
    { key: 'expired', label: 'Expired worthless' },
    { key: 'exercise', label: 'Exercise → futures' },
  ]

  return (
    <Modal onClose={onClose} title={`Close ${position.underlying_symbol} ${position.option_type.toUpperCase()} ${fmtPrice(position.strike_price)}`}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-slate-500">Position</span>
            <span className="font-semibold capitalize">{position.side} {position.num_contracts} {position.underlying_contract_month} {position.commodity} {position.option_type}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Entry premium</span><span className="font-mono">{fmtCents(position.premium_cents)}/bu</span></div>
        </div>

        <div>
          <span className={labelCls}>How is this option closing?</span>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {scenarios.map((s) => (
              <button key={s.key} type="button" onClick={() => setScenario(s.key)}
                className={`py-2 rounded-lg border text-sm ${scenario === s.key ? 'bg-green-700 text-white border-green-700' : 'bg-white border-slate-300'}`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <label className={labelCls}>
          Contracts to Close
          <input type="number" min="1" step="1" max={position.num_contracts} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
          <span className="text-xs text-slate-500">of {position.num_contracts}{partial ? ' — partial close leaves the rest open' : ''}</span>
        </label>

        {scenario === 'offset' && (
          <div className="grid grid-cols-3 gap-3">
            <label className={labelCls}>
              Close Premium (¢/bu)
              <input type="text" inputMode="decimal" placeholder="4.5 or 4 1/2" value={closeCentsInput} onChange={(e) => setCloseCentsInput(e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              Close Date
              <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              Commission <span className="text-xs text-slate-400">opt.</span>
              <input type="number" step="0.01" inputMode="decimal" value={commissionInput} onChange={(e) => setCommissionInput(e.target.value)} className={inputCls} />
            </label>
          </div>
        )}
        {scenario === 'expired' && (
          <label className={labelCls}>
            Expiration Date
            <input type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} className={inputCls} />
          </label>
        )}
        {scenario === 'exercise' && (
          <div className="space-y-2">
            <label className={labelCls}>
              Exercise Date
              <input type="date" value={exerciseDate} onChange={(e) => setExerciseDate(e.target.value)} className={inputCls} />
            </label>
            <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900">
              Creates a <b className="uppercase">{futuresSide}</b> futures position in {position.underlying_contract_month} {position.commodity} at {fmtPrice(position.strike_price)} (strike). The premium is recorded as a realized {position.side === 'buy' ? 'cost' : 'credit'}.
            </div>
          </div>
        )}

        {preview != null && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-slate-500">Premium ({qtyNum} contract{qtyNum === 1 ? '' : 's'})</span><span className="font-mono">{fmtUsd(premiumTotalForQty)}</span></div>
            <div className="flex justify-between font-semibold border-t border-slate-200 pt-1">
              <span>Realized P&amp;L (net)</span>
              <span className={`font-mono ${preview >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(preview)}</span>
            </div>
          </div>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="flex-1 rounded-xl bg-green-700 text-white font-semibold py-3 disabled:opacity-60">
            {busy ? 'Saving…' : scenario === 'exercise' ? 'Exercise Option' : partial ? `Close ${qtyNum} Contract${qtyNum === 1 ? '' : 's'}` : 'Close Option'}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-3">Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
