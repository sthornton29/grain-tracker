'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import PositionForm from '@/components/hedging/position-form'
import ClosePositionDialog from '@/components/hedging/close-position-dialog'
import StatementImport from '@/components/hedging/statement-import'
import PriceBoard, { type PriceMap } from '@/components/hedging/price-board'
import {
  COMMODITIES,
  type Commodity,
  contractMonthSortKey,
  unrealizedPnl,
  bushelsFor,
  fmtPrice,
  fmtPnl,
} from '@/lib/hedging'
import type { Entity, FuturesPosition } from '@/lib/types'

type StatusFilter = 'open' | 'closed' | 'all'

export default function HedgingPage() {
  const supabase = useMemo(() => createClient(), [])

  const [positions, setPositions] = useState<FuturesPosition[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [prices, setPrices] = useState<PriceMap>(new Map())
  const [priceDate, setPriceDate] = useState<string | null>(null)
  const [priceNote, setPriceNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Filters
  const [fCropYear, setFCropYear] = useState('All')
  const [fCommodity, setFCommodity] = useState<'All' | Commodity>('All')
  const [fEntity, setFEntity] = useState('All')
  const [fStatus, setFStatus] = useState<StatusFilter>('open')
  const [closedFrom, setClosedFrom] = useState('')
  const [closedTo, setClosedTo] = useState('')

  // Modals
  const [showNew, setShowNew] = useState(false)
  const [editTarget, setEditTarget] = useState<FuturesPosition | null>(null)
  const [closeTarget, setCloseTarget] = useState<FuturesPosition | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const refreshPrices = useCallback(
    async (pos: FuturesPosition[], force: boolean) => {
      const symbols = Array.from(new Set(pos.filter((p) => p.status === 'open').map((p) => p.contract_symbol)))
      if (symbols.length === 0) {
        setPrices(new Map())
        setPriceDate(null)
        setPriceNote(null)
        return
      }
      setRefreshing(true)
      try {
        const res = await fetch('/api/market-prices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols, force }),
        })
        const data = await res.json()
        const map: PriceMap = new Map()
        for (const p of data.prices ?? []) {
          map.set(p.symbol, { price: p.price, price_date: p.price_date, stale: p.stale })
        }
        setPrices(map)
        setPriceDate(data.priceDate ?? null)
        setPriceNote(data.note ?? null)
      } catch (e: any) {
        setPriceNote(`Could not refresh prices: ${e?.message ?? 'network error'}.`)
      } finally {
        setRefreshing(false)
      }
    },
    [],
  )

  const loadAll = useCallback(async () => {
    const [pos, ent] = await Promise.all([
      supabase.from('futures_positions').select('*').order('trade_date', { ascending: false }),
      supabase.from('entities').select('*').order('name'),
    ])
    const list = (pos.data as FuturesPosition[]) ?? []
    setPositions(list)
    setEntities((ent.data as Entity[]) ?? [])
    setLoading(false)
    await refreshPrices(list, false)
  }, [supabase, refreshPrices])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const entityName = useCallback(
    (id: string | null) => (id ? entities.find((e) => e.id === id)?.name ?? '' : ''),
    [entities],
  )

  const cropYears = useMemo(
    () => Array.from(new Set(positions.map((p) => p.crop_year))).sort((a, b) => b - a),
    [positions],
  )

  // Apply the crop-year / commodity / entity filters (status handled separately).
  const base = useMemo(
    () =>
      positions.filter(
        (p) =>
          (fCropYear === 'All' || p.crop_year === Number(fCropYear)) &&
          (fCommodity === 'All' || p.commodity === fCommodity) &&
          (fEntity === 'All' || p.entity_id === fEntity),
      ),
    [positions, fCropYear, fCommodity, fEntity],
  )

  const openPos = useMemo(() => base.filter((p) => p.status === 'open'), [base])
  const closedPos = useMemo(
    () =>
      base
        .filter(
          (p) =>
            p.status === 'closed' &&
            (!closedFrom || (p.close_date != null && p.close_date >= closedFrom)) &&
            (!closedTo || (p.close_date != null && p.close_date <= closedTo)),
        )
        .sort((a, b) => (b.close_date ?? '').localeCompare(a.close_date ?? '')),
    [base, closedFrom, closedTo],
  )

  const curPrice = (symbol: string) => prices.get(symbol)?.price ?? null
  const posUnrealized = (p: FuturesPosition) =>
    unrealizedPnl({ side: p.side, tradePrice: p.trade_price, currentPrice: curPrice(p.contract_symbol), numContracts: p.num_contracts })
  const netRealized = (p: FuturesPosition) => (p.realized_pnl ?? 0) - (p.commission ?? 0)

  // Summary bar
  const totalOpenContracts = openPos.reduce((s, p) => s + p.num_contracts, 0)
  const totalUnrealized = openPos.reduce((s, p) => s + (posUnrealized(p) ?? 0), 0)
  const totalRealizedNet = closedPos.reduce((s, p) => s + netRealized(p), 0)

  // Open positions grouped by commodity, then sorted by contract month.
  const openGroups = useMemo(() => {
    const m = new Map<Commodity, FuturesPosition[]>()
    for (const p of openPos) {
      const arr = m.get(p.commodity as Commodity) ?? []
      arr.push(p)
      m.set(p.commodity as Commodity, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => contractMonthSortKey(a.contract_month) - contractMonthSortKey(b.contract_month))
    return m
  }, [openPos])

  // Crop-year × commodity summary (open + closed within current filters).
  const cropYearSummaries = useMemo(() => {
    const m = new Map<string, {
      cropYear: number; commodity: Commodity; contracts: number; bushels: number
      priceWeight: number; unrealized: number; realized: number; hasOpen: boolean
    }>()
    for (const p of base) {
      const key = `${p.crop_year}|${p.commodity}`
      const cur = m.get(key) ?? {
        cropYear: p.crop_year, commodity: p.commodity as Commodity, contracts: 0, bushels: 0,
        priceWeight: 0, unrealized: 0, realized: 0, hasOpen: false,
      }
      cur.contracts += p.num_contracts
      cur.bushels += bushelsFor(p.num_contracts)
      cur.priceWeight += p.trade_price * p.num_contracts
      if (p.status === 'open') { cur.unrealized += posUnrealized(p) ?? 0; cur.hasOpen = true }
      else cur.realized += netRealized(p)
      m.set(key, cur)
    }
    return Array.from(m.values()).sort(
      (a, b) => b.cropYear - a.cropYear || a.commodity.localeCompare(b.commodity),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, prices])

  function afterMutation() {
    setShowNew(false)
    setEditTarget(null)
    setCloseTarget(null)
    setShowImport(false)
    loadAll()
  }

  async function deletePosition(p: FuturesPosition) {
    if (!window.confirm(`Delete ${p.side} ${p.num_contracts} ${p.contract_month} ${p.commodity} (${p.contract_symbol})? This can't be undone.`)) return
    const { error } = await supabase.from('futures_positions').delete().eq('id', p.id)
    if (error) { setBanner(`Delete failed: ${error.message}`); return }
    loadAll()
  }

  const showOpen = fStatus === 'open' || fStatus === 'all'
  const showClosed = fStatus === 'closed' || fStatus === 'all'

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Hedging</h1>
        <button onClick={() => setShowImport(true)} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm font-semibold">
          Import Brokerage Statement
        </button>
        <button onClick={() => setShowNew(true)} className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">
          + New Position
        </button>
      </div>

      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}

      {/* Summary bar */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="Open Contracts" value={String(totalOpenContracts)} />
        <StatCard label="Bushels Hedged" value={bushelsFor(totalOpenContracts).toLocaleString()} />
        <StatCard label="Unrealized P&L" value={fmtPnl(totalUnrealized)} tone={totalUnrealized >= 0 ? 'green' : 'red'} />
        <StatCard label="Realized P&L (net)" value={fmtPnl(totalRealizedNet)} tone={totalRealizedNet >= 0 ? 'green' : 'red'} />
        <div className="bg-white rounded-xl shadow p-4 flex flex-col justify-between">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Prices as of</div>
          <div className="font-semibold">{priceDate ?? '—'}</div>
          <button
            onClick={() => refreshPrices(positions, true)}
            disabled={refreshing}
            className="mt-1 rounded-lg bg-slate-700 text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50 self-start"
          >
            {refreshing ? 'Refreshing…' : 'Refresh Prices'}
          </button>
        </div>
      </div>
      {priceNote && <p className="text-xs text-amber-700">{priceNote}</p>}

      {/* Price board */}
      <PriceBoard positions={base} prices={prices} priceDate={priceDate} />

      {/* Filters */}
      <div className="bg-white rounded-xl shadow p-3 flex flex-wrap items-end gap-3">
        <Filter label="Crop Year">
          <select value={fCropYear} onChange={(e) => setFCropYear(e.target.value)} className={selCls}>
            <option value="All">All</option>
            {cropYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Filter>
        <Filter label="Commodity">
          <select value={fCommodity} onChange={(e) => setFCommodity(e.target.value as 'All' | Commodity)} className={selCls}>
            <option value="All">All</option>
            {COMMODITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Filter>
        <Filter label="Entity">
          <select value={fEntity} onChange={(e) => setFEntity(e.target.value)} className={selCls}>
            <option value="All">All</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Filter>
        <Filter label="Status">
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value as StatusFilter)} className={selCls}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </Filter>
        {showClosed && (
          <>
            <Filter label="Closed from">
              <input type="date" value={closedFrom} onChange={(e) => setClosedFrom(e.target.value)} className={selCls} />
            </Filter>
            <Filter label="Closed to">
              <input type="date" value={closedTo} onChange={(e) => setClosedTo(e.target.value)} className={selCls} />
            </Filter>
          </>
        )}
      </div>

      {loading && <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">Loading…</div>}

      {/* Open positions */}
      {!loading && showOpen && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100">
            <h2 className="font-semibold">Open Positions</h2>
            <p className="text-xs text-slate-500">Grouped by commodity, then contract month. Green = hedge gaining; red = hedge losing (your physical grain is worth more).</p>
          </div>
          {openPos.length === 0 ? (
            <Empty>No open positions for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>{['Commodity', 'Month', 'Symbol', 'Side', '# Contracts', 'Bushels', 'Trade Date', 'Trade Price', 'Current', 'Unrealized P&L', 'Crop Yr', 'Actions'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {COMMODITIES.filter((c) => (openGroups.get(c)?.length ?? 0) > 0).map((c) => {
                    const rows = openGroups.get(c)!
                    const subContracts = rows.reduce((s, p) => s + p.num_contracts, 0)
                    const subUnrealized = rows.reduce((s, p) => s + (posUnrealized(p) ?? 0), 0)
                    return (
                      <FragmentGroup key={c}>
                        {rows.map((p) => {
                          const u = posUnrealized(p)
                          return (
                            <tr key={p.id} className="border-t border-slate-100">
                              <td className="px-3 py-2">{p.commodity}</td>
                              <td className="px-3 py-2">{p.contract_month}</td>
                              <td className="px-3 py-2 font-mono">{p.contract_symbol}</td>
                              <td className="px-3 py-2 capitalize">{p.side}</td>
                              <td className="px-3 py-2 text-right">{p.num_contracts}</td>
                              <td className="px-3 py-2 text-right font-mono">{bushelsFor(p.num_contracts).toLocaleString()}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{p.trade_date}</td>
                              <td className="px-3 py-2 text-right font-mono">{fmtPrice(p.trade_price)}</td>
                              <td className="px-3 py-2 text-right font-mono">{fmtPrice(curPrice(p.contract_symbol))}</td>
                              <td className={`px-3 py-2 text-right font-mono ${u == null ? 'text-slate-400' : u >= 0 ? 'text-green-700' : 'text-red-700'}`}>{u == null ? '—' : fmtPnl(u)}</td>
                              <td className="px-3 py-2">{p.crop_year}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <button onClick={() => setCloseTarget(p)} className="text-sky-700 mr-2">Close</button>
                                <button onClick={() => setEditTarget(p)} className="text-slate-600 mr-2">Edit</button>
                                <button onClick={() => deletePosition(p)} className="text-red-600">Delete</button>
                              </td>
                            </tr>
                          )
                        })}
                        <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                          <td className="px-3 py-2" colSpan={4}>{c} subtotal</td>
                          <td className="px-3 py-2 text-right">{subContracts}</td>
                          <td className="px-3 py-2 text-right font-mono">{bushelsFor(subContracts).toLocaleString()}</td>
                          <td colSpan={3} />
                          <td className={`px-3 py-2 text-right font-mono ${subUnrealized >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(subUnrealized)}</td>
                          <td colSpan={2} />
                        </tr>
                      </FragmentGroup>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Closed positions */}
      {!loading && showClosed && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100">
            <h2 className="font-semibold">Closed Positions</h2>
          </div>
          {closedPos.length === 0 ? (
            <Empty>No closed positions for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>{['Commodity', 'Month', 'Side', '# Contracts', 'Bushels', 'Trade Date', 'Trade Price', 'Close Date', 'Close Price', 'Realized P&L', 'Commission', 'Net P&L', 'Crop Yr'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {closedPos.map((p) => {
                    const net = netRealized(p)
                    return (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{p.commodity}</td>
                        <td className="px-3 py-2">{p.contract_month}</td>
                        <td className="px-3 py-2 capitalize">{p.side}</td>
                        <td className="px-3 py-2 text-right">{p.num_contracts}</td>
                        <td className="px-3 py-2 text-right font-mono">{bushelsFor(p.num_contracts).toLocaleString()}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{p.trade_date}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtPrice(p.trade_price)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{p.close_date ?? '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtPrice(p.close_price)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${(p.realized_pnl ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(p.realized_pnl)}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtPnl(p.commission)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${net >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(net)}</td>
                        <td className="px-3 py-2">{p.crop_year}</td>
                      </tr>
                    )
                  })}
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                    <td className="px-3 py-2" colSpan={9}>Totals</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtPnl(closedPos.reduce((s, p) => s + (p.realized_pnl ?? 0), 0))}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtPnl(closedPos.reduce((s, p) => s + (p.commission ?? 0), 0))}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtPnl(totalRealizedNet)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Crop-year summary cards */}
      {!loading && cropYearSummaries.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Hedging Summary by Crop Year</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {cropYearSummaries.map((s) => {
              const avg = s.contracts > 0 ? s.priceWeight / s.contracts : null
              const total = s.unrealized + s.realized
              return (
                <div key={`${s.cropYear}-${s.commodity}`} className="bg-white rounded-xl shadow p-4 space-y-1">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-bold">{s.cropYear} {s.commodity}</h3>
                    <span className="text-xs text-slate-500">{s.contracts} contracts</span>
                  </div>
                  <Row label="Bushels hedged" value={`${s.bushels.toLocaleString()} bu`} />
                  <Row label="Avg hedge price" value={fmtPrice(avg)} />
                  {s.hasOpen && <Row label="Unrealized P&L" value={fmtPnl(s.unrealized)} tone={s.unrealized >= 0 ? 'green' : 'red'} />}
                  <Row label="Realized P&L (net)" value={fmtPnl(s.realized)} tone={s.realized >= 0 ? 'green' : 'red'} />
                  <div className="border-t border-slate-100 pt-1">
                    <Row label="Total P&L" value={fmtPnl(total)} tone={total >= 0 ? 'green' : 'red'} bold />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {showNew && <PositionForm entities={entities} onClose={() => setShowNew(false)} onSaved={afterMutation} />}
      {editTarget && <PositionForm entities={entities} initial={editTarget} onClose={() => setEditTarget(null)} onSaved={afterMutation} />}
      {closeTarget && <ClosePositionDialog position={closeTarget} onClose={() => setCloseTarget(null)} onSaved={afterMutation} />}
      {showImport && (
        <StatementImport
          entities={entities}
          existingPositions={positions}
          onClose={() => setShowImport(false)}
          onImported={(s) => { setBanner(`Imported ${s.inserted} position${s.inserted === 1 ? '' : 's'}${s.closed ? ` and closed ${s.closed} matched` : ''}.`); afterMutation() }}
        />
      )}
    </div>
  )
}

const selCls = 'mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white'

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="text-sm text-slate-700 flex flex-col">{label}{children}</label>
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' }) {
  const color = tone === 'green' ? 'text-green-700' : tone === 'red' ? 'text-red-700' : 'text-slate-800'
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  )
}

function Row({ label, value, tone, bold }: { label: string; value: string; tone?: 'green' | 'red'; bold?: boolean }) {
  const color = tone === 'green' ? 'text-green-700' : tone === 'red' ? 'text-red-700' : 'text-slate-700'
  return (
    <div className="flex justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`font-mono ${color} ${bold ? 'font-bold' : ''}`}>{value}</span>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-sm text-slate-400">{children}</div>
}

// <tbody> can't take a Fragment with key directly in some setups; this keeps the
// per-commodity group (rows + subtotal) under one key without an extra element.
function FragmentGroup({ children }: { children: React.ReactNode; key?: string }) {
  return <>{children}</>
}
