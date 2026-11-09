// The reads the ops API is built from (2026-11-08): crops, loads with their
// dry bushels (lib/contract-progress loadDryBushels, the bases every page
// uses), the 094 sale allocations (lib/load-sales), which loads a settlement
// has paid, and contracts with delivered bushels. Service role: every query
// scopes .eq('org_id', orgId).

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { loadDryBushels, type CropBases } from '@/lib/contract-progress'
import { fetchLoadSales, saleAllocations, type LoadSale, type SaleAllocation } from '@/lib/load-sales'

export type Crop = CropBases & { id: string; name: string; harvest_category: string | null }
export type Load = {
  id: string; date: string | null; crop_id: string | null; crop_year: number | null
  net_weight: number | null; moisture: number | null; dry_bushels_override: number | null
  from_type: 'field' | 'bin' | null; from_field_id: string | null; from_bin_id: string | null
  to_type: 'bin' | 'buyer' | null; to_bin_id: string | null; to_buyer_id: string | null
  contract_id: string | null; ticket_number: string | null; buyer_ticket_number: string | null
  dryBu: number
}
export type Contract = {
  id: string; contract_number: string | null; buyer_id: string | null; crop_id: string | null; entity_id: string | null
  crop_year: number | null; contracted_bushels: number | null; price_per_bushel: number | null; cash_price: number | null
  futures_price: number | null; basis: number | null; contract_type: string | null; pricing_status: string | null
  delivery_start_date: string | null; delivery_end_date: string | null; completed_at: string | null; contract_month: string | null
  contract_kind: string | null
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await fetchAllRows<T>(build)
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

/** The harvest year in progress (America/Chicago calendar year). */
export function seasonYear(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(now))
}
export function isoDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now)
}

export async function names(sb: SupabaseClient, orgId: string, table: 'buyers' | 'entities' | 'gins', col = 'name'): Promise<Map<string, string>> {
  const rows = await all<Record<string, string>>((f, t) => sb.from(table).select(`id, ${col}`).eq('org_id', orgId).order('id').range(f, t), table)
  return new Map(rows.map((r) => [r.id, r[col]]))
}

export async function loadCrops(sb: SupabaseClient, orgId: string): Promise<Map<string, Crop>> {
  const rows = await all<Crop>((f, t) => sb.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel, harvest_category').eq('org_id', orgId).order('id').range(f, t), 'crops')
  return new Map(rows.map((c) => [c.id, { ...c, base_moisture_pct: num(c.base_moisture_pct), base_lb_per_bushel: num(c.base_lb_per_bushel) }]))
}

const LOAD_COLS = 'id, date, crop_id, crop_year, net_weight, moisture, dry_bushels_override, from_type, from_field_id, from_bin_id, to_type, to_bin_id, to_buyer_id, contract_id, ticket_number, buyer_ticket_number'

export async function loadLoads(sb: SupabaseClient, orgId: string, years: number[], crops: Map<string, Crop>): Promise<Load[]> {
  const rows = await all<Omit<Load, 'dryBu'>>((f, t) => sb.from('loads').select(LOAD_COLS).eq('org_id', orgId).in('crop_year', years).order('id').range(f, t), 'loads')
  return rows.map((l) => {
    const n = { ...l, net_weight: num(l.net_weight), moisture: num(l.moisture), dry_bushels_override: num(l.dry_bushels_override) }
    return { ...n, dryBu: loadDryBushels(n, crops) ?? 0 }
  })
}

export async function loadSales(sb: SupabaseClient, orgId: string, loads: Load[]): Promise<{ sales: LoadSale[]; allocs: Map<string, SaleAllocation[]> }> {
  const sales = await fetchLoadSales(sb, { orgId, loadIds: loads.map((l) => l.id) })
  return { sales, allocs: saleAllocations(loads, sales) }
}

/** Loads a buyer's settlement has paid (a settlement line points at them). */
export async function paidLoadIds(sb: SupabaseClient, orgId: string): Promise<Set<string>> {
  const rows = await all<{ load_id: string | null }>((f, t) => sb.from('settlement_lines').select('id, load_id').eq('org_id', orgId).not('load_id', 'is', null).order('id').range(f, t), 'settlement_lines')
  return new Set(rows.map((r) => r.load_id!).filter(Boolean))
}

const CONTRACT_COLS = 'id, contract_number, buyer_id, crop_id, entity_id, crop_year, contracted_bushels, price_per_bushel, cash_price, futures_price, basis, contract_type, pricing_status, delivery_start_date, delivery_end_date, completed_at, contract_month, contract_kind'

export async function loadContracts(sb: SupabaseClient, orgId: string, years: number[]): Promise<Contract[]> {
  const rows = await all<Contract>((f, t) => sb.from('contracts').select(CONTRACT_COLS).eq('org_id', orgId).in('crop_year', years).order('id').range(f, t), 'contracts')
  return rows.map((c) => ({ ...c, contracted_bushels: num(c.contracted_bushels), price_per_bushel: num(c.price_per_bushel), cash_price: num(c.cash_price), futures_price: num(c.futures_price), basis: num(c.basis) }))
}

/** Delivered dry bushels per contract from the allocations. */
export function deliveredByContract(allocs: Map<string, SaleAllocation[]>): Map<string, number> {
  const out = new Map<string, number>()
  for (const list of allocs.values()) for (const a of list) if (a.saleType === 'contract' && a.contractId) out.set(a.contractId, (out.get(a.contractId) ?? 0) + a.bushels)
  return out
}

export const r0 = (n: number) => Math.round(n)
export const fmtBu = (n: number) => `${Math.round(n).toLocaleString('en-US')} bu`
