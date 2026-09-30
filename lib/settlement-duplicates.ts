// Duplicate-settlement detection for the settlement upload (New Settlement).
//
// Two questions, answered from the settlements already saved:
//   1. Is this STATEMENT already in Turnrow? Same buyer + same settlement
//      number (or the same check / payment number) means the same piece of
//      paper was uploaded before.
//   2. Are the LOADS on these lines already paid? A load can only be paid
//      once; a line whose matched load (or ticket, for the same buyer) is
//      already on a saved settlement line is a repeat.
// Pure functions — the page fetches the rows and renders the verdicts.

import { normalizeTicket } from '@/lib/ticket-matching'

export type ExistingSettlement = {
  id: string
  buyer_id: string
  settlement_date: string
  settlement_number: string | null
  check_number?: string | null
  payment_number?: string | null
}

export type ExistingLine = {
  settlement_id: string
  load_id: string | null
  ticket_number: string | null
}

/** Where a load or ticket was already paid. */
export type PaidRef = {
  settlementId: string
  settlementNumber: string | null
  settlementDate: string
  buyerId: string
}

export type DuplicateSettlement = {
  settlement: ExistingSettlement
  /** Which header fact matched — for the sentence on screen. */
  matchedOn: 'settlement number' | 'check number' | 'payment number'
}

/** Digits-only comparison key for a reference number: "SET-000123" and
 *  "123" are the same statement to a buyer's system. Empty when there are no
 *  digits at all (then the normalized text is used instead). */
function refKey(s: string | null | undefined): string {
  const n = normalizeTicket(s)
  if (!n) return ''
  const digits = n.replace(/\D+/g, '').replace(/^0+(?=\d)/, '')
  return digits || n
}

/** The saved settlement this draft header repeats, if any. Buyer must match
 *  when the draft has one; a draft without a buyer yet still catches a
 *  repeated settlement number so the warning shows before the buyer is set. */
export function findDuplicateSettlement(
  draft: { buyerId: string | null; settlementNumber: string | null; checkNumber?: string | null; paymentNumber?: string | null },
  existing: readonly ExistingSettlement[],
): DuplicateSettlement | null {
  const sameBuyer = (s: ExistingSettlement) => !draft.buyerId || s.buyer_id === draft.buyerId
  const num = refKey(draft.settlementNumber)
  if (num) {
    const hit = existing.find((s) => sameBuyer(s) && refKey(s.settlement_number) === num)
    if (hit) return { settlement: hit, matchedOn: 'settlement number' }
  }
  const check = refKey(draft.checkNumber)
  if (check) {
    const hit = existing.find((s) => sameBuyer(s) && refKey(s.check_number) === check)
    if (hit) return { settlement: hit, matchedOn: 'check number' }
  }
  const pay = refKey(draft.paymentNumber)
  if (pay) {
    const hit = existing.find((s) => sameBuyer(s) && refKey(s.payment_number) === pay)
    if (hit) return { settlement: hit, matchedOn: 'payment number' }
  }
  return null
}

export type PaidIndex = {
  byLoadId: Map<string, PaidRef>
  /** normalized ticket → refs (a ticket number can repeat across buyers). */
  byTicket: Map<string, PaidRef[]>
}

export function buildPaidIndex(lines: readonly ExistingLine[], settlements: readonly ExistingSettlement[]): PaidIndex {
  const settlementById = new Map(settlements.map((s) => [s.id, s]))
  const byLoadId = new Map<string, PaidRef>()
  const byTicket = new Map<string, PaidRef[]>()
  for (const l of lines) {
    const s = settlementById.get(l.settlement_id)
    if (!s) continue
    const ref: PaidRef = { settlementId: s.id, settlementNumber: s.settlement_number, settlementDate: s.settlement_date, buyerId: s.buyer_id }
    if (l.load_id && !byLoadId.has(l.load_id)) byLoadId.set(l.load_id, ref)
    const t = normalizeTicket(l.ticket_number)
    if (t) {
      const arr = byTicket.get(t) ?? []
      arr.push(ref)
      byTicket.set(t, arr)
    }
  }
  return { byLoadId, byTicket }
}

/** The saved settlement line that already pays this draft line: by the
 *  matched load first, then by ticket number for the same buyer (a ticket
 *  number alone is not unique across buyers, so a buyer is required for
 *  that path). */
export function paidRefFor(
  line: { loadId: string | null; ticketNumber: string | null; buyerId: string | null },
  index: PaidIndex,
): PaidRef | null {
  if (line.loadId) {
    const hit = index.byLoadId.get(line.loadId)
    if (hit) return hit
  }
  if (line.buyerId) {
    const t = normalizeTicket(line.ticketNumber)
    if (t) {
      const hit = (index.byTicket.get(t) ?? []).find((r) => r.buyerId === line.buyerId)
      if (hit) return hit
    }
  }
  return null
}

export type DuplicateVerdict = {
  /** Lines counted (not left out). */
  included: number
  /** Of those, lines already paid on a saved settlement. */
  paid: number
  /** Distinct saved settlements those paid lines sit on. */
  settlements: PaidRef[]
  /** Every included line is already paid on ONE saved settlement. */
  wholeStatementRepeated: boolean
}

export function duplicateVerdict(rows: ReadonlyArray<{ excluded: boolean; paid: PaidRef | null }>): DuplicateVerdict {
  const included = rows.filter((r) => !r.excluded)
  const paidRows = included.filter((r) => r.paid != null)
  const seen = new Map<string, PaidRef>()
  for (const r of paidRows) if (r.paid && !seen.has(r.paid.settlementId)) seen.set(r.paid.settlementId, r.paid)
  return {
    included: included.length,
    paid: paidRows.length,
    settlements: [...seen.values()],
    wholeStatementRepeated: included.length > 0 && paidRows.length === included.length && seen.size === 1,
  }
}

/** The label for a saved settlement in a sentence: "#12345 (9/14/2026)". */
export function paidRefLabel(ref: Pick<PaidRef, 'settlementNumber' | 'settlementDate'>, fmtDate: (iso: string) => string): string {
  return `${ref.settlementNumber ? `#${ref.settlementNumber}` : 'without a number'} (${fmtDate(ref.settlementDate)})`
}
