// GET /api/ops/brief, built (2026-11-08): what Stuart has to DO in Turnrow
// Grain, in the envelope the Morning Brief reads (turnrow-farm
// docs/OPS_API.md). The same queues the pages flag: loads delivered to a
// buyer with no sale type (/loads/assign-sales), buyer loads no settlement
// has paid (/loads/unpaid), settlement lines not matched to a load, price
// later bushels still to price, contracts past their delivery window with
// bushels left or still awaiting basis or futures, options near expiry,
// CCC loans near maturity, on-call cotton not fixed, government payments
// past their expected date, and the Turnrow Farm link's health.

import type { SupabaseClient } from '@supabase/supabase-js'
import { APP, url } from './context'
import { deliveredByContract, fmtBu, isoDay, loadContracts, loadCrops, loadLoads, loadSales, names, paidLoadIds, seasonYear } from './grain'

export type Todo = { id: string; text: string; due: string | null; status: 'open' | 'overdue' | 'done'; owner: string | null; url: string }
export type Alert = { severity: 'high' | 'medium' | 'low'; text: string; amount: number | null; url: string }
export type Metric = { key: string; label: string; value: number | string; unit: string | null; period: string | null; change: number | null; url: string | null }
export type OpsList = { name: string; columns: string[]; rows: Array<Array<string | number | null>>; url: string | null }
export type OpsBrief = { app: string; label: string; generated_at: string; as_of: string; todos: Todo[]; alerts: Alert[]; metrics: Metric[]; lists: OpsList[]; notes: string[] }

const DAY = 86_400_000
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export async function buildOpsBrief(sb: SupabaseClient, orgId: string, now: Date = new Date()): Promise<OpsBrief> {
  const today = isoDay(now)
  const year = seasonYear(now)
  const years = [year - 1, year, year + 1]
  const todos: Todo[] = []
  const alerts: Alert[] = []
  const notes: string[] = []

  const [crops, buyers] = await Promise.all([loadCrops(sb, orgId), names(sb, orgId, 'buyers')])
  const cropName = (id: string | null) => (id ? crops.get(id)?.name ?? 'crop' : 'crop')
  const loads = await loadLoads(sb, orgId, years, crops)
  const [{ allocs }, paid, contracts] = await Promise.all([loadSales(sb, orgId, loads), paidLoadIds(sb, orgId), loadContracts(sb, orgId, years)])
  const buyerLoads = loads.filter((l) => l.to_type === 'buyer')

  // 1. Loads at a buyer with no sale type.
  const unassigned = buyerLoads.filter((l) => (allocs.get(l.id)?.length ?? 0) === 0)
  if (unassigned.length) {
    const bu = unassigned.reduce((s, l) => s + l.dryBu, 0)
    todos.push({ id: 'assign-sales', text: `Pick contract, spot or price later for ${plural(unassigned.length, 'load')} delivered to buyers (${fmtBu(bu)}), so their bushels count on contracts and marketing.`, due: null, status: 'open', owner: null, url: url('/loads/assign-sales') })
  }

  // 2. Buyer loads no settlement has paid, three weeks on.
  const unpaid = buyerLoads.filter((l) => !paid.has(l.id) && l.date && daysBetween(l.date, today) > 21)
  if (unpaid.length) {
    const oldest = unpaid.reduce((m, l) => (l.date! < m ? l.date! : m), unpaid[0].date!)
    const bu = unpaid.reduce((s, l) => s + l.dryBu, 0)
    const byBuyer = new Map<string, number>()
    for (const l of unpaid) byBuyer.set(buyers.get(l.to_buyer_id ?? '') ?? 'a buyer', (byBuyer.get(buyers.get(l.to_buyer_id ?? '') ?? 'a buyer') ?? 0) + 1)
    const who = [...byBuyer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b, n]) => `${b} ${n}`).join(', ')
    todos.push({ id: 'unpaid-loads', text: `${plural(unpaid.length, 'buyer load')} delivered more than three weeks ago are on no settlement yet (${fmtBu(bu)}; ${who}). Enter or import the settlements, or chase the buyer. Oldest ${oldest}.`, due: null, status: 'open', owner: null, url: url('/loads/unpaid') })
    if (daysBetween(oldest, today) > 60) alerts.push({ severity: 'high', text: `A buyer load from ${oldest} has still not been paid on any settlement.`, amount: null, url: url('/loads/unpaid') })
  }

  // 3. Settlement lines not matched to a load.
  const { data: lines, error: le } = await sb.from('settlement_lines').select('id, settlement_id').eq('org_id', orgId).is('load_id', null).limit(2000)
  if (le) throw new Error(`settlement_lines: ${le.message}`)
  const bySettlement = new Map<string, number>()
  for (const l of (lines ?? []) as Array<{ settlement_id: string }>) bySettlement.set(l.settlement_id, (bySettlement.get(l.settlement_id) ?? 0) + 1)
  if (bySettlement.size) {
    const ids = [...bySettlement.keys()].slice(0, 200)
    const { data: sets } = await sb.from('settlements').select('id, settlement_number, settlement_date, buyer_id').eq('org_id', orgId).in('id', ids)
    const list = ((sets ?? []) as Array<{ id: string; settlement_number: string | null; settlement_date: string | null; buyer_id: string | null }>).sort((a, b) => String(b.settlement_date).localeCompare(String(a.settlement_date)))
    for (const s of list.slice(0, 5)) todos.push({ id: `match-${s.id}`, text: `Match ${plural(bySettlement.get(s.id) ?? 0, 'line')} on ${buyers.get(s.buyer_id ?? '') ?? 'a buyer'} settlement ${s.settlement_number ?? ''}${s.settlement_date ? ` (${s.settlement_date})` : ''} to their loads.`.replace('  ', ' '), due: null, status: 'open', owner: null, url: url(`/settlements/${s.id}`) })
    if (list.length > 5) notes.push(`${list.length - 5} more settlements have lines not matched to a load.`)
  }

  // 4. Price later bushels still to price (no settlement line yet).
  const priceLater = new Map<string, number>()
  for (const l of buyerLoads) for (const a of allocs.get(l.id) ?? []) if (a.saleType === 'price_later' && !a.sale?.settlement_line_id) { const k = `${l.crop_id ?? ''}|${l.crop_year ?? ''}`; priceLater.set(k, (priceLater.get(k) ?? 0) + a.bushels) }
  for (const [k, bu] of priceLater) {
    if (bu < 1) continue
    const [cropId, cy] = k.split('|')
    todos.push({ id: `price-later-${k}`, text: `Price ${fmtBu(bu)} of ${cy} ${cropName(cropId)} delivered on price later.`, due: null, status: 'open', owner: null, url: url(`/contracts/price-later/${cropId}`) })
  }

  // 5. Contracts: past the delivery window with bushels left; awaiting basis or futures.
  const delivered = deliveredByContract(allocs)
  const open = contracts.filter((c) => !c.completed_at && c.contract_kind !== 'seed')
  for (const c of open) {
    const left = (c.contracted_bushels ?? 0) - (delivered.get(c.id) ?? 0)
    const label = `contract ${c.contract_number ?? ''} with ${buyers.get(c.buyer_id ?? '') ?? 'a buyer'} (${c.crop_year ?? ''} ${cropName(c.crop_id)})`.replace('  ', ' ')
    if (c.delivery_end_date && c.delivery_end_date < today && left > 1) {
      todos.push({ id: `deliver-${c.id}`, text: `Finish or close ${label}: ${fmtBu(left)} of ${fmtBu(c.contracted_bushels ?? 0)} left after its window ended.`, due: c.delivery_end_date, status: 'overdue', owner: null, url: url(`/contracts/${c.id}`) })
    }
    if (c.pricing_status === 'awaiting_basis' || c.pricing_status === 'awaiting_futures') {
      todos.push({ id: `price-${c.id}`, text: `Set the ${c.pricing_status === 'awaiting_basis' ? 'basis' : 'futures'} on ${label}${c.contract_month ? `, ${c.contract_month}` : ''}.`, due: c.delivery_start_date && c.delivery_start_date >= today ? c.delivery_start_date : null, status: 'open', owner: null, url: url(`/contracts/${c.id}`) })
    }
  }

  // 6. Options expiring within three weeks.
  const soon = new Date(Date.parse(today) + 21 * DAY).toISOString().slice(0, 10)
  const { data: opts } = await sb.from('options_positions').select('id, option_type, side, strike_price, num_contracts, underlying_contract_month, expiration_date, commodity').eq('org_id', orgId).eq('status', 'open').lte('expiration_date', soon).limit(100)
  for (const o of (opts ?? []) as Array<{ id: string; option_type: string; side: string; strike_price: number; num_contracts: number; underlying_contract_month: string | null; expiration_date: string; commodity: string | null }>) {
    todos.push({ id: `option-${o.id}`, text: `Decide on ${o.num_contracts} ${o.side === 'buy' ? 'long' : 'short'} ${o.commodity ?? ''} ${o.underlying_contract_month ?? ''} ${o.strike_price} ${o.option_type}s before they expire.`.replace(/\s+/g, ' '), due: o.expiration_date, status: o.expiration_date < today ? 'overdue' : 'open', owner: null, url: url('/hedging') })
  }

  // 7. Cotton: CCC loans near maturity; on-call contracts not fixed.
  const in45 = new Date(Date.parse(today) + 45 * DAY).toISOString().slice(0, 10)
  const [{ data: loans }, { data: oncall }] = await Promise.all([
    sb.from('ccc_loans').select('id, loan_number, maturity_date, principal_total, crop_year').eq('org_id', orgId).eq('status', 'open').lte('maturity_date', in45).limit(100),
    sb.from('cotton_sales_contracts').select('id, contract_number, futures_month, crop_year, buyer_id').eq('org_id', orgId).eq('pricing_status', 'awaiting_futures').limit(100),
  ])
  for (const l of (loans ?? []) as Array<{ id: string; loan_number: string | null; maturity_date: string; principal_total: number | null; crop_year: number }>) {
    todos.push({ id: `ccc-${l.id}`, text: `CCC loan ${l.loan_number ?? ''} (${l.crop_year} cotton, $${Number(l.principal_total ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}) matures; redeem or let it go.`.replace('  ', ' '), due: l.maturity_date, status: l.maturity_date < today ? 'overdue' : 'open', owner: null, url: url('/cotton/marketing') })
  }
  for (const c of (oncall ?? []) as Array<{ id: string; contract_number: string | null; futures_month: string | null; crop_year: number; buyer_id: string | null }>) {
    todos.push({ id: `oncall-${c.id}`, text: `Fix the futures on on-call cotton contract ${c.contract_number ?? ''} with ${buyers.get(c.buyer_id ?? '') ?? 'a buyer'} (${c.crop_year}, ${c.futures_month ?? 'month not set'}).`.replace('  ', ' '), due: null, status: 'open', owner: null, url: url('/cotton/marketing') })
  }

  // 8. Government payments past their expected date and not received.
  const { data: gov } = await sb.from('arc_plc_payments').select('id, net_payment, expected_payment_date, payment_status, crop_year').eq('org_id', orgId).neq('payment_status', 'received').lt('expected_payment_date', today).limit(500)
  const late = (gov ?? []) as Array<{ net_payment: number | null; expected_payment_date: string; crop_year: number }>
  if (late.length) {
    const amount = late.reduce((s, g) => s + Number(g.net_payment ?? 0), 0)
    alerts.push({ severity: 'medium', text: `${plural(late.length, 'ARC/PLC payment')} past the expected date and not marked received; check the FSA statements.`, amount: Math.round(amount * 100) / 100, url: url('/reports/government-payments') })
  }

  // 9. The Turnrow Farm link.
  const { data: link } = await sb.from('farm_links').select('id, status, last_seen_at, farm_org_name').eq('org_id', orgId).maybeSingle()
  const lk = link as { id: string; status: string; last_seen_at: string | null; farm_org_name: string | null } | null
  if (!lk || lk.status !== 'active') alerts.push({ severity: 'high', text: lk ? `The Turnrow Farm link is ${lk.status}.` : 'Turnrow Grain is not linked to Turnrow Farm.', amount: null, url: url('/settings/farm-link') })
  else {
    if (!lk.last_seen_at || Date.parse(lk.last_seen_at) < now.getTime() - 3 * DAY) alerts.push({ severity: 'medium', text: `Turnrow Farm has not called the link since ${lk.last_seen_at?.slice(0, 10) ?? 'it was made'}.`, amount: null, url: url('/settings/farm-link') })
    const { data: calls } = await sb.from('farm_link_calls').select('endpoint, status').eq('link_id', lk.id).gte('called_at', new Date(now.getTime() - DAY).toISOString()).gte('status', 400).limit(500)
    const failed = (calls ?? []) as Array<{ endpoint: string; status: number }>
    if (failed.length) alerts.push({ severity: 'medium', text: `${plural(failed.length, 'Turnrow Farm link call')} failed in the last day (${[...new Set(failed.map((c) => c.endpoint))].slice(0, 4).join(', ')}).`, amount: null, url: url('/settings/farm-link') })
  }

  // Metrics: the season in progress.
  const thisYear = loads.filter((l) => l.crop_year === year)
  const metrics: Metric[] = [
    { key: 'loads', label: `${year} loads`, value: thisYear.length, unit: 'count', period: String(year), change: null, url: url('/loads') },
  ]
  const deliveredByCrop = new Map<string, number>()
  for (const l of thisYear) if (l.to_type === 'buyer') deliveredByCrop.set(cropName(l.crop_id), (deliveredByCrop.get(cropName(l.crop_id)) ?? 0) + l.dryBu)
  for (const [c, bu] of [...deliveredByCrop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) metrics.push({ key: `delivered-${c}`, label: `${c} delivered to buyers`, value: Math.round(bu), unit: 'bu', period: String(year), change: null, url: url('/loads') })
  metrics.push({ key: 'open-contracts', label: 'Open grain contracts', value: open.length, unit: 'count', period: `${years[0]} to ${years[2]}`, change: null, url: url('/contracts') })
  const { count: hedges } = await sb.from('futures_positions').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'open')
  metrics.push({ key: 'open-futures', label: 'Open futures positions', value: hedges ?? 0, unit: 'count', period: null, change: null, url: url('/hedging') })

  // The open contracts, nearest window end first.
  const contractRows = open
    .map((c) => ({ c, left: (c.contracted_bushels ?? 0) - (delivered.get(c.id) ?? 0) }))
    .sort((a, b) => String(a.c.delivery_end_date ?? '9999').localeCompare(String(b.c.delivery_end_date ?? '9999')))
    .slice(0, 25)
    .map(({ c, left }) => [c.contract_number ?? '', buyers.get(c.buyer_id ?? '') ?? '', cropName(c.crop_id), c.crop_year, Math.round(c.contracted_bushels ?? 0), Math.round(left), c.delivery_end_date, c.pricing_status === 'fully_priced' ? 'priced' : (c.pricing_status ?? '').replace('_', ' ')] as Array<string | number | null>)
  const lists: OpsList[] = contractRows.length ? [{ name: 'Open grain contracts', columns: ['Contract', 'Buyer', 'Crop', 'Crop year', 'Contracted bu', 'Left bu', 'Window ends', 'Pricing'], rows: contractRows, url: url('/contracts') }] : []

  todos.sort((a, b) => (a.status === 'overdue' ? 0 : 1) - (b.status === 'overdue' ? 0 : 1) || String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')))
  if (todos.length > 25) notes.push(`${todos.length - 25} more to-dos not shown.`)
  const stamp = now.toISOString()
  return { app: APP.app, label: APP.label, generated_at: stamp, as_of: stamp, todos: todos.slice(0, 25), alerts, metrics: metrics.slice(0, 8), lists, notes }
}
