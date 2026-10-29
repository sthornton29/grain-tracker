// The one client-side fetch for the 0099 tables every government-payment
// consumer needs (the Tracker, Cash Flow, Revenue Projections, Income
// Sensitivity): program-year payees, FSA payment statements, their lines
// and crop amounts — all paged (lib/fetch-all-rows), so a decade of
// statements never silently truncates. A database before 0099 answers with
// an error per table; that reads as "none" so every page keeps working.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import type { FarmProgramPayee, FsaPaymentCropAmount, FsaPaymentLine, FsaPaymentStatement } from '@/lib/types'

export type GovernmentActuals = {
  payees: FarmProgramPayee[]
  statements: FsaPaymentStatement[]
  lines: FsaPaymentLine[]
  cropAmounts: FsaPaymentCropAmount[]
}

export const EMPTY_GOVERNMENT_ACTUALS: GovernmentActuals = { payees: [], statements: [], lines: [], cropAmounts: [] }

export async function fetchGovernmentActuals(supabase: SupabaseClient): Promise<GovernmentActuals> {
  const safe = async <T,>(p: Promise<{ data: unknown; error: unknown }>): Promise<T[]> => {
    try {
      const { data, error } = await p
      if (error) return []
      return (data as T[]) ?? []
    } catch {
      return []
    }
  }
  const [payees, statements, lines, cropAmounts] = await Promise.all([
    safe<FarmProgramPayee>(fetchAllRows((f, t) => supabase.from('farm_program_payees').select('*').order('id').range(f, t))),
    safe<FsaPaymentStatement>(fetchAllRows((f, t) => supabase.from('fsa_payment_statements').select('*').order('statement_date', { ascending: false }).order('id').range(f, t))),
    safe<FsaPaymentLine>(fetchAllRows((f, t) => supabase.from('fsa_payment_lines').select('*').order('id').range(f, t))),
    safe<FsaPaymentCropAmount>(fetchAllRows((f, t) => supabase.from('fsa_payment_crop_amounts').select('*').order('id').range(f, t))),
  ])
  return { payees, statements, lines, cropAmounts }
}
