'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { coerceAppRole } from '@/lib/app-role'
import { friendlyError } from '@/lib/friendly-error'
import { fetchSalesForContracts, priceLaterContractPayload, type PriceLaterContractInput } from '@/lib/contracts-sales-fetch'
import { applyPriceLaterMove, planPriceLaterPricing, priceLaterPoolId } from '@/lib/virtual-contracts'
import { writeLoadSales } from '@/lib/load-sales'

export type PriceBushelsInput = PriceLaterContractInput & {
  cropId: string
  cropYear: number
  buyerId: string
}

/**
 * "Price bushels" on a price-later pool: create a fully priced, delivered
 * forward contract at the typed price and move the OLDEST bushels of the
 * pool onto it (FIFO by delivery date, the last load split if it does not
 * fit whole). Owners only. Redirects to the new contract on success.
 */
export async function priceBushels(input: PriceBushelsInput): Promise<{ ok: false; error: string }> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Please sign in again to price these bushels.' }
  const { data: profile } = await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
  if (coerceAppRole((profile as { role?: string } | null)?.role) !== 'owner') {
    return { ok: false, error: 'Only the operation owner can price bushels.' }
  }

  // Recompute the pool server-side: the screen may be stale.
  const salesData = await fetchSalesForContracts(supabase, { cropYear: input.cropYear })
  const pool = salesData.pools.find((p) => p.id === priceLaterPoolId(input.cropId, input.cropYear, input.buyerId))
  if (!pool || pool.bushels <= 0) return { ok: false, error: 'There are no unpriced bushels left for this buyer.' }

  const built = priceLaterContractPayload(pool, input, salesData.marketingAgentEntityId)
  if ('error' in built) return { ok: false, error: built.error }

  const { data: created, error: insertErr } = await supabase.from('contracts').insert(built.payload).select('id').single()
  if (insertErr || !created) {
    console.error('[turnrow] price-later contract insert', insertErr)
    return { ok: false, error: friendlyError(insertErr ?? new Error('no row'), { action: 'create the contract', noun: 'contract' }) }
  }
  const contractId = (created as { id: string }).id

  const plan = planPriceLaterPricing(pool, built.bushels, contractId)
  for (const move of plan.moves) {
    const existing = salesData.sales.filter((s) => s.load_id === move.loadId)
    try {
      await writeLoadSales(supabase, move.loadId, applyPriceLaterMove(existing, move))
    } catch (err) {
      console.error('[turnrow] price-later move', move.loadId, err)
      return {
        ok: false,
        error: `${friendlyError(err instanceof Error ? err : String(err), { action: 'move the bushels onto the new contract', noun: 'load' })} The contract was created — open it to check which loads moved.`,
      }
    }
  }

  revalidatePath('/contracts')
  revalidatePath(`/contracts/${contractId}`)
  revalidatePath(`/contracts/price-later/${input.cropId}/${input.cropYear}/${input.buyerId}`)
  revalidatePath('/loads')
  redirect(`/contracts/${contractId}`)
}
