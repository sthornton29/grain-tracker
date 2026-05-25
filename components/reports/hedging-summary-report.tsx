'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  COMMODITIES,
  type Commodity,
  contractMonthSortKey,
  unrealizedPnl,
  bushelsFor,
  fmtPrice,
  fmtPnl,
} from '@/lib/hedging'
import type { ExportPayload } from '@/lib/exports'
import type { Entity, FuturesPosition } from '@/lib/types'

type Props = {
  onPayloadChange?: (build: () => ExportPayload) => void
}

export default function HedgingSummaryReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [positions, setPositions] = useState<FuturesPosition[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [priceBySymbol, setPriceBySymbol] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)

  const [cropYear, setCropYear] = useState('All')
  const [commodity, setCommodity] = useState<'All' | Commodity>('All')
  const [entityId, setEntityId] = useState('All')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    ;(async () => {
      const [pos, ent, mp] = await Promise.all([
        supabase.from('futures_positions').select('*').order('trade_date', { ascending: false }),
        supabase.from('entities').select('*').order('name'),
        supabase.from('market_prices').select('contract_symbol, price, price_date').order('price_date', { ascending: false }),
      ])
      setPositions((pos.data as FuturesPosition[]) ?? [])
      setEntities((ent.data as Entity[]) ?? [])
      const m = new Map<string, number>()
      for (const r of (mp.data as Array<{ contract_symbol: string; price: number }>) ?? []) {
        if (!m.has(r.contract_symbol)) m.set(r.contract_symbol, Number(r.price))
      }
      setPriceBySymbol(m)
      setLoading(false)
    })()
  }, [supabase])

  const entityName = (id: string | null) => (id ? entities.find((e) => e.id === id)?.name ?? '' : '')

  const cropYears = useMemo(
    () => Array.from(new Set(positions.map((p) => p.crop_year))).sort((a, b) => b - a),
    [positions],
  )

  // A position's reference date for the date-range filter: close date if closed,
  // otherwise the trade date.
  const refDate = (p: FuturesPosition) => (p.status === 'closed' ? p.close_date ?? p.trade_date : p.trade_date)

  const filtered = useMemo(
    () =>
      positions
        .filter(
          (p) =>
            (cropYear === 'All' || p.crop_year === Number(cropYear)) &&
            (commodity === 'All' || p.commodity === commodity) &&
            (entityId === 'All' || p.entity_id === entityId) &&
            (!from || refDate(p) >= from) &&
            (!to || refDate(p) <= to),
        )
        .sort(
          (a, b) =>
            b.crop_year - a.crop_year ||
            a.commodity.localeCompare(b.commodity) ||
            contractMonthSortKey(a.contract_month) - contractMonthSortKey(b.contract_month),
        ),
    [positions, cropYear, commodity, entityId, from, to],
  )

  const unrealizedOf = (p: FuturesPosition) =>
    p.status === 'open'
      ? unrealizedPnl({ side: p.side, tradePrice: p.trade_price, currentPrice: priceBySymbol.get(p.contract_symbol) ?? null, numContracts: p.num_contracts })
      : null
  const netRealizedOf = (p: FuturesPosition) => (p.status === 'closed' ? (p.realized_pnl ?? 0) - (p.commission ?? 0) : 0)

  // Summary by crop year × commodity.
  const summary = useMemo(() => {
    const m = new Map<string, {
      cropYear: number; commodity: Commodity; contracts: number; bushels: number
      priceWeight: number; unrealized: number; realized: number
    }>()
    for (const p of filtered) {
      const key = `${p.crop_year}|${p.commodity}`
      const cur = m.get(key) ?? { cropYear: p.crop_year, commodity: p.commodity as Commodity, contracts: 0, bushels: 0, priceWeight: 0, unrealized: 0, realized: 0 }
      cur.contracts += p.num_contracts
      cur.bushels += bushelsFor(p.num_contracts)
      cur.priceWeight += p.trade_price * p.num_contracts
      cur.unrealized += unrealizedOf(p) ?? 0
      cur.realized += netRealizedOf(p)
      m.set(key, cur)
    }
    return Array.from(m.values()).sort((a, b) => b.cropYear - a.cropYear || a.commodity.localeCompare(b.commodity))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, priceBySymbol])

  function filtersLabel() {
    const parts = [`Crop year: ${cropYear}`, `Commodity: ${commodity}`]
    if (entityId !== 'All') parts.push(`Entity: ${entityName(entityId) || entityId}`)
    if (from) parts.push(`From: ${from}`)
    if (to) parts.push(`To: ${to}`)
    return parts.join(' · ')
  }

  function buildExportPayload(): ExportPayload {
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: 'Summary by Crop Year',
      columns: [
        { label: 'Crop Year' }, { label: 'Commodity' },
        { label: 'Contracts', align: 'right' }, { label: 'Bushels', align: 'right' },
        { label: 'Avg Hedge Price', align: 'right' }, { label: 'Unrealized P&L', align: 'right' },
        { label: 'Realized P&L (net)', align: 'right' }, { label: 'Total P&L', align: 'right' },
      ],
      rows: summary.map((s) => [
        s.cropYear, s.commodity, s.contracts, s.bushels,
        s.contracts > 0 ? Number((s.priceWeight / s.contracts).toFixed(4)) : '',
        Number(s.unrealized.toFixed(2)), Number(s.realized.toFixed(2)), Number((s.unrealized + s.realized).toFixed(2)),
      ]),
    })
    sections.push({
      title: 'Positions',
      columns: [
        { label: 'Crop Year' }, { label: 'Commodity' }, { label: 'Month' }, { label: 'Symbol' },
        { label: 'Side' }, { label: 'Contracts', align: 'right' }, { label: 'Bushels', align: 'right' },
        { label: 'Trade Date' }, { label: 'Trade Price', align: 'right' }, { label: 'Status' },
        { label: 'Close Date' }, { label: 'Close Price', align: 'right' },
        { label: 'Realized P&L', align: 'right' }, { label: 'Commission', align: 'right' },
        { label: 'Net P&L', align: 'right' }, { label: 'Unrealized P&L', align: 'right' }, { label: 'Entity' },
      ],
      rows: filtered.map((p) => {
        const u = unrealizedOf(p)
        return [
          p.crop_year, p.commodity, p.contract_month, p.contract_symbol, p.side,
          p.num_contracts, bushelsFor(p.num_contracts),
          p.trade_date, Number(p.trade_price), p.status,
          p.close_date ?? '', p.close_price != null ? Number(p.close_price) : '',
          p.realized_pnl != null ? Number(p.realized_pnl) : '', Number(p.commission ?? 0),
          p.status === 'closed' ? Number(netRealizedOf(p).toFixed(2)) : '',
          u != null ? Number(u.toFixed(2)) : '', entityName(p.entity_id),
        ]
      }),
    })
    return { title: 'Hedging Summary', filters: filtersLabel(), sections }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, summary, cropYear, commodity, entityId, from, to, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  if (loading) return <p className="text-slate-500">Loading…</p>

  const grandUnrealized = summary.reduce((s, r) => s + r.unrealized, 0)
  const grandRealized = summary.reduce((s, r) => s + r.realized, 0)

  return (
    <div className="space-y-4 print-area">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 no-print">
        <select value={cropYear} onChange={(e) => setCropYear(e.target.value)} className={inputCls}>
          <option value="All">All crop years</option>
          {cropYears.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={commodity} onChange={(e) => setCommodity(e.target.value as 'All' | Commodity)} className={inputCls}>
          <option value="All">All commodities</option>
          {COMMODITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={inputCls}>
          <option value="All">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} title="From date" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} title="To date" />
      </div>

      {filtered.length === 0 ? (
        <p className="text-slate-400 text-center py-8">No positions match these filters.</p>
      ) : (
        <div className="space-y-6">
          <section className="bg-white rounded-xl shadow p-4 avoid-break">
            <h2 className="font-bold text-lg mb-2">Summary by Crop Year</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-slate-500">
                  <tr>{['Crop Year', 'Commodity', 'Contracts', 'Bushels', 'Avg Hedge Price', 'Unrealized P&L', 'Realized P&L (net)', 'Total P&L'].map((h) => <th key={h} className="text-left pr-4 font-medium whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {summary.map((s) => {
                    const avg = s.contracts > 0 ? s.priceWeight / s.contracts : null
                    const total = s.unrealized + s.realized
                    return (
                      <tr key={`${s.cropYear}-${s.commodity}`} className="border-t border-slate-100">
                        <td className="pr-4 py-1 font-semibold">{s.cropYear}</td>
                        <td className="pr-4 py-1">{s.commodity}</td>
                        <td className="pr-4 py-1 text-right font-mono">{s.contracts}</td>
                        <td className="pr-4 py-1 text-right font-mono">{s.bushels.toLocaleString()}</td>
                        <td className="pr-4 py-1 text-right font-mono">{fmtPrice(avg)}</td>
                        <td className={`pr-4 py-1 text-right font-mono ${s.unrealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(s.unrealized)}</td>
                        <td className={`pr-4 py-1 text-right font-mono ${s.realized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(s.realized)}</td>
                        <td className={`pr-4 py-1 text-right font-mono font-bold ${total >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(total)}</td>
                      </tr>
                    )
                  })}
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                    <td className="pr-4 py-1" colSpan={5}>Grand total</td>
                    <td className={`pr-4 py-1 text-right font-mono ${grandUnrealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(grandUnrealized)}</td>
                    <td className={`pr-4 py-1 text-right font-mono ${grandRealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(grandRealized)}</td>
                    <td className={`pr-4 py-1 text-right font-mono ${grandUnrealized + grandRealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(grandUnrealized + grandRealized)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="bg-white rounded-xl shadow p-4 avoid-break">
            <h2 className="font-bold text-lg mb-2">Positions</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-slate-500">
                  <tr>{['Crop Yr', 'Commodity', 'Month', 'Symbol', 'Side', '#', 'Bushels', 'Trade Date', 'Trade $', 'Status', 'Close Date', 'Close $', 'Realized', 'Comm.', 'Net', 'Unrealized'].map((h) => <th key={h} className="text-left pr-3 font-medium whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const u = unrealizedOf(p)
                    const net = netRealizedOf(p)
                    return (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className="pr-3 py-1">{p.crop_year}</td>
                        <td className="pr-3 py-1">{p.commodity}</td>
                        <td className="pr-3 py-1 whitespace-nowrap">{p.contract_month}</td>
                        <td className="pr-3 py-1 font-mono">{p.contract_symbol}</td>
                        <td className="pr-3 py-1 capitalize">{p.side}</td>
                        <td className="pr-3 py-1 text-right">{p.num_contracts}</td>
                        <td className="pr-3 py-1 text-right font-mono">{bushelsFor(p.num_contracts).toLocaleString()}</td>
                        <td className="pr-3 py-1 whitespace-nowrap">{p.trade_date}</td>
                        <td className="pr-3 py-1 text-right font-mono">{fmtPrice(p.trade_price)}</td>
                        <td className="pr-3 py-1 capitalize">{p.status}</td>
                        <td className="pr-3 py-1 whitespace-nowrap">{p.close_date ?? ''}</td>
                        <td className="pr-3 py-1 text-right font-mono">{p.close_price != null ? fmtPrice(p.close_price) : ''}</td>
                        <td className={`pr-3 py-1 text-right font-mono ${(p.realized_pnl ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>{p.realized_pnl != null ? fmtPnl(p.realized_pnl) : ''}</td>
                        <td className="pr-3 py-1 text-right font-mono">{p.commission ? fmtPnl(p.commission) : ''}</td>
                        <td className={`pr-3 py-1 text-right font-mono ${net >= 0 ? 'text-green-700' : 'text-red-700'}`}>{p.status === 'closed' ? fmtPnl(net) : ''}</td>
                        <td className={`pr-3 py-1 text-right font-mono ${u == null ? '' : u >= 0 ? 'text-green-700' : 'text-red-700'}`}>{u != null ? fmtPnl(u) : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
