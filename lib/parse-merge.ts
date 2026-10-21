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
  BrokerageClosedGroup,
  BrokerageClosedGroupLot,
  BrokerageClosingFill,
  BrokerageOpenPosition,
  BrokerageStatementExtraction,
  ContractExtraction,
  CottonLoadsExtraction,
  CropInsuranceExtraction,
  DiscountScheduleExtraction,
  FsaBaseAcresExtraction,
  GinReceiptExtraction,
  LeaseAgreementExtraction,
  SeedContractExtraction,
  SettlementDiscountItemExtraction,
  SettlementExtraction,
  TicketsExtraction,
} from '@/lib/pdf-upload'
import type { CottonMarketingExtraction, CottonMarketingExtracted } from '@/lib/cotton-doc-import'
import { normalizePbi } from '@/lib/cotton-doc-import'
import { numberKey } from '@/lib/number-key'
import { normalizeSettlementExtraction } from '@/lib/pdf-upload'

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
      (t) => (t.ticket_number ? `${norm(t.ticket_number)}|${norm(t.date_text ?? t.date)}` : null),
    ),
  }
}

export function mergeSettlements(rawParts: SettlementExtraction[]): SettlementExtraction {
  // Each part may still carry the model's nested contract_blocks (nulls
  // omitted): flatten to the line shape first, so the dedupe keys below see
  // every line's contract and every key is present.
  const parts = rawParts.map((p) => normalizeSettlementExtraction(p))
  // Discount items: an EXACT category+description+amount repeat across a
  // chunk boundary is the same printed line seen twice — drop it. Different
  // amounts under the same category+description are per-chunk PARTIAL sums
  // (each batch of pages saw its share of, say, the drying charges) — SUM
  // them into one item, keeping the first non-null rate/basis text.
  const deduped = mergeList(
    parts.map((p) => p.discount_items ?? []),
    (i) => `${norm(i.deduction_kind) || 'price'}|${norm(i.category)}|${norm(i.description)}|${i.amount ?? ''}`,
  )
  const byKey = new Map<string, SettlementDiscountItemExtraction>()
  for (const i of deduped) {
    const key = `${norm(i.deduction_kind) || 'price'}|${norm(i.category)}|${norm(i.description)}`
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
    // 086: header contract + the remittance page's payment facts print once.
    contract_number: firstValue(parts, (p) => p.contract_number ?? null),
    payment_number: firstValue(parts, (p) => p.payment_number ?? null),
    check_number: firstValue(parts, (p) => p.check_number ?? null),
    payment_date: firstValue(parts, (p) => p.payment_date ?? null),
    // 094: the same ticket under TWO contract blocks (58 bu finishing a
    // contract, the rest spot) is a SPLIT, not a boundary repeat — the key
    // carries the line's contract text, so only a true repeat collapses.
    line_items: mergeList(
      parts.map((p) => p.line_items ?? []),
      (l) => (l.ticket_number ? `${norm(l.ticket_number)}|${norm(l.contract_number)}` : null),
    ),
    discount_items: [...byKey.values()],
    // The grand total prints once (last page / check stub): first non-null.
    statement_reported_total: firstValue(parts, (p) => p.statement_reported_total ?? null),
    statement_reported_bushels: firstValue(parts, (p) => p.statement_reported_bushels ?? null),
    statement_reported_gross: firstValue(parts, (p) => p.statement_reported_gross ?? null),
    // "No. Tickets: 94" prints once; the completeness guard reads it.
    statement_reported_ticket_count: firstValue(parts, (p) => p.statement_reported_ticket_count ?? null),
    // The contract summary block prints once (Woodall: the last page).
    contract_summary: firstValue(parts, (p) => p.contract_summary ?? null),
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

export function mergeSeedContracts(parts: SeedContractExtraction[]): SeedContractExtraction {
  // One agreement per document: scalars from the first chunk that read them
  // (signature page first), premium rows collected across the terms pages and
  // deduped on outcome + component.
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  return {
    ...mergeScalars(parts.map(({ premiums: _premiums, ...rest }) => rest)),
    premiums: mergeList(
      parts.map((p) => p.premiums ?? []),
      (r) => {
        const key = `${norm(r.outcome)}|${norm(r.component)}`
        return key === '|' ? null : key
      },
    ),
  } as SeedContractExtraction
}

export function mergeBrokerage(parts: BrokerageStatementExtraction[]): BrokerageStatementExtraction {
  // Natural keys (2026-10-13): an open fill is commodity|month|side|date|
  // price|qty|code; a closed offset group is commodity|month|side|close_date
  // — a group that straddles a chunk boundary comes back from both chunks
  // with part of its lots each, so the lots MERGE (deduped on their own
  // date|price|qty) instead of the second chunk's copy being dropped; a
  // subtotal line is commodity|month|side. lib/statement-lots does the
  // tolerant, statement-aware reconciliation afterwards.
  const px = (v: number | null | undefined) => (v == null ? '' : String(Math.round(Number(v) * 1e6) / 1e6))
  const openKey = (p: BrokerageOpenPosition) =>
    `${norm(p.commodity)}|${norm(p.contract_month)}|${norm(p.side)}|${norm(p.trade_date)}|${px(p.trade_price)}|${p.num_contracts ?? ''}|${norm(p.execution_code)}`
  const groupKey = (g: BrokerageClosedGroup) => `${norm(g.commodity)}|${norm(g.contract_month)}|${norm(g.side)}|${norm(g.close_date)}`
  const lotKey = (l: BrokerageClosedGroupLot) => `${norm(l.open_date)}|${px(l.open_price)}|${l.contracts ?? ''}`
  const fillKey = (f: BrokerageClosingFill) => `${norm(f.date)}|${px(f.price)}|${f.contracts ?? ''}`

  const groups = new Map<string, BrokerageClosedGroup>()
  for (const part of parts) {
    for (const g of part.closed_groups ?? []) {
      const key = groupKey(g)
      const prev = groups.get(key)
      if (!prev) {
        groups.set(key, { ...g, lots: [...(g.lots ?? [])], closing_fills: g.closing_fills ? [...g.closing_fills] : g.closing_fills })
        continue
      }
      prev.lots = mergeList([prev.lots ?? [], g.lots ?? []], lotKey)
      if (g.closing_fills?.length) prev.closing_fills = mergeList([prev.closing_fills ?? [], g.closing_fills], fillKey)
      prev.close_price = prev.close_price ?? g.close_price
      prev.statement_reported_total = prev.statement_reported_total ?? g.statement_reported_total
      prev.statement_reported_contracts = prev.statement_reported_contracts ?? g.statement_reported_contracts
      prev.fees = prev.fees ?? g.fees
      prev.close_execution_code = prev.close_execution_code ?? g.close_execution_code
    }
  }

  return {
    statement_date: firstValue(parts, (p) => p.statement_date),
    broker: firstValue(parts, (p) => p.broker ?? null),
    open_positions: mergeList(parts.map((p) => p.open_positions ?? []), openKey),
    closed_groups: [...groups.values()],
    closed_trades: mergeList(parts.map((p) => p.closed_trades ?? [])),
    confirmation_trades: mergeList(
      parts.map((p) => p.confirmation_trades ?? []),
      (t) => `${norm(t.commodity)}|${norm(t.contract_month)}|${norm(t.side)}|${norm(t.trade_date)}|${px(t.trade_price)}|${t.num_contracts ?? ''}|${norm(t.execution_code)}`,
    ),
    open_position_subtotals: mergeList(
      parts.map((p) => p.open_position_subtotals ?? []),
      (s) => `${norm(s.commodity)}|${norm(s.contract_month)}|${norm(s.side)}`,
    ),
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
  // One load per page: a load number repeated on ANOTHER page is a second
  // scan the review collapses (with its page numbers); only the same page
  // seen twice across a chunk boundary is dropped here.
  return {
    loads: mergeList(
      parts.map((p) => p.loads ?? []),
      (l) => (numberKey(l.load_number) ? `${numberKey(l.load_number)}|${l.page ?? ''}` : null),
    ),
  }
}

export function mergeGinReceipts(parts: GinReceiptExtraction[]): GinReceiptExtraction {
  // The statement is reported PAGE BY PAGE (2026-10-11) and the pages are
  // rebased to the whole document before this runs, so the only boundary
  // artifact is the same page returned twice — first wins. Nothing here
  // folds one statement into another: lib/gin-statements groups the pages
  // (totals block / header date / bale rows restarting at 1) afterwards,
  // and a bale repeated in a statement's list is the review's call
  // (pbiReview), never silently dropped.
  const pages = mergeList(
    parts.map((p) => (Array.isArray(p?.pages) ? p.pages : [])),
    (pg) => (pg.page != null && Number.isFinite(Number(pg.page)) ? String(Number(pg.page)) : null),
  )
  return { pages: [...pages].sort((a, b) => Number(a.page ?? 0) - Number(b.page ?? 0)) }
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
    // A sales contract's quality terms can span pages (the clause on page 1,
    // the farm schedule on page 4): merge the object's scalars across chunks
    // and concatenate the schedule rows, deduped on the FSA number.
    const qualityParts = extractedParts
      .map((e) => (e.quality != null && typeof e.quality === 'object' ? (e.quality as Record<string, unknown>) : null))
      .filter((q): q is Record<string, unknown> => q != null)
    if (qualityParts.length > 0) {
      const quality = mergeScalars(qualityParts)
      const farmLists = qualityParts
        .map((q) => (Array.isArray(q.eligible_farms) ? (q.eligible_farms as Array<Record<string, unknown>>) : null))
        .filter((x): x is Array<Record<string, unknown>> => x != null)
      if (farmLists.length > 0) {
        quality.eligible_farms = mergeList(farmLists, (r) => (r.fsa_number == null ? null : String(r.fsa_number).replace(/\D/g, '').replace(/^0+(?=\d)/, '') || null))
      }
      ;(merged as Record<string, unknown>).quality = quality
    }
    extracted = merged as CottonMarketingExtracted
  }
  const confidences = parts.map((p) => p.confidence)
  const confidence: CottonMarketingExtraction['confidence'] =
    confidences.includes('low') ? 'low' : confidences.includes('medium') ? 'medium' : 'high'
  return { document_category: category, confidence, extracted }
}
