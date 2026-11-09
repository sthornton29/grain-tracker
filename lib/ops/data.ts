// GET /api/ops/data (2026-11-08): the curated datasets an agent may read
// from Turnrow Grain, each the figures the pages show (turnrow-farm
// docs/OPS_API.md). Read only; service role scoped .eq('org_id', orgId).

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { APP, url } from './context'
import { deliveredByContract, loadContracts, loadCrops, loadLoads, loadSales, names, paidLoadIds, seasonYear } from './grain'

export type Param = { name: string; type: 'integer' | 'string' | 'date'; required: boolean; description: string }
export type Dataset = { name: string; description: string; params: Param[] }
export type DataResult = { app: string; dataset: string; as_of: string; columns: string[]; rows: Array<Array<string | number | boolean | null>>; total: number; truncated: boolean; url: string | null }
type Args = Record<string, string | undefined>
type Ctx = { sb: SupabaseClient; orgId: string; now: Date }
type Out = { columns: string[]; rows: DataResult['rows']; url: string | null }

export const MAX_ROWS = 500
export class BadParam extends Error {}

const cropYearParam: Param = { name: 'crop_year', type: 'integer', required: false, description: 'The crop year; default the harvest year in progress' }
const cropParam: Param = { name: 'crop', type: 'string', required: false, description: 'A crop name, e.g. corn, soybeans, wheat, cotton' }

function yearOf(args: Args, now: Date): number {
  if (args.crop_year === undefined || args.crop_year === '') return seasonYear(now)
  const y = Number(args.crop_year)
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new BadParam('crop_year is a year such as 2026.')
  return y
}
function dateOf(v: string | undefined, name: string): string | null {
  if (!v) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadParam(`${name} is a date as YYYY-MM-DD.`)
  return v
}
const r0 = (n: number) => Math.round(n)
const r2 = (n: number) => Math.round(n * 100) / 100

async function cropFilter(ctx: Ctx, crop: string | undefined) {
  const crops = await loadCrops(ctx.sb, ctx.orgId)
  const want = (crop ?? '').trim().toLowerCase()
  const match = want ? [...crops.values()].filter((c) => c.name.toLowerCase().includes(want.replace(/s$/, ''))) : null
  if (want && !match?.length) throw new BadParam(`No crop matches "${crop}". Crops: ${[...crops.values()].map((c) => c.name).join(', ')}.`)
  return { crops, ok: (id: string | null) => !match || match.some((c) => c.id === id) }
}

async function positions(ctx: Ctx, args: Args): Promise<Out> {
  const year = yearOf(args, ctx.now)
  const { crops, ok } = await cropFilter(ctx, args.crop)
  const loads = (await loadLoads(ctx.sb, ctx.orgId, [year], crops)).filter((l) => ok(l.crop_id))
  const { allocs } = await loadSales(ctx.sb, ctx.orgId, loads)
  const contracts = (await loadContracts(ctx.sb, ctx.orgId, [year])).filter((c) => ok(c.crop_id) && c.contract_kind !== 'seed')
  type Row = { harvested: number; toBins: number; delivered: number; contract: number; spot: number; priceLater: number; unassigned: number; contracted: number }
  const by = new Map<string, Row>()
  const row = (id: string | null) => { const k = id ?? ''; let r = by.get(k); if (!r) { r = { harvested: 0, toBins: 0, delivered: 0, contract: 0, spot: 0, priceLater: 0, unassigned: 0, contracted: 0 }; by.set(k, r) } return r }
  for (const l of loads) {
    const r = row(l.crop_id)
    if (l.from_type === 'field') r.harvested += l.dryBu
    if (l.from_type === 'field' && l.to_type === 'bin') r.toBins += l.dryBu
    if (l.to_type === 'buyer') {
      r.delivered += l.dryBu
      const a = allocs.get(l.id) ?? []
      if (!a.length) r.unassigned += l.dryBu
      for (const x of a) { if (x.saleType === 'contract') r.contract += x.bushels; else if (x.saleType === 'spot') r.spot += x.bushels; else r.priceLater += x.bushels }
    }
  }
  for (const c of contracts) row(c.crop_id).contracted += c.contracted_bushels ?? 0
  return {
    columns: ['crop', 'crop_year', 'harvested_bu', 'harvested_into_bins_bu', 'delivered_to_buyers_bu', 'on_contracts_bu', 'spot_bu', 'price_later_bu', 'no_sale_type_bu', 'contracted_bu', 'contracted_not_delivered_bu'],
    rows: [...by.entries()].map(([id, r]) => [crops.get(id)?.name ?? '?', year, r0(r.harvested), r0(r.toBins), r0(r.delivered), r0(r.contract), r0(r.spot), r0(r.priceLater), r0(r.unassigned), r0(r.contracted), r0(Math.max(0, r.contracted - r.contract))]),
    url: url('/reports/marketing'),
  }
}

async function contractsDs(ctx: Ctx, args: Args): Promise<Out> {
  const year = yearOf(args, ctx.now)
  const status = (args.status ?? 'open').toLowerCase()
  if (!['open', 'all'].includes(status)) throw new BadParam('status is open or all.')
  const { crops, ok } = await cropFilter(ctx, args.crop)
  const [buyers, entities] = await Promise.all([names(ctx.sb, ctx.orgId, 'buyers'), names(ctx.sb, ctx.orgId, 'entities')])
  const contracts = (await loadContracts(ctx.sb, ctx.orgId, [year])).filter((c) => ok(c.crop_id) && (status === 'all' || !c.completed_at))
  const loads = await loadLoads(ctx.sb, ctx.orgId, [year, year + 1], crops)
  const delivered = deliveredByContract((await loadSales(ctx.sb, ctx.orgId, loads)).allocs)
  return {
    columns: ['contract_number', 'buyer', 'entity', 'crop', 'crop_year', 'kind', 'type', 'pricing_status', 'contracted_bu', 'delivered_bu', 'left_bu', 'price_per_bu', 'futures', 'basis', 'contract_month', 'delivery_start', 'delivery_end', 'completed', 'link'],
    rows: contracts.map((c) => { const d = delivered.get(c.id) ?? 0; return [c.contract_number, buyers.get(c.buyer_id ?? '') ?? null, entities.get(c.entity_id ?? '') ?? null, crops.get(c.crop_id ?? '')?.name ?? null, c.crop_year, c.contract_kind, c.contract_type, c.pricing_status, r0(c.contracted_bushels ?? 0), r0(d), r0((c.contracted_bushels ?? 0) - d), c.price_per_bushel ?? c.cash_price, c.futures_price, c.basis, c.contract_month, c.delivery_start_date, c.delivery_end_date, !!c.completed_at, url(`/contracts/${c.id}`)] }),
    url: url('/contracts'),
  }
}

async function loadsDs(ctx: Ctx, args: Args, onlyUnpaid = false): Promise<Out> {
  const year = yearOf(args, ctx.now)
  const since = dateOf(args.since, 'since')
  const { crops, ok } = await cropFilter(ctx, args.crop)
  const [buyers] = await Promise.all([names(ctx.sb, ctx.orgId, 'buyers')])
  let loads = (await loadLoads(ctx.sb, ctx.orgId, [year], crops)).filter((l) => ok(l.crop_id) && (!since || (l.date ?? '') >= since))
  const paid = await paidLoadIds(ctx.sb, ctx.orgId)
  if (onlyUnpaid) loads = loads.filter((l) => l.to_type === 'buyer' && !paid.has(l.id))
  const { allocs } = await loadSales(ctx.sb, ctx.orgId, loads)
  const [fields, bins] = await Promise.all([
    fetchAllRows<{ id: string; name_or_number: string }>((f, t) => ctx.sb.from('fields').select('id, name_or_number').eq('org_id', ctx.orgId).order('id').range(f, t)),
    fetchAllRows<{ id: string; name_or_number: string }>((f, t) => ctx.sb.from('bins').select('id, name_or_number').eq('org_id', ctx.orgId).order('id').range(f, t)),
  ])
  const field = new Map(fields.data.map((f) => [f.id, f.name_or_number]))
  const bin = new Map(bins.data.map((b) => [b.id, b.name_or_number]))
  loads.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return {
    columns: ['date', 'ticket', 'buyer_ticket', 'crop', 'crop_year', 'from', 'to', 'dry_bu', 'sale', 'paid_on_settlement', 'link'],
    rows: loads.map((l) => {
      const from = l.from_type === 'field' ? `field ${field.get(l.from_field_id ?? '') ?? '?'}` : `bin ${bin.get(l.from_bin_id ?? '') ?? '?'}`
      const to = l.to_type === 'buyer' ? buyers.get(l.to_buyer_id ?? '') ?? 'buyer' : `bin ${bin.get(l.to_bin_id ?? '') ?? '?'}`
      const a = allocs.get(l.id) ?? []
      const sale = l.to_type !== 'buyer' ? null : a.length ? [...new Set(a.map((x) => x.saleType.replace('_', ' ')))].join(' + ') : 'no sale type'
      return [l.date, l.ticket_number, l.buyer_ticket_number, crops.get(l.crop_id ?? '')?.name ?? null, l.crop_year, from, to, r0(l.dryBu), sale, l.to_type === 'buyer' ? paid.has(l.id) : null, url(`/loads/${l.id}`)]
    }),
    url: url(onlyUnpaid ? '/loads/unpaid' : '/loads'),
  }
}

async function settlementsDs(ctx: Ctx, args: Args): Promise<Out> {
  const since = dateOf(args.since, 'since') ?? `${seasonYear(ctx.now) - 1}-08-01`
  const buyers = await names(ctx.sb, ctx.orgId, 'buyers')
  const sets = await fetchAllRows<{ id: string; buyer_id: string | null; settlement_date: string | null; settlement_number: string | null; check_number: string | null; payment_date: string | null }>((f, t) => ctx.sb.from('settlements').select('id, buyer_id, settlement_date, settlement_number, check_number, payment_date').eq('org_id', ctx.orgId).gte('settlement_date', since).order('id').range(f, t))
  if (sets.error) throw new Error(sets.error.message)
  const ids = sets.data.map((s) => s.id)
  const lines: Array<{ settlement_id: string; net_bushels: number | null; gross_revenue: number | null; discounts: number | null; net_revenue: number | null; load_id: string | null }> = []
  for (let i = 0; i < ids.length; i += 200) {
    const r = await fetchAllRows<(typeof lines)[number]>((f, t) => ctx.sb.from('settlement_lines').select('id, settlement_id, net_bushels, gross_revenue, discounts, net_revenue, load_id').eq('org_id', ctx.orgId).in('settlement_id', ids.slice(i, i + 200)).order('id').range(f, t))
    if (r.error) throw new Error(r.error.message)
    lines.push(...r.data)
  }
  const agg = new Map<string, { bu: number; gross: number; disc: number; net: number; n: number; unmatched: number }>()
  for (const l of lines) { const a = agg.get(l.settlement_id) ?? { bu: 0, gross: 0, disc: 0, net: 0, n: 0, unmatched: 0 }; a.bu += Number(l.net_bushels ?? 0); a.gross += Number(l.gross_revenue ?? 0); a.disc += Number(l.discounts ?? 0); a.net += Number(l.net_revenue ?? 0); a.n++; if (!l.load_id) a.unmatched++; agg.set(l.settlement_id, a) }
  sets.data.sort((a, b) => String(b.settlement_date).localeCompare(String(a.settlement_date)))
  return {
    columns: ['settlement_date', 'buyer', 'settlement_number', 'check_number', 'payment_date', 'lines', 'lines_not_matched', 'net_bushels', 'gross_revenue', 'discounts', 'net_revenue', 'link'],
    rows: sets.data.map((s) => { const a = agg.get(s.id) ?? { bu: 0, gross: 0, disc: 0, net: 0, n: 0, unmatched: 0 }; return [s.settlement_date, buyers.get(s.buyer_id ?? '') ?? null, s.settlement_number, s.check_number, s.payment_date, a.n, a.unmatched, r0(a.bu), r2(a.gross), r2(a.disc), r2(a.net), url(`/settlements/${s.id}`)] }),
    url: url('/settlements'),
  }
}

async function bins(ctx: Ctx): Promise<Out> {
  const { data, error } = await ctx.sb.from('bins').select('id, name_or_number, capacity_bushels, crop_id, bin_site_id').eq('org_id', ctx.orgId)
  if (error) throw new Error(error.message)
  const crops = await loadCrops(ctx.sb, ctx.orgId)
  const { data: sites } = await ctx.sb.from('bin_sites').select('id, name').eq('org_id', ctx.orgId)
  const site = new Map(((sites ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]))
  return {
    columns: ['bin', 'site', 'crop', 'capacity_bu'],
    rows: ((data ?? []) as Array<{ name_or_number: string; capacity_bushels: number | null; crop_id: string | null; bin_site_id: string | null }>).map((b) => [b.name_or_number, site.get(b.bin_site_id ?? '') ?? null, crops.get(b.crop_id ?? '')?.name ?? null, b.capacity_bushels === null ? null : Number(b.capacity_bushels)]),
    url: url('/inventory'),
  }
}

async function hedges(ctx: Ctx, args: Args): Promise<Out> {
  const status = (args.status ?? 'open').toLowerCase()
  if (!['open', 'all'].includes(status)) throw new BadParam('status is open or all.')
  const entities = await names(ctx.sb, ctx.orgId, 'entities')
  let fq = ctx.sb.from('futures_positions').select('id, entity_id, commodity, contract_month, crop_year, side, num_contracts, trade_price, trade_date, status, close_price, close_date, realized_pnl').eq('org_id', ctx.orgId)
  let oq = ctx.sb.from('options_positions').select('id, entity_id, commodity, option_type, side, underlying_contract_month, strike_price, num_contracts, premium_cents, trade_date, expiration_date, crop_year, status, realized_pnl').eq('org_id', ctx.orgId)
  if (status === 'open') { fq = fq.eq('status', 'open'); oq = oq.eq('status', 'open') }
  const [{ data: fut, error: fe }, { data: op, error: oe }] = await Promise.all([fq.limit(MAX_ROWS), oq.limit(MAX_ROWS)])
  if (fe || oe) throw new Error((fe ?? oe)!.message)
  const rows: DataResult['rows'] = []
  for (const f of (fut ?? []) as Array<Record<string, unknown>>) rows.push(['futures', entities.get(String(f.entity_id)) ?? null, f.commodity as string, f.contract_month as string, f.crop_year as number, f.side as string, Number(f.num_contracts), null, Number(f.trade_price), f.trade_date as string, null, f.status as string, f.realized_pnl === null ? null : Number(f.realized_pnl)])
  for (const o of (op ?? []) as Array<Record<string, unknown>>) rows.push([`${o.option_type} option`, entities.get(String(o.entity_id)) ?? null, o.commodity as string, o.underlying_contract_month as string, o.crop_year as number, o.side as string, Number(o.num_contracts), Number(o.strike_price), o.premium_cents === null ? null : Number(o.premium_cents), o.trade_date as string, o.expiration_date as string, o.status as string, o.realized_pnl === null ? null : Number(o.realized_pnl)])
  return { columns: ['kind', 'entity', 'commodity', 'month', 'crop_year', 'side', 'contracts', 'strike', 'price_or_premium_cents', 'trade_date', 'expires', 'status', 'realized_pnl'], rows, url: url('/hedging') }
}

async function government(ctx: Ctx, args: Args): Promise<Out> {
  const year = yearOf(args, ctx.now)
  const { data, error } = await ctx.sb.from('arc_plc_payments').select('farm_id, commodity_id, crop_year, election, base_acres, net_payment, payment_status, expected_payment_date, actual_payment_date, actual_payment_amount').eq('org_id', ctx.orgId).eq('crop_year', year).limit(MAX_ROWS)
  if (error) throw new Error(error.message)
  const { data: farms } = await ctx.sb.from('farms').select('id, name, fsa_number').eq('org_id', ctx.orgId)
  const farm = new Map(((farms ?? []) as Array<{ id: string; name: string; fsa_number: string | null }>).map((f) => [f.id, f.fsa_number ? `${f.name} (FSA ${f.fsa_number})` : f.name]))
  const { data: comms } = await ctx.sb.from('covered_commodities').select('id, name')
  const comm = new Map(((comms ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]))
  return {
    columns: ['farm', 'commodity', 'program_year', 'election', 'base_acres', 'net_payment', 'status', 'expected_date', 'paid_date', 'paid_amount'],
    rows: ((data ?? []) as Array<Record<string, unknown>>).map((p) => [farm.get(String(p.farm_id)) ?? null, comm.get(String(p.commodity_id)) ?? null, p.crop_year as number, p.election as string, p.base_acres === null ? null : Number(p.base_acres), p.net_payment === null ? null : Number(p.net_payment), p.payment_status as string, p.expected_payment_date as string, p.actual_payment_date as string, p.actual_payment_amount === null ? null : Number(p.actual_payment_amount)]),
    url: url('/reports/government-payments'),
  }
}

async function landownerSettlements(ctx: Ctx, args: Args): Promise<Out> {
  const year = yearOf(args, ctx.now)
  const { data, error } = await ctx.sb.from('landowner_settlements').select('landowner_name, crop_year, lease_type, status, finalized_at, received_at').eq('org_id', ctx.orgId).eq('crop_year', year).limit(MAX_ROWS)
  if (error) throw new Error(error.message)
  return { columns: ['landowner', 'crop_year', 'lease_type', 'status', 'finalized_in_farm', 'received'], rows: ((data ?? []) as Array<Record<string, unknown>>).map((s) => [s.landowner_name as string, s.crop_year as number, s.lease_type as string, s.status as string, s.finalized_at as string, s.received_at as string]), url: url('/reports/rent-settlement') }
}

async function cotton(ctx: Ctx, args: Args): Promise<Out> {
  const year = yearOf(args, ctx.now)
  const gins = await names(ctx.sb, ctx.orgId, 'gins')
  const entities = await names(ctx.sb, ctx.orgId, 'entities')
  const r = await fetchAllRows<{ gin_id: string | null; entity_id: string | null; bales_count: number | null; total_bale_weight: number | null; total_seed_cotton_weight: number | null; modules_count: number | null }>((f, t) => ctx.sb.from('gin_receipts').select('id, gin_id, entity_id, bales_count, total_bale_weight, total_seed_cotton_weight, modules_count').eq('org_id', ctx.orgId).eq('crop_year', year).order('id').range(f, t))
  if (r.error) throw new Error(r.error.message)
  const by = new Map<string, { receipts: number; modules: number; bales: number; lint: number; seed: number }>()
  for (const g of r.data) { const k = `${g.gin_id ?? ''}|${g.entity_id ?? ''}`; const a = by.get(k) ?? { receipts: 0, modules: 0, bales: 0, lint: 0, seed: 0 }; a.receipts++; a.modules += Number(g.modules_count ?? 0); a.bales += Number(g.bales_count ?? 0); a.lint += Number(g.total_bale_weight ?? 0); a.seed += Number(g.total_seed_cotton_weight ?? 0); by.set(k, a) }
  return {
    columns: ['gin', 'entity', 'crop_year', 'gin_receipts', 'modules', 'bales', 'lint_lbs', 'seed_cotton_lbs', 'turnout_pct'],
    rows: [...by.entries()].map(([k, a]) => { const [gin, ent] = k.split('|'); return [gins.get(gin) ?? null, entities.get(ent) ?? null, year, a.receipts, a.modules, a.bales, r0(a.lint), r0(a.seed), a.seed ? r2((a.lint / a.seed) * 100) : null] }),
    url: url('/cotton'),
  }
}

type Builder = (ctx: Ctx, args: Args) => Promise<Out>
const REGISTRY: Array<Dataset & { build: Builder }> = [
  { name: 'positions', description: 'By crop for one crop year: bushels harvested (field loads, dry), harvested into bins, delivered to buyers, on contracts, spot, price later, delivered with no sale type, contracted, and contracted not yet delivered.', params: [cropYearParam, cropParam], build: positions },
  { name: 'contracts', description: 'Grain contracts for one crop year: buyer, entity, crop, type and pricing status, contracted, delivered and left bushels, price, futures, basis, delivery window.', params: [cropYearParam, cropParam, { name: 'status', type: 'string', required: false, description: 'open (default) or all' }], build: contractsDs },
  { name: 'loads', description: 'Loads for one crop year, newest first: date, tickets, crop, from (field or bin), to (bin or buyer), dry bushels, how it was sold, and whether a settlement has paid it.', params: [cropYearParam, cropParam, { name: 'since', type: 'date', required: false, description: 'Only loads on or after this date' }], build: (c, a) => loadsDs(c, a) },
  { name: 'unpaid_loads', description: 'Buyer loads no settlement has paid yet, for one crop year, newest first.', params: [cropYearParam, cropParam], build: (c, a) => loadsDs(c, a, true) },
  { name: 'settlements', description: 'Buyer settlements since a date: buyer, numbers, check and payment date, lines and how many are not matched to a load, net bushels, gross, discounts and net revenue.', params: [{ name: 'since', type: 'date', required: false, description: 'Default August 1 of last year' }], build: settlementsDs },
  { name: 'bins', description: 'Bins with their site, the crop in them, and capacity.', params: [], build: (c) => bins(c) },
  { name: 'hedges', description: 'Futures and options positions: entity, commodity, month, crop year, side, contracts, strike, price or premium, dates, status, realized P&L.', params: [{ name: 'status', type: 'string', required: false, description: 'open (default) or all' }], build: hedges },
  { name: 'government_payments', description: 'ARC/PLC payments for one program year by farm and commodity: election, base acres, net payment, status, expected and paid dates.', params: [cropYearParam], build: government },
  { name: 'landowner_settlements', description: 'Landowner rent statements Turnrow Farm finalized and sent here, for one crop year.', params: [cropYearParam], build: landownerSettlements },
  { name: 'cotton_ginning', description: 'Cotton ginned for one crop year by gin and entity: gin receipts, modules, bales, lint and seed cotton pounds, turnout.', params: [cropYearParam], build: cotton },
]

export const DATASETS: Dataset[] = REGISTRY.map(({ name, description, params }) => ({ name, description, params }))

export function datasetIndex() {
  return { app: APP.app, label: APP.label, datasets: DATASETS }
}

export async function readDataset(sb: SupabaseClient, orgId: string, name: string, args: Args, now: Date = new Date()): Promise<DataResult> {
  const d = REGISTRY.find((x) => x.name === name)
  if (!d) throw new BadParam(`No dataset ${name}. Datasets: ${DATASETS.map((x) => x.name).join(', ')}.`)
  const out = await d.build({ sb, orgId, now }, args)
  return { app: APP.app, dataset: name, as_of: now.toISOString(), columns: out.columns, rows: out.rows.slice(0, MAX_ROWS), total: out.rows.length, truncated: out.rows.length > MAX_ROWS, url: out.url }
}


