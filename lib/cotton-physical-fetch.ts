// Shared client-side fetch for the physical-cotton-marketing tables (044) —
// used by the Marketing dashboard, Revenue Projections, Cash Flow, Income
// Sensitivity, and the Cotton Marketing page so they all see the same inputs.
// Tolerates the 044 tables not existing yet (returns empty inputs — every
// consumer then behaves exactly as before the feature).

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCottonPhysicalSummary, type CottonPhysicalInputs, type CottonPhysicalSummary } from '@/lib/cotton-sales'
import type {
  CccLoan, CottonBale, CottonBaleDisposition, CottonBaleGrade, CottonFee,
  CottonLdpRecord, CottonPoolPayment, CottonSalesContract,
} from '@/lib/types'

export type CottonPhysicalData = {
  inputs: CottonPhysicalInputs
  summary: CottonPhysicalSummary
  /** True when ANY marketing row exists (contracts/loans/LDPs/fees) — pages can
   *  skip cotton-marketing UI entirely when false. */
  hasData: boolean
}

export async function fetchCottonPhysical(
  supabase: SupabaseClient,
  cropYear: number,
  // Service-role callers (the partner API) bypass RLS and MUST pass their org;
  // session-client callers omit it and rely on the 054 policies as before.
  opts?: { orgId?: string },
): Promise<CottonPhysicalData> {
  const orgId = opts?.orgId
  // The dynamic select string defeats supabase's literal-type parsing, so the
  // builder is typed loosely here; every result is cast at its use site, as
  // this module always has.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string, select: string): any => {
    const q = supabase.from(table).select(select)
    return orgId ? q.eq('org_id', orgId) : q
  }
  const [balesQ, gradesQ, dispQ, contractsQ, poolQ, loansQ, loanBalesQ, ldpsQ, ldpBalesQ, feesQ] = await Promise.all([
    from('cotton_bales', 'id, gin_receipt_id, crop_year, pbi_number, net_weight_lbs, created_at').eq('crop_year', cropYear),
    from('cotton_bale_grades', 'bale_id, loan_value_cents_per_lb, loan_value_total, class_date'),
    from('cotton_bale_dispositions', '*'),
    from('cotton_sales_contracts', '*').eq('crop_year', cropYear),
    from('cotton_pool_payments', '*'),
    from('ccc_loans', '*').eq('crop_year', cropYear),
    from('ccc_loan_bales', 'loan_id, bale_id'),
    from('cotton_ldp_records', '*').eq('crop_year', cropYear),
    from('cotton_ldp_bales', 'ldp_id, bale_id'),
    from('cotton_fees', '*').eq('crop_year', cropYear),
  ])

  const bales = ((balesQ.data as CottonBale[]) || [])
  const baleIds = new Set(bales.map((b) => b.id))
  const gradesByBale = new Map(
    (((gradesQ.data as unknown) as CottonBaleGrade[]) || [])
      .filter((g) => baleIds.has(g.bale_id))
      .map((g) => [g.bale_id, g] as const),
  )
  const contracts = ((contractsQ.data as CottonSalesContract[]) || [])
  const contractIds = new Set(contracts.map((c) => c.id))
  const loans = ((loansQ.data as CccLoan[]) || [])
  const loanIds = new Set(loans.map((l) => l.id))

  const inputs: CottonPhysicalInputs = {
    cropYear,
    bales,
    gradesByBale,
    dispositions: (((dispQ.data as unknown) as CottonBaleDisposition[]) || []).filter((d) => baleIds.has(d.bale_id)),
    contracts,
    poolPayments: (((poolQ.data as unknown) as CottonPoolPayment[]) || []).filter((p) => contractIds.has(p.contract_id)),
    loans,
    loanBales: (((loanBalesQ.data as unknown) as Array<{ loan_id: string; bale_id: string }>) || []).filter((lb) => loanIds.has(lb.loan_id)),
    ldps: ((ldpsQ.data as CottonLdpRecord[]) || []),
    fees: ((feesQ.data as CottonFee[]) || []),
  }
  void ldpBalesQ // per-bale LDP links are consumed by the Cotton Marketing page directly

  const summary = buildCottonPhysicalSummary(inputs)
  const hasData =
    inputs.contracts.length > 0 || inputs.loans.length > 0 || inputs.ldps.length > 0 || inputs.fees.length > 0
  return { inputs, summary, hasData }
}
