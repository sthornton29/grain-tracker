'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useReportCropYear } from '@/lib/report-filters'
import { fmtDate } from '@/lib/format-date'
import {
  COMMODITIES,
  type Commodity,
  contractMonthSortKey,
  parseContractMonth,
  optionUnrealizedPnl,

  quantityFor,
  contractUnit,
  fmtCommodityPrice,
  fmtPrice,
  fmtPnl,
  fmtCents,
} from '@/lib/hedging'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import { quoteMapFromWire, type Quote } from '@/lib/quotes'
import { markOpenPosition } from '@/lib/hedging-rows'
import { buildEntityScope } from '@/lib/entity-scope'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { buildHedgeTimeline, hedgeEventExportRows, HEDGE_EVENT_EXPORT_COLUMNS } from '@/lib/hedge-events'
import HedgingHistory from '@/components/hedging/hedging-history'
import type { Crop, Entity, FuturesPosition, HedgePositionEvent, OptionPosition } from '@/lib/types'
import {
  SummaryCards,
  EmptyState,
  ReportHeader,
  ReportFilterBar,
  FilterField,
  signedTone,
  toneText,
  theadCls,
  grandTotalRowCls,
  stickyColCls,
  stickyColHeadCls,
  selectCls,
  inputCls,
  filterSummaryOf,
  cropYearLabel,
  type SummaryCardData,
} from '@/components/reports/report-kit'

type Props = {
  onPayloadChange?: (build: () => ExportPayload) => void
  /** Rendered in the report header's action slot (the page passes <ExportBar/>). */
  headerActions?: ReactNode
}

// 'DEC 26' + 'Corn' → 'Dec 26 Corn': the readable name shown beside a raw
// futures symbol like ZCZ26.
function contractLabel(commodity: string, contractMonth: string | null | undefined): string {
  const p = parseContractMonth(contractMonth)
  if (!p) return commodity
  const mon = p.abbr.charAt(0) + p.abbr.slice(1).toLowerCase()
  return `${mon} ${String(p.year2).padStart(2, '0')} ${commodity}`
}

export default function HedgingSummaryReport({ onPayloadChange, headerActions }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [positions, setPositions] = useState<FuturesPosition[]>([])
  const [options, setOptions] = useState<OptionPosition[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [quoteBySymbol, setQuoteBySymbol] = useState<Map<string, Quote>>(new Map())
  const [priceDate, setPriceDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // The hedging history ledger (083) — the "Hedging activity" section. Null
  // when it can't be read (migration not applied, or a viewer: the ledger is
  // owner-only because it carries whole-book snapshots).
  const [events, setEvents] = useState<HedgePositionEvent[] | null>(null)

  // Filters persist per report. The crop year follows the one report rule
  // (current year by default, never overwritten on load; "All" stays on offer).
  const cropYears = useMemo(
    () => Array.from(new Set([...positions.map((p) => p.crop_year), ...options.map((o) => o.crop_year)])).sort((a, b) => b - a),
    [positions, options],
  )
  const [cropYearValue, setCropYearValue] = useReportCropYear('hedging-summary:cropYear', { allowAll: true, options: cropYears, loaded: !loading })
  const cropYear = cropYearValue === '' ? 'All' : String(cropYearValue)
  const setCropYear = (v: string) => setCropYearValue(v === 'All' || v === '' ? '' : Number(v))
  const [commodity, setCommodity] = usePersistentState<'All' | Commodity>('hedging-summary:commodity', 'All')
  const [entityId, setEntityId] = usePersistentState('hedging-summary:entity', 'All')
  const [from, setFrom] = usePersistentState('hedging-summary:from', '')
  const [to, setTo] = usePersistentState('hedging-summary:to', '')

  useEffect(() => {
    ;(async () => {
      const [pos, ent, opt, ev] = await Promise.all([
        fetchAllRows((f, t) => supabase.from('futures_positions').select('*').order('trade_date', { ascending: false }).order('id').range(f, t)),
        supabase.from('entities').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('options_positions').select('*').order('trade_date', { ascending: false }).order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('hedge_position_events').select('*').order('occurred_at', { ascending: false }).order('recorded_at', { ascending: false }).order('id').range(f, t)),
      ])
      const allPos = (pos.data as FuturesPosition[]) ?? []
      setPositions(allPos)
      setOptions((opt.data as OptionPosition[]) ?? [])
      setEntities((ent.data as Entity[]) ?? [])
      setEvents(ev.error ? null : ((ev.data as HedgePositionEvent[]) ?? []))
      // Quotes for the open symbols through THE seam (/api/market-prices:
      // live → manual → none) — never a raw newest-row read of the cache, so
      // a manual cotton quote and its provenance reach this report too.
      const symbols = Array.from(new Set(allPos.filter((p) => p.status === 'open').map((p) => p.contract_symbol)))
      const m = new Map<string, Quote>()
      if (symbols.length > 0) {
        try {
          const res = await fetch('/api/market-prices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols }) })
          const json = await res.json().catch(() => null)
          for (const [k, v] of quoteMapFromWire(json?.prices)) m.set(k, v)
          setPriceDate(typeof json?.priceDate === 'string' ? json.priceDate : null)
        } catch { /* unrealized stays "—" for unquoted rows */ }
      }
      setQuoteBySymbol(m)
      setLoading(false)
    })()
  }, [supabase])

  // Viewer role (052): agent-held / operation-level (null-entity) positions
  // must never appear whole — they attribute at the granted entities' pro-rata
  // acre share, exactly like the Marketing dashboard (lib/entity-scope.ts).
  // Owners skip all of this (attributed === raw rows).
  const viewer = useViewerScope(supabase)
  const [viewerAcreage, setViewerAcreage] = useState<{
    plantings: Array<{ field_id: string; crop_id: string; season_year: number; planted_acres: number | null }>
    crops: Crop[]
    farms: Array<{ id: string; entity_id: string | null }>
    fields: Array<{ id: string; farm_id: string | null }>
  } | null>(null)
  useEffect(() => {
    if (!viewer.isViewer) return
    let cancelled = false
    ;(async () => {
      const [pl, cr, fa, fi] = await Promise.all([
        fetchAllRows((f, t) => supabase.from('field_plantings').select('field_id, crop_id, season_year, planted_acres').order('id').range(f, t)),
        supabase.from('crops').select('*'),
        supabase.from('farms').select('id, entity_id'),
        supabase.from('fields').select('id, farm_id'),
      ])
      if (cancelled) return
      setViewerAcreage({
        plantings: (pl.data as Array<{ field_id: string; crop_id: string; season_year: number; planted_acres: number | null }>) ?? [],
        crops: (cr.data as Crop[]) ?? [],
        farms: (fa.data as Array<{ id: string; entity_id: string | null }>) ?? [],
        fields: (fi.data as Array<{ id: string; farm_id: string | null }>) ?? [],
      })
    })()
    return () => { cancelled = true }
  }, [viewer.isViewer, supabase])
  const viewerAttr = useMemo(() => {
    if (!viewer.isViewer || !viewerAcreage) return null
    const scope = buildEntityScope({
      entityId: entityId === 'All' ? '' : entityId,
      farms: viewerAcreage.farms, fields: viewerAcreage.fields, entities,
      grantedEntityIds: viewer.grantedIds,
    })
    return scope.attribution({ plantings: viewerAcreage.plantings, crops: viewerAcreage.crops })
  }, [viewer.isViewer, viewer.grantedIds, viewerAcreage, entities, entityId])
  // Attributed inputs: identity for owners; scaled + grant-narrowed for viewers.
  const attributedPositions = useMemo(
    () => (viewerAttr ? viewerAttr.futures(positions) : positions),
    [viewerAttr, positions],
  )
  const attributedOptions = useMemo(
    () => (viewerAttr ? viewerAttr.options(options) : options),
    [viewerAttr, options],
  )
  // A viewer's rows are already entity-narrowed by the attribution — the
  // strict per-row entity match below would wrongly drop scaled agent rows.
  const entityMatches = (rowEntity: string | null) =>
    viewer.isViewer ? true : entityId === 'All' || rowEntity === entityId
  const viewerReady = !viewer.loading && (!viewer.isViewer || viewerAcreage != null)

  const entityName = (id: string | null) => (id ? entities.find((e) => e.id === id)?.name ?? '' : '')

  // Viewer attribution scales positions fractionally (an entity's pro-rata
  // share) — cap the display: contracts to 2 decimals (whole stays whole),
  // bushels to the nearest whole. Money already goes through fmtPnl (2 dp).
  const fmtContracts = (n: number) => Number(n.toFixed(2)).toLocaleString()
  const fmtQty = (n: number) => Math.round(n).toLocaleString()

  // A position's reference date for the date-range filter: close date if closed,
  // otherwise the trade date.
  const refDate = (p: FuturesPosition) => (p.status === 'closed' ? p.close_date ?? p.trade_date : p.trade_date)

  const filtered = useMemo(
    () =>
      (viewerReady ? attributedPositions : [])
        .filter(
          (p) =>
            (cropYear === 'All' || p.crop_year === Number(cropYear)) &&
            (commodity === 'All' || p.commodity === commodity) &&
            entityMatches(p.entity_id) &&
            (!from || refDate(p) >= from) &&
            (!to || refDate(p) <= to),
        )
        .sort(
          (a, b) =>
            b.crop_year - a.crop_year ||
            a.commodity.localeCompare(b.commodity) ||
            contractMonthSortKey(a.contract_month) - contractMonthSortKey(b.contract_month),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attributedPositions, viewerReady, viewer.isViewer, cropYear, commodity, entityId, from, to],
  )

  const markOf = (p: FuturesPosition) => markOpenPosition({ position: p, quote: quoteBySymbol.get(p.contract_symbol) ?? null })
  const unrealizedOf = (p: FuturesPosition) => (p.status === 'open' ? markOf(p).unrealized : null)
  const netRealizedOf = (p: FuturesPosition) => (p.status === 'closed' ? (p.realized_pnl ?? 0) - (p.commission ?? 0) : 0)

  // Options. No live pricing in the report — unrealized uses each option's
  // manually-entered current value when present; closed options' realized_pnl
  // is already net of commission.
  const refDateOpt = (o: OptionPosition) => (o.status !== 'open' ? o.close_date ?? o.trade_date : o.trade_date)
  const filteredOptions = useMemo(
    () =>
      (viewerReady ? attributedOptions : [])
        .filter(
          (o) =>
            (cropYear === 'All' || o.crop_year === Number(cropYear)) &&
            (commodity === 'All' || o.commodity === commodity) &&
            entityMatches(o.entity_id) &&
            (!from || refDateOpt(o) >= from) &&
            (!to || refDateOpt(o) <= to),
        )
        .sort(
          (a, b) =>
            b.crop_year - a.crop_year ||
            a.commodity.localeCompare(b.commodity) ||
            contractMonthSortKey(a.underlying_contract_month) - contractMonthSortKey(b.underlying_contract_month),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attributedOptions, viewerReady, viewer.isViewer, cropYear, commodity, entityId, from, to],
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

  // Hedging activity: the ledger under the same crop-year / commodity /
  // entity / date filters (dates apply to the event's trade date). Owners
  // only — a viewer's report never shows the ledger.
  const filteredEvents = useMemo(
    () =>
      viewer.isViewer || events == null ? [] : events.filter(
        (e) =>
          (cropYear === 'All' || e.crop_year === Number(cropYear)) &&
          (commodity === 'All' || e.commodity === commodity) &&
          (entityId === 'All' || (e.entity_id ?? '') === entityId) &&
          (!from || e.occurred_at >= from) &&
          (!to || e.occurred_at <= to),
      ),
    [events, viewer.isViewer, cropYear, commodity, entityId, from, to],
  )
  const activity = useMemo(() => buildHedgeTimeline(filteredEvents, { entityName }), [filteredEvents]) // eslint-disable-line react-hooks/exhaustive-deps
  const positionLabel = (id: string | null) => {
    const p = id ? positions.find((x) => x.id === id) : null
    return p ? `${p.contract_month} ${p.commodity} ${p.side} ${p.num_contracts} @ ${p.trade_price}` : (id ?? '')
  }

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
      cur.bushels += quantityFor(p.commodity, p.num_contracts)
      cur.priceWeight += p.trade_price * p.num_contracts
      cur.unrealized += unrealizedOf(p) ?? 0
      cur.realized += netRealizedOf(p)
      m.set(key, cur)
    }
    return Array.from(m.values()).sort((a, b) => b.cropYear - a.cropYear || a.commodity.localeCompare(b.commodity))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, quoteBySymbol])

  function filtersLabel() {
    const granted = viewerAllEntitiesLabel(viewer, entities)
    return filterSummaryOf(
      cropYearLabel(cropYearValue),
      entityId !== 'All' ? (entityName(entityId) || entityId) : (granted ?? 'All Entities'),
      commodity === 'All' ? 'All Commodities' : commodity,
      from && to ? `${fmtDate(from)} – ${fmtDate(to)}` : from ? `From ${fmtDate(from)}` : to ? `Through ${fmtDate(to)}` : null,
    )
  }
  const activeFilterCount = (cropYearValue !== '' ? 1 : 0) + (commodity !== 'All' ? 1 : 0) + (entityId !== 'All' ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0)

  function buildExportPayload(): ExportPayload {
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: 'Summary by Crop Year',
      columns: [
        { label: 'Crop Year', format: 'text' }, { label: 'Commodity' },
        { label: 'Futures Contracts', align: 'right', format: 'dec2' }, { label: 'Qty (bu · lbs)', align: 'right', format: 'bu' }, { label: 'Unit' },
        { label: 'Avg Hedge Price', align: 'right', format: 'price' }, { label: 'Futures Unrealized', align: 'right', format: 'usd2' },
        { label: 'Futures Realized (net)', align: 'right', format: 'usd2' }, { label: 'Options P&L (net)', align: 'right', format: 'usd2' },
        { label: 'Combined P&L', align: 'right', format: 'usd2' },
      ],
      rows: summary.map((s) => {
        const opt = optPnlForKey(s.cropYear, s.commodity)
        return [
          s.cropYear, s.commodity, Number(s.contracts.toFixed(2)), Math.round(s.bushels), contractUnit(s.commodity),
          s.contracts > 0 ? Number((s.priceWeight / s.contracts).toFixed(4)) : '',
          Number(s.unrealized.toFixed(2)), Number(s.realized.toFixed(2)), Number(opt.toFixed(2)),
          Number((s.unrealized + s.realized + opt).toFixed(2)),
        ]
      }),
    })
    sections.push({
      title: 'Positions',
      columns: [
        { label: 'Crop Year', format: 'text' }, { label: 'Commodity' }, { label: 'Month' }, { label: 'Symbol' },
        { label: 'Side' }, { label: 'Contracts', align: 'right', format: 'dec2' }, { label: 'Qty (bu · lbs)', align: 'right', format: 'bu' }, { label: 'Unit' },
        { label: 'Trade Date' }, { label: 'Trade Price', align: 'right', format: 'price' }, { label: 'Status' },
        { label: 'Close Date' }, { label: 'Close Price', align: 'right', format: 'price' },
        { label: 'Realized P&L', align: 'right', format: 'usd2' }, { label: 'Commission', align: 'right', format: 'usd2' },
        { label: 'Net P&L', align: 'right', format: 'usd2' }, { label: 'Unrealized P&L', align: 'right', format: 'usd2' }, { label: 'Entity' },
      ],
      rows: filtered.map((p) => {
        const u = unrealizedOf(p)
        return [
          p.crop_year, p.commodity, p.contract_month, p.contract_symbol, p.side,
          Number(Number(p.num_contracts).toFixed(2)), Math.round(quantityFor(p.commodity, p.num_contracts)), contractUnit(p.commodity),
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
          { label: 'Crop Year', format: 'text' }, { label: 'Commodity' }, { label: 'Type' }, { label: 'Side' },
          { label: 'Month' }, { label: 'Strike', align: 'right', format: 'price' }, { label: 'Contracts', align: 'right', format: 'dec2' },
          { label: 'Trade Date' }, { label: 'Premium ¢', align: 'right', format: 'dec2' }, { label: 'Premium $', align: 'right', format: 'usd2' },
          { label: 'Status' }, { label: 'Close Date' }, { label: 'Close ¢', align: 'right', format: 'dec2' },
          { label: 'Realized P&L', align: 'right', format: 'usd2' }, { label: 'Unrealized P&L', align: 'right', format: 'usd2' }, { label: 'Entity' },
        ],
        rows: filteredOptions.map((o) => {
          const u = optUnrealizedOf(o)
          return [
            o.crop_year, o.commodity, o.option_type, o.side, o.underlying_contract_month,
            Number(o.strike_price), Number(Number(o.num_contracts).toFixed(2)), o.trade_date, Number(o.premium_cents), Number(o.premium_total ?? 0),
            o.status, o.close_date ?? '', o.close_price_cents != null ? Number(o.close_price_cents) : '',
            o.realized_pnl != null ? Number(o.realized_pnl) : '', u != null ? Number(u.toFixed(2)) : '', entityName(o.entity_id),
          ]
        }),
      })
    }
    // Hedging activity — the auditable trail, one row per event, chronological,
    // with the detail columns (the same ledger the hedging page's History shows).
    if (filteredEvents.length > 0) {
      sections.push({
        title: 'Hedging Activity',
        columns: HEDGE_EVENT_EXPORT_COLUMNS,
        rows: hedgeEventExportRows(filteredEvents, { entityName, positionLabel }),
      })
    }
    // Headline band mirroring the on-screen summary cards (formatted through the
    // shared formatter so negatives parenthesize consistently with the tables).
    const gUnrealized = summary.reduce((s, r) => s + r.unrealized, 0)
    const gRealized = summary.reduce((s, r) => s + r.realized, 0)
    const gOptions = filteredOptions.reduce((s, o) => s + (optUnrealizedOf(o) ?? 0) + optNetRealizedOf(o), 0)
    const gCombined = gUnrealized + gRealized + gOptions
    const summaryBand: ExportPayload['summary'] = [
      { label: 'Futures Unrealized', value: formatNumber(gUnrealized, 'usd2'), tone: signedTone(gUnrealized) },
      { label: 'Futures Realized (net)', value: formatNumber(gRealized, 'usd2'), tone: signedTone(gRealized) },
      { label: 'Options P&L (net)', value: formatNumber(gOptions, 'usd2'), tone: signedTone(gOptions) },
      { label: 'Combined P&L', value: formatNumber(gCombined, 'usd2'), tone: signedTone(gCombined) },
    ]
    return { title: 'Hedging Summary', filters: filtersLabel(), summary: summaryBand, sections }
  }

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, filteredOptions, filteredEvents, summary, cropYear, commodity, entityId, from, to, onPayloadChange])

  if (loading) return <p className="text-slate-500">Loading…</p>

  const grandUnrealized = summary.reduce((s, r) => s + r.unrealized, 0)
  const grandRealized = summary.reduce((s, r) => s + r.realized, 0)
  const grandOptions = filteredOptions.reduce((s, o) => s + (optUnrealizedOf(o) ?? 0) + optNetRealizedOf(o), 0)
  const grandCombined = grandUnrealized + grandRealized + grandOptions

  // Headline cards from the already-computed grand totals (no new math).
  const summaryCards: SummaryCardData[] = [
    { label: 'Futures Unrealized', value: fmtPnl(grandUnrealized), tone: signedTone(grandUnrealized) },
    { label: 'Futures Realized (net)', value: fmtPnl(grandRealized), tone: signedTone(grandRealized) },
    { label: 'Options P&L (net)', value: fmtPnl(grandOptions), tone: signedTone(grandOptions) },
    { label: 'Combined P&L', value: fmtPnl(grandCombined), tone: signedTone(grandCombined) },
  ]

  return (
    <div className="space-y-4 print-area">
      <ReportHeader title="Hedging Summary" filterSummary={filtersLabel()} actions={headerActions} />
      <ReportFilterBar activeCount={activeFilterCount}>
        <FilterField label="Crop year">
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value)} className={selectCls}>
            <option value="All">All crop years</option>
            {cropYearValue !== '' && !cropYears.includes(cropYearValue) && <option value={cropYearValue}>{cropYearValue}</option>}
            {cropYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </FilterField>
        <FilterField label="Commodity">
          <select value={commodity} onChange={(e) => setCommodity(e.target.value as 'All' | Commodity)} className={selectCls}>
            <option value="All">All commodities</option>
            {COMMODITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </FilterField>
        {(!viewer.isViewer || entityOptionsFor(viewer, entities).length > 1) && (
          <FilterField label="Entity">
            <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={selectCls}>
              <option value="All">All entities</option>
              {entityOptionsFor(viewer, entities).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </FilterField>
        )}
        <FilterField label="From date">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </FilterField>
        <FilterField label="To date">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </FilterField>
      </ReportFilterBar>

      {filtered.length === 0 && filteredOptions.length === 0 ? (
        <EmptyState
          message="No positions match these filters."
          hint="Try widening the crop year, commodity, entity, or date filters — or record hedging positions."
          linkHref="/hedging"
          linkLabel="Add hedging positions"
          role={viewer.role}
        />
      ) : (
        <div className="space-y-6">
          <SummaryCards cards={summaryCards} />

          <section className="bg-white rounded-xl shadow p-4 avoid-break">
            <h2 className="font-bold text-lg mb-2">Summary by Crop Year</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className={theadCls}>
                  <tr>{['Crop Year', 'Commodity', 'Contracts', 'Quantity', 'Avg hedge price', 'Futures unrealized', 'Futures realized (net)', 'Options gain/loss', 'Combined gain/loss'].map((h, i) => <th key={h} className={`${i >= 2 ? 'text-right' : 'text-left'} pr-4 py-1 font-medium whitespace-nowrap`}>{h}</th>)}</tr>
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
                        <td className="pr-4 py-1 text-right tabular-nums">{fmtContracts(s.contracts)}</td>
                        <td className="pr-4 py-1 text-right tabular-nums">{fmtQty(s.bushels)} {contractUnit(s.commodity)}</td>
                        <td className="pr-4 py-1 text-right tabular-nums">{fmtCommodityPrice(s.commodity, avg)}</td>
                        <td className={`pr-4 py-1 text-right tabular-nums ${toneText(signedTone(s.unrealized))}`}>{fmtPnl(s.unrealized)}</td>
                        <td className={`pr-4 py-1 text-right tabular-nums ${toneText(signedTone(s.realized))}`}>{fmtPnl(s.realized)}</td>
                        <td className={`pr-4 py-1 text-right tabular-nums ${toneText(signedTone(opt))}`}>{fmtPnl(opt)}</td>
                        <td className={`pr-4 py-1 text-right tabular-nums font-bold ${toneText(signedTone(combined))}`}>{fmtPnl(combined)}</td>
                      </tr>
                    )
                  })}
                  <tr className={grandTotalRowCls}>
                    <td className="pr-4 py-1" colSpan={5}>Grand total</td>
                    <td className={`pr-4 py-1 text-right tabular-nums ${toneText(signedTone(grandUnrealized))}`}>{fmtPnl(grandUnrealized)}</td>
                    <td className={`pr-4 py-1 text-right tabular-nums ${toneText(signedTone(grandRealized))}`}>{fmtPnl(grandRealized)}</td>
                    <td className={`pr-4 py-1 text-right tabular-nums ${toneText(signedTone(grandOptions))}`}>{fmtPnl(grandOptions)}</td>
                    <td className={`pr-4 py-1 text-right tabular-nums ${toneText(signedTone(grandCombined))}`}>{fmtPnl(grandCombined)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="bg-white rounded-xl shadow p-4 avoid-break">
            <h2 className="font-bold text-lg mb-2">Positions</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className={theadCls}>
                  <tr>{['Contract', 'Crop year', 'Commodity', 'Symbol', 'Side', 'Contracts', 'Quantity', 'Trade date', 'Trade price', 'Status', 'Close date', 'Close price', 'Realized', 'Commission', 'Net', 'Unrealized'].map((h, i) => {
                    const right = [5, 6, 8, 11, 12, 13, 14, 15].includes(i)
                    return <th key={h} className={`${right ? 'text-right' : 'text-left'} ${i === 0 ? `${stickyColHeadCls} pl-2` : ''} pr-3 py-1 font-medium whitespace-nowrap`}>{h}</th>
                  })}</tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const u = unrealizedOf(p)
                    const net = netRealizedOf(p)
                    return (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className={`${stickyColCls} pl-2 pr-3 py-1 whitespace-nowrap font-semibold`}>{contractLabel(p.commodity, p.contract_month)}</td>
                        <td className="pr-3 py-1">{p.crop_year}</td>
                        <td className="pr-3 py-1">{p.commodity}</td>
                        <td className="pr-3 py-1 text-xs text-slate-500 tabular-nums">{p.contract_symbol}</td>
                        <td className="pr-3 py-1 capitalize">{p.side}</td>
                        <td className="pr-3 py-1 text-right tabular-nums">{fmtContracts(p.num_contracts)}</td>
                        <td className="pr-3 py-1 text-right tabular-nums whitespace-nowrap">{fmtQty(quantityFor(p.commodity, p.num_contracts))} {contractUnit(p.commodity)}</td>
                        <td className="pr-3 py-1 whitespace-nowrap">{fmtDate(p.trade_date)}</td>
                        <td className="pr-3 py-1 text-right tabular-nums">{fmtPrice(p.trade_price)}</td>
                        <td className="pr-3 py-1 capitalize">{p.status}</td>
                        <td className="pr-3 py-1 whitespace-nowrap">{fmtDate(p.close_date)}</td>
                        <td className="pr-3 py-1 text-right tabular-nums">{p.close_price != null ? fmtPrice(p.close_price) : ''}</td>
                        <td className={`pr-3 py-1 text-right tabular-nums ${toneText(signedTone(p.realized_pnl))}`}>{p.realized_pnl != null ? fmtPnl(p.realized_pnl) : ''}</td>
                        <td className="pr-3 py-1 text-right tabular-nums">{p.commission ? fmtPnl(p.commission) : ''}</td>
                        <td className={`pr-3 py-1 text-right tabular-nums ${toneText(signedTone(net))}`}>{p.status === 'closed' ? fmtPnl(net) : ''}</td>
                        <td className={`pr-3 py-1 text-right tabular-nums ${u == null ? '' : toneText(signedTone(u))}`}>{u != null ? fmtPnl(u) : ''}</td>
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
                  <thead className={theadCls}>
                    <tr>{['Contract', 'Crop year', 'Commodity', 'Type', 'Side', 'Strike', 'Contracts', 'Trade date', 'Premium ¢', 'Premium $', 'Status', 'Close date', 'Close ¢', 'Realized', 'Unrealized'].map((h, i) => {
                      const right = [5, 6, 8, 9, 12, 13, 14].includes(i)
                      return <th key={h} className={`${right ? 'text-right' : 'text-left'} ${i === 0 ? `${stickyColHeadCls} pl-2` : ''} pr-3 py-1 font-medium whitespace-nowrap`}>{h}</th>
                    })}</tr>
                  </thead>
                  <tbody>
                    {filteredOptions.map((o) => {
                      const u = optUnrealizedOf(o)
                      return (
                        <tr key={o.id} className="border-t border-slate-100">
                          <td className={`${stickyColCls} pl-2 pr-3 py-1 whitespace-nowrap font-semibold`}>{contractLabel(o.commodity, o.underlying_contract_month)}</td>
                          <td className="pr-3 py-1">{o.crop_year}</td>
                          <td className="pr-3 py-1">{o.commodity}</td>
                          <td className="pr-3 py-1 capitalize">{o.option_type}</td>
                          <td className="pr-3 py-1 capitalize">{o.side}</td>
                          <td className="pr-3 py-1 text-right tabular-nums">{fmtPrice(o.strike_price)}</td>
                          <td className="pr-3 py-1 text-right tabular-nums">{fmtContracts(o.num_contracts)}</td>
                          <td className="pr-3 py-1 whitespace-nowrap">{fmtDate(o.trade_date)}</td>
                          <td className="pr-3 py-1 text-right tabular-nums">{fmtCents(o.premium_cents)}</td>
                          <td className="pr-3 py-1 text-right tabular-nums">{fmtPnl(o.premium_total)}</td>
                          <td className="pr-3 py-1 whitespace-nowrap capitalize">{o.status}</td>
                          <td className="pr-3 py-1 whitespace-nowrap">{fmtDate(o.close_date)}</td>
                          <td className="pr-3 py-1 text-right tabular-nums">{o.close_price_cents != null ? fmtCents(o.close_price_cents) : ''}</td>
                          <td className={`pr-3 py-1 text-right tabular-nums ${toneText(signedTone(o.realized_pnl))}`}>{o.realized_pnl != null ? fmtPnl(o.realized_pnl) : ''}</td>
                          <td className={`pr-3 py-1 text-right tabular-nums ${u == null ? '' : toneText(signedTone(u))}`}>{u != null ? fmtPnl(u) : ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Hedging activity — the same auditable trail the hedging page's
              History view shows, in the report's format; exports as one row
              per event (see buildExportPayload). Owners only. */}
          {!viewer.isViewer && events != null && (
            <section className="bg-white rounded-xl shadow p-4 avoid-break">
              <h2 className="font-bold text-lg mb-1">Hedging Activity</h2>
              <p className="text-xs text-slate-500 mb-2 no-print">Every open, close, roll, edit, and import in the period, newest first. Tap a line for the detail; the export lists one row per event.</p>
              <HedgingHistory lines={activity} report emptyText="No hedging activity for these filters." />
            </section>
          )}
        </div>
      )}
    </div>
  )
}
