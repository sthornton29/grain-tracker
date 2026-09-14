// Shared fetch helpers for the data assistant's curated tools — used by
// lib/assistant-tools.ts (the original tools) and lib/assistant-tools-
// modules.ts (cotton, seed, settlements, bins, combine, rent, budget).
// Every read goes through the caller's SESSION client so RLS applies.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'

export async function all<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return ((data as unknown) as T[]) ?? []
}

/** Paginated read of a FILTERED/ordered query — throws on error like all().
 *  The loop (lib/fetch-all-rows) is cap-agnostic and id-ordered builders keep
 *  page boundaries stable. */
export async function allRows<T>(build: Parameters<typeof fetchAllRows>[0]): Promise<T[]> {
  const { data, error } = await fetchAllRows<T>(build)
  if (error) throw new Error(error.message)
  return data
}

/** Paginated full-table read (the project caps rows per request). Ordered by
 *  id so page boundaries are stable — unordered ranges can skip/double rows. */
export async function allPaged<T>(supabase: SupabaseClient, table: string, select: string): Promise<T[]> {
  return allRows<T>((f, t) => supabase.from(table).select(select).order('id').range(f, t))
}

// The combine-entry columns every report page fetches (CombineEntryLike).
export const COMBINE_SELECT = 'id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date'
export type CombineRow = {
  id: string; field_id: string; crop_id: string; crop_year: number
  stated_total_bushels: number; adjusted_total_bushels: number
  adjustment_bu_per_acre: number | null; destination_bin_id: string | null
  harvest_complete: boolean; entry_date: string
}

export const num = (v: unknown) => Number(v) || 0
export const r0 = (v: number) => Math.round(v)
export const r2 = (v: number) => Math.round(v * 100) / 100

export type ScopeBits = {
  entities: Array<{ id: string; name: string; entity_role: string | null }>
  farms: Array<{ id: string; name: string; entity_id: string | null; landowner_id: string | null }>
  fields: Array<{ id: string; farm_id: string | null; name_or_number: string }>
}

export async function fetchScopeBits(supabase: SupabaseClient): Promise<ScopeBits> {
  const [entities, farms, fields] = await Promise.all([
    all<ScopeBits['entities'][number]>(supabase.from('entities').select('id, name, entity_role').order('name')),
    all<ScopeBits['farms'][number]>(supabase.from('farms').select('id, name, entity_id, landowner_id')),
    all<ScopeBits['fields'][number]>(supabase.from('fields').select('id, farm_id, name_or_number')),
  ])
  return { entities, farms, fields }
}

/** Exact then substring match on a name, case-insensitive. */
export function resolveByName<T extends { id: string; name: string }>(rows: T[], name: string | undefined): T | null {
  if (!name?.trim()) return null
  const norm = name.trim().toLowerCase()
  return rows.find((r) => r.name.trim().toLowerCase() === norm) ?? rows.find((r) => r.name.trim().toLowerCase().includes(norm)) ?? null
}

export const nameOf = <T extends { id: string; name: string }>(rows: readonly T[]) => {
  const m = new Map(rows.map((r) => [r.id, r.name]))
  return (id: string | null | undefined) => (id ? m.get(id) ?? null : null)
}
