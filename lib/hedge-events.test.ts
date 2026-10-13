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

// ---------------------------------------------------------------------------
// 0095: a roll with SEVERAL new-month fills (the 10/12/2026 statement rolled
// 23 DEC 26 cotton shorts into MAR 27 as 3 @ 83.63, 12 @ 83.64, 3 @ 83.65,
// 3 @ 83.67, 2 @ 83.68) is ONE line; notes the ledger carries show up.
// ---------------------------------------------------------------------------
describe('multi-fill roll (0095) collapses into one line', () => {
  const imp = { source: 'statement_import' as const, statement_date: '2026-10-12', statement_ref: 'StoneX', commodity: 'Cotton', roll_group_id: 'gc' }
  const dec10 = ev({ ...imp, id: 'c1', position_id: 'dec10', event_type: 'roll_close', occurred_at: '2026-10-12', contract_month: 'DEC 26', contract_symbol: 'CTZ26', quantity: 10, price: 72.65, close_price: 80.45739, realized_pnl: -39036.96, recorded_at: '2026-10-13T15:00:00Z', after_snapshot: { execution_code: 'SE' } })
  const dec13 = ev({ ...imp, id: 'c2', position_id: 'dec13', event_type: 'roll_close', occurred_at: '2026-10-12', contract_month: 'DEC 26', contract_symbol: 'CTZ26', quantity: 13, price: 84.4, close_price: 80.45739, realized_pnl: 25626.96, recorded_at: '2026-10-13T15:00:01Z', after_snapshot: { execution_code: 'SE' } })
  const fills = [[3, 83.63], [12, 83.64], [3, 83.65], [3, 83.67], [2, 83.68]].map(([q, p], i) =>
    ev({ ...imp, id: `o${i}`, position_id: `mar${i}`, event_type: 'roll_open', occurred_at: '2026-10-12', related_position_id: 'dec10', contract_month: 'MAR 27', contract_symbol: 'CTH27', quantity: q, price: p, recorded_at: `2026-10-13T15:00:0${2 + i}Z`, after_snapshot: { execution_code: 'SE' }, note: 'Save anyway, I’ve checked' }),
  )

  it('one roll_close pair + five roll_opens in one group = one "Rolled" line with the fills and the spread', () => {
    const lines = buildHedgeTimeline([dec10, dec13, ...fills])
    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line.kind).toBe('roll')
    // Weighted close 80.45739, weighted open 83.647391 → spread +3.190001 ¢/lb ($0.0319).
    expect(line.headline).toBe('Rolled 23 DEC 26 → MAR 27 cotton in 5 fills, spread +$0.0319 · ($13,410.00) realized')
    expect(line.realized).toBeCloseTo(-13410, 2)
    expect(line.positionIds.sort()).toEqual(['dec10', 'dec13', 'mar0', 'mar1', 'mar2', 'mar3', 'mar4'])
    expect(line.events).toHaveLength(7)
    expect(line.detail[0]).toBe('Closed DEC 26 @ $0.8046 → ($13,410.00) realized; opened MAR 27 in 5 fills @ $0.8363–$0.8368 (avg $0.8365), spread +$0.0319 (spread order)')
    expect(line.detail[1]).toBe('Crop year 2026 (inherited by the new leg)')
    // The override note is shown once, not once per leg.
    expect(line.detail.filter((d) => d.includes('Save anyway'))).toEqual(['Note: Save anyway, I’ve checked'])
    expect(line.detail.some((d) => d.startsWith('MAR 27 fill 12 @ $0.8364 leg:'))).toBe(true)
  })

  it('the single-fill roll line is unchanged by the multi-fill support', () => {
    const [line] = buildHedgeTimeline([ROLL_CLOSE, ROLL_OPEN])
    expect(line.headline).toBe('Rolled 14 DEC 26 → MAR 27 corn · ($33,775.00) realized')
    expect(line.detail[0]).toBe('Closed DEC 26 @ $5.435 → ($33,775.00) realized; opened MAR 27 @ $5.585 (spread order)')
  })

  it('an undo note rides on the deleted line and in the detail', () => {
    const del = ev({ id: 'd1', position_id: 'mar1', event_type: 'deleted', occurred_at: '2026-10-14', source: 'manual', statement_date: '2026-10-12', statement_ref: 'StoneX', commodity: 'Cotton', contract_month: 'MAR 27', quantity: 12, price: 83.64, note: 'undid import of StoneX 10/12/2026', recorded_at: '2026-10-14T09:00:00Z' })
    const [line] = buildHedgeTimeline([del])
    expect(line.headline).toBe('Deleted short 12 MAR 27 cotton @ $0.8364 (undid import of StoneX 10/12/2026)')
    expect(line.detail).toContain('Note: undid import of StoneX 10/12/2026')
    expect(line.sourceLabel).toBe('entered by hand')
  })
})

// 0095 replaces the trigger and the roll RPC and adds the undo. The same
// wiring guarantees hold in the new text: three inserts, every event type,
// the note setting read, the undo stamping source 'manual', the roll taking
// several open legs.
describe('0095 ledger wiring — note setting, multi-open rolls, undo', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '0095_hedge_import_guards.sql'), 'utf8')
  const fn = sql.slice(sql.indexOf('create or replace function public.hedge_position_event_trigger'), sql.indexOf('-- 2. hedge_execute_roll'))

  it('the trigger still inserts exactly once per DELETE / INSERT / UPDATE and emits every event type', () => {
    expect(fn).toMatch(/if tg_op = 'DELETE' then/)
    expect(fn).toMatch(/if tg_op = 'INSERT' then/)
    expect(fn).toMatch(/-- UPDATE/)
    for (const t of ['opened', 'closed', 'partial_close', 'roll_close', 'roll_open', 'edited', 'deleted', 'crop_year_changed', 'imported']) {
      expect(fn, `event type ${t} is never emitted`).toMatch(new RegExp(`'${t}'`))
    }
    expect(fn.split(/insert into public\.hedge_position_events/).slice(0, -1).length).toBe(3)
    expect(fn).toMatch(/if o = n then\s+return NEW; -- nothing changed: no event/)
  })

  it('the trigger reads the note setting and writes it on every event', () => {
    expect(fn).toMatch(/gnote text := nullif\(current_setting\('turnrow\.hedge_event_note', true\), ''\)/)
    // DELETE and INSERT write gnote directly; UPDATE folds it into nt.
    expect((fn.match(/, gnote\);/g) ?? []).length).toBe(2)
    expect(fn).toMatch(/nt := case when nt is null then gnote else nt \|\| ' — ' \|\| gnote end/)
  })

  it('hedge_undo_import exists, is authenticated-only, and stamps source manual with the undo note', () => {
    const undo = sql.slice(sql.indexOf('create or replace function public.hedge_undo_import'))
    expect(undo).toMatch(/if auth\.uid\(\) is null then\s+raise exception 'sign in required'/)
    expect(undo).toMatch(/set_config\('turnrow\.hedge_event_source', 'manual', true\)/)
    expect(undo).toMatch(/set_config\('turnrow\.hedge_event_note', coalesce\(p_note, 'undid import of '/)
    expect(undo).toMatch(/these positions changed after the import, so it cannot be undone: %/)
    expect(undo).toMatch(/using errcode = 'check_violation'/)
    expect(undo).toMatch(/revoke all on function public\.hedge_undo_import\(date, text, text\) from public, anon/)
    expect(undo).toMatch(/grant execute on function public\.hedge_undo_import\(date, text, text\) to authenticated/)
  })

  it('hedge_execute_roll accepts several open legs (`opens` or an `open` array) and links each to the anchor', () => {
    const roll = sql.slice(sql.indexOf('create or replace function public.hedge_execute_roll'), sql.indexOf('-- 3. hedge_undo_import'))
    expect(roll).toMatch(/opens := coalesce\(payload -> 'opens', payload -> 'open'\)/)
    expect(roll).toMatch(/opens := case when jsonb_typeof\(opens\) = 'array' then opens else jsonb_build_array\(opens\) end/)
    expect(roll).toMatch(/for o in select \* from jsonb_array_elements\(opens\) loop/)
    expect(roll).toMatch(/'opened_position_ids', to_jsonb\(opened_ids\)/)
    expect(roll).toMatch(/set_config\('turnrow\.hedge_event_note', coalesce\(gnote, ''\), true\)/)
    expect(roll).toMatch(/set_config\('turnrow\.hedge_event_source', src, true\)/)
  })
})
