import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildHedgeTimeline, filterTimeline, eventsForPosition, hedgeEventExportRows, HEDGE_EVENT_EXPORT_COLUMNS,
  fmtMd, sourceLabel, snapshotDiff, eventHeadline,
} from '@/lib/hedge-events'
import type { HedgePositionEvent } from '@/lib/types'

function ev(over: Partial<HedgePositionEvent> & Pick<HedgePositionEvent, 'id' | 'position_id' | 'event_type' | 'occurred_at'>): HedgePositionEvent {
  return {
    related_position_id: null, roll_group_id: null, recorded_at: '2026-09-04T14:00:00Z', source: 'manual',
    statement_date: null, statement_ref: null, actor_user_id: null, actor_email: null, entity_id: null,
    commodity: 'Corn', contract_month: 'DEC 26', contract_symbol: 'ZCZ26', side: 'short', crop_year: 2026,
    quantity: 14, price: 4.9525, close_price: null, fees: null, realized_pnl: null,
    before_snapshot: null, after_snapshot: null, note: null, ...over,
  }
}

// The 9/03 roll as the ledger records it (two events, one roll group).
const ROLL_CLOSE = ev({
  id: 'e1', position_id: 'dec', event_type: 'roll_close', occurred_at: '2026-09-03', roll_group_id: 'g1',
  source: 'statement_import', statement_date: '2026-09-03', statement_ref: 'StoneX',
  close_price: 5.435, realized_pnl: -33775, recorded_at: '2026-09-04T14:00:00Z',
  after_snapshot: { execution_code: 'SE' },
})
const ROLL_OPEN = ev({
  id: 'e2', position_id: 'mar', event_type: 'roll_open', occurred_at: '2026-09-03', roll_group_id: 'g1', related_position_id: 'dec',
  source: 'statement_import', statement_date: '2026-09-03', statement_ref: 'StoneX',
  contract_month: 'MAR 27', contract_symbol: 'ZCH27', price: 5.585, recorded_at: '2026-09-04T14:00:01Z',
  after_snapshot: { execution_code: 'SE' },
})
const OPENED = ev({ id: 'e0', position_id: 'dec', event_type: 'opened', occurred_at: '2026-04-15', source: 'backfill', recorded_at: '2026-09-01T00:00:00Z' })

describe('hedging history timeline', () => {
  it('formats dates the way the statements print them', () => {
    expect(fmtMd('2026-09-03')).toBe('9/03')
    expect(fmtMd('2026-11-20')).toBe('11/20')
  })

  it('a roll close + open in one group collapse into ONE plain line', () => {
    const [line] = buildHedgeTimeline([ROLL_CLOSE, ROLL_OPEN])
    expect(line.kind).toBe('roll')
    expect(line.date).toBe('2026-09-03')
    expect(line.headline).toBe('Rolled 14 DEC 26 → MAR 27 corn · ($33,775.00) realized')
    expect(line.sourceLabel).toBe('from StoneX statement 9/03')
    expect(line.realized).toBe(-33775)
    expect(line.positionIds.sort()).toEqual(['dec', 'mar'])
    expect(line.detail[0]).toBe('Closed DEC 26 @ $5.435 → ($33,775.00) realized; opened MAR 27 @ $5.585 (spread order)')
    expect(line.detail[1]).toBe('Crop year 2026 (inherited by the new leg)')
  })

  it('orders newest first and keeps single events as their own lines', () => {
    const lines = buildHedgeTimeline([OPENED, ROLL_CLOSE, ROLL_OPEN])
    expect(lines.map((l) => l.kind)).toEqual(['roll', 'opened'])
    expect(lines[1].headline).toBe('Opened short 14 DEC 26 corn @ $4.9525')
    expect(lines[1].sourceLabel).toBe('from existing records')
  })

  it('a lone roll_open (its close filtered away) still names the month it rolled from', () => {
    const [line] = buildHedgeTimeline([ROLL_OPEN])
    expect(line.headline).toBe('Opened short 14 MAR 27 corn @ $5.585 (rolled)')
  })

  it('filters by crop year, commodity, and entity', () => {
    const soy = ev({ id: 'e9', position_id: 'x', event_type: 'opened', occurred_at: '2026-05-01', commodity: 'Soybeans', contract_month: 'NOV 26', crop_year: 2025, entity_id: 'ent-a' })
    const lines = buildHedgeTimeline([OPENED, ROLL_CLOSE, ROLL_OPEN, soy])
    expect(filterTimeline(lines, { cropYear: 2026 })).toHaveLength(2)
    expect(filterTimeline(lines, { commodity: 'Soybeans' })).toHaveLength(1)
    expect(filterTimeline(lines, { entityId: 'ent-a' })).toHaveLength(1)
    expect(filterTimeline(lines, { cropYear: 'All', commodity: 'All', entityId: 'All' })).toHaveLength(3)
  })

  it('a position’s own chain is oldest-first', () => {
    expect(eventsForPosition([ROLL_CLOSE, OPENED, ROLL_OPEN], 'dec').map((e) => e.event_type)).toEqual(['opened', 'roll_close'])
  })

  it('edit lines spell out what changed', () => {
    const edited = ev({
      id: 'e5', position_id: 'dec', event_type: 'edited', occurred_at: '2026-09-05',
      before_snapshot: { num_contracts: 14, trade_price: 4.9525, updated_at: 'x' },
      after_snapshot: { num_contracts: 10, trade_price: 4.9525, updated_at: 'y' },
      note: 'contracts reduced by a partial close',
    })
    expect(snapshotDiff(edited.before_snapshot, edited.after_snapshot)).toEqual([{ field: 'num_contracts', label: 'contracts', before: 14, after: 10 }])
    expect(eventHeadline(edited)).toBe('Edited short 14 DEC 26 corn: contracts 14 → 10 (contracts reduced by a partial close)')
  })

  it('the export is one row per event, chronological, with the detail columns', () => {
    const rows = hedgeEventExportRows([ROLL_OPEN, ROLL_CLOSE, OPENED], { entityName: () => 'Turnrow Farm' })
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r[0])).toEqual(['2026-04-15', '2026-09-03', '2026-09-03'])
    expect(rows[1][1]).toBe('Closed (roll)')
    expect(rows[1][8]).toBe(5.435)
    expect(rows[1][9]).toBe(-33775)
    expect(rows[1][13]).toBe('from StoneX statement 9/03')
    expect(rows[1][14]).toBe('StoneX 2026-09-03')
    expect(rows[2][17]).toBe('dec') // linked to the leg it rolled from
    expect(rows[0].length).toBe(HEDGE_EVENT_EXPORT_COLUMNS.length)
  })

  it('source labels read plainly', () => {
    expect(sourceLabel({ source: 'manual', statement_date: null, statement_ref: null })).toBe('entered by hand')
    expect(sourceLabel({ source: 'roll_action', statement_date: null, statement_ref: null })).toBe('roll entered on the hedging page')
    expect(sourceLabel({ source: 'statement_import', statement_date: null, statement_ref: null })).toBe('from a brokerage statement')
  })
})

// ---------------------------------------------------------------------------
// The ledger is written by the DATABASE: a trigger on futures_positions
// appends an event for every insert, update, and delete, whatever the caller
// (forms, statement import, the roll RPC, the partner API, a hand edit in
// the SQL editor). This test pins that wiring in the migration text so a
// mutation path without an event cannot be introduced by editing the
// trigger, and that the ledger stays append-only and gets backfilled.
// ---------------------------------------------------------------------------
describe('083 ledger wiring — every mutation path appends', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase', '083_hedge_rolls_and_events.sql'), 'utf8')

  it('the trigger fires AFTER INSERT OR UPDATE OR DELETE on futures_positions, for each row', () => {
    expect(sql).toMatch(/create trigger futures_positions_hedge_event\s+after insert or update or delete on public\.futures_positions\s+for each row execute function public\.hedge_position_event_trigger\(\)/)
  })

  it('every mutation shape resolves to an event type (and every type is reachable)', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.hedge_position_event_trigger'), sql.indexOf('drop trigger if exists futures_positions_hedge_event'))
    expect(fn).toMatch(/if tg_op = 'DELETE' then/)
    expect(fn).toMatch(/if tg_op = 'INSERT' then/)
    expect(fn).toMatch(/-- UPDATE/)
    for (const t of ['opened', 'closed', 'partial_close', 'roll_close', 'roll_open', 'edited', 'deleted', 'crop_year_changed', 'imported']) {
      expect(fn, `event type ${t} is never emitted`).toMatch(new RegExp(`'${t}'`))
    }
    // The only early return without an insert is the no-op guard (nothing changed).
    const returnsWithoutInsert = fn.split(/insert into public\.hedge_position_events/).slice(0, -1).length
    expect(returnsWithoutInsert).toBe(3) // one insert each for DELETE, INSERT, UPDATE
    expect(fn).toMatch(/if o = n then\s+return NEW; -- nothing changed: no event/)
  })

  it('the ledger is append-only: select + insert policies only, no update/delete policy', () => {
    const block = sql.slice(sql.indexOf("foreach t in array array['hedge_position_events']"), sql.indexOf('-- 3. The ledger trigger'))
    expect(block).toMatch(/"authed read" on public\.%I for select/)
    expect(block).toMatch(/"authed append" on public\.%I for insert/)
    expect(block).not.toMatch(/create policy \\"authed all\\"/)
    expect(block).not.toMatch(/for update to authenticated using \(true\)/)
    expect(block).not.toMatch(/for delete to authenticated using \(true\)/)
    // viewers/gin/agronomists blocked, org isolation present
    expect(block).toMatch(/_viewer_block_sel/)
    expect(block).toMatch(/_org_isolation/)
    expect(block).toMatch(/_owner_only/)
    expect(block).toMatch(/_agronomist_block_sel/)
  })

  it('backfills opened + closed events from existing positions, idempotently', () => {
    const backfill = sql.slice(sql.indexOf('-- 5. Backfill the ledger'))
    expect(backfill).toMatch(/'opened'/)
    expect(backfill).toMatch(/'closed'/)
    expect(backfill).toMatch(/'backfill'/)
    expect((backfill.match(/where not exists \(/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect((backfill.match(/not exists \(/g) ?? []).length).toBe(2)
  })

  it('the roll RPC sets the event source for its transaction and is authenticated-only', () => {
    expect(sql).toMatch(/set_config\('turnrow\.hedge_event_source', src, true\)/)
    expect(sql).toMatch(/if auth\.uid\(\) is null then\s+raise exception 'sign in required'/)
    expect(sql).toMatch(/revoke all on function public\.hedge_execute_roll\(jsonb\) from public, anon/)
    expect(sql).toMatch(/grant execute on function public\.hedge_execute_roll\(jsonb\) to authenticated/)
  })
})
