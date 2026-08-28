// Merging per-chunk AI extraction results back into one document result.
//
// Large documents are parsed in page batches (lib/parse-chunked.ts) — the
// extraction prompts already handle partial-document context, so each chunk
// returns the same shape as a whole-document parse. These merge functions
// combine the chunks and DEDUPE ACROSS CHUNK BOUNDARIES: a record printed on
// (or straddling) two batched pages — a repeated ticket, a bale number, a
// carried-over position line — resolves once. Scalar/header fields take the
// first non-null value (headers live on page 1, so chunk order matters).
//
// Pure functions — no fetch, no DOM — so the boundary-dedupe rules are unit
// tested (lib/parse-merge.test.ts).

import type {
  BrokerageStatementExtraction,
  ContractExtraction,
  CottonLoadsExtraction,
  CropInsuranceExtraction,
  DiscountScheduleExtraction,
  FsaBaseAcresExtraction,
  GinReceiptExtraction,
  LeaseAgreementExtraction,
  SettlementDiscountItemExtraction,
  SettlementExtraction,
  TicketsExtraction,
} from '@/lib/pdf-upload'
import type { CottonMarketingExtraction, CottonMarketingExtracted } from '@/lib/cotton-doc-import'
import { normalizePbi } from '@/lib/cotton-doc-import'

// ---------- generic helpers ----------

/** First non-null/non-undefined value of `pick` across the parts, else null. */
export function firstValue<P, V>(parts: P[], pick: (p: P) => V | null | undefined): V | null {
  for (const p of parts) {
    const v = pick(p)
    if (v != null) return v
  }
  return null
}

/**
 * Concatenate the parts' lists, dropping later items whose key already
 * appeared. The default key is the full JSON of the item, which removes the
 * classic boundary artifact — the SAME record extracted from two overlapping
 * chunks — while keeping legitimately similar records (different values →
 * different JSON). Pass a natural key (e.g. ticket number) where one exists;
 * items whose natural key is null/empty are always kept.
 */
export function mergeList<T>(lists: T[][], keyOf?: (item: T) => string | null): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = keyOf ? keyOf(item) : JSON.stringify(item)
      if (key != null && key !== '') {
        if (seen.has(key)) continue
        seen.add(key)
      }
      out.push(item)
    }
  }
  return out
}

const norm = (v: unknown) => (v == null ? '' : String(v).trim().toLowerCase())

/** Object whose fields are each the first non-null across parts. */
function mergeScalars<T extends Record<string, unknown>>(parts: Array<T | null | undefined>): T {
  const present = parts.filter((p): p is T => p != null)
  const out: Record<string, unknown> = {}
  for (const p of present) {
    for (const [k, v] of Object.entries(p)) {
      if (out[k] == null && v != null) out[k] = v
    }
  }
  // Keep null for keys that never had a value (shape-preserving).
  for (const p of present) for (const k of Object.keys(p)) if (!(k in out)) out[k] = null
  return out as T
}

// ---------- per-document-type merges ----------

export function mergeTickets(parts: TicketsExtraction[]): TicketsExtraction {
  return {
    tickets: mergeList(
      parts.map((p) => p.tickets ?? []),
      // A ticket number identifies the ticket; unnumbered tickets always keep.
      (t) => (t.ticket_number ? `${norm(t.ticket_number)}|${norm(t.date)}` : null),
    ),
  }
}

export function mergeSettlements(parts: SettlementExtraction[]): SettlementExtraction {
  // Discount items: an EXACT category+description+amount repeat across a
  // chunk boundary is the same printed line seen twice — drop it. Different
  // amounts under the same category+description are per-chunk PARTIAL sums
  // (each batch of pages saw its share of, say, the drying charges) — SUM
  // them into one item, keeping the first non-null rate/basis text.
  const deduped = mergeList(
    parts.map((p) => p.discount_items ?? []),
    (i) => `${norm(i.category)}|${norm(i.description)}|${i.amount ?? ''}`,
  )
  const byKey = new Map<string, SettlementDiscountItemExtraction>()
  for (const i of deduped) {
    const key = `${norm(i.category)}|${norm(i.description)}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...i })
    } else {
      prev.amount = (prev.amount ?? 0) + (i.amount ?? 0)
      prev.rate_note = prev.rate_note ?? i.rate_note
      prev.quantity_basis = prev.quantity_basis ?? i.quantity_basis
    }
  }
  return {
    buyer_name: firstValue(parts, (p) => p.buyer_name),
    settlement_date: firstValue(parts, (p) => p.settlement_date),
    settlement_number: firstValue(parts, (p) => p.settlement_number),
    line_items: mergeList(
      parts.map((p) => p.line_items ?? []),
      (l) => (l.ticket_number ? norm(l.ticket_number) : null),
    ),
    discount_items: [...byKey.values()],
  }
}

export function mergeDiscountSchedules(parts: DiscountScheduleExtraction[]): DiscountScheduleExtraction {
  // One schedule per document: header scalars from the first chunk that has
  // them; rules concatenate with one entry per factor (the earliest chunk's
  // rule for a factor wins — a schedule prices each factor once).
  return {
    buyer_name: firstValue(parts, (p) => p.buyer_name),
    crop: firstValue(parts, (p) => p.crop),
    effective_date: firstValue(parts, (p) => p.effective_date),
    crop_year: firstValue(parts, (p) => p.crop_year),
    schedule_text: firstValue(parts, (p) => p.schedule_text),
    rules: mergeList(parts.map((p) => p.rules ?? []), (r) => norm(r.factor) || null),
  }
}

export function mergeContracts(parts: ContractExtraction[]): ContractExtraction {
  // One contract per document — later pages only fill fields page 1 lacked.
  return mergeScalars(parts)
}

export function mergeBrokerage(parts: BrokerageStatementExtraction[]): BrokerageStatementExtraction {
  return {
    statement_date: firstValue(parts, (p) => p.statement_date),
    open_positions: mergeList(parts.map((p) => p.open_positions ?? [])),
    closed_groups: mergeList(parts.map((p) => p.closed_groups ?? [])),
    closed_trades: mergeList(parts.map((p) => p.closed_trades ?? [])),
    open_options: mergeList(parts.map((p) => p.open_options ?? [])),
    closed_options: mergeList(parts.map((p) => p.closed_options ?? [])),
    account_summary: firstValue(parts, (p) => p.account_summary),
  }
}

export function mergeCropInsurance(parts: CropInsuranceExtraction[]): CropInsuranceExtraction {
  // The review screen dedupes again on the policy natural key; here we only
  // drop exact boundary repeats.
  return { policies: mergeList(parts.map((p) => p.policies ?? [])) }
}

export function mergeFsaBaseAcres(parts: FsaBaseAcresExtraction[]): FsaBaseAcresExtraction {
  // The import screen merges per-farm cards afterwards (mergeFarmRows);
  // exact repeats across a boundary are dropped here.
  return { farms: mergeList(parts.map((p) => p.farms ?? [])) }
}

export function mergeCottonLoads(parts: CottonLoadsExtraction[]): CottonLoadsExtraction {
  return {
    loads: mergeList(
      parts.map((p) => p.loads ?? []),
      (l) => (l.load_number ? norm(l.load_number) : null),
    ),
  }
}

export function mergeGinReceipts(parts: GinReceiptExtraction[]): GinReceiptExtraction {
  const scalars = mergeScalars(
    parts.map(({ loads: _l, bales: _b, ...rest }) => rest),
  ) as Omit<GinReceiptExtraction, 'loads' | 'bales'>
  return {
    ...scalars,
    loads: mergeList(
      parts.map((p) => p.loads ?? []),
      (l) => (l.load_number ? norm(l.load_number) : null),
    ),
    // Bale numbers match on digits, leading zeros ignored (the PBI rule).
    bales: mergeList(
      parts.map((p) => p.bales ?? []),
      (b) => (b.pbi_number ? normalizePbi(String(b.pbi_number)) || null : null),
    ),
  }
}

export function mergeLeaseAgreements(parts: LeaseAgreementExtraction[]): LeaseAgreementExtraction {
  // One lease per document: scalars/objects from the first chunk that has
  // them (terms usually front-load); list clauses concatenate deduped.
  return {
    landowner_name: firstValue(parts, (p) => p.landowner_name),
    landowner_address: firstValue(parts, (p) => p.landowner_address),
    farm_names: mergeList(parts.map((p) => p.farm_names ?? []), (s) => String(s).trim().toLowerCase() || null),
    lease_type: firstValue(parts, (p) => p.lease_type),
    share_terms: firstValue(parts, (p) => p.share_terms),
    expense_terms: mergeList(parts.map((p) => p.expense_terms ?? []), (e) => `${e.category}|${e.landowner_pct}`),
    pricing_method: firstValue(parts, (p) => p.pricing_method),
    cash_terms: firstValue(parts, (p) => p.cash_terms),
    flex_terms: mergeList(parts.map((p) => p.flex_terms ?? []), (f) => f.description.trim().toLowerCase() || null),
    payment_timing: firstValue(parts, (p) => p.payment_timing),
    crop_year: firstValue(parts, (p) => p.crop_year),
    notes: firstValue(parts, (p) => p.notes),
    source: firstValue(parts, (p) => p.source),
  }
}

export function mergeCottonMarketing(parts: CottonMarketingExtraction[]): CottonMarketingExtraction {
  if (parts.length === 1) return parts[0]
  // Majority category across chunks (a bale list's later pages can read as
  // "bale_list" while page 1 reads as the covering document — the majority
  // usually reflects the document body).
  const counts = new Map<string, number>()
  for (const p of parts) {
    if (!p.document_category) continue
    counts.set(p.document_category, (counts.get(p.document_category) ?? 0) + 1)
  }
  let category = parts[0].document_category
  let best = 0
  for (const [c, n] of counts) if (n > best) { best = n; category = c as CottonMarketingExtraction['document_category'] }
  const matching = parts.filter((p) => p.document_category === category && p.extracted != null)
  const extractedParts = (matching.length > 0 ? matching : parts).map((p) => p.extracted).filter(Boolean) as Array<Record<string, unknown>>
  let extracted: CottonMarketingExtracted | null = null
  if (extractedParts.length > 0) {
    const merged = mergeScalars(extractedParts)
    // bale_pbis lists concatenate across chunks, deduped on the PBI rule.
    const pbiLists = extractedParts
      .map((e) => (Array.isArray(e.bale_pbis) ? (e.bale_pbis as string[]) : null))
      .filter((x): x is string[] => x != null)
    if (pbiLists.length > 0) {
      ;(merged as Record<string, unknown>).bale_pbis = mergeList(pbiLists.map((l) => l.map((s) => String(s))), (s) => normalizePbi(s) || null)
    }
    extracted = merged as CottonMarketingExtracted
  }
  const confidences = parts.map((p) => p.confidence)
  const confidence: CottonMarketingExtraction['confidence'] =
    confidences.includes('low') ? 'low' : confidences.includes('medium') ? 'medium' : 'high'
  return { document_category: category, confidence, extracted }
}
