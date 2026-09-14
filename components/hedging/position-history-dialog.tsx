'use client'

// One position's detail (083): its roll lineage across legs (origin → … →
// current, with the effective price since the original entry) and its own
// event chain from the ledger — every open, close, roll, edit, crop-year
// change, with who/when/where-from on expand.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { Modal } from './position-form'
import HedgingHistory from './hedging-history'
import { effectiveEntry, lineageChain } from '@/lib/hedge-lineage'
import { buildHedgeTimeline } from '@/lib/hedge-events'
import { fmtCommodityPrice, fmtPnl } from '@/lib/hedging'
import type { FuturesPosition, HedgePositionEvent } from '@/lib/types'

type Props = {
  position: FuturesPosition
  allPositions: FuturesPosition[]
  entityName: (id: string | null) => string
  onClose: () => void
}

export default function PositionHistoryDialog({ position, allPositions, entityName, onClose }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const chain = useMemo(() => lineageChain(position, allPositions), [position, allPositions])
  const latest = chain[chain.length - 1]
  const eff = useMemo(() => effectiveEntry(latest, allPositions), [latest, allPositions])
  const [events, setEvents] = useState<HedgePositionEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const ids = chain.map((p) => p.id)
      const res = await fetchAllRows((f, t) =>
        supabase.from('hedge_position_events').select('*').in('position_id', ids).order('occurred_at', { ascending: false }).order('recorded_at', { ascending: false }).order('id').range(f, t),
      )
      if (cancelled) return
      if (res.error) { setErr('The history could not be loaded right now.'); setEvents([]); return }
      setEvents((res.data as HedgePositionEvent[]) ?? [])
    })()
    return () => { cancelled = true }
  }, [supabase, chain])

  const lines = useMemo(() => buildHedgeTimeline(events ?? [], { entityName }), [events, entityName])
  const rolled = chain.length > 1

  return (
    <Modal onClose={onClose} title={`${position.contract_month} ${position.commodity} — history`} wide>
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span><span className="text-slate-500">Position</span> <span className="font-semibold capitalize">{position.side} {position.num_contracts} {position.contract_month} {position.commodity}</span></span>
            <span><span className="text-slate-500">Entry</span> <span className="font-mono">{fmtCommodityPrice(position.commodity, position.trade_price)}</span> on {position.trade_date}</span>
            {position.status === 'closed' && (
              <span><span className="text-slate-500">Closed</span> <span className="font-mono">{fmtCommodityPrice(position.commodity, position.close_price)}</span> on {position.close_date}{position.realized_pnl != null && <> · <span className={`font-mono ${position.realized_pnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(position.realized_pnl)}</span></>}</span>
            )}
            <span><span className="text-slate-500">Crop year</span> <span className="font-semibold">{position.crop_year}</span></span>
            {entityName(position.entity_id) && <span><span className="text-slate-500">Entity</span> {entityName(position.entity_id)}</span>}
          </div>
        </div>

        {rolled && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
            <div className="font-semibold text-sky-900 mb-1">Roll lineage</div>
            <ol className="flex flex-wrap items-center gap-2">
              {chain.map((leg, i) => (
                <li key={leg.id} className="flex items-center gap-2">
                  {i > 0 && <span className="text-sky-400">→</span>}
                  <span className={`rounded-lg px-2 py-1 ${leg.id === position.id ? 'bg-white border border-sky-300 font-semibold' : 'bg-white/60'}`}>
                    {leg.contract_month} @ {fmtCommodityPrice(leg.commodity, leg.trade_price)}
                    {leg.status === 'closed' && leg.close_price != null && <span className="text-slate-500"> → closed {fmtCommodityPrice(leg.commodity, leg.close_price)}</span>}
                    <span className="text-xs text-slate-500"> · {leg.num_contracts}</span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="mt-2 text-sky-900">
              Effective price since {eff.originalMonth} @ {fmtCommodityPrice(position.commodity, eff.originalEntry)}:{' '}
              <span className="font-mono font-semibold">{fmtCommodityPrice(position.commodity, eff.effectivePrice)}</span>
              <span className="text-xs text-slate-600">
                {' '}({eff.steps.map((s) => `${s.fromMonth}→${s.toMonth} ${s.spread >= 0 ? '+' : ''}${fmtCommodityPrice(position.commodity, s.spread)}`).join(', ')})
              </span>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-sm font-semibold">
            Events{rolled ? ' across the lineage' : ''}
          </div>
          {events == null ? (
            <div className="px-4 py-6 text-sm text-slate-400">Loading…</div>
          ) : (
            <HedgingHistory lines={lines} emptyText={err ?? 'No events recorded for this position yet.'} />
          )}
        </div>
      </div>
    </Modal>
  )
}
