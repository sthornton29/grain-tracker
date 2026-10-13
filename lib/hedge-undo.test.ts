import { describe, it, expect, vi } from 'vitest'
import {
  importBatches, batchHeadline, batchCountsText, undoEffectText, undoNote, blockedBy,
  groupTimelineByImport, undoRefusalText, undoImport, batchKey,
} from '@/lib/hedge-undo'
import { buildHedgeTimeline } from '@/lib/hedge-events'
import type { HedgePositionEvent } from '@/lib/types'

function ev(over: Partial<HedgePositionEvent> & Pick<HedgePositionEvent, 'id' | 'position_id' | 'event_type' | 'occurred_at' | 'recorded_at'>): HedgePositionEvent {
  return {
    related_position_id: null, roll_group_id: null, source: 'statement_import', statement_date: '2026-10-12', statement_ref: 'StoneX',
    actor_user_id: null, actor_email: null, entity_id: null,
    commodity: 'Cotton', contract_month: 'MAR 27', contract_symbol: 'CTH27', side: 'short', crop_year: 2026,
    quantity: 3, price: 83.63, close_price: null, fees: null, realized_pnl: null,
    before_snapshot: null, after_snapshot: null, note: null, ...over,
  }
}

// The 10/12/2026 StoneX import as the ledger holds it: two DEC legs rolled
// (before snapshots → touched), five MAR fills opened by the roll, one plain
// new position, and one existing position closed by hand earlier (manual).
const T0 = '2026-10-13T15:00:00Z'
const IMPORT: HedgePositionEvent[] = [
  ev({ id: 'c1', position_id: 'dec10', event_type: 'roll_close', occurred_at: '2026-10-12', recorded_at: '2026-10-13T15:00:00Z', roll_group_id: 'gc', contract_month: 'DEC 26', quantity: 10, price: 72.65, close_price: 80.45739, realized_pnl: -39036.96, before_snapshot: { status: 'open' }, after_snapshot: { status: 'closed' } }),
  ev({ id: 'c2', position_id: 'dec13', event_type: 'roll_close', occurred_at: '2026-10-12', recorded_at: '2026-10-13T15:00:01Z', roll_group_id: 'gc', contract_month: 'DEC 26', quantity: 13, price: 84.4, close_price: 80.45739, realized_pnl: 25626.96, before_snapshot: { status: 'open' }, after_snapshot: { status: 'closed' } }),
  ...[0, 1, 2, 3, 4].map((i) => ev({ id: `o${i}`, position_id: `mar${i}`, event_type: 'roll_open', occurred_at: '2026-10-12', recorded_at: `2026-10-13T15:00:0${2 + i}Z`, roll_group_id: 'gc', related_position_id: 'dec10', after_snapshot: { status: 'open' } })),
  ev({ id: 'n1', position_id: 'wheat', event_type: 'opened', occurred_at: '2026-10-09', recorded_at: '2026-10-13T15:00:08Z', commodity: 'Chicago Wheat', contract_month: 'JUL 27', after_snapshot: { status: 'open' } }),
]
const MANUAL_BEFORE = ev({ id: 'm0', position_id: 'soy', event_type: 'closed', occurred_at: '2026-10-01', recorded_at: '2026-10-02T10:00:00Z', source: 'manual', statement_date: null, statement_ref: null, commodity: 'Soybeans', contract_month: 'NOV 26', before_snapshot: { status: 'open' }, after_snapshot: { status: 'closed' } })

describe('importBatches', () => {
  it('one batch per statement with created / touched positions, counts, and the label', () => {
    const batches = importBatches([...IMPORT, MANUAL_BEFORE].reverse())
    expect(batches).toHaveLength(1)
    const [b] = batches
    expect(b.key).toBe('2026-10-12|StoneX')
    expect(b.label).toBe('StoneX 10/12/2026')
    expect(b.recordedAt).toBe(T0)
    expect(b.lastRecordedAt).toBe('2026-10-13T15:00:08Z')
    expect(b.createdIds).toEqual(['mar0', 'mar1', 'mar2', 'mar3', 'mar4', 'wheat'])
    expect(b.touchedIds).toEqual(['dec10', 'dec13'])
    expect(b.rollGroupIds).toEqual(['gc'])
    expect(b.counts).toEqual({ opened: 6, closed: 2, rolls: 1, edited: 0, events: 8 })
    expect(b.undone).toBe(false)
    expect(batchCountsText(b)).toBe('2 closed, 6 opened, 1 roll')
    expect(batchHeadline(b)).toBe('StoneX statement 10/12/2026 — 2 closed, 6 opened, 1 roll · imported 10/13/2026')
    expect(undoEffectText(b)).toBe('Deletes 6 positions this import created, restores 2 positions it closed, rolled, or changed; the ledger keeps every step.')
    expect(undoNote(b)).toBe('undid import of StoneX 10/12/2026')
  })

  it('a position touched then re-touched inside the same import counts once, by its FIRST event', () => {
    const edited = ev({ id: 'e1', position_id: 'mar1', event_type: 'edited', occurred_at: '2026-10-12', recorded_at: '2026-10-13T15:00:09Z', before_snapshot: { crop_year: 2026 }, after_snapshot: { crop_year: 2027 } })
    const [b] = importBatches([...IMPORT, edited])
    expect(b.createdIds).toContain('mar1')
    expect(b.touchedIds).not.toContain('mar1')
    expect(b.counts.edited).toBe(1)
  })

  it('reads as undone once the hand-written undo rows for that statement are in the ledger', () => {
    const undoRows = [
      ...[0, 1, 2, 3, 4].map((i) => ev({ id: `d${i}`, position_id: `mar${i}`, event_type: 'deleted', occurred_at: '2026-10-14', recorded_at: `2026-10-14T09:00:0${i}Z`, source: 'manual', note: 'undid import of StoneX 10/12/2026' })),
      ev({ id: 'dw', position_id: 'wheat', event_type: 'deleted', occurred_at: '2026-10-14', recorded_at: '2026-10-14T09:00:05Z', source: 'manual', note: 'undid import of StoneX 10/12/2026' }),
      ev({ id: 'r1', position_id: 'dec10', event_type: 'edited', occurred_at: '2026-10-14', recorded_at: '2026-10-14T09:00:06Z', source: 'manual', note: 'undid import of StoneX 10/12/2026', before_snapshot: { status: 'closed' }, after_snapshot: { status: 'open' } }),
    ]
    expect(importBatches([...IMPORT, ...undoRows])[0].undone).toBe(true)
    // A custom note still reads as undone when every created position was deleted under the statement.
    const custom = undoRows.map((e) => ({ ...e, note: 'wrong statement' }))
    expect(importBatches([...IMPORT, ...custom])[0].undone).toBe(true)
    // Only some deleted + no undo note → not undone.
    expect(importBatches([...IMPORT, ...custom.slice(0, 2)])[0].undone).toBe(false)
  })

  it('two statements → two batches, newest first; a later one touching the same positions blocks the older', () => {
    const later = [
      ev({ id: 'l1', position_id: 'mar1', event_type: 'closed', occurred_at: '2026-10-19', recorded_at: '2026-10-20T15:00:00Z', statement_date: '2026-10-19', close_price: 81, realized_pnl: 15840, before_snapshot: { status: 'open' }, after_snapshot: { status: 'closed' } }),
    ]
    const batches = importBatches([...IMPORT, ...later])
    expect(batches.map((b) => b.statementDate)).toEqual(['2026-10-19', '2026-10-12'])
    expect(blockedBy(batches[1], batches)?.key).toBe('2026-10-19|StoneX')
    expect(blockedBy(batches[0], batches)).toBeNull()
    // Once the newer one is undone it no longer blocks.
    const undone = batches.map((b) => (b.key === '2026-10-19|StoneX' ? { ...b, undone: true } : b))
    expect(blockedBy(undone[1], undone)).toBeNull()
  })

  it('ignores events without a statement date and hand entries', () => {
    expect(importBatches([MANUAL_BEFORE, ev({ ...MANUAL_BEFORE, id: 'x', source: 'statement_import', statement_date: null })])).toEqual([])
  })
})

describe('groupTimelineByImport', () => {
  it('one section per batch, placed at its newest line; hand entries stay in plain runs', () => {
    const manualAfter = ev({ id: 'm9', position_id: 'corn', event_type: 'opened', occurred_at: '2026-10-15', recorded_at: '2026-10-15T10:00:00Z', source: 'manual', statement_date: null, statement_ref: null, commodity: 'Corn', contract_month: 'DEC 26' })
    const events = [...IMPORT, MANUAL_BEFORE, manualAfter]
    const lines = buildHedgeTimeline(events)
    const sections = groupTimelineByImport(lines, importBatches(events))
    expect(sections.map((s) => (s.batch ? s.batch.label : `${s.lines.length} plain`))).toEqual(['1 plain', 'StoneX 10/12/2026', '1 plain'])
    // The roll (7 events) and the wheat open both sit under the statement header.
    expect(sections[1].lines.map((l) => l.kind)).toEqual(['roll', 'opened'])
    expect(batchKey(sections[1].lines[0].events[0])).toBe('2026-10-12|StoneX')
  })
})

describe('undoRefusalText', () => {
  it('turns the database refusal into a sentence plus the positions', () => {
    const r = undoRefusalText('these positions changed after the import, so it cannot be undone: short 12 MAR 27 Cotton (open); long 2 NOV 26 Soybeans (closed)')
    expect(r?.positions).toEqual(['Short 12 MAR 27 Cotton (open)', 'Long 2 NOV 26 Soybeans (closed)'])
    expect(r?.text).toMatch(/can.t be undone because these positions have changed/)
  })
  it('is null for any other error', () => {
    expect(undoRefusalText('no import found for that statement')).toBeNull()
    expect(undoRefusalText(null)).toBeNull()
  })
})

describe('undoImport', () => {
  function client(result: { data?: unknown; error?: { message: string; code?: string } | null }) {
    const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
    return { supabase: { rpc } as never, rpc }
  }

  it('calls hedge_undo_import with the statement and the default note', async () => {
    const { supabase, rpc } = client({ data: { deleted: 6, restored: 2 } })
    const res = await undoImport(supabase, { statementDate: '2026-10-12', statementRef: 'StoneX' })
    expect(rpc).toHaveBeenCalledWith('hedge_undo_import', { p_statement_date: '2026-10-12', p_statement_ref: 'StoneX', p_note: 'undid import of StoneX 10/12/2026' })
    expect(res).toEqual({ ok: true, deleted: 6, restored: 2 })
  })

  it('a refusal comes back with the positions named', async () => {
    const { supabase } = client({ error: { message: 'these positions changed after the import, so it cannot be undone: short 12 MAR 27 Cotton (open)', code: '23514' } })
    const res = await undoImport(supabase, { statementDate: '2026-10-12', statementRef: 'StoneX' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.refusal?.positions).toEqual(['Short 12 MAR 27 Cotton (open)'])
  })

  it('other failures read plainly', async () => {
    const gone = await undoImport(client({ error: { message: 'no import found for that statement' } }).supabase, { statementDate: '2026-10-12', statementRef: 'StoneX' })
    expect(gone).toMatchObject({ ok: false, refusal: null, error: 'That import is no longer on record. Refresh the page and look again.' })
    const missing = await undoImport(client({ error: { message: 'Could not find the function public.hedge_undo_import' } }).supabase, { statementDate: '2026-10-12', statementRef: 'StoneX' })
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('contact support') })
    const signedOut = await undoImport(client({ error: { message: 'sign in required' } }).supabase, { statementDate: '2026-10-12', statementRef: 'StoneX' })
    expect(signedOut).toMatchObject({ ok: false, error: expect.stringContaining('Sign in again') })
  })
})
