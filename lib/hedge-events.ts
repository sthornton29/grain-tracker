// The hedging history trail (083): turning ledger rows into the one-line
// timeline the hedging page, each position's detail, and the Hedging
// Summary report all show — and the one-row-per-event export sheet. Pure.
//
//   "9/03 · Rolled 14 DEC 26 → MAR 27 corn · -$33,775.00 realized · from StoneX statement 9/03"
//
// The ledger itself is written by the database (a trigger on every futures
// position change — supabase/083), so nothing here appends; this only reads.

import { fmtCommodityPrice, fmtPnl } from '@/lib/hedging'
import type { HedgePositionEvent, HedgeEventType } from '@/lib/types'

export type TimelineLine = {
  /** Stable key (the first event id). */
  id: string
  /** Trade date the line is about (YYYY-MM-DD). */
  date: string
  /** ISO timestamp of the latest event in the line (tie-break, recency). */
  recordedAt: string
  kind: HedgeEventType | 'roll'
  headline: string
  sourceLabel: string
  /** Extra detail lines shown when the line is expanded. */
  detail: string[]
  events: HedgePositionEvent[]
  positionIds: string[]
  cropYear: number | null
  commodity: string | null
  entityId: string | null
  realized: number | null
}

const COMMODITY_SHORT: Record<string, string> = {
  Corn: 'corn',
  Soybeans: 'soybeans',
  'Chicago Wheat': 'wheat',
  Cotton: 'cotton',
}
export function shortCommodity(c: string | null | undefined): string {
  if (!c) return ''
  return COMMODITY_SHORT[c] ?? c.toLowerCase()
}

/** "9/03" — month unpadded, day two digits (how the statements print days). */
export function fmtMd(date: string | null | undefined): string {
  if (!date) return ''
  const m = String(date).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!m) return String(date)
  return `${Number(m[2])}/${m[3].padStart(2, '0')}`
}

export function fmtRecorded(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function sourceLabel(ev: Pick<HedgePositionEvent, 'source' | 'statement_date' | 'statement_ref'>): string {
  switch (ev.source) {
    case 'statement_import': {
      const who = ev.statement_ref ? `${ev.statement_ref} statement` : 'brokerage statement'
      return ev.statement_date ? `from ${who} ${fmtMd(ev.statement_date)}` : `from a ${who}`
    }
    case 'roll_action':
      return 'roll entered on the hedging page'
    case 'backfill':
      return 'from existing records'
    default:
      return 'entered by hand'
  }
}

const EVENT_LABEL: Record<HedgeEventType | 'roll', string> = {
  opened: 'Opened',
  closed: 'Closed',
  partial_close: 'Partial close',
  roll_close: 'Closed (roll)',
  roll_open: 'Opened (roll)',
  roll: 'Rolled',
  edited: 'Edited',
  deleted: 'Deleted',
  crop_year_changed: 'Crop year changed',
  imported: 'Imported closed trade',
}
export function eventLabel(kind: HedgeEventType | 'roll'): string {
  return EVENT_LABEL[kind] ?? kind
}

// Friendly names for the fields an edit diff can touch.
const FIELD_LABEL: Record<string, string> = {
  entity_id: 'entity',
  commodity: 'commodity',
  contract_month: 'month',
  contract_symbol: 'symbol',
  crop_year: 'crop year',
  side: 'side',
  num_contracts: 'contracts',
  trade_price: 'trade price',
  trade_date: 'trade date',
  status: 'status',
  close_price: 'close price',
  close_date: 'close date',
  realized_pnl: 'realized P&L',
  commission: 'commission',
  notes: 'notes',
  source: 'source',
  execution_code: 'trade code',
  roll_group_id: 'roll link',
  rolled_from_position_id: 'rolled from',
  partial_close_of: 'partial close of',
  import_statement_date: 'statement date',
  import_statement_ref: 'statement',
}
const DIFF_SKIP = new Set(['id', 'org_id', 'created_at', 'updated_at'])

export type SnapshotDiff = { field: string; label: string; before: unknown; after: unknown }

/** The fields that changed between two snapshots (ids/timestamps ignored). */
export function snapshotDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): SnapshotDiff[] {
  if (!before || !after) return []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: SnapshotDiff[] = []
  for (const k of keys) {
    if (DIFF_SKIP.has(k)) continue
    const b = before[k] ?? null
    const a = after[k] ?? null
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    out.push({ field: k, label: FIELD_LABEL[k] ?? k.replace(/_/g, ' '), before: b, after: a })
  }
  return out
}

function fmtVal(commodity: string | null, field: string, v: unknown): string {
  if (v == null || v === '') return '—'
  if (field === 'trade_price' || field === 'close_price') return fmtCommodityPrice(commodity, Number(v))
  if (field === 'realized_pnl' || field === 'commission') return fmtPnl(Number(v))
  if (field === 'roll_group_id' || field === 'rolled_from_position_id' || field === 'partial_close_of' || field === 'entity_id') return 'set'
  return String(v)
}

export function diffSummary(ev: HedgePositionEvent): string {
  return snapshotDiff(ev.before_snapshot, ev.after_snapshot)
    .map((d) => `${d.label} ${fmtVal(ev.commodity, d.field, d.before)} → ${fmtVal(ev.commodity, d.field, d.after)}`)
    .join(', ')
}

function legText(ev: HedgePositionEvent): string {
  const side = ev.side ? `${ev.side} ` : ''
  return `${side}${ev.quantity ?? ''} ${ev.contract_month ?? ''} ${shortCommodity(ev.commodity)}`.replace(/\s+/g, ' ').trim()
}

function realizedText(ev: Pick<HedgePositionEvent, 'realized_pnl'>): string {
  return ev.realized_pnl == null ? '' : ` · ${fmtPnl(Number(ev.realized_pnl))} realized`
}

/** One event → its headline (without the source suffix). */
export function eventHeadline(ev: HedgePositionEvent, opts?: { fromMonth?: string | null }): string {
  const price = (p: number | null) => fmtCommodityPrice(ev.commodity, p)
  switch (ev.event_type) {
    case 'opened':
      return `Opened ${legText(ev)} @ ${price(ev.price)}`
    case 'roll_open':
      return `Opened ${legText(ev)} @ ${price(ev.price)}${opts?.fromMonth ? ` (rolled from ${opts.fromMonth})` : ' (rolled)'}`
    case 'closed':
      return `Closed ${legText(ev)} @ ${price(ev.close_price)}${realizedText(ev)}`
    case 'roll_close':
      return `Closed ${legText(ev)} @ ${price(ev.close_price)} (rolled)${realizedText(ev)}`
    case 'partial_close':
      return `Closed ${ev.quantity ?? ''} of the ${ev.contract_month ?? ''} ${shortCommodity(ev.commodity)} ${ev.side ?? ''} @ ${price(ev.close_price)}${realizedText(ev)}`.replace(/\s+/g, ' ')
    case 'imported':
      return `Imported closed trade ${legText(ev)} ${price(ev.price)} → ${price(ev.close_price)}${realizedText(ev)}`
    case 'crop_year_changed': {
      const b = ev.before_snapshot?.crop_year
      const a = ev.after_snapshot?.crop_year ?? ev.crop_year
      return `Crop year changed ${b ?? '—'} → ${a ?? '—'} on ${legText(ev)}`
    }
    case 'edited': {
      const d = diffSummary(ev)
      return `Edited ${legText(ev)}${d ? `: ${d}` : ''}${ev.note ? ` (${ev.note})` : ''}`
    }
    case 'deleted':
      return `Deleted ${legText(ev)} @ ${price(ev.price)}`
    default:
      return `${eventLabel(ev.event_type)} ${legText(ev)}`
  }
}

/** Expanded detail for one event: prices, fees, who/when, statement, edits. */
export function eventDetail(ev: HedgePositionEvent, entityName?: (id: string | null) => string): string[] {
  const price = (p: number | null) => fmtCommodityPrice(ev.commodity, p)
  const lines: string[] = []
  if (ev.price != null) lines.push(`Entry price ${price(ev.price)}`)
  if (ev.close_price != null) lines.push(`Close price ${price(ev.close_price)}`)
  if (ev.realized_pnl != null) lines.push(`Realized P&L ${fmtPnl(Number(ev.realized_pnl))} (before commission)`)
  if (ev.fees != null && Number(ev.fees) !== 0) lines.push(`Commission & fees ${fmtPnl(Number(ev.fees))}`)
  if (ev.crop_year != null) lines.push(`Crop year ${ev.crop_year}`)
  const ent = entityName?.(ev.entity_id)
  if (ent) lines.push(`Entity ${ent}`)
  if (ev.statement_date || ev.statement_ref) lines.push(`Statement: ${ev.statement_ref ? `${ev.statement_ref} ` : ''}${ev.statement_date ?? ''}`.trim())
  if (ev.event_type === 'edited' || ev.event_type === 'crop_year_changed') {
    const d = diffSummary(ev)
    if (d) lines.push(`Changed: ${d}`)
  }
  if (ev.note) lines.push(ev.note)
  lines.push(`Recorded ${fmtRecorded(ev.recorded_at)}${ev.actor_email ? ` by ${ev.actor_email}` : ''} · ${sourceLabel(ev)}`)
  return lines
}

function byDateDesc(a: TimelineLine, b: TimelineLine): number {
  return b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt)
}

/** Ledger rows → timeline lines, newest first. Roll close + open events
 *  sharing a roll group collapse into ONE "Rolled …" line. */
export function buildHedgeTimeline(
  events: readonly HedgePositionEvent[],
  opts?: { entityName?: (id: string | null) => string },
): TimelineLine[] {
  const lines: TimelineLine[] = []
  const rollGroups = new Map<string, HedgePositionEvent[]>()
  for (const ev of events) {
    if ((ev.event_type === 'roll_close' || ev.event_type === 'roll_open') && ev.roll_group_id) {
      const arr = rollGroups.get(ev.roll_group_id) ?? []
      arr.push(ev)
      rollGroups.set(ev.roll_group_id, arr)
    }
  }
  const consumed = new Set<string>()

  for (const [, evs] of rollGroups) {
    const closes = evs.filter((e) => e.event_type === 'roll_close')
    const opens = evs.filter((e) => e.event_type === 'roll_open')
    if (closes.length === 0 || opens.length === 0) continue // rendered singly below
    for (const e of evs) consumed.add(e.id)
    const open = opens[0]
    const contracts = closes.reduce((s, e) => s + (e.quantity ?? 0), 0)
    const realizedSum = closes.reduce((s, e) => s + Number(e.realized_pnl ?? 0), 0)
    const anyRealized = closes.some((e) => e.realized_pnl != null)
    const fromMonth = closes[0].contract_month ?? ''
    const spread = closes.some((e) => isSpreadNote(e)) || opens.some((e) => isSpreadNote(e))
    const closePx = fmtCommodityPrice(open.commodity, closes[0].close_price)
    const openPx = fmtCommodityPrice(open.commodity, open.price)
    const headline = `Rolled ${contracts} ${fromMonth} → ${open.contract_month ?? ''} ${shortCommodity(open.commodity)}${anyRealized ? ` · ${fmtPnl(realizedSum)} realized` : ''}`
    const detail = [
      `Closed ${fromMonth} @ ${closePx}${anyRealized ? ` → ${fmtPnl(realizedSum)} realized` : ''}; opened ${open.contract_month ?? ''} @ ${openPx}${spread ? ' (spread order)' : ''}`,
      ...(open.crop_year != null ? [`Crop year ${open.crop_year} (inherited by the new leg)`] : []),
      ...closes.flatMap((e) => eventDetail(e, opts?.entityName).map((l) => `${fromMonth} leg: ${l}`)),
      ...eventDetail(open, opts?.entityName).map((l) => `${open.contract_month ?? ''} leg: ${l}`),
    ]
    lines.push({
      id: closes[0].id,
      date: open.occurred_at,
      recordedAt: evs.map((e) => e.recorded_at).sort().at(-1) ?? open.recorded_at,
      kind: 'roll',
      headline,
      sourceLabel: sourceLabel(open),
      detail,
      events: [...closes, ...opens],
      positionIds: Array.from(new Set(evs.map((e) => e.position_id))),
      cropYear: open.crop_year ?? closes[0].crop_year ?? null,
      commodity: open.commodity ?? null,
      entityId: open.entity_id ?? closes[0].entity_id ?? null,
      realized: anyRealized ? Math.round(realizedSum * 100) / 100 : null,
    })
  }

  for (const ev of events) {
    if (consumed.has(ev.id)) continue
    // A lone roll_open: name the month it rolled from when a sibling close
    // event in the same group is around (even if it was filtered out).
    const sibling = ev.roll_group_id ? (rollGroups.get(ev.roll_group_id) ?? []).find((e) => e.event_type === 'roll_close') : undefined
    lines.push({
      id: ev.id,
      date: ev.occurred_at,
      recordedAt: ev.recorded_at,
      kind: ev.event_type,
      headline: eventHeadline(ev, { fromMonth: sibling?.contract_month ?? null }),
      sourceLabel: sourceLabel(ev),
      detail: eventDetail(ev, opts?.entityName),
      events: [ev],
      positionIds: [ev.position_id],
      cropYear: ev.crop_year ?? null,
      commodity: ev.commodity ?? null,
      entityId: ev.entity_id ?? null,
      realized: ev.realized_pnl != null ? Number(ev.realized_pnl) : null,
    })
  }
  return lines.sort(byDateDesc)
}

function isSpreadNote(ev: HedgePositionEvent): boolean {
  const code = ev.after_snapshot?.execution_code
  const c = typeof code === 'string' ? code.trim().toUpperCase() : ''
  return c === 'S' || c === 'SE'
}

export type TimelineFilters = {
  cropYear?: number | 'All' | string
  commodity?: string
  entityId?: string
}

export function filterTimeline(lines: readonly TimelineLine[], f: TimelineFilters): TimelineLine[] {
  return lines.filter((l) => {
    if (f.cropYear != null && f.cropYear !== 'All' && f.cropYear !== '' && l.cropYear !== Number(f.cropYear)) return false
    if (f.commodity && f.commodity !== 'All' && l.commodity !== f.commodity) return false
    if (f.entityId && f.entityId !== 'All' && (l.entityId ?? '') !== f.entityId) return false
    return true
  })
}

/** Events for one position, oldest first — its own chain. */
export function eventsForPosition(events: readonly HedgePositionEvent[], positionId: string): HedgePositionEvent[] {
  return events
    .filter((e) => e.position_id === positionId)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.recorded_at.localeCompare(b.recorded_at))
}

// ---------- export (one row per event, chronological) ----------

export const HEDGE_EVENT_EXPORT_COLUMNS = [
  { label: 'Date' }, { label: 'Event' }, { label: 'Commodity' }, { label: 'Month' }, { label: 'Symbol' }, { label: 'Side' },
  { label: 'Contracts', align: 'right' as const, format: 'int' as const },
  { label: 'Entry Price', align: 'right' as const, format: 'price' as const },
  { label: 'Close Price', align: 'right' as const, format: 'price' as const },
  { label: 'Realized P&L', align: 'right' as const, format: 'usd2' as const },
  { label: 'Fees', align: 'right' as const, format: 'usd2' as const },
  { label: 'Crop Year', format: 'text' as const }, { label: 'Entity' },
  { label: 'Source' }, { label: 'Statement' }, { label: 'Recorded' }, { label: 'By' }, { label: 'Linked To' }, { label: 'Changes / Note' },
]

export type HedgeEventExportRow = Array<string | number>

export function hedgeEventExportRows(
  events: readonly HedgePositionEvent[],
  opts?: { entityName?: (id: string | null) => string; positionLabel?: (id: string | null) => string },
): HedgeEventExportRow[] {
  const sorted = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.recorded_at.localeCompare(b.recorded_at))
  return sorted.map((ev) => [
    ev.occurred_at,
    eventLabel(ev.event_type),
    ev.commodity ?? '',
    ev.contract_month ?? '',
    ev.contract_symbol ?? '',
    ev.side ?? '',
    ev.quantity ?? '',
    ev.price != null ? Number(ev.price) : '',
    ev.close_price != null ? Number(ev.close_price) : '',
    ev.realized_pnl != null ? Number(ev.realized_pnl) : '',
    ev.fees != null ? Number(ev.fees) : '',
    ev.crop_year ?? '',
    opts?.entityName?.(ev.entity_id) ?? '',
    sourceLabel(ev),
    ev.statement_date ? `${ev.statement_ref ? `${ev.statement_ref} ` : ''}${ev.statement_date}` : '',
    ev.recorded_at,
    ev.actor_email ?? '',
    ev.related_position_id ? (opts?.positionLabel?.(ev.related_position_id) ?? ev.related_position_id) : '',
    [ev.event_type === 'edited' || ev.event_type === 'crop_year_changed' ? diffSummary(ev) : '', ev.note ?? ''].filter(Boolean).join(' · '),
  ])
}
