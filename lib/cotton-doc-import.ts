// Cotton marketing document import — pure helpers behind the "Upload Marketing
// Document" and "Assign bales from file" flows on /cotton/marketing.
//
//   * parseBaleNumberList: a forgiving reader for bale-number files — a CSV
//     with a PBI/Bale column among others, a single headered column, or a bare
//     pasted list; whitespace, blank lines, and duplicate rows tolerated.
//   * partitionBaleAssignment: matches a PBI list against cotton_bales and
//     splits it into matched (assignable), conflicts (blocked, with the
//     reason — honoring the loan⊕LDP mutual exclusion and disposition state),
//     and unmatched numbers (returned verbatim for the user to chase).
//
// No I/O — the page passes already-fetched rows in, mirroring lib/cotton-sales.

import type { CottonDisposition } from '@/lib/types'

// ---------- AI extraction categories & shapes ----------

export const COTTON_MARKETING_CATEGORIES = [
  'sales_contract', 'pool_payment', 'ccc_loan', 'ldp_notice', 'equity_sale', 'storage_invoice', 'bale_list',
] as const
export type CottonMarketingCategory = (typeof COTTON_MARKETING_CATEGORIES)[number]

export const COTTON_MARKETING_CATEGORY_LABEL: Record<CottonMarketingCategory, string> = {
  sales_contract: 'Sales contract',
  pool_payment: 'Pool payment notice',
  ccc_loan: 'CCC loan document',
  ldp_notice: 'LDP notice',
  equity_sale: 'Equity sale confirmation',
  storage_invoice: 'Warehouse / storage invoice',
  bale_list: 'Bale number list',
}

export type CottonContractExtract = {
  contract_type: 'spot' | 'fixed_price' | 'on_call' | 'pool' | null
  buyer: string | null
  contract_number: string | null
  contract_date: string | null
  crop_year: number | null
  committed_bales: number | null
  committed_acres: number | null
  price_cents_per_lb: number | null
  basis_cents: number | null
  futures_month: string | null
  delivery_start: string | null
  delivery_end: string | null
  notes: string | null
}
export type CottonPoolPaymentExtract = {
  buyer: string | null
  contract_number: string | null
  payment_type: 'initial_advance' | 'progress' | 'final_settlement' | null
  amount: number | null
  cents_per_lb_equivalent: number | null
  payment_date: string | null
  crop_year: number | null
}
export type CccLoanExtract = {
  loan_number: string | null
  entry_date: string | null
  maturity_date: string | null
  loan_rate_base_cents: number | null
  principal_total: number | null
  crop_year: number | null
  bale_pbis: string[]
}
export type LdpNoticeExtract = {
  ldp_date: string | null
  awp_cents: number | null
  ldp_rate_cents: number | null
  total_payment: number | null
  crop_year: number | null
  bale_pbis: string[]
}
export type EquitySaleExtract = {
  loan_number: string | null
  buyer: string | null
  equity_cents_per_lb: number | null
  equity_total: number | null
  sale_date: string | null
  crop_year: number | null
}
export type StorageInvoiceExtract = {
  invoice_number: string | null
  fee_type: 'warehouse_receiving' | 'storage_monthly' | 'classing' | 'checkoff' | 'loan_interest' | 'loan_servicing' | 'pool_deduction' | 'merchant_fee' | 'other' | null
  amount_total: number | null
  fee_date: string | null
  bales_count: number | null
  loan_number: string | null
  notes: string | null
  crop_year: number | null
}
export type BaleListExtract = { bale_pbis: string[] }

export type CottonMarketingExtracted =
  | CottonContractExtract | CottonPoolPaymentExtract | CccLoanExtract
  | LdpNoticeExtract | EquitySaleExtract | StorageInvoiceExtract | BaleListExtract

export type CottonMarketingExtraction = {
  document_category: CottonMarketingCategory | null
  confidence: 'high' | 'medium' | 'low'
  extracted: CottonMarketingExtracted | null
}

// ---------- PBI normalization ----------

// Bale/PBI numbers match on digits with leading zeros ignored — the same rule
// the classing-CSV import uses (lib/cotton-grades.ts). "PBI# 0123456" → "123456".
export function normalizePbi(raw: string): string {
  return raw.replace(/\D/g, '').replace(/^0+/, '')
}

// A token counts as a bale number when its digit content is at least 4 long —
// long enough to skip row indices, bale counts, and weights-in-lbs columns.
const MIN_PBI_DIGITS = 4
const isPbiToken = (t: string) => normalizePbi(t).length >= MIN_PBI_DIGITS

// ---------- bale-number file parsing ----------

export type ParsedBaleList = {
  /** Unique bale numbers in file order: raw token as it appeared + normalized PBI. */
  entries: Array<{ raw: string; pbi: string }>
  /** Rows dropped as duplicates of an earlier entry. */
  duplicateCount: number
  /** True when a PBI/Bale column header was found and used. */
  usedHeaderColumn: boolean
}

function splitLine(line: string): string[] {
  // Delimited first (CSV/TSV); a bare line splits on whitespace.
  const cells = /[,;\t]/.test(line) ? line.split(/[,;\t]/) : line.split(/\s+/)
  return cells.map((c) => c.trim().replace(/^"|"$/g, '').trim()).filter((c) => c !== '')
}

export function parseBaleNumberList(text: string): ParsedBaleList {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  const rows = lines.map(splitLine).filter((r) => r.length > 0)
  if (rows.length === 0) return { entries: [], duplicateCount: 0, usedHeaderColumn: false }

  // Header-column mode: the first row carries a cell naming the PBI/bale
  // column ("PBI", "Bale #", "Bale Number", …) — read that column only, so a
  // recap sheet with weights/grades alongside never picks up the wrong field.
  const header = rows[0]
  // Prefer an explicit PBI header; else a "Bale …" header that isn't a
  // weight column ("Bale Wt" / "Bale Lbs" must never win).
  const pbiExact = header.findIndex((c) => /pbi/i.test(c))
  const baleCol = header.findIndex((c) => /\bbale\b/i.test(c) && !/w(eigh)?t|lbs?\b/i.test(c))
  const pbiCol = pbiExact >= 0 ? pbiExact : baleCol
  const usedHeaderColumn = pbiCol >= 0 && !isPbiToken(header[pbiCol])

  let rawTokens: string[]
  if (usedHeaderColumn) {
    rawTokens = rows.slice(1).map((r) => r[pbiCol] ?? '').filter((t) => isPbiToken(t))
  } else {
    // Bare-list mode: every numeric-enough token anywhere in the file. Header
    // words without digits fall out naturally.
    rawTokens = rows.flat().filter((t) => isPbiToken(t))
  }

  const seen = new Set<string>()
  const entries: Array<{ raw: string; pbi: string }> = []
  let duplicateCount = 0
  for (const raw of rawTokens) {
    const pbi = normalizePbi(raw)
    if (pbi === '') continue
    if (seen.has(pbi)) { duplicateCount++; continue }
    seen.add(pbi)
    entries.push({ raw, pbi })
  }
  return { entries, duplicateCount, usedHeaderColumn }
}

// ---------- match / conflict / unmatched partition ----------

export type AssignTarget = 'loan' | 'ldp' | 'contract'

export type BaleForAssign = { id: string; pbi_number: string; net_weight_lbs: number | string }

export type BalePartitionInput = {
  /** Raw bale-number tokens (from parseBaleNumberList entries or AI extraction). */
  tokens: ReadonlyArray<string>
  bales: ReadonlyArray<BaleForAssign>
  /** Current disposition per bale id; a missing entry means 'held'. */
  dispositionByBale: ReadonlyMap<string, CottonDisposition>
  /** Bales that are (or ever were) on a CCC loan — junction rows are permanent. */
  loanedBaleIds: ReadonlySet<string>
  /** Bales that took an LDP. */
  ldpBaleIds: ReadonlySet<string>
  target: AssignTarget
}

export type BaleMatch = { baleId: string; pbi: string; lbs: number; disposition: CottonDisposition }
export type BaleConflict = BaleMatch & { reason: string }

export type BalePartition = {
  matched: BaleMatch[]
  conflicts: BaleConflict[]
  /** Numbers with no bale on file, verbatim as they appeared in the file. */
  unmatched: string[]
  matchedLbs: number
  matchedCount: number
}

const DISPOSITION_CONFLICT_REASON: Partial<Record<CottonDisposition, string>> = {
  sold_spot: 'already sold (spot)',
  contract_delivery: 'already delivered on a contract',
  pool: 'already committed to a pool',
  ccc_loan: 'currently in a CCC loan',
}

// The blocking reason for one bale, or null when it is clean for the target.
// Mirrors the page's manual bale picker and the 044 DB triggers: loan and LDP
// are mutually exclusive for life (junction rows are permanent, unique per
// bale), and only held bales are assignable.
export function baleConflictReason(args: {
  disposition: CottonDisposition
  everLoaned: boolean
  tookLdp: boolean
  target: AssignTarget
}): string | null {
  const { disposition, everLoaned, tookLdp, target } = args
  if (target === 'loan') {
    if (everLoaned) return 'already pledged to a CCC loan (a bale can only be pledged once)'
    if (tookLdp) return 'took an LDP — loan-ineligible'
  }
  if (target === 'ldp') {
    if (everLoaned) return 'is (or was) on a CCC loan — LDP-ineligible'
    if (tookLdp) return 'already took an LDP'
  }
  // All targets need the bale to be held right now (an LDP does not change
  // disposition, so LDP'd bales can still be sold/delivered).
  if (disposition !== 'held') return DISPOSITION_CONFLICT_REASON[disposition] ?? `not held (${disposition})`
  return null
}

export function partitionBaleAssignment(inp: BalePartitionInput): BalePartition {
  const baleByPbi = new Map<string, BaleForAssign>()
  for (const b of inp.bales) {
    const key = normalizePbi(String(b.pbi_number ?? ''))
    if (key !== '') baleByPbi.set(key, b)
  }

  const seen = new Set<string>()
  const matched: BaleMatch[] = []
  const conflicts: BaleConflict[] = []
  const unmatched: string[] = []
  for (const raw of inp.tokens) {
    const pbi = normalizePbi(raw)
    if (pbi === '' || seen.has(pbi)) continue // blank / duplicate rows fold away
    seen.add(pbi)
    const bale = baleByPbi.get(pbi)
    if (!bale) { unmatched.push(raw); continue }
    const disposition = inp.dispositionByBale.get(bale.id) ?? 'held'
    const row: BaleMatch = { baleId: bale.id, pbi, lbs: Number(bale.net_weight_lbs ?? 0), disposition }
    const reason = baleConflictReason({
      disposition,
      everLoaned: inp.loanedBaleIds.has(bale.id),
      tookLdp: inp.ldpBaleIds.has(bale.id),
      target: inp.target,
    })
    if (reason) conflicts.push({ ...row, reason })
    else matched.push(row)
  }
  return {
    matched,
    conflicts,
    unmatched,
    matchedLbs: matched.reduce((s, m) => s + m.lbs, 0),
    matchedCount: matched.length,
  }
}
