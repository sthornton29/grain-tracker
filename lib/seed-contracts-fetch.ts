// Shared client-side fetch for the seed-production-contract tables (077) —
// used by the Marketing dashboard, Revenue Projections, Income Sensitivity,
// Cash Flow, and the Contract Tracker so they all see the same inputs.
// Tolerates the 077 tables not existing yet (returns an empty bundle list —
// every consumer then behaves exactly as before the feature).

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  SeedContractBundle, SeedContractDetails, SeedContractPayment,
  SeedContractPremium, SeedPricingElection,
} from '@/lib/seed-contracts'
import type { Contract } from '@/lib/types'

export type SeedContractData = {
  bundles: SeedContractBundle[]
  /** True when any seed contract exists for the crop year. */
  hasData: boolean
}

export async function fetchSeedContracts(
  supabase: SupabaseClient,
  cropYear: number,
  // Service-role callers bypass RLS and MUST pass their org; session-client
  // callers omit it and rely on the 054 policies as usual.
  opts?: { orgId?: string; contracts?: readonly Contract[] },
): Promise<SeedContractData> {
  const orgId = opts?.orgId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string, select: string): any => {
    const q = supabase.from(table).select(select)
    return orgId ? q.eq('org_id', orgId) : q
  }

  // Seed contracts for the year — reuse the caller's contracts fetch when it
  // already has one (the reports all fetch contracts anyway).
  let seedContracts: Contract[]
  if (opts?.contracts) {
    seedContracts = opts.contracts.filter(
      (c) => (c.contract_kind ?? 'grain') === 'seed_production' && c.crop_year === cropYear,
    )
  } else {
    const q = await from('contracts', '*').eq('crop_year', cropYear).eq('contract_kind', 'seed_production')
    seedContracts = (q.data as Contract[]) || []
  }
  if (seedContracts.length === 0) return { bundles: [], hasData: false }

  const ids = seedContracts.map((c) => c.id)
  const [detailsQ, premiumsQ, electionsQ, paymentsQ, plantingsQ] = await Promise.all([
    from('seed_contract_details', '*').in('contract_id', ids),
    from('seed_contract_premiums', '*').in('contract_id', ids).order('sort_order'),
    from('seed_pricing_elections', '*').in('contract_id', ids).order('election_date'),
    from('seed_contract_payments', '*').in('contract_id', ids).order('payment_date'),
    from('seed_contract_plantings', 'contract_id, planting_id').in('contract_id', ids),
  ])

  const detailsBy = new Map(
    (((detailsQ.data as unknown) as SeedContractDetails[]) || []).map((d) => [d.contract_id, d] as const),
  )
  const premiums = ((premiumsQ.data as unknown) as SeedContractPremium[]) || []
  const elections = ((electionsQ.data as unknown) as SeedPricingElection[]) || []
  const payments = ((paymentsQ.data as unknown) as SeedContractPayment[]) || []
  const junctions = ((plantingsQ.data as unknown) as Array<{ contract_id: string; planting_id: string }>) || []

  const bundles: SeedContractBundle[] = []
  for (const c of seedContracts) {
    const details = detailsBy.get(c.id)
    if (!details) continue // a seed contract without its details row is unusable
    bundles.push({
      contract: {
        id: c.id,
        buyer_id: c.buyer_id,
        crop_id: c.crop_id,
        crop_year: c.crop_year,
        entity_id: c.entity_id,
        contract_number: c.contract_number,
      },
      details,
      premiums: premiums.filter((p) => p.contract_id === c.id),
      elections: elections.filter((e) => e.contract_id === c.id),
      payments: payments.filter((p) => p.contract_id === c.id),
      plantingIds: junctions.filter((j) => j.contract_id === c.id).map((j) => j.planting_id),
    })
  }
  return { bundles, hasData: bundles.length > 0 }
}
