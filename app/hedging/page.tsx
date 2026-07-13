'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import PositionForm from '@/components/hedging/position-form'
import ClosePositionDialog from '@/components/hedging/close-position-dialog'
import OptionForm from '@/components/hedging/option-form'
import CloseOptionDialog from '@/components/hedging/close-option-dialog'
import StatementImport from '@/components/hedging/statement-import'
import PriceBoard, { type PriceMap } from '@/components/hedging/price-board'
import {
  COMMODITIES,
  COMMODITY_SPECS,
  type Commodity,
  contractMonthSortKey,
  unrealizedPnl,
  pnlSizeFor,
  optionUnrealizedPnl,
  optionPremiumTotal,
  parseFractional,
  bushelsFor,
  quantityFor,
  fmtQuantity,
  contractUnit,
  fmtCommodityPrice,
  fmtPrice,
  fmtPnl,
  fmtCents,
} from '@/lib/hedging'
import type { Entity, FuturesPosition, OptionPosition } from '@/lib/types'

type StatusFilter = 'open' | 'closed' | 'all'

export default function HedgingPage() {
  const supabase = useMemo(() => createClient(), [])

  const [positions, setPositions] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [prices, setPrices] = useState<PriceMap>(new Map())
  const [priceDate, setPriceDate] = useState<string | null>(null)
  const [priceNote, setPriceNote] = useState<string | null>(null)
  // Live option premiums (cents/bu) keyed by option id, from Barchart when available.
  const [optionValueById, setOptionValueById] = useState<Map<string, number>>(new Map())
  const [optionPriceNote, setOptionPriceNote] = useState<string | null>(null)
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
  const [showNewOption, setShowNewOption] = useState(false)
  const [editOption, setEditOption] = useState<OptionPosition | null>(null)
  const [closeOptionTarget, setCloseOptionTarget] = useState<OptionPosition | null>(null)
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

  // Best-effort live option premiums. Falls back silently when Barchart options
  // pricing isn't available; the UI then uses each option's manual value.
  const fetchOptionPrices = useCallback(async (opts: OptionPosition[]) => {
    const open = opts.filter((o) => o.status === 'open')
    if (open.length === 0) { setOptionValueById(new Map()); setOptionPriceNote(null); return }
    const requests = open.map((o) => ({
      id: o.id,
      root: COMMODITY_SPECS[o.commodity as Commodity]?.symbol ?? o.underlying_symbol.slice(0, 2),
      contract: o.underlying_symbol,
      optionType: o.option_type,
      strike: o.strike_price,
    }))
    try {
      const res = await fetch('/api/options-prices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests }),
      })
      const data = await res.json()
      const map = new Map<string, number>()
      for (const [id, v] of Object.entries(data.values ?? {})) if (typeof v === 'number') map.set(id, v)
      setOptionValueById(map)
      setOptionPriceNote(data.available ? null : data.note ?? 'Live options pricing not available.')
    } catch {
      setOptionPriceNote('Live options pricing not available — enter current values manually.')
    }
  }, [])

  const loadAll = useCallback(async () => {
    const [pos, ent, opt] = await Promise.all([
      supabase.from('futures_positions').select('*').order('trade_date', { ascending: false }),
      supabase.from('entities').select('*').order('name'),
      supabase.from('options_positions').select('*').order('trade_date', { ascending: false }),
    ])
    const list = (pos.data as FuturesPosition[]) ?? []
    const optList = (opt.data as OptionPosition[]) ?? []
    setPositions(list)
    setEntities((ent.data as Entity[]) ?? [])
    setOptions(optList)
    setLoading(false)
    await refreshPrices(list, false)
    await fetchOptionPrices(optList)
  }, [supabase, refreshPrices, fetchOptionPrices])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const entityName = useCallback(
    (id: string | null) => (id ? entities.find((e) => e.id === id)?.name ?? '' : ''),
    [entities],
  )

  const cropYears = useMemo(
    () => Array.from(new Set([...positions.map((p) => p.crop_year), ...options.map((o) => o.crop_year)])).sort((a, b) => b - a),
    [positions, options],
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
    unrealizedPnl({ side: p.side, tradePrice: p.trade_price, currentPrice: curPrice(p.contract_symbol), numContracts: p.num_contracts, contractSizeBu: pnlSizeFor(p.commodity) })
  const netRealized = (p: FuturesPosition) => (p.realized_pnl ?? 0) - (p.commission ?? 0)

  // Options: same crop-year / commodity / entity filters; status split with the
  // closed date-range. Closed options' realized_pnl is already net of commission.
  const baseOptions = useMemo(
    () =>
      options.filter(
        (o) =>
          (fCropYear === 'All' || o.crop_year === Number(fCropYear)) &&
          (fCommodity === 'All' || o.commodity === fCommodity) &&
          (fEntity === 'All' || o.entity_id === fEntity),
      ),
    [options, fCropYear, fCommodity, fEntity],
  )
  const openOptions = useMemo(() => baseOptions.filter((o) => o.status === 'open'), [baseOptions])
  const closedOptions = useMemo(
    () =>
      baseOptions
        .filter(
          (o) =>
            o.status !== 'open' &&
            (!closedFrom || (o.close_date != null && o.close_date >= closedFrom)) &&
            (!closedTo || (o.close_date != null && o.close_date <= closedTo)),
        )
        .sort((a, b) => (b.close_date ?? '').localeCompare(a.close_date ?? '')),
    [baseOptions, closedFrom, closedTo],
  )
  // Live Barchart value, else the manually-entered value, else unknown.
  const optCurrentCents = (o: OptionPosition) => optionValueById.get(o.id) ?? o.manual_current_value_cents ?? null
  const optUnrealized = (o: OptionPosition) =>
    optionUnrealizedPnl({ side: o.side, premiumCents: o.premium_cents, currentCents: optCurrentCents(o), numContracts: o.num_contracts })
  const optNetRealized = (o: OptionPosition) => o.realized_pnl ?? 0

  // Net realized P&L across the filtered closed positions (closed-table total).
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

  // Open options grouped by commodity, then sorted by underlying month.
  const optionGroups = useMemo(() => {
    const m = new Map<Commodity, OptionPosition[]>()
    for (const o of openOptions) {
      const arr = m.get(o.commodity as Commodity) ?? []
      arr.push(o)
      m.set(o.commodity as Commodity, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => contractMonthSortKey(a.underlying_contract_month) - contractMonthSortKey(b.underlying_contract_month))
    return m
  }, [openOptions])

  // Crop-year × commodity summary, combining futures and options.
  type Leg = { contracts: number; bushels: number; priceWeight: number; premium: number; unrealized: number; realized: number; hasOpen: boolean }
  const emptyLeg = (): Leg => ({ contracts: 0, bushels: 0, priceWeight: 0, premium: 0, unrealized: 0, realized: 0, hasOpen: false })
  const cropYearSummaries = useMemo(() => {
    const m = new Map<string, { cropYear: number; commodity: Commodity; fut: Leg; opt: Leg }>()
    const get = (cropYear: number, commodity: Commodity) => {
      const key = `${cropYear}|${commodity}`
      let cur = m.get(key)
      if (!cur) { cur = { cropYear, commodity, fut: emptyLeg(), opt: emptyLeg() }; m.set(key, cur) }
      return cur
    }
    for (const p of base) {
      const f = get(p.crop_year, p.commodity as Commodity).fut
      f.contracts += p.num_contracts
      f.bushels += quantityFor(p.commodity, p.num_contracts)
      f.priceWeight += p.trade_price * p.num_contracts
      if (p.status === 'open') { f.unrealized += posUnrealized(p) ?? 0; f.hasOpen = true }
      else f.realized += netRealized(p)
    }
    for (const o of baseOptions) {
      const g = get(o.crop_year, o.commodity as Commodity).opt
      g.contracts += o.num_contracts
      g.bushels += quantityFor(o.commodity, o.num_contracts)
      // Net premium cash: buying pays out (negative), selling collects (positive).
      g.premium += (o.side === 'buy' ? -1 : 1) * (o.premium_total ?? optionPremiumTotal(o.premium_cents, o.num_contracts))
      if (o.status === 'open') { g.unrealized += optUnrealized(o) ?? 0; g.hasOpen = true }
      else g.realized += optNetRealized(o)
    }
    return Array.from(m.values()).sort((a, b) => b.cropYear - a.cropYear || a.commodity.localeCompare(b.commodity))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, baseOptions, prices, optionValueById])

  function afterMutation() {
    setShowNew(false)
    setEditTarget(null)
    setCloseTarget(null)
    setShowNewOption(false)
    setEditOption(null)
    setCloseOptionTarget(null)
    setShowImport(false)
    loadAll()
  }

  async function deletePosition(p: FuturesPosition) {
    if (!window.confirm(`Delete ${p.side} ${p.num_contracts} ${p.contract_month} ${p.commodity} (${p.contract_symbol})? This can't be undone.`)) return
    const { error } = await supabase.from('futures_positions').delete().eq('id', p.id)
    if (error) { setBanner(`Delete failed: ${error.message}`); return }
    loadAll()
  }

  async function deleteOption(o: OptionPosition) {
    if (!window.confirm(`Delete ${o.side} ${o.num_contracts} ${o.underlying_contract_month} ${o.commodity} ${fmtPrice(o.strike_price)} ${o.option_type}? This can't be undone.`)) return
    const { error } = await supabase.from('options_positions').delete().eq('id', o.id)
    if (error) { setBanner(`Delete failed: ${error.message}`); return }
    loadAll()
  }

  async function updateOptionValue(o: OptionPosition) {
    const cur = optCurrentCents(o)
    const input = window.prompt(`Current premium for ${o.underlying_symbol} ${o.option_type.toUpperCase()} ${fmtPrice(o.strike_price)} (¢/bu):`, cur != null ? String(cur) : '')
    if (input == null) return
    const v = parseFractional(input)
    if (v == null) { setBanner('Could not read that premium value.'); return }
    const { error } = await supabase.from('options_positions').update({ manual_current_value_cents: v }).eq('id', o.id)
    if (error) { setBanner(`Update failed: ${error.message}`); return }
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

      {/* Prices + refresh */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-slate-500">
          Prices as of <span className="font-semibold text-slate-700">{priceDate ?? '—'}</span>
        </span>
        <button
          onClick={() => refreshPrices(positions, true)}
          disabled={refreshing}
          className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh Prices'}
        </button>
      </div>
      {priceNote && <p className="text-xs text-amber-700">{priceNote}</p>}
      {optionPriceNote && <p className="text-xs text-amber-700">Options: {optionPriceNote}</p>}

      {/* Hedging summary by crop year — combines futures and options per crop. */}
      {!loading && cropYearSummaries.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Hedging Summary by Crop Year</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {cropYearSummaries.map((s) => {
              const avg = s.fut.contracts > 0 ? s.fut.priceWeight / s.fut.contracts : null
              const futTotal = s.fut.unrealized + s.fut.realized
              const optTotal = s.opt.unrealized + s.opt.realized
              const combined = futTotal + optTotal
              return (
                <div key={`${s.cropYear}-${s.commodity}`} className="bg-white rounded-xl shadow p-4 space-y-2">
                  <h3 className="font-bold">{s.cropYear} {s.commodity}</h3>
                  {s.fut.contracts > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-xs uppercase tracking-wide text-slate-400">Futures</div>
                      <Row label={contractUnit(s.commodity) === 'lbs' ? 'Lbs hedged' : 'Bushels hedged'} value={`${s.fut.bushels.toLocaleString()} ${contractUnit(s.commodity)} (${s.fut.contracts})`} />
                      <Row label="Avg hedge price" value={fmtCommodityPrice(s.commodity, avg)} />
                      {s.fut.hasOpen && <Row label="Unrealized" value={fmtPnl(s.fut.unrealized)} tone={s.fut.unrealized >= 0 ? 'green' : 'red'} />}
                      <Row label="Realized (net)" value={fmtPnl(s.fut.realized)} tone={s.fut.realized >= 0 ? 'green' : 'red'} />
                    </div>
                  )}
                  {s.opt.contracts > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-xs uppercase tracking-wide text-slate-400">Options</div>
                      <Row label={contractUnit(s.commodity) === 'lbs' ? 'Lbs covered' : 'Bushels covered'} value={`${s.opt.bushels.toLocaleString()} ${contractUnit(s.commodity)} (${s.opt.contracts})`} />
                      <Row label={s.opt.premium < 0 ? 'Premium paid' : 'Premium received'} value={fmtPnl(Math.abs(s.opt.premium))} />
                      {s.opt.hasOpen && <Row label="Unrealized" value={fmtPnl(s.opt.unrealized)} tone={s.opt.unrealized >= 0 ? 'green' : 'red'} />}
                      <Row label="Realized (net)" value={fmtPnl(s.opt.realized)} tone={s.opt.realized >= 0 ? 'green' : 'red'} />
                    </div>
                  )}
                  <div className="border-t border-slate-100 pt-1">
                    <Row label="Combined Total P&L" value={fmtPnl(combined)} tone={combined >= 0 ? 'green' : 'red'} bold />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Price board */}
      <PriceBoard positions={base} prices={prices} priceDate={priceDate} />

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
                  <tr>{['Commodity', 'Month', 'Symbol', 'Side', '# Contracts', 'Qty', 'Trade Date', 'Trade Price', 'Current', 'Unrealized P&L', 'Crop Yr', 'Actions'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
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
                              <td className="px-3 py-2 text-right font-mono">{fmtQuantity(p.commodity, p.num_contracts)}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{p.trade_date}</td>
                              <td className="px-3 py-2 text-right font-mono">{fmtCommodityPrice(p.commodity, p.trade_price)}</td>
                              <td className="px-3 py-2 text-right font-mono">{fmtCommodityPrice(p.commodity, curPrice(p.contract_symbol))}</td>
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
                          <td className="px-3 py-2 text-right font-mono">{fmtQuantity(c, subContracts)}</td>
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
                  <tr>{['Commodity', 'Month', 'Side', '# Contracts', 'Qty', 'Trade Date', 'Trade Price', 'Close Date', 'Close Price', 'Realized P&L', 'Commission', 'Net P&L', 'Crop Yr'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
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
                        <td className="px-3 py-2 text-right font-mono">{fmtQuantity(p.commodity, p.num_contracts)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{p.trade_date}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtCommodityPrice(p.commodity, p.trade_price)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{p.close_date ?? '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtCommodityPrice(p.commodity, p.close_price)}</td>
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

      {/* Open options */}
      {!loading && showOpen && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100 flex items-center gap-3 flex-wrap">
            <div className="flex-1">
              <h2 className="font-semibold">Open Options</h2>
              <p className="text-xs text-slate-500">
                Grouped by commodity, then underlying month.{optionPriceNote ? ' Live pricing unavailable — use “Update” to enter current premiums.' : ''}
              </p>
            </div>
            <button onClick={() => setShowNewOption(true)} className="rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold">+ New Option</button>
          </div>
          {openOptions.length === 0 ? (
            <Empty>No open options for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>{['Commodity', 'Type', 'Side', 'Month', 'Strike', '# Contracts', 'Qty', 'Trade Date', 'Premium ¢', 'Premium $', 'Current ¢', 'Unrealized P&L', 'Crop Yr', 'Actions'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {COMMODITIES.filter((c) => (optionGroups.get(c)?.length ?? 0) > 0).map((c) => {
                    const rows = optionGroups.get(c)!
                    const subContracts = rows.reduce((s, o) => s + o.num_contracts, 0)
                    const subUnreal = rows.reduce((s, o) => s + (optUnrealized(o) ?? 0), 0)
                    return (
                      <FragmentGroup key={c}>
                        {rows.map((o) => {
                          const u = optUnrealized(o)
                          const cv = optCurrentCents(o)
                          return (
                            <tr key={o.id} className="border-t border-slate-100">
                              <td className="px-3 py-2">{o.commodity}</td>
                              <td className="px-3 py-2 capitalize">{o.option_type}</td>
                              <td className="px-3 py-2 capitalize">{o.side}</td>
                              <td className="px-3 py-2">{o.underlying_contract_month}</td>
                              <td className="px-3 py-2 text-right font-mono">{fmtPrice(o.strike_price)}</td>
                              <td className="px-3 py-2 text-right">{o.num_contracts}</td>
                              <td className="px-3 py-2 text-right font-mono">{bushelsFor(o.num_contracts).toLocaleString()}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{o.trade_date}</td>
                              <td className="px-3 py-2 text-right font-mono">{fmtCents(o.premium_cents)}</td>
                              <td className="px-3 py-2 text-right font-mono">{fmtPnl(o.premium_total)}</td>
                              <td className="px-3 py-2 text-right font-mono">{cv == null ? <span className="text-slate-400">N/A</span> : fmtCents(cv)}</td>
                              <td className={`px-3 py-2 text-right font-mono ${u == null ? 'text-slate-400' : u >= 0 ? 'text-green-700' : 'text-red-700'}`}>{u == null ? 'N/A' : fmtPnl(u)}</td>
                              <td className="px-3 py-2">{o.crop_year}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <button onClick={() => setCloseOptionTarget(o)} className="text-sky-700 mr-2">Close</button>
                                <button onClick={() => updateOptionValue(o)} className="text-slate-600 mr-2">Update</button>
                                <button onClick={() => setEditOption(o)} className="text-slate-600 mr-2">Edit</button>
                                <button onClick={() => deleteOption(o)} className="text-red-600">Delete</button>
                              </td>
                            </tr>
                          )
                        })}
                        <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                          <td className="px-3 py-2" colSpan={5}>{c} subtotal</td>
                          <td className="px-3 py-2 text-right">{subContracts}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtQuantity(c, subContracts)}</td>
                          <td colSpan={4} />
                          <td className={`px-3 py-2 text-right font-mono ${subUnreal >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(subUnreal)}</td>
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

      {/* Closed options */}
      {!loading && showClosed && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100"><h2 className="font-semibold">Closed Options</h2></div>
          {closedOptions.length === 0 ? (
            <Empty>No closed options for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>{['Commodity', 'Type', 'Side', 'Month', 'Strike', '# Contracts', 'Trade Date', 'Premium ¢', 'Close Date', 'Status', 'Close ¢', 'Realized P&L', 'Crop Yr'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {closedOptions.map((o) => {
                    const statusLabel = o.status === 'closed_offset' ? 'Offset' : o.status === 'expired_worthless' ? 'Expired' : 'Exercised'
                    return (
                      <tr key={o.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{o.commodity}</td>
                        <td className="px-3 py-2 capitalize">{o.option_type}</td>
                        <td className="px-3 py-2 capitalize">{o.side}</td>
                        <td className="px-3 py-2">{o.underlying_contract_month}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtPrice(o.strike_price)}</td>
                        <td className="px-3 py-2 text-right">{o.num_contracts}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{o.trade_date}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtCents(o.premium_cents)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{o.close_date ?? '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{statusLabel}{o.status === 'exercised' && <span className="text-xs text-slate-400"> → futures</span>}</td>
                        <td className="px-3 py-2 text-right font-mono">{o.close_price_cents != null ? fmtCents(o.close_price_cents) : '—'}</td>
                        <td className={`px-3 py-2 text-right font-mono ${(o.realized_pnl ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(o.realized_pnl)}</td>
                        <td className="px-3 py-2">{o.crop_year}</td>
                      </tr>
                    )
                  })}
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                    <td className="px-3 py-2" colSpan={11}>Total realized P&L (net)</td>
                    <td className={`px-3 py-2 text-right font-mono ${closedOptions.reduce((s, o) => s + (o.realized_pnl ?? 0), 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(closedOptions.reduce((s, o) => s + (o.realized_pnl ?? 0), 0))}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showNew && <PositionForm entities={entities} onClose={() => setShowNew(false)} onSaved={afterMutation} />}
      {editTarget && <PositionForm entities={entities} initial={editTarget} onClose={() => setEditTarget(null)} onSaved={afterMutation} />}
      {closeTarget && <ClosePositionDialog position={closeTarget} onClose={() => setCloseTarget(null)} onSaved={afterMutation} />}
      {showNewOption && <OptionForm entities={entities} onClose={() => setShowNewOption(false)} onSaved={afterMutation} />}
      {editOption && <OptionForm entities={entities} initial={editOption} onClose={() => setEditOption(null)} onSaved={afterMutation} />}
      {closeOptionTarget && <CloseOptionDialog position={closeOptionTarget} onClose={() => setCloseOptionTarget(null)} onSaved={afterMutation} />}
      {showImport && (
        <StatementImport
          entities={entities}
          existingPositions={positions}
          existingOptions={options}
          onClose={() => setShowImport(false)}
          onChanged={loadAll}
          onImported={(s) => { setBanner(`Imported ${s.inserted} item${s.inserted === 1 ? '' : 's'}${s.closed ? ` and closed ${s.closed} matched` : ''}.`); afterMutation() }}
        />
      )}
    </div>
  )
}

const selCls = 'mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white'

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="text-sm text-slate-700 flex flex-col">{label}{children}</label>
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
