// gin_receipts writes shared by the Gin Receipts list (upload / hand entry)
// and a receipt's own page (edit). The 093 identity columns are stripped and
// the write retried when the database has not been updated yet (the 090
// pattern) — the app tolerates a pre-093 schema.

import type { SupabaseClient } from '@supabase/supabase-js'

export const RECEIPT_093_COLUMNS = ['gin_code', 'statement_number', 'printed_farm_number', 'printed_field', 'farm_ytd_modules', 'farm_ytd_seed_cotton_lbs', 'farm_ytd_bales', 'farm_ytd_bale_weight'] as const

export const isMissingColumn = (error: { message?: string } | null | undefined) => !!error?.message && /column|schema/i.test(error.message)
export const without = (row: Record<string, unknown>, cols: ReadonlyArray<string>) => Object.fromEntries(Object.entries(row).filter(([k]) => !cols.includes(k)))

export async function insertReceipt(supabase: SupabaseClient, header: Record<string, unknown>) {
  const first = await supabase.from('gin_receipts').insert(header).select('id').single()
  if (!first.error || !isMissingColumn(first.error)) return first
  return supabase.from('gin_receipts').insert(without(header, RECEIPT_093_COLUMNS)).select('id').single()
}

export async function updateReceipt(supabase: SupabaseClient, id: string, header: Record<string, unknown>) {
  const first = await supabase.from('gin_receipts').update(header).eq('id', id)
  if (!first.error || !isMissingColumn(first.error)) return first
  return supabase.from('gin_receipts').update(without(header, RECEIPT_093_COLUMNS)).eq('id', id)
}
