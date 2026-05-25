'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  COMMODITIES,
  type Commodity,
  contractMonthSortKey,
  unrealizedPnl,
  optionUnrealizedPnl,
  bushelsFor,
  fmtPrice,
  fmtPnl,
  fmtCents,
} from '@/lib/hedging'
import type { ExportPayload } from '@/lib/exports'
import type { Entity, FuturesPosition, OptionPosition } from '@/lib/types'

type Props = {
  onPayloadChange?: (build: () => ExportPayload) => void
}

export default function HedgingSummaryReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [positions, setPositions] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
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
      const [pos, ent, mp, opt] = await Promise.all([
        supabase.from('futures_positions').select('*').order('trade_date', { ascending: false }),
        supabase.from('entities').select('*').order('name'),
        supabase.from('market_prices').select('contract_symbol, price, price_date').order('price_date', { ascending: false }),
        supabase.from('options_positions').select('*').order('trade_date', { ascending: false }),
      ])
      setPositions((pos.data as FuturesPosition[]) ?? [])
      setOptions((opt.data as OptionPosition[]) ?? [])
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
    () => Array.from(new Set([...positions.map((p) => p.crop_year), ...options.map((o) => o.crop_year)])).sort((a, b) => b - a),
    [positions, options],
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

  // Options. No live pricing in the report — unrealized uses each option's
  // manually-entered current value when present; closed options' realized_pnl
  // is already net of commission.
  const refDateOpt = (o: OptionPosition) => (o.status !== 'open' ? o.close_date ?? o.trade_date : o.trade_date)
  const filteredOptions = useMemo(
    () =>
      options
        .filter(
          (o) =>
            (cropYear === 'All' || o.crop_year === Number(cropYear)) &&
            (commodity === 'All' || o.commodity === commodity) &&
            (entityId === 'All' || o.entity_id === entityId) &&
            (!from || refDateOpt(o) >= from) &&
            (!to || refDateOpt(o) <= to),
        )
        .sort(
          (a, b) =>
            b.crop_year - a.crop_year ||
            a.commodity.localeCompare(b.commodity) ||
            contractMonthSortKey(a.underlying_contract_month) - contractMonthSortKey(b.underlying_contract_month),
        ),
    [options, cropYear, commodity, entityId, from, to],
  )
  const optUnrealizedOf = (o: OptionPosition) =>
    o.status === 'open'
      ? optionUnrealizedPnl({ side: o.side, premiumCents: o.premium_cents, currentCents: o.manual_current_value_cents, numContracts: o.num_contracts })
      : null
  const optNetRealizedOf = (o: OptionPosition) => (o.status !== 'open' ? (o.realized_pnl ?? 0) : 0)

  // Per crop-year × commodity options P&L (unrealized + realized), for the
  // combined column in the summary table.
  const optionsByKey = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of filteredOptions) {
      const key = `${o.crop_year}|${o.commodity}`
      m.set(key, (m.get(key) ?? 0) + (optUnrealizedOf(o) ?? 0) + optNetRealizedOf(o))
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOptions])
  const optPnlForKey = (cy: number, c: string) => optionsByKey.get(`${cy}|${c}`) ?? 0

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
        { label: 'Futures Contracts', align: 'right' }, { label: 'Bushels', align: 'right' },
        { label: 'Avg Hedge Price', align: 'right' }, { label: 'Futures Unrealized', align: 'right' },
        { label: 'Futures Realized (net)', align: 'right' }, { label: 'Options P&L (net)', align: 'right' },
        { label: 'Combined P&L', align: 'right' },
      ],
      rows: summary.map((s) => {
        const opt = optPnlForKey(s.cropYear, s.commodity)
        return [
          s.cropYear, s.commodity, s.contracts, s.bushels,
          s.contracts > 0 ? Number((s.priceWeight / s.contracts).toFixed(4)) : '',
          Number(s.unrealized.toFixed(2)), Number(s.realized.toFixed(2)), Number(opt.toFixed(2)),
          Number((s.unrealized + s.realized + opt).toFixed(2)),
        ]
      }),
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
    if (filteredOptions.length > 0) {
      sections.push({
        title: 'Options',
        columns: [
          { label: 'Crop Year' }, { label: 'Commodity' }, { label: 'Type' }, { label: 'Side' },
          { label: 'Month' }, { label: 'Strike', align: 'right' }, { label: 'Contracts', align: 'right' },
          { label: 'Trade Date' }, { label: 'Premium ¢', align: 'right' }, { label: 'Premium $', align: 'right' },
          { label: 'Status' }, { label: 'Close Date' }, { label: 'Close ¢', align: 'right' },
          { label: 'Realized P&L', align: 'right' }, { label: 'Unrealized P&L', align: 'right' }, { label: 'Entity' },
        ],
        rows: filteredOptions.map((o) => {
          const u = optUnrealizedOf(o)
          return [
            o.crop_year, o.commodity, o.option_type, o.side, o.underlying_contract_month,
            Number(o.strike_price), o.num_contracts, o.trade_date, Number(o.premium_cents), Number(o.premium_total ?? 0),
            o.status, o.close_date ?? '', o.close_price_cents != null ? Number(o.close_price_cents) : '',
            o.realized_pnl != null ? Number(o.realized_pnl) : '', u != null ? Number(u.toFixed(2)) : '', entityName(o.entity_id),
          ]
        }),
      })
    }
    return { title: 'Hedging Summary', filters: filtersLabel(), sections }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, filteredOptions, summary, cropYear, commodity, entityId, from, to, onPayloadChange])

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  if (loading) return <p className="text-slate-500">Loading…</p>

  const grandUnrealized = summary.reduce((s, r) => s + r.unrealized, 0)
  const grandRealized = summary.reduce((s, r) => s + r.realized, 0)
  const grandOptions = filteredOptions.reduce((s, o) => s + (optUnrealizedOf(o) ?? 0) + optNetRealizedOf(o), 0)

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

      {filtered.length === 0 && filteredOptions.length === 0 ? (
        <p className="text-slate-400 text-center py-8">No positions match these filters.</p>
      ) : (
        <div className="space-y-6">
          <section className="bg-white rounded-xl shadow p-4 avoid-break">
            <h2 className="font-bold text-lg mb-2">Summary by Crop Year</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-slate-500">
                  <tr>{['Crop Year', 'Commodity', 'Futures', 'Bushels', 'Avg Price', 'Fut Unrealized', 'Fut Realized', 'Options P&L', 'Combined P&L'].map((h) => <th key={h} className="text-left pr-4 font-medium whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {summary.map((s) => {
                    const avg = s.contracts > 0 ? s.priceWeight / s.contracts : null
                    const opt = optPnlForKey(s.cropYear, s.commodity)
                    const combined = s.unrealized + s.realized + opt
                    return (
                      <tr key={`${s.cropYear}-${s.commodity}`} className="border-t border-slate-100">
                        <td className="pr-4 py-1 font-semibold">{s.cropYear}</td>
                        <td className="pr-4 py-1">{s.commodity}</td>
                        <td className="pr-4 py-1 text-right font-mono">{s.contracts}</td>
                        <td className="pr-4 py-1 text-right font-mono">{s.bushels.toLocaleString()}</td>
                        <td className="pr-4 py-1 text-right font-mono">{fmtPrice(avg)}</td>
                        <td className={`pr-4 py-1 text-right font-mono ${s.unrealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(s.unrealized)}</td>
                        <td className={`pr-4 py-1 text-right font-mono ${s.realized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(s.realized)}</td>
                        <td className={`pr-4 py-1 text-right font-mono ${opt >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(opt)}</td>
                        <td className={`pr-4 py-1 text-right font-mono font-bold ${combined >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(combined)}</td>
                      </tr>
                    )
                  })}
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                    <td className="pr-4 py-1" colSpan={5}>Grand total</td>
                    <td className={`pr-4 py-1 text-right font-mono ${grandUnrealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(grandUnrealized)}</td>
                    <td className={`pr-4 py-1 text-right font-mono ${grandRealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(grandRealized)}</td>
                    <td className={`pr-4 py-1 text-right font-mono ${grandOptions >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(grandOptions)}</td>
                    <td className={`pr-4 py-1 text-right font-mono ${grandUnrealized + grandRealized + grandOptions >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(grandUnrealized + grandRealized + grandOptions)}</td>
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

          {filteredOptions.length > 0 && (
            <section className="bg-white rounded-xl shadow p-4 avoid-break">
              <h2 className="font-bold text-lg mb-2">Options</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-slate-500">
                    <tr>{['Crop Yr', 'Commodity', 'Type', 'Side', 'Month', 'Strike', '#', 'Trade Date', 'Premium ¢', 'Premium $', 'Status', 'Close Date', 'Close ¢', 'Realized', 'Unrealized'].map((h) => <th key={h} className="text-left pr-3 font-medium whitespace-nowrap">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {filteredOptions.map((o) => {
                      const u = optUnrealizedOf(o)
                      return (
                        <tr key={o.id} className="border-t border-slate-100">
                          <td className="pr-3 py-1">{o.crop_year}</td>
                          <td className="pr-3 py-1">{o.commodity}</td>
                          <td className="pr-3 py-1 capitalize">{o.option_type}</td>
                          <td className="pr-3 py-1 capitalize">{o.side}</td>
                          <td className="pr-3 py-1 whitespace-nowrap">{o.underlying_contract_month}</td>
                          <td className="pr-3 py-1 text-right font-mono">{fmtPrice(o.strike_price)}</td>
                          <td className="pr-3 py-1 text-right">{o.num_contracts}</td>
                          <td className="pr-3 py-1 whitespace-nowrap">{o.trade_date}</td>
                          <td className="pr-3 py-1 text-right font-mono">{fmtCents(o.premium_cents)}</td>
                          <td className="pr-3 py-1 text-right font-mono">{fmtPnl(o.premium_total)}</td>
                          <td className="pr-3 py-1 whitespace-nowrap">{o.status}</td>
                          <td className="pr-3 py-1 whitespace-nowrap">{o.close_date ?? ''}</td>
                          <td className="pr-3 py-1 text-right font-mono">{o.close_price_cents != null ? fmtCents(o.close_price_cents) : ''}</td>
                          <td className={`pr-3 py-1 text-right font-mono ${(o.realized_pnl ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>{o.realized_pnl != null ? fmtPnl(o.realized_pnl) : ''}</td>
                          <td className={`pr-3 py-1 text-right font-mono ${u == null ? '' : u >= 0 ? 'text-green-700' : 'text-red-700'}`}>{u != null ? fmtPnl(u) : ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
