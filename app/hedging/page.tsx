'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import PositionForm from '@/components/hedging/position-form'
import ClosePositionDialog from '@/components/hedging/close-position-dialog'
import OptionForm from '@/components/hedging/option-form'
import CloseOptionDialog from '@/components/hedging/close-option-dialog'
import StatementImport from '@/components/hedging/statement-import'
import RollPositionDialog from '@/components/hedging/roll-position-dialog'
import PositionHistoryDialog from '@/components/hedging/position-history-dialog'
import HedgingHistory from '@/components/hedging/hedging-history'
import PriceBoard, { type PriceMap, infoToQuote } from '@/components/hedging/price-board'
import { markOpenPosition } from '@/lib/hedging-rows'
import { buildHedgeTimeline, filterTimeline } from '@/lib/hedge-events'
import { effectiveEntry } from '@/lib/hedge-lineage'
import { QuoteChip } from '@/components/quote-chip'
import { AppModal, ConfirmDialog, PromptDialog } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
import {
  FilterField, ReportFilterBar, selectCls, inputCls,
  theadCls, stickyColCls, stickyColHeadCls, subtotalRowCls, grandTotalRowCls,
  signedTone, toneText,
} from '@/components/reports/report-kit'
import {
  COMMODITIES,
  COMMODITY_SPECS,
  type Commodity,
  contractMonthSortKey,
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
import type { Entity, FuturesPosition, HedgePositionEvent, OptionPosition } from '@/lib/types'

type StatusFilter = 'open' | 'closed' | 'all'
type View = 'positions' | 'history'

// Filters are remembered per page, like the contracts tracker and settlements.
const FILTER_KEY = 'hedging:filters'
type SavedFilters = { cropYear?: string; commodity?: string; entity?: string; status?: StatusFilter; closedFrom?: string; closedTo?: string; view?: View }
function readSavedFilters(): SavedFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    return raw ? (JSON.parse(raw) as SavedFilters) : {}
  } catch { return {} }
}

const cell = 'px-3 py-2'
const numCell = 'px-3 py-2 text-right tabular-nums whitespace-nowrap'
const pnlCls = (n: number | null | undefined) => `${numCell} ${toneText(signedTone(n))}`
const smallBtn = 'rounded-lg border px-2.5 min-h-10 text-xs font-semibold whitespace-nowrap'

export default function HedgingPage() {
  const supabase = useMemo(() => createClient(), [])

  const [positions, setPositions] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [prices, setPrices] = useState<PriceMap>(new Map())
  const [priceDate, setPriceDate] = useState<string | null>(null)
  const [priceNote, setPriceNote] = useState<string | null>(null)
  // Live option premiums (cents/bu) keyed by option id, from the price feed when available.
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
  const [view, setView] = useState<View>('positions')
  const [filtersReady, setFiltersReady] = useState(false)

  useEffect(() => {
    const s = readSavedFilters()
    if (s.cropYear) setFCropYear(s.cropYear)
    if (s.commodity) setFCommodity(s.commodity as 'All' | Commodity)
    if (s.entity) setFEntity(s.entity)
    if (s.status) setFStatus(s.status)
    if (s.closedFrom) setClosedFrom(s.closedFrom)
    if (s.closedTo) setClosedTo(s.closedTo)
    if (s.view) setView(s.view)
    setFiltersReady(true)
  }, [])
  useEffect(() => {
    if (!filtersReady) return
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ cropYear: fCropYear, commodity: fCommodity, entity: fEntity, status: fStatus, closedFrom, closedTo, view } satisfies SavedFilters))
    } catch { /* storage unavailable */ }
  }, [filtersReady, fCropYear, fCommodity, fEntity, fStatus, closedFrom, closedTo, view])

  // Modals
  const [showNew, setShowNew] = useState(false)
  const [editTarget, setEditTarget] = useState<FuturesPosition | null>(null)
  const [closeTarget, setCloseTarget] = useState<FuturesPosition | null>(null)
  const [showNewOption, setShowNewOption] = useState(false)
  const [editOption, setEditOption] = useState<OptionPosition | null>(null)
  const [closeOptionTarget, setCloseOptionTarget] = useState<OptionPosition | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  // 083 — rolls + the history trail.
  const [rollTarget, setRollTarget] = useState<FuturesPosition | null>(null)
  const [historyTarget, setHistoryTarget] = useState<FuturesPosition | null>(null)
  const [events, setEvents] = useState<HedgePositionEvent[]>([])
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  // Row "…" action sheet, delete confirmation, option premium prompt.
  const [menuFor, setMenuFor] = useState<{ kind: 'position'; row: FuturesPosition } | { kind: 'option'; row: OptionPosition } | null>(null)
  const [deleteFor, setDeleteFor] = useState<{ kind: 'position'; row: FuturesPosition } | { kind: 'option'; row: OptionPosition } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [premiumFor, setPremiumFor] = useState<OptionPosition | null>(null)

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
          map.set(p.symbol, { price: p.price, price_date: p.price_date, stale: p.stale, source: p.source ?? null, entered_at: p.entered_at ?? null })
        }
        setPrices(map)
        setPriceDate(data.priceDate ?? null)
        setPriceNote(data.note ?? null)
      } catch (e: any) {
        setPriceNote(reportError(e, { action: 'refresh the market prices', noun: 'price' }))
      } finally {
        setRefreshing(false)
      }
    },
    [],
  )

  // Best-effort live option premiums. Falls back silently when live options
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
      setOptionPriceNote(data.available ? null : data.note ?? 'Live options pricing is not available.')
    } catch {
      setOptionPriceNote('Live options pricing is not available right now — enter current premiums with Update.')
    }
  }, [])

  const loadAll = useCallback(async () => {
    const [pos, ent, opt, ev] = await Promise.all([
      fetchAllRows((f, t) => supabase.from('futures_positions').select('*').order('trade_date', { ascending: false }).order('id').range(f, t)),
      supabase.from('entities').select('*').order('name'),
      fetchAllRows((f, t) => supabase.from('options_positions').select('*').order('trade_date', { ascending: false }).order('id').range(f, t)),
      // The history ledger (083). Absent until the migration is applied — the
      // History view then says so instead of failing the page.
      fetchAllRows((f, t) => supabase.from('hedge_position_events').select('*').order('occurred_at', { ascending: false }).order('recorded_at', { ascending: false }).order('id').range(f, t)),
    ])
    const list = (pos.data as FuturesPosition[]) ?? []
    const optList = (opt.data as OptionPosition[]) ?? []
    setPositions(list)
    setEntities((ent.data as Entity[]) ?? [])
    setOptions(optList)
    if (ev.error) { setHistoryUnavailable(true); setEvents([]) } else { setHistoryUnavailable(false); setEvents((ev.data as HedgePositionEvent[]) ?? []) }
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

  // The history timeline under the same crop-year / commodity / entity filters.
  const timeline = useMemo(
    () => filterTimeline(buildHedgeTimeline(events, { entityName }), { cropYear: fCropYear, commodity: fCommodity, entityId: fEntity }),
    [events, entityName, fCropYear, fCommodity, fEntity],
  )
  // Lineage read-out for a rolled-into open leg: "rolled from DEC 26 @ 4.9525"
  // + the effective price since the original entry (original ± roll spreads).
  const lineageOf = (p: FuturesPosition) => (p.rolled_from_position_id ? effectiveEntry(p, positions) : null)

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

  // One row model for the mark (lib/hedging-rows): price, provenance, P&L.
  const markOf = (p: FuturesPosition) => markOpenPosition({ position: p, quote: infoToQuote(p.contract_symbol, prices.get(p.contract_symbol)) })
  const curPrice = (symbol: string) => prices.get(symbol)?.price ?? null
  const posUnrealized = (p: FuturesPosition) => markOf(p).unrealized
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
  // Live value, else the manually-entered value, else unknown.
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
    setRollTarget(null)
    loadAll()
  }

  async function doDelete() {
    if (!deleteFor) return
    setDeleting(true)
    const { error } = deleteFor.kind === 'position'
      ? await supabase.from('futures_positions').delete().eq('id', deleteFor.row.id)
      : await supabase.from('options_positions').delete().eq('id', deleteFor.row.id)
    setDeleting(false)
    setDeleteFor(null)
    if (error) { setBanner(reportError(error, { action: deleteFor.kind === 'position' ? 'delete this position' : 'delete this option', noun: deleteFor.kind })); return }
    loadAll()
  }

  async function savePremium(raw: string) {
    const o = premiumFor
    if (!o) return
    const v = parseFractional(raw)
    if (v == null) { setBanner('That premium could not be read — enter cents per bushel like 15.5 or 15 1/2.'); return }
    setPremiumFor(null)
    const { error } = await supabase.from('options_positions').update({ manual_current_value_cents: v }).eq('id', o.id)
    if (error) { setBanner(reportError(error, { action: 'save the current premium', noun: 'option' })); return }
    loadAll()
  }

  const showOpen = fStatus === 'open' || fStatus === 'all'
  const showClosed = fStatus === 'closed' || fStatus === 'all'
  const activeFilters = [fCropYear !== 'All', fCommodity !== 'All', fEntity !== 'All', view === 'positions' && fStatus !== 'open', !!closedFrom, !!closedTo].filter(Boolean).length

  const describePosition = (p: FuturesPosition) => `${p.side === 'short' ? 'Short' : 'Long'} ${p.num_contracts} ${p.contract_month} ${p.commodity} (${p.contract_symbol})`
  const describeOption = (o: OptionPosition) => `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.num_contracts} ${o.underlying_contract_month} ${o.commodity} ${fmtPrice(o.strike_price)} ${o.option_type}${o.num_contracts === 1 ? '' : 's'}`

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Hedging</h1>
        <div className="flex-1 flex items-end">
          <div className="inline-flex rounded-lg border border-slate-300 bg-white overflow-hidden text-sm font-semibold" role="tablist" aria-label="View">
            {(['positions', 'history'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`px-3 py-2 min-h-10 ${view === v ? 'bg-brand text-white' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                {v === 'positions' ? 'Positions' : 'History'}
              </button>
            ))}
          </div>
        </div>
        <button type="button" onClick={() => setShowImport(true)} className="rounded-lg bg-white border border-slate-300 px-3 min-h-10 text-sm font-semibold">
          Import brokerage statement
        </button>
        <button type="button" onClick={() => setShowNew(true)} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-10 font-semibold">
          + New position
        </button>
      </div>

      {banner && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 flex items-start gap-2" role="status">
          <span className="flex-1">{banner}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss" className="text-amber-700 min-h-8 min-w-8">✕</button>
        </div>
      )}

      {/* Filters — apply as they change; remembered for next time. */}
      <div className="bg-white rounded-xl shadow p-3">
        <ReportFilterBar activeCount={activeFilters}>
          <FilterField label="Crop year">
            <select value={fCropYear} onChange={(e) => setFCropYear(e.target.value)} className={selectCls}>
              <option value="All">All crop years</option>
              {cropYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </FilterField>
          <FilterField label="Commodity">
            <select value={fCommodity} onChange={(e) => setFCommodity(e.target.value as 'All' | Commodity)} className={selectCls}>
              <option value="All">All commodities</option>
              {COMMODITIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FilterField>
          <FilterField label="Entity">
            <select value={fEntity} onChange={(e) => setFEntity(e.target.value)} className={selectCls}>
              <option value="All">All entities</option>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </FilterField>
          {view === 'positions' && (
            <FilterField label="Status">
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value as StatusFilter)} className={selectCls}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="all">Open and closed</option>
              </select>
            </FilterField>
          )}
          {view === 'positions' && showClosed && (
            <>
              <FilterField label="Closed from">
                <input type="date" value={closedFrom} onChange={(e) => setClosedFrom(e.target.value)} className={inputCls} />
              </FilterField>
              <FilterField label="Closed to">
                <input type="date" value={closedTo} onChange={(e) => setClosedTo(e.target.value)} className={inputCls} />
              </FilterField>
            </>
          )}
          {activeFilters > 0 && (
            <button
              type="button"
              onClick={() => { setFCropYear('All'); setFCommodity('All'); setFEntity('All'); setFStatus('open'); setClosedFrom(''); setClosedTo('') }}
              className="rounded-lg border border-slate-300 px-3 min-h-10 text-sm text-slate-600 hover:bg-slate-50"
            >
              Clear filters
            </button>
          )}
        </ReportFilterBar>
      </div>

      {/* History — the auditable trail, one line per event (083). */}
      {view === 'history' && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100">
            <h2 className="font-semibold">History</h2>
            <p className="text-xs text-slate-500">Every open, close, roll, edit, and import — newest first. Tap a line for prices, fees, the statement it came from, and who recorded it.</p>
          </div>
          {loading ? (
            <Empty>Loading…</Empty>
          ) : historyUnavailable ? (
            <Empty>The hedging history isn&rsquo;t set up for your account yet — contact support.</Empty>
          ) : (
            <HedgingHistory
              lines={timeline}
              emptyText="No hedging activity for these filters."
              renderAction={(l) => {
                const p = positions.find((x) => l.positionIds.includes(x.id))
                return p ? <button type="button" onClick={() => setHistoryTarget(p)} className="text-brand-deep text-xs min-h-8">Position</button> : null
              }}
            />
          )}
        </div>
      )}

      {/* Prices + refresh */}
      {view === 'positions' && (
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-slate-500">
          Prices as of <span className="font-semibold text-slate-700">{priceDate ? fmtDate(priceDate) : '—'}</span>
        </span>
        <button
          type="button"
          onClick={() => refreshPrices(positions, true)}
          disabled={refreshing}
          className="rounded-lg bg-slate-700 text-white px-3 min-h-10 text-xs font-semibold disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh prices'}
        </button>
      </div>
      )}
      {view === 'positions' && priceNote && <p className="text-xs text-amber-700">{priceNote}</p>}
      {view === 'positions' && optionPriceNote && <p className="text-xs text-amber-700">Options: {optionPriceNote}</p>}

      {/* Hedging summary by crop year — combines futures and options per crop. */}
      {view === 'positions' && !loading && cropYearSummaries.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Hedging summary by crop year</h2>
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
                      <Row label={contractUnit(s.commodity) === 'lbs' ? 'Pounds hedged' : 'Bushels hedged'} value={`${s.fut.bushels.toLocaleString()} ${contractUnit(s.commodity)} (${s.fut.contracts} contract${s.fut.contracts === 1 ? '' : 's'})`} />
                      <Row label="Average hedge price" value={fmtCommodityPrice(s.commodity, avg)} />
                      {s.fut.hasOpen && <Row label="Unrealized" value={fmtPnl(s.fut.unrealized)} tone={signedTone(s.fut.unrealized)} />}
                      <Row label="Realized, after commission" value={fmtPnl(s.fut.realized)} tone={signedTone(s.fut.realized)} />
                    </div>
                  )}
                  {s.opt.contracts > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-xs uppercase tracking-wide text-slate-400">Options</div>
                      <Row label={contractUnit(s.commodity) === 'lbs' ? 'Pounds covered' : 'Bushels covered'} value={`${s.opt.bushels.toLocaleString()} ${contractUnit(s.commodity)} (${s.opt.contracts} contract${s.opt.contracts === 1 ? '' : 's'})`} />
                      <Row label={s.opt.premium < 0 ? 'Premium paid' : 'Premium received'} value={fmtPnl(Math.abs(s.opt.premium))} />
                      {s.opt.hasOpen && <Row label="Unrealized" value={fmtPnl(s.opt.unrealized)} tone={signedTone(s.opt.unrealized)} />}
                      <Row label="Realized, after commission" value={fmtPnl(s.opt.realized)} tone={signedTone(s.opt.realized)} />
                    </div>
                  )}
                  <div className="border-t border-slate-100 pt-1">
                    <Row label="Combined gain or loss" value={fmtPnl(combined)} tone={signedTone(combined)} bold />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Price board */}
      {view === 'positions' && <PriceBoard positions={base} prices={prices} priceDate={priceDate} onManualSaved={() => void refreshPrices(positions, true)} />}

      {view === 'positions' && loading && <div className="bg-white rounded-xl shadow p-6 text-center text-slate-400">Loading…</div>}

      {/* Open positions */}
      {view === 'positions' && !loading && showOpen && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100">
            <h2 className="font-semibold">Open positions</h2>
            <p className="text-xs text-slate-500">Grouped by commodity, then contract month. Green = the hedge is gaining; red = the hedge is losing (your grain in the field is worth more). <b>eff.</b> under a rolled position is the price the hedge really sits at since the original entry, with each roll&rsquo;s spread folded in.</p>
          </div>
          {openPos.length === 0 ? (
            <Empty>No open positions for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm border-collapse">
                <thead className={theadCls}>
                  <tr>
                    <th className={`${stickyColHeadCls} text-left ${cell} whitespace-nowrap`}>Commodity</th>
                    {['Month', 'Symbol', 'Side'].map((h) => <th key={h} className={`text-left ${cell} whitespace-nowrap`}>{h}</th>)}
                    {['Contracts', 'Quantity'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Trade date</th>
                    {['Trade price', 'Current price', 'Unrealized'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Crop year</th>
                    <th className={`text-left ${cell} whitespace-nowrap`}>Actions</th>
                  </tr>
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
                          const lin = lineageOf(p)
                          return (
                            <tr key={p.id} className="border-t border-slate-100 align-top">
                              <td className={`${stickyColCls} ${cell} font-medium whitespace-nowrap`}>{p.commodity}</td>
                              <td className={`${cell} whitespace-nowrap`}>
                                {p.contract_month}
                                {lin && (
                                  <div className="mt-0.5">
                                    <button type="button" onClick={() => setHistoryTarget(p)} className="text-[11px] rounded-full bg-sky-100 text-sky-800 px-2 py-0.5 whitespace-nowrap min-h-6" aria-label="Show the roll history">
                                      rolled from {lin.steps[lin.steps.length - 1]?.fromMonth ?? lin.originalMonth} @ {fmtCommodityPrice(p.commodity, lin.steps.length > 1 ? lin.steps[lin.steps.length - 1].closePrice : lin.originalEntry)}
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td className={`${cell} font-mono`}>{p.contract_symbol}</td>
                              <td className={`${cell} capitalize`}>{p.side}</td>
                              <td className={numCell}>{p.num_contracts}</td>
                              <td className={numCell}>{fmtQuantity(p.commodity, p.num_contracts)}</td>
                              <td className={`${cell} whitespace-nowrap`}>{fmtDate(p.trade_date)}</td>
                              <td className={numCell}>
                                {fmtCommodityPrice(p.commodity, p.trade_price)}
                                {lin && (
                                  <div className="text-[11px] text-slate-500 whitespace-nowrap">
                                    eff. <span className="text-slate-700">{fmtCommodityPrice(p.commodity, lin.effectivePrice)}</span> since {lin.originalMonth}
                                  </div>
                                )}
                              </td>
                              <td className={numCell}>
                                {fmtCommodityPrice(p.commodity, curPrice(p.contract_symbol))}
                                {markOf(p).quote?.source === 'manual' && <QuoteChip quote={markOf(p).quote} className="ml-1" />}
                              </td>
                              <td className={pnlCls(u)}>{u == null ? '—' : fmtPnl(u)}</td>
                              <td className={cell}>{p.crop_year}</td>
                              <td className={`${cell} whitespace-nowrap`}>
                                <div className="flex items-center gap-1.5">
                                  <button type="button" onClick={() => setCloseTarget(p)} className={`${smallBtn} border-brand text-brand-deep bg-white hover:bg-green-50`}>Close</button>
                                  <button type="button" onClick={() => setRollTarget(p)} className={`${smallBtn} border-slate-300 text-slate-700 bg-white hover:bg-slate-50`}>Roll…</button>
                                  <button type="button" onClick={() => setMenuFor({ kind: 'position', row: p })} className={`${smallBtn} border-slate-300 text-slate-700 bg-white hover:bg-slate-50 min-w-10`} aria-label={`More actions for ${describePosition(p)}`}>…</button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                        <tr className={`border-t border-slate-200 ${subtotalRowCls}`}>
                          <td className={`${stickyColCls} ${cell} bg-slate-50`}>{c} subtotal</td>
                          <td className={cell} colSpan={3} />
                          <td className={numCell}>{subContracts}</td>
                          <td className={numCell}>{fmtQuantity(c, subContracts)}</td>
                          <td colSpan={3} />
                          <td className={pnlCls(subUnrealized)}>{fmtPnl(subUnrealized)}</td>
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
      {view === 'positions' && !loading && showClosed && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100">
            <h2 className="font-semibold">Closed positions</h2>
          </div>
          {closedPos.length === 0 ? (
            <Empty>No closed positions for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm border-collapse">
                <thead className={theadCls}>
                  <tr>
                    <th className={`${stickyColHeadCls} text-left ${cell} whitespace-nowrap`}>Commodity</th>
                    {['Month', 'Side'].map((h) => <th key={h} className={`text-left ${cell} whitespace-nowrap`}>{h}</th>)}
                    {['Contracts', 'Quantity'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Trade date</th>
                    <th className={`text-right ${cell} whitespace-nowrap`}>Trade price</th>
                    <th className={`text-left ${cell} whitespace-nowrap`}>Close date</th>
                    {['Close price', 'Realized', 'Commission', 'Net after commission'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Crop year</th>
                    <th className={`text-left ${cell} whitespace-nowrap`}></th>
                  </tr>
                </thead>
                <tbody>
                  {closedPos.map((p) => {
                    const net = netRealized(p)
                    const rolledInto = p.roll_group_id ? positions.find((x) => x.rolled_from_position_id === p.id) : null
                    return (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className={`${stickyColCls} ${cell} font-medium whitespace-nowrap`}>{p.commodity}</td>
                        <td className={`${cell} whitespace-nowrap`}>
                          {p.contract_month}
                          {rolledInto && <div className="mt-0.5"><span className="text-[11px] rounded-full bg-sky-100 text-sky-800 px-2 py-0.5">rolled → {rolledInto.contract_month}</span></div>}
                        </td>
                        <td className={`${cell} capitalize`}>{p.side}</td>
                        <td className={numCell}>{p.num_contracts}</td>
                        <td className={numCell}>{fmtQuantity(p.commodity, p.num_contracts)}</td>
                        <td className={`${cell} whitespace-nowrap`}>{fmtDate(p.trade_date)}</td>
                        <td className={numCell}>{fmtCommodityPrice(p.commodity, p.trade_price)}</td>
                        <td className={`${cell} whitespace-nowrap`}>{p.close_date ? fmtDate(p.close_date) : '—'}</td>
                        <td className={numCell}>{fmtCommodityPrice(p.commodity, p.close_price)}</td>
                        <td className={pnlCls(p.realized_pnl)}>{fmtPnl(p.realized_pnl)}</td>
                        <td className={numCell}>{fmtPnl(p.commission)}</td>
                        <td className={pnlCls(net)}>{fmtPnl(net)}</td>
                        <td className={cell}>{p.crop_year}</td>
                        <td className={`${cell} whitespace-nowrap`}><button type="button" onClick={() => setHistoryTarget(p)} className={`${smallBtn} border-slate-300 text-slate-700 bg-white`}>History</button></td>
                      </tr>
                    )
                  })}
                  <tr className={grandTotalRowCls}>
                    <td className={`${stickyColCls} ${cell} bg-slate-100`}>Totals</td>
                    <td className={cell} colSpan={8} />
                    <td className={numCell}>{fmtPnl(closedPos.reduce((s, p) => s + (p.realized_pnl ?? 0), 0))}</td>
                    <td className={numCell}>{fmtPnl(closedPos.reduce((s, p) => s + (p.commission ?? 0), 0))}</td>
                    <td className={pnlCls(totalRealizedNet)}>{fmtPnl(totalRealizedNet)}</td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Open options */}
      {view === 'positions' && !loading && showOpen && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100 flex items-center gap-3 flex-wrap">
            <div className="flex-1">
              <h2 className="font-semibold">Open options</h2>
              <p className="text-xs text-slate-500">
                Grouped by commodity, then underlying month.{optionPriceNote ? ' Live pricing is unavailable — use Update to enter current premiums.' : ''}
              </p>
            </div>
            <button type="button" onClick={() => setShowNewOption(true)} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-10 text-sm font-semibold">+ New option</button>
          </div>
          {openOptions.length === 0 ? (
            <Empty>No open options for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm border-collapse">
                <thead className={theadCls}>
                  <tr>
                    <th className={`${stickyColHeadCls} text-left ${cell} whitespace-nowrap`}>Commodity</th>
                    {['Type', 'Side', 'Month'].map((h) => <th key={h} className={`text-left ${cell} whitespace-nowrap`}>{h}</th>)}
                    {['Strike', 'Contracts', 'Bushels'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Trade date</th>
                    {['Premium ¢/bu', 'Premium total', 'Current ¢/bu', 'Unrealized'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Crop year</th>
                    <th className={`text-left ${cell} whitespace-nowrap`}>Actions</th>
                  </tr>
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
                              <td className={`${stickyColCls} ${cell} font-medium whitespace-nowrap`}>{o.commodity}</td>
                              <td className={`${cell} capitalize`}>{o.option_type}</td>
                              <td className={`${cell} capitalize`}>{o.side}</td>
                              <td className={cell}>{o.underlying_contract_month}</td>
                              <td className={numCell}>{fmtPrice(o.strike_price)}</td>
                              <td className={numCell}>{o.num_contracts}</td>
                              <td className={numCell}>{bushelsFor(o.num_contracts).toLocaleString()}</td>
                              <td className={`${cell} whitespace-nowrap`}>{fmtDate(o.trade_date)}</td>
                              <td className={numCell}>{fmtCents(o.premium_cents)}</td>
                              <td className={numCell}>{fmtPnl(o.premium_total)}</td>
                              <td className={numCell}>{cv == null ? <span className="text-slate-400">not entered</span> : fmtCents(cv)}</td>
                              <td className={pnlCls(u)}>{u == null ? '—' : fmtPnl(u)}</td>
                              <td className={cell}>{o.crop_year}</td>
                              <td className={`${cell} whitespace-nowrap`}>
                                <div className="flex items-center gap-1.5">
                                  <button type="button" onClick={() => setCloseOptionTarget(o)} className={`${smallBtn} border-brand text-brand-deep bg-white hover:bg-green-50`}>Close</button>
                                  <button type="button" onClick={() => setPremiumFor(o)} className={`${smallBtn} border-slate-300 text-slate-700 bg-white hover:bg-slate-50`}>Update</button>
                                  <button type="button" onClick={() => setMenuFor({ kind: 'option', row: o })} className={`${smallBtn} border-slate-300 text-slate-700 bg-white hover:bg-slate-50 min-w-10`} aria-label={`More actions for ${describeOption(o)}`}>…</button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                        <tr className={`border-t border-slate-200 ${subtotalRowCls}`}>
                          <td className={`${stickyColCls} ${cell} bg-slate-50`}>{c} subtotal</td>
                          <td className={cell} colSpan={4} />
                          <td className={numCell}>{subContracts}</td>
                          <td className={numCell}>{fmtQuantity(c, subContracts)}</td>
                          <td colSpan={4} />
                          <td className={pnlCls(subUnreal)}>{fmtPnl(subUnreal)}</td>
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
      {view === 'positions' && !loading && showClosed && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-4 pt-3 pb-2 border-b border-slate-100"><h2 className="font-semibold">Closed options</h2></div>
          {closedOptions.length === 0 ? (
            <Empty>No closed options for these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm border-collapse">
                <thead className={theadCls}>
                  <tr>
                    <th className={`${stickyColHeadCls} text-left ${cell} whitespace-nowrap`}>Commodity</th>
                    {['Type', 'Side', 'Month'].map((h) => <th key={h} className={`text-left ${cell} whitespace-nowrap`}>{h}</th>)}
                    {['Strike', 'Contracts'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Trade date</th>
                    <th className={`text-right ${cell} whitespace-nowrap`}>Premium ¢/bu</th>
                    <th className={`text-left ${cell} whitespace-nowrap`}>Close date</th>
                    <th className={`text-left ${cell} whitespace-nowrap`}>How it closed</th>
                    {['Close ¢/bu', 'Realized'].map((h) => <th key={h} className={`text-right ${cell} whitespace-nowrap`}>{h}</th>)}
                    <th className={`text-left ${cell} whitespace-nowrap`}>Crop year</th>
                  </tr>
                </thead>
                <tbody>
                  {closedOptions.map((o) => {
                    const statusLabel = o.status === 'closed_offset' ? 'Traded back' : o.status === 'expired_worthless' ? 'Expired' : 'Exercised'
                    return (
                      <tr key={o.id} className="border-t border-slate-100">
                        <td className={`${stickyColCls} ${cell} font-medium whitespace-nowrap`}>{o.commodity}</td>
                        <td className={`${cell} capitalize`}>{o.option_type}</td>
                        <td className={`${cell} capitalize`}>{o.side}</td>
                        <td className={cell}>{o.underlying_contract_month}</td>
                        <td className={numCell}>{fmtPrice(o.strike_price)}</td>
                        <td className={numCell}>{o.num_contracts}</td>
                        <td className={`${cell} whitespace-nowrap`}>{fmtDate(o.trade_date)}</td>
                        <td className={numCell}>{fmtCents(o.premium_cents)}</td>
                        <td className={`${cell} whitespace-nowrap`}>{o.close_date ? fmtDate(o.close_date) : '—'}</td>
                        <td className={`${cell} whitespace-nowrap`}>{statusLabel}{o.status === 'exercised' && <span className="text-xs text-slate-400"> → futures</span>}</td>
                        <td className={numCell}>{o.close_price_cents != null ? fmtCents(o.close_price_cents) : '—'}</td>
                        <td className={pnlCls(o.realized_pnl)}>{fmtPnl(o.realized_pnl)}</td>
                        <td className={cell}>{o.crop_year}</td>
                      </tr>
                    )
                  })}
                  <tr className={grandTotalRowCls}>
                    <td className={`${stickyColCls} ${cell} bg-slate-100`}>Total realized</td>
                    <td className={cell} colSpan={10} />
                    <td className={pnlCls(closedOptions.reduce((s, o) => s + (o.realized_pnl ?? 0), 0))}>{fmtPnl(closedOptions.reduce((s, o) => s + (o.realized_pnl ?? 0), 0))}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Row action sheet: the less-used actions behind "…", Delete last. */}
      <AppModal
        open={menuFor != null}
        title={menuFor ? (menuFor.kind === 'position' ? describePosition(menuFor.row) : describeOption(menuFor.row)) : ''}
        onClose={() => setMenuFor(null)}
        size="sm"
      >
        {menuFor && (
          <div className="flex flex-col gap-1">
            <button type="button" data-autofocus onClick={() => { if (menuFor.kind === 'position') setEditTarget(menuFor.row); else setEditOption(menuFor.row); setMenuFor(null) }} className="text-left rounded-lg px-3 min-h-11 hover:bg-slate-50 font-medium">Edit</button>
            {menuFor.kind === 'position' && (
              <button type="button" onClick={() => { setHistoryTarget(menuFor.row); setMenuFor(null) }} className="text-left rounded-lg px-3 min-h-11 hover:bg-slate-50 font-medium">History</button>
            )}
            <div className="border-t border-slate-200 my-1" />
            <button type="button" onClick={() => { setDeleteFor(menuFor); setMenuFor(null) }} className="text-left rounded-lg px-3 min-h-11 hover:bg-red-50 font-medium text-red-700">Delete…</button>
            <button type="button" onClick={() => setMenuFor(null)} className="mt-1 rounded-lg border border-slate-300 bg-white px-3 min-h-11 text-sm">Cancel</button>
          </div>
        )}
      </AppModal>

      <ConfirmDialog
        open={deleteFor != null}
        title={deleteFor?.kind === 'option' ? 'Delete this option?' : 'Delete this position?'}
        body={deleteFor && (
          <p>
            <b>{deleteFor.kind === 'position' ? describePosition(deleteFor.row) : describeOption(deleteFor.row)}</b> is removed from your hedging records. This can&rsquo;t be undone — if the trade was real, close it instead.
          </p>
        )}
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleteFor(null)}
      />

      <PromptDialog
        open={premiumFor != null}
        title="Current premium"
        body={premiumFor ? <p>{premiumFor.underlying_symbol} {premiumFor.option_type.toUpperCase()} {fmtPrice(premiumFor.strike_price)} — the premium it is worth today, in cents per bushel (15.5 or 15 1/2).</p> : null}
        label="Premium"
        unit="¢/bu"
        initial={premiumFor ? (optCurrentCents(premiumFor) != null ? String(optCurrentCents(premiumFor)) : '') : ''}
        confirmLabel="Save premium"
        onSubmit={(v) => void savePremium(v)}
        onCancel={() => setPremiumFor(null)}
      />

      {showNew && <PositionForm entities={entities} onClose={() => setShowNew(false)} onSaved={afterMutation} />}
      {editTarget && <PositionForm entities={entities} initial={editTarget} onClose={() => setEditTarget(null)} onSaved={afterMutation} />}
      {closeTarget && <ClosePositionDialog position={closeTarget} onClose={() => setCloseTarget(null)} onSaved={afterMutation} />}
      {rollTarget && <RollPositionDialog position={rollTarget} allPositions={positions} onClose={() => setRollTarget(null)} onSaved={afterMutation} />}
      {historyTarget && <PositionHistoryDialog position={historyTarget} allPositions={positions} entityName={entityName} onClose={() => setHistoryTarget(null)} />}
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
          onImported={(s) => {
            const parts = [
              s.rolled ? `recorded ${s.rolled} roll${s.rolled === 1 ? '' : 's'}` : '',
              `imported ${s.inserted} item${s.inserted === 1 ? '' : 's'}`,
              s.closed ? `closed ${s.closed} matched` : '',
            ].filter(Boolean)
            const msg = parts.join(', ')
            setBanner(msg.charAt(0).toUpperCase() + msg.slice(1) + '.')
            afterMutation()
          }}
        />
      )}
    </div>
  )
}

function Row({ label, value, tone = 'neutral', bold }: { label: string; value: string; tone?: ReturnType<typeof signedTone>; bold?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`tabular-nums ${toneText(tone)} ${bold ? 'font-bold' : ''}`}>{value}</span>
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
