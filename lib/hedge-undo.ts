// Undo a brokerage-statement import (0095): the batches the ledger shows, the
// plain sentence for each, and the one RPC that reverses a batch.
//
// A "batch" is everything ONE statement wrote — every ledger row with source
// 'statement_import' and the same statement date + reference. The database
// decides created-vs-touched the same way hedge_undo_import does: a
// position's FIRST event in the batch is an insert-class event with no
// before snapshot (created → deleted on undo) or carries a before snapshot
// (touched → restored to it on undo). The ledger itself is never rewritten:
// the undo appends 'deleted' / 'edited' rows with source 'manual' and a note
// that starts "undid import of …", which is also how a batch reads as undone.
//
// Pure functions except undoImport (the RPC call).

import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
import type { HedgeEventType, HedgePositionEvent } from '@/lib/types'
import type { TimelineLine } from '@/lib/hedge-events'

export const UNDO_NOTE_PREFIX = 'undid import of'

const CREATE_EVENTS: ReadonlySet<HedgeEventType> = new Set(['opened', 'imported', 'roll_open', 'partial_close'])

export type ImportBatch = {
  /** `${statementDate}|${statementRef ?? ''}` — stable key for grouping. */
  key: string
  statementDate: string
  statementRef: string | null
  /** "StoneX 10/12/2026" */
  label: string
  /** When the import was recorded (its first ledger row). */
  recordedAt: string
  /** Its last ledger row — anything a position does after this is "later". */
  lastRecordedAt: string
  /** Positions the import created (deleted by an undo). */
  createdIds: string[]
  /** Positions the import closed, rolled, or edited (restored by an undo). */
  touchedIds: string[]
  rollGroupIds: string[]
  counts: { opened: number; closed: number; rolls: number; edited: number; events: number }
  undone: boolean
  events: HedgePositionEvent[]
}

export function batchKey(ev: Pick<HedgePositionEvent, 'statement_date' | 'statement_ref'>): string {
  return `${ev.statement_date ?? ''}|${ev.statement_ref ?? ''}`
}

export function batchLabel(statementDate: string, statementRef: string | null): string {
  return `${statementRef || 'Statement'} ${fmtDate(statementDate)}`
}

/** Default note the undo writes on every ledger row it appends. */
export function undoNote(batch: Pick<ImportBatch, 'label'>): string {
  return `${UNDO_NOTE_PREFIX} ${batch.label}`
}

function byRecorded(a: HedgePositionEvent, b: HedgePositionEvent): number {
  return a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id)
}

/** One batch per statement among the 'statement_import' events, newest first. */
export function importBatches(events: readonly HedgePositionEvent[]): ImportBatch[] {
  const sorted = [...events].sort(byRecorded)
  const byKey = new Map<string, HedgePositionEvent[]>()
  for (const ev of sorted) {
    if (ev.source !== 'statement_import' || !ev.statement_date) continue
    const k = batchKey(ev)
    const arr = byKey.get(k) ?? []
    arr.push(ev)
    byKey.set(k, arr)
  }

  const batches: ImportBatch[] = []
  for (const [key, evs] of byKey) {
    const first = evs[0]
    const statementDate = first.statement_date as string
    const statementRef = first.statement_ref ?? null
    const createdIds: string[] = []
    const touchedIds: string[] = []
    const seen = new Set<string>()
    const rollGroups = new Set<string>()
    const counts = { opened: 0, closed: 0, rolls: 0, edited: 0, events: evs.length }
    for (const ev of evs) {
      if (!seen.has(ev.position_id)) {
        seen.add(ev.position_id)
        if (ev.before_snapshot == null && CREATE_EVENTS.has(ev.event_type)) createdIds.push(ev.position_id)
        else if (ev.before_snapshot != null) touchedIds.push(ev.position_id)
      }
      if (ev.roll_group_id && (ev.event_type === 'roll_close' || ev.event_type === 'roll_open')) rollGroups.add(ev.roll_group_id)
      switch (ev.event_type) {
        case 'opened': case 'roll_open': counts.opened += 1; break
        case 'closed': case 'roll_close': case 'imported': case 'partial_close': counts.closed += 1; break
        case 'edited': case 'crop_year_changed': counts.edited += 1; break
        default: break
      }
    }
    counts.rolls = rollGroups.size
    const lastRecordedAt = evs[evs.length - 1].recorded_at

    // Undone: a later hand-written row for this statement whose note says so,
    // or every position it created has since been deleted under this statement.
    const undoRows = sorted.filter(
      (e) => e.source === 'manual' && batchKey(e) === key && e.recorded_at > lastRecordedAt,
    )
    const noteSaysSo = undoRows.some((e) => (e.note ?? '').toLowerCase().startsWith(UNDO_NOTE_PREFIX))
    const allCreatedDeleted =
      createdIds.length > 0 && createdIds.every((id) => undoRows.some((e) => e.position_id === id && e.event_type === 'deleted'))
    batches.push({
      key, statementDate, statementRef, label: batchLabel(statementDate, statementRef),
      recordedAt: first.recorded_at, lastRecordedAt,
      createdIds, touchedIds, rollGroupIds: Array.from(rollGroups), counts,
      undone: noteSaysSo || allCreatedDeleted,
      events: evs,
    })
  }
  return batches.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
}

/** "2 closed, 5 opened, 1 roll" */
export function batchCountsText(b: Pick<ImportBatch, 'counts'>): string {
  const parts: string[] = []
  const n = (count: number, noun: string, plural = `${noun}s`) => `${count} ${count === 1 ? noun : plural}`
  if (b.counts.closed > 0) parts.push(`${b.counts.closed} closed`)
  if (b.counts.opened > 0) parts.push(`${b.counts.opened} opened`)
  if (b.counts.rolls > 0) parts.push(n(b.counts.rolls, 'roll'))
  if (b.counts.edited > 0) parts.push(`${b.counts.edited} edited`)
  return parts.length > 0 ? parts.join(', ') : n(b.counts.events, 'change')
}

/** "StoneX statement 10/12/2026 — 2 closed, 5 opened, 1 roll · imported 10/13/2026" */
export function batchHeadline(b: ImportBatch): string {
  const who = b.statementRef ? `${b.statementRef} statement` : 'Brokerage statement'
  return `${who} ${fmtDate(b.statementDate)} — ${batchCountsText(b)} · imported ${fmtDate(b.recordedAt.slice(0, 10))}`
}

/** What an undo would do, in the farmer's words:
 *  "Deletes 5 positions this import created, restores 2 positions it closed; the ledger keeps every step." */
export function undoEffectText(b: Pick<ImportBatch, 'createdIds' | 'touchedIds'>): string {
  const parts: string[] = []
  const pos = (n: number) => `${n} position${n === 1 ? '' : 's'}`
  if (b.createdIds.length > 0) parts.push(`Deletes ${pos(b.createdIds.length)} this import created`)
  if (b.touchedIds.length > 0) parts.push(`${parts.length > 0 ? 'restores' : 'Restores'} ${pos(b.touchedIds.length)} it closed, rolled, or changed`)
  if (parts.length === 0) return 'This import recorded nothing that needs reversing; the ledger keeps every step.'
  return `${parts.join(', ')}; the ledger keeps every step.`
}

/** The newer, not-undone batch that touched any of this batch's positions —
 *  it has to be undone first (the database would refuse this one anyway). */
export function blockedBy(batch: ImportBatch, all: readonly ImportBatch[]): ImportBatch | null {
  const ids = new Set([...batch.createdIds, ...batch.touchedIds])
  const later = all
    .filter((b) => b.key !== batch.key && !b.undone && b.recordedAt > batch.lastRecordedAt)
    .filter((b) => [...b.createdIds, ...b.touchedIds].some((id) => ids.has(id)))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  return later[0] ?? null
}

// ---------- the History view's grouping ----------

export type TimelineSection = { key: string; batch: ImportBatch | null; lines: TimelineLine[] }

/** The line's batch key when it came from a statement import. */
export function lineBatchKey(line: TimelineLine): string | null {
  const ev = line.events.find((e) => e.source === 'statement_import' && e.statement_date)
  return ev ? batchKey(ev) : null
}

/** Timeline lines (already sorted) → sections: one per import batch, placed
 *  where its newest line falls; lines entered by hand or rolled on the page
 *  stay in plain runs between them. */
export function groupTimelineByImport(lines: readonly TimelineLine[], batches: readonly ImportBatch[]): TimelineSection[] {
  const byKey = new Map(batches.map((b) => [b.key, b]))
  const sections: TimelineSection[] = []
  const open = new Map<string, TimelineSection>()
  let run = 0
  for (const line of lines) {
    const k = lineBatchKey(line)
    if (k && byKey.has(k)) {
      let s = open.get(k)
      if (!s) { s = { key: k, batch: byKey.get(k)!, lines: [] }; open.set(k, s); sections.push(s) }
      s.lines.push(line)
    } else {
      const last = sections[sections.length - 1]
      if (last && last.batch === null) last.lines.push(line)
      else sections.push({ key: `run-${run++}`, batch: null, lines: [line] })
    }
  }
  return sections
}

// ---------- the undo itself ----------

const REFUSAL_PREFIX = 'these positions changed after the import, so it cannot be undone:'

export type UndoRefusal = { text: string; positions: string[] }

/** The database's refusal ("these positions changed after the import, so it
 *  cannot be undone: short 12 MAR 27 Cotton (open); …") as a sentence plus
 *  the positions, or null when the error is something else. */
export function undoRefusalText(errorMessage: string | null | undefined): UndoRefusal | null {
  const m = (errorMessage ?? '').trim()
  const idx = m.toLowerCase().indexOf(REFUSAL_PREFIX)
  if (idx < 0) return null
  const positions = m
    .slice(idx + REFUSAL_PREFIX.length)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
  return {
    text: 'This import can’t be undone because these positions have changed since it was recorded — closed, edited, or rolled again. Undo those changes first, or fix the positions by hand.',
    positions,
  }
}

export type UndoImportResult =
  | { ok: true; deleted: number; restored: number }
  | { ok: false; refusal: UndoRefusal | null; error: string }

export async function undoImport(
  supabase: SupabaseClient,
  args: { statementDate: string; statementRef: string | null; note?: string | null },
): Promise<UndoImportResult> {
  const { data, error } = await supabase.rpc('hedge_undo_import', {
    p_statement_date: args.statementDate,
    p_statement_ref: args.statementRef,
    p_note: args.note ?? undoNote({ label: batchLabel(args.statementDate, args.statementRef) }),
  })
  if (error) {
    const refusal = undoRefusalText(error.message)
    if (refusal) return { ok: false, refusal, error: refusal.text }
    const m = (error.message ?? '').toLowerCase()
    if (m.includes('sign in required')) return { ok: false, refusal: null, error: 'Your sign-in has expired. Sign in again to continue.' }
    if (m.includes('no import found')) return { ok: false, refusal: null, error: 'That import is no longer on record. Refresh the page and look again.' }
    return { ok: false, refusal: null, error: reportError(error, { action: 'undo this import', noun: 'import' }) }
  }
  const d = (data ?? {}) as { deleted?: number; restored?: number }
  return { ok: true, deleted: Number(d.deleted ?? 0), restored: Number(d.restored ?? 0) }
}
