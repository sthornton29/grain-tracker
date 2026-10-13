// Re-reading a saved settlement's PDF for its contract blocks (094).
//
// A settlement saved before per-line contract text existed (or one whose
// read missed a block) can have its sales assigned later: the stored PDF is
// fetched, sent through the same settlement parser the New Settlement
// screen uses, and the re-read lines are PAIRED with the saved lines by
// ticket (+ contract text when the saved line has one). New lines are never
// added — a re-read line with no saved partner only helps work out a split
// (the saved statement may carry one merged line for a ticket the buyer
// printed under two blocks). Pure pairing is tested in
// lib/settlement-reread.test.ts; the fetch/parse helpers are browser-only.

import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeSettlements } from '@/lib/parse-merge'
import { flagSummaryLines } from '@/lib/settlement-lines'
import type { SettlementExtraction, SettlementLineExtraction } from '@/lib/pdf-upload'
import { normalizeTicket } from '@/lib/ticket-matching'
import { contractNumberKey } from '@/lib/settlement-sales'

export type SavedLineForPairing = {
  id: string
  ticket_number: string | null
  contract_number_text?: string | null
  net_bushels?: number | null
}

export type RereadPairing = {
  /** re-read line index → saved line id. */
  savedIdByIndex: Map<number, string>
  /** Saved lines no re-read line claimed (they keep what they have). */
  unpairedSavedIds: string[]
  /** Re-read lines with no saved partner (shown, never saved as lines). */
  unpairedIndexes: number[]
}

/**
 * Pair re-read lines with saved lines: same ticket, preferring the same
 * contract text when the saved line carries one, then the closest bushels.
 * Each saved line is claimed once.
 */
export function pairRereadLines(saved: ReadonlyArray<SavedLineForPairing>, reread: ReadonlyArray<SettlementLineExtraction>): RereadPairing {
  const claimed = new Set<string>()
  const savedIdByIndex = new Map<number, string>()
  // Per ticket: exact contract-text pairs first, then the closest bushels
  // across every remaining (re-read line, saved line) pair — so a merged
  // saved line goes to the re-read line nearest its bushels, not to
  // whichever line the statement printed first.
  const byTicket = new Map<string, number[]>()
  reread.forEach((line, index) => {
    const ticket = normalizeTicket(line.ticket_number)
    if (ticket) byTicket.set(ticket, [...(byTicket.get(ticket) ?? []), index])
  })
  for (const [ticket, indexes] of byTicket) {
    const cands = saved.filter((s) => normalizeTicket(s.ticket_number) === ticket)
    if (cands.length === 0) continue
    const pending = new Set(indexes)
    for (const index of indexes) {
      const key = contractNumberKey(reread[index].contract_number)
      if (!key) continue
      const hit = cands.find((s) => !claimed.has(s.id) && contractNumberKey(s.contract_number_text) === key)
      if (hit) { claimed.add(hit.id); savedIdByIndex.set(index, hit.id); pending.delete(index) }
    }
    const pairs: Array<{ index: number; id: string; gap: number }> = []
    for (const index of pending) {
      const bu = Number(reread[index].net_bushels ?? 0)
      for (const s of cands) {
        if (claimed.has(s.id)) continue
        // A saved line that names a DIFFERENT contract is not this line.
        const sText = contractNumberKey(s.contract_number_text)
        const key = contractNumberKey(reread[index].contract_number)
        if (sText && key && sText !== key) continue
        pairs.push({ index, id: s.id, gap: Math.abs(Number(s.net_bushels ?? 0) - bu) })
      }
    }
    pairs.sort((a, b) => a.gap - b.gap)
    for (const p of pairs) {
      if (!pending.has(p.index) || claimed.has(p.id)) continue
      claimed.add(p.id); savedIdByIndex.set(p.index, p.id); pending.delete(p.index)
    }
  }
  const unpairedIndexes = reread.map((_, i) => i).filter((i) => !savedIdByIndex.has(i))
  return { savedIdByIndex, unpairedSavedIds: saved.filter((s) => !claimed.has(s.id)).map((s) => s.id), unpairedIndexes }
}

/** The stored PDF as a File the parser accepts. */
export async function fetchStoredPdf(url: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${res.status}`)
  const blob = await res.blob()
  const name = decodeURIComponent(url.split('/').pop() ?? 'settlement.pdf').split('?')[0] || 'settlement.pdf'
  return new File([blob], name, { type: 'application/pdf' })
}

export type RereadResult = {
  extraction: SettlementExtraction
  /** The ticket lines with summary / check-stub rows dropped. */
  lines: SettlementLineExtraction[]
  warning: string | null
}

/** Re-read a settlement document the way the New Settlement screen reads it. */
export async function rereadSettlementFile(file: File, onProgress?: (label: string) => void): Promise<RereadResult> {
  const { data, warning } = await parseDocumentChunked<SettlementExtraction>(file, 'settlement', { onProgress, merge: mergeSettlements })
  const all = Array.isArray(data.line_items) ? data.line_items : []
  const guards = flagSummaryLines(all, { settlementNumber: data.settlement_number })
  const refs = [data.settlement_number, data.payment_number, data.check_number].filter((x): x is string => !!x).map((r) => normalizeTicket(r).replace(/\D+/g, ''))
  const lines = all.filter((li, i) => {
    if (guards[i].flagged) return false
    const tk = normalizeTicket(li.ticket_number).replace(/\D+/g, '')
    return !(tk && refs.includes(tk))
  })
  return { extraction: data, lines, warning }
}
