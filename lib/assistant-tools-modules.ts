// "Ask Turnrow" curated tools for the modules that had none (2026-09-14):
// cotton marketing, cotton production, settlements with itemized discounts,
// bin transfers, combine entries, rent settlements, crop budgets. (Seed
// contracts live in lib/assistant-tools.ts next to the marketing bundle they
// share.) Same rules as every tool: the caller's SESSION client (RLS scopes
// every row), the report engines / pure libs do the math, growing tables are
// paginated, and an empty result is reported as exactly that.

import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import { all, allRows, allPaged, COMBINE_SELECT, num, r0, r2, fetchScopeBits, resolveByName, nameOf, type CombineRow } from '@/lib/assistant-tools-shared'
import type { AssistantContext } from '@/lib/assistant-tools'
import { buildEntityScope } from '@/lib/entity-scope'
import { fetchCottonPhysical } from '@/lib/cotton-physical-fetch'
import { buildCottonPhysicalSummary, contractPricedCents, dispositionBoard, type CottonPhysicalSummary } from '@/lib/cotton-sales'
import { cottonFieldYields, lintTurnoutPct } from '@/lib/cotton'
import { isCottonCrop } from '@/lib/marketing'
import { DISCOUNT_CATEGORY_LABELS, coerceDiscountCategory, centsPerBu, sumCheck } from '@/lib/settlement-discounts'
import { parseLeaseTerms, type SettlementStatement } from '@/lib/rent-settlement'
import { budgetLineMath, scenarioTotals, isCottonName } from '@/lib/crop-budget'
import { checkoffByCrop } from '@/lib/checkoff'
import { normalizeTicket } from '@/lib/ticket-matching'
import type { BudgetLine, BudgetScenario, Crop, FieldPlanting, LeaseTerm, RentSettlement } from '@/lib/types'

const PRICE_BASIS = 'stored positions and assumptions — not live futures quotes; the report pages layer live quotes on top'

/** `.in()` on a long id list, in URL-safe chunks (paginated inside each). */
async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 150) out.push(...(await fetch(ids.slice(i, i + 150))))
  return out
}

const CROPS_SELECT = 'id, name, base_moisture_pct, base_lb_per_bushel, harvest_category, double_crop'

// ---------- cotton marketing ----------

export async function getCottonMarketing(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number; buyer?: string }) {
  const cropYear = num(input.crop_year)
  const [raw, buyers, bits, crops, plantings] = await Promise.all([
    fetchCottonPhysical(supabase, cropYear),
    all<{ id: string; name: string }>(supabase.from('buyers').select('id, name')),
    fetchScopeBits(supabase),
    all<Crop>(supabase.from('crops').select(CROPS_SELECT)),
    allRows<FieldPlanting>((f, t) => supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres').eq('season_year', cropYear).order('id').range(f, t)),
  ])
  const buyerName = nameOf(buyers)
  const { inputs } = raw
  const baleById = new Map(inputs.bales.map((b) => [b.id, b]))
  const buyerFilter = input.buyer?.trim().toLowerCase() || null
  const matchesBuyer = (id: string | null) => !buyerFilter || (buyerName(id) ?? '').toLowerCase().includes(buyerFilter)

  // Viewer attribution (052): agent/null-entity rows scaled to the granted
  // entities' cotton acre share, exactly like the Marketing dashboard; owners
  // get the whole book.
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const attribution = scope.attribution({ plantings, crops })
  const summary: CottonPhysicalSummary | null = ctx.grantedEntityIds ? attribution.cottonSummary(inputs) : (raw.hasData ? buildCottonPhysicalSummary(inputs) : null)

  const contracts = inputs.contracts.filter((c) => matchesBuyer(c.buyer_id)).map((c) => {
    const assigned = inputs.dispositions.filter((d) => d.contract_id === c.id)
    const lbs = assigned.reduce((s, d) => s + num(baleById.get(d.bale_id)?.net_weight_lbs), 0)
    const committed = c.committed_bales != null ? num(c.committed_bales) : null
    const priced = contractPricedCents(c)
    const pool = c.contract_type === 'pool' ? inputs.poolPayments.filter((p) => p.contract_id === c.id) : []
    return {
      contract_number: c.contract_number,
      buyer: buyerName(c.buyer_id),
      crop_year: c.crop_year,
      contract_type: c.contract_type,
      contract_date: c.contract_date,
      commitment: c.commitment_basis === 'acres' ? { basis: 'acres', committed_acres: c.committed_acres != null ? num(c.committed_acres) : null } : { basis: 'bales', committed_bales: committed },
      delivered_bales: assigned.length,
      delivered_lbs: r0(lbs),
      remaining_bales: committed != null ? Math.max(0, committed - assigned.length) : null,
      pricing_status: c.pricing_status,
      price_cents_per_lb: priced != null ? r2(priced) : null,
      price_usd_per_lb: priced != null ? r2(priced / 100 * 100) / 100 : null,
      basis_cents: c.basis_cents != null ? r2(num(c.basis_cents)) : null,
      futures_month: c.futures_month,
      futures_fixed_cents: c.futures_fixed_cents != null ? r2(num(c.futures_fixed_cents)) : null,
      delivery_window: [c.delivery_start, c.delivery_end].filter(Boolean).join(' to ') || null,
      pool_ledger: c.contract_type === 'pool'
        ? {
            received_usd: r2(pool.filter((p) => p.status === 'received').reduce((s, p) => s + num(p.amount), 0)),
            projected_usd: r2(pool.filter((p) => p.status === 'projected').reduce((s, p) => s + num(p.amount), 0)),
            payments: pool.map((p) => ({ type: p.payment_type, amount_usd: r2(num(p.amount)), cents_per_lb: p.cents_per_lb_equivalent != null ? r2(num(p.cents_per_lb_equivalent)) : null, date: p.payment_date, status: p.status })),
          }
        : null,
      notes: c.notes,
    }
  })

  const loans = inputs.loans.filter((l) => !buyerFilter || matchesBuyer(l.buyer_id)).map((l) => {
    const baleIds = inputs.loanBales.filter((b) => b.loan_id === l.id).map((b) => b.bale_id)
    const lbs = baleIds.reduce((s, id) => s + num(baleById.get(id)?.net_weight_lbs), 0)
    return {
      loan_number: l.loan_number,
      status: l.status,
      entry_date: l.entry_date,
      maturity_date: l.maturity_date,
      bales: baleIds.length,
      lbs: r0(lbs),
      loan_rate_base_cents: r2(num(l.loan_rate_base_cents)),
      principal_usd: r2(num(l.principal_total)),
      pending_classing: l.pending_classing,
      outcome_date: l.outcome_date,
      awp_at_outcome_cents: l.awp_at_outcome_cents != null ? r2(num(l.awp_at_outcome_cents)) : null,
      redemption_payoff_usd: l.redemption_payoff_total != null ? r2(num(l.redemption_payoff_total)) : null,
      equity_cents_per_lb: l.equity_cents_per_lb != null ? r2(num(l.equity_cents_per_lb)) : null,
      equity_usd: l.equity_total != null ? r2(num(l.equity_total)) : null,
      mlg_usd: l.mlg_total != null ? r2(num(l.mlg_total)) : null,
      interest_paid_usd: l.interest_paid != null ? r2(num(l.interest_paid)) : null,
      storage_paid_usd: l.storage_charges_paid != null ? r2(num(l.storage_charges_paid)) : null,
      equity_buyer: buyerName(l.buyer_id),
    }
  })

  const ldps = inputs.ldps.map((p) => ({ date: p.ldp_date, awp_cents: r2(num(p.awp_cents)), ldp_rate_cents: r2(num(p.ldp_rate_cents)), total_usd: r2(num(p.total_payment)), status: p.status }))
  const board = dispositionBoard(inputs.bales, inputs.dispositions)
  const fees = inputs.fees.reduce((s, f) => s + (f.status === 'actual' ? num(f.amount_total) : 0), 0)

  if (!raw.hasData && contracts.length === 0) {
    return { crop_year: cropYear, contracts: [], loans: [], ldps: [], note: `No cotton marketing records (contracts, loans, LDPs, pools) for crop year ${cropYear}${buyerFilter ? ` matching "${input.buyer}"` : ''}. Buyers with cotton contracts this year: none.` }
  }
  return {
    crop_year: cropYear,
    contracts,
    contract_count: contracts.length,
    loans,
    ldps,
    disposition_board: { total_bales: board.totalBales, total_lbs: r0(board.totalLbs), by_disposition: Object.fromEntries(Object.entries(board.byDisposition).map(([k, v]) => [k, { bales: v.bales, lbs: r0(v.lbs) }])) },
    summary: summary
      ? {
          sold_lbs: r0(summary.soldLbs), sold_usd: r2(summary.soldDollars), awaiting_call_lbs: r0(summary.awaitingCallLbs),
          pool_lbs: r0(summary.poolLbs), pool_received_usd: r2(summary.poolReceivedDollars), pool_est_cents: summary.poolEstCents != null ? r2(summary.poolEstCents) : null,
          in_loan_lbs: r0(summary.inLoanLbs), loan_banked_usd: r2(summary.loanBankedDollars), loan_floor_cents: summary.loanFloorCents != null ? r2(summary.loanFloorCents) : null,
          held_lbs: r0(summary.heldLbs), program_usd: r2(summary.programDollars), program_label: summary.programLabel, fees_usd: r2(summary.feeDollars),
        }
      : null,
    actual_fees_usd: r2(fees),
    buyers_with_cotton_contracts: Array.from(new Set(inputs.contracts.map((c) => buyerName(c.buyer_id)).filter(Boolean))),
    note: `Cotton Marketing engine. Prices in ¢/lb (72.65 = $0.7265/lb); bales delivered = bales assigned to the contract on the disposition board; remaining = committed − delivered. ${buyerFilter && contracts.length === 0 ? `No contracts matched "${input.buyer}" — buyers listed in buyers_with_cotton_contracts.` : ''}`,
  }
}

// ---------- cotton production ----------

type ReceiptRow = { id: string; gin_id: string | null; receipt_number: string | null; receipt_date: string | null; crop_year: number; entity_id: string | null; farm_id: string | null; field_id: string | null; bales_count: number | null; total_bale_weight: number | null; total_seed_cotton_weight: number | null }
type BaleRow = { id: string; gin_receipt_id: string; net_weight_lbs: number }
type GradeRow = { bale_id: string; color_grade: string | null; leaf_grade: string | null; staple_32nds: number | null; micronaire: number | null; strength_g_tex: number | null; uniformity_pct: number | null; loan_value_cents_per_lb: number | null; loan_value_total: number | null }

export async function getCottonProduction(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number }) {
  const cropYear = num(input.crop_year)
  const [receiptsAll, bales, bits, gins, crops, loads, plantings] = await Promise.all([
    allRows<ReceiptRow>((f, t) => supabase.from('gin_receipts').select('id, gin_id, receipt_number, receipt_date, crop_year, entity_id, farm_id, field_id, bales_count, total_bale_weight, total_seed_cotton_weight').eq('crop_year', cropYear).order('id').range(f, t)),
    allRows<BaleRow>((f, t) => supabase.from('cotton_bales').select('id, gin_receipt_id, net_weight_lbs').eq('crop_year', cropYear).order('id').range(f, t)),
    fetchScopeBits(supabase),
    all<{ id: string; name: string }>(supabase.from('gins').select('id, name')),
    all<Crop>(supabase.from('crops').select(CROPS_SELECT)),
    allRows<{ id: string; field_id: string | null; net_weight: number | null }>((f, t) => supabase.from('cotton_loads').select('id, field_id, net_weight').eq('crop_year', cropYear).order('id').range(f, t)),
    allRows<FieldPlanting>((f, t) => supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres').eq('season_year', cropYear).order('id').range(f, t)),
  ])
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const receipts = scope.ginReceipts(receiptsAll)
  const receiptIds = new Set(receipts.map((r) => r.id))
  const scopedBales = bales.filter((b) => receiptIds.has(b.gin_receipt_id))
  const [grades, ginnedLinks] = await Promise.all([
    inChunks(scopedBales.map((b) => b.id), (chunk) => allRows<GradeRow>((f, t) => supabase.from('cotton_bale_grades').select('bale_id, color_grade, leaf_grade, staple_32nds, micronaire, strength_g_tex, uniformity_pct, loan_value_cents_per_lb, loan_value_total').in('bale_id', chunk).order('id').range(f, t))),
    inChunks(receipts.map((r) => r.id), (chunk) => allRows<{ cotton_load_id: string; gin_receipt_id: string }>((f, t) => supabase.from('gin_receipt_loads').select('cotton_load_id, gin_receipt_id').in('gin_receipt_id', chunk).order('id').range(f, t))),
  ])
  const ginName = nameOf(gins)
  const farmName = nameOf(bits.farms)
  const fieldName = nameOf(bits.fields.map((f) => ({ id: f.id, name: f.name_or_number })))
  const balesByReceipt = new Map<string, { lbs: number; count: number }>()
  for (const b of scopedBales) {
    const g = balesByReceipt.get(b.gin_receipt_id) ?? { lbs: 0, count: 0 }
    g.lbs += num(b.net_weight_lbs); g.count += 1
    balesByReceipt.set(b.gin_receipt_id, g)
  }
  const receiptRows = receipts.map((r) => {
    const fromBales = balesByReceipt.get(r.id)
    const lint = fromBales && fromBales.lbs > 0 ? fromBales.lbs : num(r.total_bale_weight)
    const count = fromBales && fromBales.count > 0 ? fromBales.count : num(r.bales_count)
    return {
      receipt_number: r.receipt_number, date: r.receipt_date, gin: ginName(r.gin_id), farm: farmName(r.farm_id), field: fieldName(r.field_id),
      bales: count, lint_lbs: r0(lint), seed_cotton_lbs: r.total_seed_cotton_weight != null ? r0(num(r.total_seed_cotton_weight)) : null,
      turnout_pct: r.total_seed_cotton_weight != null ? lintTurnoutPct(lint, num(r.total_seed_cotton_weight)) : null,
    }
  })
  const totalBales = receiptRows.reduce((s, r) => s + r.bales, 0)
  const totalLint = receiptRows.reduce((s, r) => s + r.lint_lbs, 0)

  // Grade summary (the Bale Quality report's rollup).
  const classed = grades.length
  const avg = (vals: Array<number | null>) => { const v = vals.filter((x): x is number => x != null && Number.isFinite(Number(x))).map(Number); return v.length ? r2(v.reduce((s, x) => s + x, 0) / v.length) : null }
  let loanValue = 0, loanLbs = 0
  const baleLbs = new Map(scopedBales.map((b) => [b.id, num(b.net_weight_lbs)]))
  const colors = new Map<string, number>()
  for (const g of grades) {
    if (g.loan_value_total != null) { loanValue += num(g.loan_value_total); loanLbs += baleLbs.get(g.bale_id) ?? 0 }
    if (g.color_grade) colors.set(g.color_grade, (colors.get(g.color_grade) ?? 0) + 1)
  }
  const gradeSummary = {
    classed_bales: classed, unclassed_bales: Math.max(0, scopedBales.length - classed),
    avg_loan_cents_per_lb: loanLbs > 0 ? r2((loanValue / loanLbs) * 100) : null,
    avg_micronaire: avg(grades.map((g) => g.micronaire)), avg_staple_32nds: avg(grades.map((g) => g.staple_32nds)),
    avg_strength_g_tex: avg(grades.map((g) => g.strength_g_tex)), avg_uniformity_pct: avg(grades.map((g) => g.uniformity_pct)),
    color_grades: Object.fromEntries([...colors.entries()].sort((a, b) => b[1] - a[1])),
  }

  // Per-field lint per acre (the cotton yields section engine).
  const cottonCropIds = new Set(crops.filter((c) => isCottonCrop(c.name)).map((c) => c.id))
  const fieldAcres = new Map<string, number>()
  for (const p of plantings) if (cottonCropIds.has(p.crop_id) && p.field_id) fieldAcres.set(p.field_id, (fieldAcres.get(p.field_id) ?? 0) + num(p.planted_acres))
  const fieldIds = new Set([...fieldAcres.keys(), ...receipts.map((r) => r.field_id).filter((x): x is string => !!x)])
  const yields = cottonFieldYields({
    fields: [...fieldIds].map((fieldId) => ({ fieldId, plantedAcres: fieldAcres.get(fieldId) ?? 0 })),
    receipts: receipts.map((r) => ({ id: r.id, field_id: r.field_id, total_seed_cotton_weight: r.total_seed_cotton_weight, total_bale_weight: r.total_bale_weight, bales_count: r.bales_count })),
    bales: scopedBales,
    loads,
    ginnedLoadIds: new Set(ginnedLinks.map((l) => l.cotton_load_id)),
  }).filter((y) => y.status !== 'unharvested').map((y) => ({
    field: fieldName(y.fieldId), acres: r2(y.plantedAcres), receipts: y.receipts, bales: y.bales, lint_lbs: r0(y.lintLbs), lint_lbs_per_acre: y.lintPerAcre != null ? r0(y.lintPerAcre) : null,
    seed_cotton_lbs: r0(y.seedCottonLbs), turnout_pct: y.turnoutPct != null ? r2(y.turnoutPct) : null, on_yard_seed_lbs: r0(y.yardSeedLbs), status: y.status,
  }))

  if (receipts.length === 0 && loads.length === 0) {
    return { crop_year: cropYear, receipts: [], note: `No cotton production records (gin receipts, bales, cotton loads) for crop year ${cropYear}.` }
  }
  return {
    crop_year: cropYear,
    totals: { receipts: receipts.length, bales: totalBales, lint_lbs: r0(totalLint), cotton_loads: loads.length },
    receipts: receiptRows.slice(0, 80),
    receipts_truncated: Math.max(0, receiptRows.length - 80),
    grade_summary: gradeSummary,
    by_field: yields,
    note: 'Cotton production from gin receipts and bales (bale rows win over the receipt total when present). Lint in pounds; yields in lbs lint per planted acre; loan value in ¢/lb.',
  }
}

// ---------- settlements with itemized discounts ----------

type SettlementRow = { id: string; buyer_id: string | null; settlement_date: string | null; settlement_number: string | null; notes: string | null }
type LineRow = { id: string; settlement_id: string; load_id: string | null; ticket_number: string | null; net_bushels: number | null; gross_revenue: number | null; discounts: number | null; net_revenue: number | null; price_per_bushel: number | null; load: { crop_year: number | null; crop_id: string | null } | null }
type ItemRow = { id: string; settlement_id: string; category: string; deduction_kind: string | null; amount: number | null; description: string | null; rate: number | null }

export async function getSettlements(supabase: SupabaseClient, _ctx: AssistantContext, input: { crop_year?: number; buyer?: string; from_date?: string; to_date?: string; limit?: number }) {
  const [settlements, lines, items, buyers, crops] = await Promise.all([
    allRows<SettlementRow>((f, t) => {
      let q = supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_number, notes').order('settlement_date', { ascending: false }).order('id')
      if (input.from_date) q = q.gte('settlement_date', input.from_date)
      if (input.to_date) q = q.lte('settlement_date', input.to_date)
      return q.range(f, t)
    }),
    allRows<LineRow>((f, t) => supabase.from('settlement_lines').select('id, settlement_id, load_id, ticket_number, net_bushels, gross_revenue, discounts, net_revenue, price_per_bushel, load:loads(crop_year, crop_id)').order('id').range(f, t)),
    allRows<ItemRow>((f, t) => supabase.from('settlement_discount_items').select('id, settlement_id, category, deduction_kind, amount, description, rate').order('id').range(f, t)),
    all<{ id: string; name: string }>(supabase.from('buyers').select('id, name')),
    all<Crop>(supabase.from('crops').select(CROPS_SELECT)),
  ])
  const buyerName = nameOf(buyers)
  const cropName = nameOf(crops)
  const buyer = resolveByName(buyers, input.buyer)
  if (input.buyer && !buyer) return { count: 0, settlements: [], note: `No buyer named "${input.buyer}". Buyers: ${buyers.map((b) => b.name).join(', ') || 'none'}.` }
  const linesBy = new Map<string, LineRow[]>()
  for (const l of lines) { const a = linesBy.get(l.settlement_id) ?? []; a.push(l); linesBy.set(l.settlement_id, a) }
  const itemsBy = new Map<string, ItemRow[]>()
  for (const it of items) { const a = itemsBy.get(it.settlement_id) ?? []; a.push(it); itemsBy.set(it.settlement_id, a) }
  const mode = <T,>(xs: T[]): T | null => { const m = new Map<T, number>(); for (const x of xs) if (x != null) m.set(x, (m.get(x) ?? 0) + 1); let best: T | null = null, n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v }; return best }

  const out = settlements
    .filter((s) => !buyer || s.buyer_id === buyer.id)
    .map((s) => {
      const ls = linesBy.get(s.id) ?? []
      const cropYear = mode(ls.map((l) => l.load?.crop_year ?? null))
      const cropId = mode(ls.map((l) => l.load?.crop_id ?? null))
      const bu = ls.reduce((t, l) => t + num(l.net_bushels), 0)
      const gross = ls.reduce((t, l) => t + num(l.gross_revenue), 0)
      const disc = ls.reduce((t, l) => t + num(l.discounts), 0)
      const net = ls.reduce((t, l) => t + num(l.net_revenue), 0)
      const its = itemsBy.get(s.id) ?? []
      const check = its.length ? sumCheck(its.map((i) => ({ category: i.category, amount: i.amount, deduction_kind: i.deduction_kind })), disc) : null
      return {
        settlement_number: s.settlement_number, date: s.settlement_date, buyer: buyerName(s.buyer_id), crop: cropName(cropId), crop_year: cropYear,
        lines: ls.length, matched_loads: ls.filter((l) => l.load_id).length,
        settled_bu: r0(bu), gross_usd: r2(gross), discounts_usd: r2(disc), net_usd: r2(net), avg_net_price_per_bu: bu > 0 ? r2(net / bu) : null,
        discount_items: its.map((i) => ({ category: DISCOUNT_CATEGORY_LABELS[coerceDiscountCategory(i.category)] ?? i.category, kind: i.deduction_kind ?? 'price', amount_usd: i.amount != null ? r2(num(i.amount)) : null, cents_per_bu: i.amount != null ? centsPerBu(num(i.amount), bu) : null, description: i.description })),
        itemized_vs_stated_mismatch: check?.mismatch ? r2(check.delta) : null,
        notes: s.notes,
      }
    })
    .filter((s) => input.crop_year == null || s.crop_year === num(input.crop_year))
  const limit = Math.min(Math.max(1, num(input.limit) || 40), 100)
  if (out.length === 0) return { count: 0, settlements: [], note: `No settlements found${input.crop_year ? ` for crop year ${input.crop_year}` : ''}${buyer ? ` from ${buyer.name}` : ''}${input.from_date || input.to_date ? ' in that date range' : ''}.` }
  return {
    count: out.length,
    settlements: out.slice(0, limit),
    truncated: Math.max(0, out.length - limit),
    totals: { settled_bu: r0(out.reduce((t, s) => t + s.settled_bu, 0)), gross_usd: r2(out.reduce((t, s) => t + s.gross_usd, 0)), discounts_usd: r2(out.reduce((t, s) => t + s.discounts_usd, 0)), net_usd: r2(out.reduce((t, s) => t + s.net_usd, 0)) },
    note: 'Settlement statements with their itemized discounts (¢/bu = item ÷ settled bushels). Crop year comes through the loads the settlement pays. Prices $/bu.',
  }
}

// ---------- checkoff paid (086) ----------

export async function getCheckoffPaid(supabase: SupabaseClient, _ctx: AssistantContext, input: { crop_year: number; crop?: string }) {
  const cropYear = num(input.crop_year)
  const [settlements, items, loads, crops, buyers] = await Promise.all([
    allRows<{ id: string; buyer_id: string | null; settlement_date: string | null; settlement_number: string | null; settlement_lines: Array<{ load_id: string | null; ticket_number: string | null; net_bushels: number | null }> | null }>((f, t) =>
      supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_number, settlement_lines(load_id, ticket_number, net_bushels)').order('id').range(f, t)),
    allRows<{ settlement_id: string; category: string; amount: number | null; deduction_kind: string | null; description: string | null }>((f, t) =>
      supabase.from('settlement_discount_items').select('settlement_id, category, amount, deduction_kind, description').order('id').range(f, t)),
    allRows<{ id: string; ticket_number: string | null; to_buyer_id: string | null; crop_id: string | null; crop_year: number | null }>((f, t) =>
      supabase.from('loads').select('id, ticket_number, to_buyer_id, crop_id, crop_year').eq('to_type', 'buyer').order('id').range(f, t)),
    all<Crop>(supabase.from('crops').select(CROPS_SELECT)),
    all<{ id: string; name: string }>(supabase.from('buyers').select('id, name')),
  ])
  const cropName = nameOf(crops)
  const buyerName = nameOf(buyers)
  const wantCrop = resolveByName(crops, input.crop)
  const itemsBy = new Map<string, typeof items>()
  for (const it of items) { const a = itemsBy.get(it.settlement_id) ?? []; a.push(it); itemsBy.set(it.settlement_id, a) }
  const loadById = new Map(loads.map((l) => [l.id, l]))
  const byBuyerTicket = new Map<string, typeof loads>()
  for (const l of loads) {
    const t = normalizeTicket(l.ticket_number)
    if (!t || !l.to_buyer_id) continue
    const key = `${l.to_buyer_id}|${t}`
    const a = byBuyerTicket.get(key) ?? []; a.push(l); byBuyerTicket.set(key, a)
  }
  const mode = <T,>(xs: T[]): T | null => { const m = new Map<T, number>(); for (const x of xs) if (x != null) m.set(x, (m.get(x) ?? 0) + 1); let best: T | null = null, n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v }; return best }
  const inputs = settlements.map((s) => {
    const matched: typeof loads = []
    for (const ln of s.settlement_lines ?? []) {
      if (ln.load_id) { const ld = loadById.get(ln.load_id); if (ld) matched.push(ld); continue }
      const cands = byBuyerTicket.get(`${s.buyer_id}|${normalizeTicket(ln.ticket_number)}`) ?? []
      if (cands.length === 1) matched.push(cands[0])
    }
    return {
      settlementId: s.id, buyerId: s.buyer_id, settlementDate: s.settlement_date,
      cropId: mode(matched.map((l) => l.crop_id)), cropYear: mode(matched.map((l) => l.crop_year)),
      settledBu: (s.settlement_lines ?? []).reduce((t, l) => t + num(l.net_bushels), 0),
      items: itemsBy.get(s.id) ?? [],
    }
  })
  const rows = checkoffByCrop(inputs).filter((r) => r.cropYear === cropYear && (!wantCrop || r.cropId === wantCrop.id))
  if (rows.length === 0) {
    return { crop_year: cropYear, count: 0, rows: [], note: `No itemized checkoff on any settlement for crop year ${cropYear}${wantCrop ? ` (${wantCrop.name})` : ''}. Checkoff shows once a settlement's discount lines are itemized (uploads do this automatically; hand-entered settlements can add a Checkoff line on their page).` }
  }
  return {
    crop_year: cropYear,
    count: rows.length,
    rows: rows.map((r) => ({
      crop: cropName(r.cropId) ?? 'Unassigned crop', crop_year: r.cropYear, checkoff_usd: r.dollars, cents_per_bu: r.centsPerBu != null ? r2(r.centsPerBu) : null,
      settled_bu: r0(r.settledBu), settlements: r.settlements,
      by_settlement: r.settlementIds.map((id) => { const s = settlements.find((x) => x.id === id); const d = (itemsBy.get(id) ?? []).filter((i) => i.category === 'checkoff').reduce((t, i) => t + num(i.amount), 0); return { settlement_number: s?.settlement_number ?? null, date: s?.settlement_date ?? null, buyer: buyerName(s?.buyer_id ?? null), checkoff_usd: r2(d) } }),
    })),
    total_checkoff_usd: r2(rows.reduce((t, r) => t + r.dollars, 0)),
    note: 'Checkoff (promotion assessments) paid per crop × crop year from the itemized settlement lines — NOT a quality discount. Some states refund checkoff on request; this is the number to claim. ¢/bu is over the crop year’s settled bushels.',
  }
}

// ---------- bin transfers ----------

export async function getBinTransfers(supabase: SupabaseClient, _ctx: AssistantContext, input: { from_date?: string; to_date?: string; bin?: string; crop?: string; limit?: number }) {
  const [transfers, bins, crops] = await Promise.all([
    allRows<{ id: string; from_bin_id: string | null; to_bin_id: string | null; crop_id: string | null; bushels: number | null; transfer_date: string | null; notes?: string | null }>((f, t) => {
      let q = supabase.from('bin_transfers').select('*').order('transfer_date', { ascending: false }).order('id')
      if (input.from_date) q = q.gte('transfer_date', input.from_date)
      if (input.to_date) q = q.lte('transfer_date', input.to_date)
      return q.range(f, t)
    }),
    all<{ id: string; name_or_number: string }>(supabase.from('bins').select('id, name_or_number')),
    all<Crop>(supabase.from('crops').select(CROPS_SELECT)),
  ])
  const binRows = bins.map((b) => ({ id: b.id, name: b.name_or_number }))
  const binName = nameOf(binRows)
  const cropName = nameOf(crops)
  const wantBin = resolveByName(binRows, input.bin)
  const wantCrop = resolveByName(crops, input.crop)
  const rows = transfers
    .filter((t) => !wantBin || t.from_bin_id === wantBin.id || t.to_bin_id === wantBin.id)
    .filter((t) => !wantCrop || t.crop_id === wantCrop.id)
    .map((t) => ({ date: t.transfer_date, from_bin: binName(t.from_bin_id), to_bin: binName(t.to_bin_id), crop: cropName(t.crop_id), bushels: r0(num(t.bushels)), notes: t.notes ?? null }))
  const limit = Math.min(Math.max(1, num(input.limit) || 60), 200)
  if (rows.length === 0) return { count: 0, transfers: [], note: 'No bin-to-bin transfers recorded for those filters.' }
  const byCrop = new Map<string, number>()
  for (const r of rows) byCrop.set(r.crop ?? 'unknown', (byCrop.get(r.crop ?? 'unknown') ?? 0) + r.bushels)
  return { count: rows.length, transfers: rows.slice(0, limit), truncated: Math.max(0, rows.length - limit), bushels_by_crop: Object.fromEntries(byCrop), note: 'Dry bushels moved bin to bin (the Bin Inventory transfer records).' }
}

// ---------- combine yield entries ----------

export async function getCombineEntries(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number; crop?: string; field?: string }) {
  const cropYear = num(input.crop_year)
  const [entries, bits, crops, bins, plantings] = await Promise.all([
    allRows<CombineRow & { entry_mode?: string | null }>((f, t) => supabase.from('combine_yield_entries').select(`${COMBINE_SELECT}, entry_mode`).eq('crop_year', cropYear).order('entry_date', { ascending: false }).order('id').range(f, t)),
    fetchScopeBits(supabase),
    all<Crop>(supabase.from('crops').select(CROPS_SELECT)),
    all<{ id: string; name_or_number: string }>(supabase.from('bins').select('id, name_or_number')),
    allRows<FieldPlanting>((f, t) => supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres').eq('season_year', cropYear).order('id').range(f, t)),
  ])
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const fieldRows = bits.fields.map((f) => ({ id: f.id, name: f.name_or_number, farm_id: f.farm_id }))
  const fieldName = nameOf(fieldRows)
  const farmName = nameOf(bits.farms)
  const cropName = nameOf(crops)
  const binName = nameOf(bins.map((b) => ({ id: b.id, name: b.name_or_number })))
  const wantCrop = resolveByName(crops, input.crop)
  const wantField = resolveByName(fieldRows, input.field)
  const acresFor = (fieldId: string, cropId: string) => plantings.filter((p) => p.field_id === fieldId && p.crop_id === cropId).reduce((s, p) => s + num(p.planted_acres), 0)
  const rows = entries
    .filter((e) => !scope.active || !scope.fieldIds || scope.fieldIds.has(e.field_id))
    .filter((e) => !wantCrop || e.crop_id === wantCrop.id)
    .filter((e) => !wantField || e.field_id === wantField.id)
    .map((e) => {
      const acres = acresFor(e.field_id, e.crop_id)
      const field = fieldRows.find((f) => f.id === e.field_id)
      return {
        date: e.entry_date, field: fieldName(e.field_id), farm: farmName(field?.farm_id ?? null), crop: cropName(e.crop_id),
        entry_mode: e.entry_mode ?? null, stated_bu: r0(num(e.stated_total_bushels)), adjusted_bu: r0(num(e.adjusted_total_bushels)),
        adjustment_bu_per_acre: e.adjustment_bu_per_acre != null ? r2(num(e.adjustment_bu_per_acre)) : null,
        acres: r2(acres), yield_bu_per_acre: acres > 0 ? r2(num(e.adjusted_total_bushels) / acres) : null,
        destination_bin: binName(e.destination_bin_id), harvest_complete: e.harvest_complete,
      }
    })
  if (rows.length === 0) return { crop_year: cropYear, count: 0, entries: [], note: `No combine-monitor entries for crop year ${cropYear}${wantCrop ? ` (${wantCrop.name})` : ''}.` }
  return { crop_year: cropYear, count: rows.length, entries: rows.slice(0, 120), truncated: Math.max(0, rows.length - 120), total_adjusted_bu: r0(rows.reduce((s, r) => s + r.adjusted_bu, 0)), note: 'Combine-monitor totals per field × crop (stated, then adjusted by the crop’s per-acre combine adjustment). Yield = adjusted bushels ÷ planted acres. The Yields page reconciles these against weighed loads.' }
}

// ---------- rent settlements ----------

export async function getRentSettlements(supabase: SupabaseClient, ctx: AssistantContext, input: { crop_year: number; landowner?: string }) {
  const cropYear = num(input.crop_year)
  const [leases, settlements, landowners, bits] = await Promise.all([
    allRows<LeaseTerm>((f, t) => supabase.from('lease_terms').select('*').order('id').range(f, t)),
    allRows<RentSettlement>((f, t) => supabase.from('rent_settlements').select('*').eq('crop_year', cropYear).order('id').range(f, t)),
    all<{ id: string; name: string }>(supabase.from('landowners').select('id, name')),
    fetchScopeBits(supabase),
  ])
  const scope = buildEntityScope({ entityId: '', farms: bits.farms, fields: bits.fields, entities: bits.entities, grantedEntityIds: ctx.grantedEntityIds })
  const farmName = nameOf(bits.farms)
  const landownerName = nameOf(landowners)
  const want = resolveByName(landowners, input.landowner)
  if (input.landowner && !want) return { crop_year: cropYear, count: 0, leases: [], note: `No landowner named "${input.landowner}". Landowners: ${landowners.map((l) => l.name).join(', ') || 'none'}.` }
  const farmsOf = (lease: LeaseTerm) => {
    const ids = lease.farm_ids?.length ? lease.farm_ids : bits.farms.filter((f) => f.landowner_id === lease.landowner_id).map((f) => f.id)
    return ids.filter((id) => !scope.active || !scope.farmIds || scope.farmIds.has(id))
  }
  const rows = leases
    .filter((l) => !want || l.landowner_id === want.id)
    .map((l) => {
      const terms = parseLeaseTerms(l)
      const farms = farmsOf(l)
      const settled = settlements.filter((s) => s.landowner_id === l.landowner_id && (s.lease_term_id == null || s.lease_term_id === l.id))
      return {
        landowner: landownerName(l.landowner_id), farms: farms.map((id) => farmName(id)).filter(Boolean),
        lease_type: terms.leaseType,
        share_pct: terms.shareTerms ? { default: terms.shareTerms.defaultPct, by_crop: terms.shareTerms.byCrop } : null,
        cash_terms: terms.cashTerms ? { per_acre: terms.cashTerms.perAcre, total_annual: terms.cashTerms.totalAnnual } : null,
        flex_clauses: terms.flexTerms?.map((f) => f.description) ?? [],
        shared_expenses: terms.expenseTerms?.map((e) => ({ category: e.category, landowner_pct: e.landownerPct })) ?? [],
        pricing_method: terms.pricingMethod?.method ?? null,
        payment_timing: terms.paymentTiming,
        settlements: settled.map((s) => {
          const st = s.statement as SettlementStatement | null
          return {
            generated_at: s.generated_at, total_due_usd: s.total_due != null ? r2(num(s.total_due)) : st ? r2(st.totalDue) : null,
            bushels_only: st?.bushelsOnly ?? false,
            sections: st?.sections?.map((sec) => ({ title: sec.title, subtotal_usd: r2(sec.subtotal), lines: sec.lines.map((ln) => ({ item: ln.label, bushels: ln.quantityBu != null ? r0(ln.quantityBu) : null, price_per_bu: ln.pricePerBu != null ? r2(ln.pricePerBu) : null, amount_usd: ln.amount != null ? r2(ln.amount) : null, source: ln.source })) })) ?? [],
          }
        }),
      }
    })
    .filter((r) => !scope.active || r.farms.length > 0)
  if (rows.length === 0) return { crop_year: cropYear, count: 0, leases: [], note: `No leases${want ? ` for ${want.name}` : ''} recorded (Rent Settlement report → Leases).` }
  return {
    crop_year: cropYear, count: rows.length, leases: rows,
    note: 'Lease terms and the recorded rent settlement statements for the year. A lease with no settlement listed has not been settled yet in Turnrow — the Rent Settlement report generates one (it asks for any prices or expenses it cannot find in the records).',
  }
}

// ---------- crop budget ----------

export async function getBudget(supabase: SupabaseClient, _ctx: AssistantContext, input: { year: number; scenario?: string }) {
  const year = num(input.year)
  const [scenarios, crops, entities] = await Promise.all([
    allRows<BudgetScenario>((f, t) => supabase.from('budget_scenarios').select('*').eq('budget_crop_year', year).order('id').range(f, t)),
    all<Crop>(supabase.from('crops').select(CROPS_SELECT)),
    all<{ id: string; name: string }>(supabase.from('entities').select('id, name')),
  ])
  if (scenarios.length === 0) return { year, count: 0, scenarios: [], note: `No crop budget scenarios for ${year} (Reports → Crop Budget Planner).` }
  const lines = await inChunks(scenarios.map((s) => s.id), (chunk) => allRows<BudgetLine>((f, t) => supabase.from('budget_lines').select('*').in('scenario_id', chunk).order('sort_order').order('id').range(f, t)))
  const cropName = nameOf(crops)
  const entityName = nameOf(entities)
  const want = scenarios.length > 1 ? resolveByName(scenarios, input.scenario) : null
  const out = scenarios
    .filter((s) => !want || s.id === want.id)
    .map((s) => {
      const rows = lines.filter((l) => l.scenario_id === s.id).map((l) => {
        const crop = cropName(l.crop_id)
        const math = budgetLineMath(l, null, isCottonName(crop))
        return {
          crop, label: l.label, practice: l.practice, cropping: l.cropping, acres: l.acres != null ? r2(num(l.acres)) : null,
          yield_per_acre: l.yield_per_acre != null ? r2(num(l.yield_per_acre)) : null,
          price_mode: l.price_mode, manual_price: l.manual_price != null ? r2(num(l.manual_price)) : null, basis: l.basis != null ? r2(num(l.basis)) : null,
          cost_per_acre: l.cost_per_acre != null ? r2(num(l.cost_per_acre)) : null,
          effective_price: math.effectivePrice != null ? r2(math.effectivePrice) : null,
          revenue_per_acre: math.revenuePerAcre != null ? r2(math.revenuePerAcre) : null,
          profit_per_acre: math.profitPerAcre != null ? r2(math.profitPerAcre) : null,
          total_revenue_usd: math.totalRevenue != null ? r0(math.totalRevenue) : null,
          total_profit_usd: math.totalProfit != null ? r0(math.totalProfit) : null,
          breakeven_price: math.breakevenPrice != null ? r2(math.breakevenPrice) : null,
          breakeven_yield: math.breakevenYield != null ? r2(math.breakevenYield) : null,
          missing_live_price: math.missingPrice,
          _math: math, _acres: l.acres != null ? num(l.acres) : null,
        }
      })
      const totals = scenarioTotals(rows.map((r) => ({ acres: r._acres, math: r._math })))
      return {
        scenario: s.name, entity: entityName(s.entity_id) ?? 'whole operation', notes: s.notes,
        lines: rows.map(({ _math, _acres, ...rest }) => { void _math; void _acres; return rest }),
        totals: { acres: r2(totals.totalAcres), revenue_usd: r0(totals.totalRevenue), profit_usd: r0(totals.totalProfit), profit_per_acre: totals.weightedProfitPerAcre != null ? r2(totals.weightedProfitPerAcre) : null, incomplete_lines: totals.incompleteLines },
      }
    })
  return {
    year, count: out.length, scenarios: out,
    note: `Crop Budget Planner scenarios (a sandbox — never the actuals). Lines priced 'live' have no quote here (${PRICE_BASIS}) and are flagged missing_live_price; manual-price lines are complete. Cotton prices ¢/lb.`,
  }
}

// ---------- registry entries ----------

const cropYearProp = { type: 'number' as const, description: 'Crop (harvest) year, e.g. 2026' }

export const MODULE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_cotton_marketing',
    description: 'Cotton marketing for a crop year — the Cotton → Marketing engine: every cotton sales contract (buyer, bales committed / delivered / remaining, pricing type and status, ¢/lb price or basis + futures, delivery window, pool ledger), CCC loans (status, bales, principal, equity/MLG), LDPs, the bale disposition board (sold / contract / pool / loan / held), and the sold / awaiting-call / pool / in-loan / held summary. Use for ANY cotton contract, buyer, loan, pool, LDP or bale-disposition question (e.g. "how many bales on our Victoria’s Secret contract").',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp, buyer: { type: 'string', description: 'Optional buyer/merchant name filter' } }, required: ['crop_year'] },
  },
  {
    name: 'get_cotton_production',
    description: 'Cotton production for a crop year: gin receipts (gin, farm, field, bales, lint lbs, seed cotton, turnout), bale and lint totals, the classing/grade summary (classed bales, avg loan ¢/lb, micronaire, staple, strength, color grades) and lint per acre by field — the Cotton pages’ and Bale Quality report’s math.',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp }, required: ['crop_year'] },
  },
  {
    name: 'get_settlements',
    description: 'Buyer settlement statements (grain) with their ITEMIZED discounts: per settlement the buyer, date, crop, settled bushels, gross, total discounts, net, average net $/bu, and each discount item (category, $ and ¢/bu) with an itemized-vs-stated check. Filter by crop year, buyer, or date range.',
    input_schema: { type: 'object', properties: { crop_year: { type: 'number' }, buyer: { type: 'string' }, from_date: { type: 'string', description: 'YYYY-MM-DD' }, to_date: { type: 'string' }, limit: { type: 'number', description: 'Max settlements to return (default 40, max 100)' } } },
  },
  {
    name: 'get_checkoff_paid',
    description: 'Checkoff (promotion assessment) paid per crop × crop year from the itemized settlement lines — dollars, ¢/bu over settled bushels, settlement count, and the per-settlement breakdown. NOT a quality discount; some states refund checkoff on request — this is the number to claim. Use for "how much checkoff did we pay on soybeans this year".',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp, crop: { type: 'string', description: 'Optional crop name' } }, required: ['crop_year'] },
  },
  {
    name: 'get_bin_transfers',
    description: 'Bin-to-bin grain transfers (dry bushels): date, from/to bin, crop, bushels, with totals by crop. Filter by date range, bin, or crop.',
    input_schema: { type: 'object', properties: { from_date: { type: 'string', description: 'YYYY-MM-DD' }, to_date: { type: 'string' }, bin: { type: 'string' }, crop: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'get_combine_entries',
    description: 'Combine-monitor yield entries for a crop year: per field × crop the stated and adjusted bushels, acres, yield per acre, destination bin, harvest-complete flag and entry date.',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp, crop: { type: 'string' }, field: { type: 'string' } }, required: ['crop_year'] },
  },
  {
    name: 'get_rent_settlements',
    description: 'Landowner leases and rent settlements for a crop year: each lease’s type and terms (share % by crop, cash rent, flex clauses, shared expenses, pricing method, payment timing), the farms it covers, and the recorded settlement statement(s) with sections, lines and total due — the Rent Settlement report’s records.',
    input_schema: { type: 'object', properties: { crop_year: cropYearProp, landowner: { type: 'string' } }, required: ['crop_year'] },
  },
  {
    name: 'get_budget',
    description: 'Crop Budget Planner scenarios for a budget year: each scenario’s crop lines (acres, yield, price, basis, cost/acre → effective price, revenue and profit per acre and total, breakeven price and yield) and scenario totals.',
    input_schema: { type: 'object', properties: { year: { type: 'number', description: 'Budget crop year' }, scenario: { type: 'string', description: 'Optional scenario name' } }, required: ['year'] },
  },
]

export const MODULE_STATUS_LABELS: Record<string, string> = {
  get_cotton_marketing: 'Checking your cotton contracts and loans…',
  get_cotton_production: 'Checking your gin receipts and bales…',
  get_settlements: 'Reading your settlement statements…',
  get_checkoff_paid: 'Adding up your checkoff…',
  get_bin_transfers: 'Checking your bin transfers…',
  get_combine_entries: 'Checking your combine entries…',
  get_rent_settlements: 'Checking your leases and rent settlements…',
  get_budget: 'Opening your crop budget…',
}
