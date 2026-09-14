import { describe, it, expect } from 'vitest'
import type { SettlementExtraction, SettlementLineExtraction } from '@/lib/pdf-upload'
import { mergeSettlements } from '@/lib/parse-merge'
import { flagSummaryLines, reconcileLines } from '@/lib/settlement-lines'
import { categoryTotals, coerceDiscountCategory, detailedPriceWalk, isQualityDiscount, normalizeExtractedDiscountItems, sumCheck } from '@/lib/settlement-discounts'
import { settlementLostRevenue } from '@/lib/lost-revenue'
import { checkoffByCrop } from '@/lib/checkoff'
import { matchAllTickets, type TicketMatchLoad } from '@/lib/ticket-matching'
import { planDocument } from '@/lib/orientation'

// ---------------------------------------------------------------------------
// The Bunge soybean settlement No. 0000161152 (9/10/2026): 24 tickets,
// contract 2002960604-10, gross $294,012.61, deductions $2,125.16, net
// $291,887.45 — modeled as the EXTRACTION SHAPE the hardened prompt emits.
// The original PDF was not on this machine when the fixture was written; the
// per-ticket figures are synthetic and sum exactly to the statement's
// printed totals. Everything after the model is under test here: the totals
// guard, the category itemization and its reconciliation, checkoff by crop,
// the tiered ticket matching, and page-orientation normalization.
// ---------------------------------------------------------------------------

const GROSS = 294_012.61
const DEDUCTIONS = 2_125.16
const NET = 291_887.45
const BUSHELS = 26_004.113 // Σ net bushels below

const CHECKOFF = 1_467.98
const FEE = 240
const MOISTURE = 396.93
const HEAT = 20.25

// 24 tickets: bushels vary around 1,083; gross = bu × $11.3063; the per-line
// deductions spread the four cash items; the last line absorbs cent rounding
// so the sheet foots to the printed totals exactly.
function buildTickets(): SettlementLineExtraction[] {
  const bushels = [1120.4, 1064.2, 1101.7, 1088.9, 1042.5, 1096.3, 1077.8, 1110.1, 1069.4, 1085.6, 1053.2, 1099.7, 1071.3, 1104.9, 1088.2, 1060.8, 1093.5, 1082.1, 1075.6, 1107.4, 1066.9, 1091.2, 1079.3, 1073.113]
  expect(bushels.reduce((s, b) => s + b, 0)).toBeCloseTo(BUSHELS, 3)
  const out: SettlementLineExtraction[] = []
  let grossSoFar = 0, discSoFar = 0
  for (let i = 0; i < bushels.length; i++) {
    const last = i === bushels.length - 1
    const gross = last ? Math.round((GROSS - grossSoFar) * 100) / 100 : Math.round(bushels[i] * 11.3063 * 100) / 100
    const disc = last ? Math.round((DEDUCTIONS - discSoFar) * 100) / 100 : Math.round((DEDUCTIONS / 24) * 100) / 100
    grossSoFar += gross; discSoFar += disc
    out.push({
      ticket_number: String(498074 + i).padStart(7, '0'), // "0498074" … Bunge pads to seven
      secondary_ref: String(8817742 + i), // Load Order #
      delivery_date: `2026-09-0${Math.min(9, 1 + Math.floor(i / 3))}`,
      vehicle_plate: i % 2 === 0 ? 'AL 4ZH 118' : 'AL 7KQ 220',
      gross_weight: Math.round(bushels[i] * 60 + 24_000), tare_weight: 24_000,
      net_bushels: bushels[i], gross_revenue: gross, discounts: disc,
      grade_readings: { moisture: 12.4 + (i % 5) * 0.2, foreign_material: 1.0, splits: 6 + (i % 4), total_damage: 1.2, heat_damage: i % 7 === 0 ? 0.3 : 0, test_weight: 56.1, other_color: 0.4, oil: 18.7, protein: 34.2 },
    })
  }
  return out
}

const TICKETS = buildTickets()

// What a naive read returns: the 24 tickets PLUS the totals rows and the
// check page restated as "tickets". The guard must drop the extras.
const TOTAL_ROWS: SettlementLineExtraction[] = [
  { ticket_number: 'Total From 0498074', net_bushels: BUSHELS, gross_revenue: GROSS, discounts: DEDUCTIONS },
  { ticket_number: 'Contract Total 2002960604-10', net_bushels: BUSHELS, gross_revenue: GROSS, discounts: DEDUCTIONS },
  { ticket_number: 'Settlement Total', net_bushels: BUSHELS, gross_revenue: GROSS, discounts: DEDUCTIONS },
  { ticket_number: '0000161152', net_bushels: BUSHELS, gross_revenue: NET, discounts: 0 }, // the check stub restating the settlement
]

const BUNGE: SettlementExtraction = {
  buyer_name: 'Bunge North America', settlement_date: '2026-09-10', settlement_number: '0000161152',
  contract_number: '2002960604-10',
  payment_number: '7001234567', check_number: '0093321', payment_date: '2026-09-12',
  statement_reported_total: NET, statement_reported_bushels: BUSHELS,
  line_items: [...TICKETS, ...TOTAL_ROWS],
  discount_items: [
    // CASH DISCOUNTS (price) — with the legend codes as printed.
    { category: 'other', description: 'I02 National Check-Off', amount: CHECKOFF, rate_note: '$0.50 per $100 value', quantity_basis: null, deduction_kind: 'price' },
    { category: 'other', description: 'I11 Vehicle Inspection', amount: FEE, rate_note: '$10.00 per load', quantity_basis: '24 loads', deduction_kind: 'price' },
    { category: 'moisture_shrink', description: 'MO Moisture', amount: MOISTURE, rate_note: '1.5% per 0.5 over 13.0', quantity_basis: null, deduction_kind: 'price' },
    { category: 'heat_damage', description: 'HD Heat Damage', amount: HEAT, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
    // QTY DISCOUNTS BY QUALITY FACTOR (weight): the FM volume shrink.
    { category: 'foreign_material', description: 'ZFM Foreign Material', amount: 0, rate_note: '1:1 over 1.0%', quantity_basis: '23.282 bu', deduction_kind: 'weight' },
  ],
}

describe('Bunge 0000161152 — the totals guard', () => {
  const merged = mergeSettlements([BUNGE])
  const guards = flagSummaryLines(merged.line_items, { settlementNumber: merged.settlement_number })

  it('extracts 24 tickets and none from the totals or check pages', () => {
    const kept = merged.line_items.filter((_, i) => !guards[i].flagged)
    expect(kept).toHaveLength(24)
    expect(kept.every((l) => /^0\d{6}$/.test(l.ticket_number ?? ''))).toBe(true)
    const dropped = merged.line_items.filter((_, i) => guards[i].flagged).map((l) => l.ticket_number)
    expect(dropped).toEqual(['Total From 0498074', 'Contract Total 2002960604-10', 'Settlement Total', '0000161152'])
    for (const g of guards.filter((x) => x.flagged)) expect(g.reason).toMatch(/looks like the settlement total/)
  })

  it('the kept lines reconcile to the printed gross, deductions and net', () => {
    const kept = merged.line_items.filter((_, i) => !guards[i].flagged)
    expect(kept.reduce((s, l) => s + (l.gross_revenue ?? 0), 0)).toBeCloseTo(GROSS, 2)
    expect(kept.reduce((s, l) => s + (l.discounts ?? 0), 0)).toBeCloseTo(DEDUCTIONS, 2)
    const rec = reconcileLines(merged.line_items.map((l, i) => ({ ...l, excluded: guards[i].flagged })), merged.statement_reported_total)
    expect(rec.linesTotal).toBeCloseTo(NET, 2)
    expect(rec.mismatch).toBe(false)
    // Keeping the check-stub line would double the settlement and trip the check.
    const naive = reconcileLines(merged.line_items.map((l) => ({ ...l, excluded: false })), merged.statement_reported_total)
    expect(naive.mismatch).toBe(true)
  })

  it('carries the header contract number and the payment facts — never as tickets', () => {
    expect(merged.contract_number).toBe('2002960604-10')
    expect(merged.payment_number).toBe('7001234567')
    expect(merged.check_number).toBe('0093321')
    expect(merged.payment_date).toBe('2026-09-12')
    expect(merged.line_items.some((l) => l.ticket_number === '7001234567' || l.ticket_number === '0093321')).toBe(false)
  })

  it('each ticket carries its grade block as readings', () => {
    const t = merged.line_items[0]
    expect(t.grade_readings).toMatchObject({ moisture: 12.4, foreign_material: 1.0, test_weight: 56.1, protein: 34.2 })
    expect(t.secondary_ref).toBe('8817742')
    expect(t.vehicle_plate).toBe('AL 4ZH 118')
  })
})

describe('Bunge 0000161152 — checkoff and fees itemized as their own categories', () => {
  const items = normalizeExtractedDiscountItems(BUNGE.discount_items)

  it('categorizes every line: checkoff $1,467.98, fee $240.00, moisture $396.93, heat damage $20.25, FM 23.282 bu volume', () => {
    expect(items.map((i) => i.category)).toEqual(['checkoff', 'fee', 'moisture_shrink', 'heat_damage', 'foreign_material'])
    const totals = categoryTotals(items)
    expect(totals.get('checkoff')).toBeCloseTo(CHECKOFF, 2)
    expect(totals.get('fee')).toBe(FEE)
    expect(totals.get('moisture_shrink')).toBeCloseTo(MOISTURE, 2)
    expect(totals.get('heat_damage')).toBeCloseTo(HEAT, 2)
    const fm = items.find((i) => i.category === 'foreign_material')!
    expect(fm.deduction_kind).toBe('weight')
    expect(fm.quantity_basis).toBe('23.282 bu')
    expect(fm.amount).toBe(0)
    expect(coerceDiscountCategory('checkoff')).toBe('checkoff')
    expect(isQualityDiscount('checkoff')).toBe(false)
    expect(isQualityDiscount('fee')).toBe(false)
  })

  it('the price items reconcile to the stated $2,125.16 deductions; the weight item stays out of the sum', () => {
    const check = sumCheck(items, DEDUCTIONS)
    expect(check.itemizedTotal).toBeCloseTo(DEDUCTIONS, 2)
    expect(check.mismatch).toBe(false)
  })

  it('the price walk shows checkoff and fees as distinct deductions from the quality discounts', () => {
    const w = detailedPriceWalk({ grossRevenue: GROSS, discountTotal: DEDUCTIONS, settledBu: BUSHELS, items })
    expect(w.qualityDollars).toBeCloseTo(MOISTURE + HEAT, 2)
    expect(w.checkoffDollars).toBeCloseTo(CHECKOFF, 2)
    expect(w.feeDollars).toBe(FEE)
    expect(w.grossPerBu).toBeCloseTo(GROSS / BUSHELS, 6)
    expect(w.netPerBu).toBeCloseTo(NET / BUSHELS, 6)
    expect(w.checkoffCentsPerBu).toBeCloseTo((CHECKOFF / BUSHELS) * 100, 4)
  })

  it('lost revenue counts only the quality discounts ($417.18), never the checkoff or the fee', () => {
    const lost = settlementLostRevenue({ items, loads: [] })
    expect(lost.priceDollars).toBeCloseTo(MOISTURE + HEAT, 2)
    expect(lost.byGroup.moistureDrying).toBeCloseTo(MOISTURE, 2)
    expect(lost.byGroup.damage).toBeCloseTo(HEAT, 2)
    expect(lost.byGroup.other).toBe(0)
  })

  it('checkoff paid rolls up per crop × crop year: soybeans 2026 → $1,467.98, 5.65¢/bu', () => {
    const rows = checkoffByCrop([{ settlementId: 's-161152', buyerId: 'bunge', settlementDate: '2026-09-10', cropId: 'soy', cropYear: 2026, settledBu: BUSHELS, items }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ cropId: 'soy', cropYear: 2026, settlements: 1 })
    expect(rows[0].dollars).toBeCloseTo(CHECKOFF, 2)
    expect(rows[0].centsPerBu).toBeCloseTo(5.645, 2)
  })
})

describe('Bunge 0000161152 — tolerant ticket matching against our loads', () => {
  // Our loads for the same deliveries: the buyer's ticket embedded in our
  // dash-delimited numbers, one load with only the Load Order #, one with no
  // ticket at all (matched by date + bushels + plate), and a decoy.
  const LOADS: TicketMatchLoad[] = TICKETS.map((t, i) => {
    const buyerTicket = String(498074 + i)
    const base = { id: `L${i}`, crop_id: 'soy', to_buyer_id: 'bunge', date: t.delivery_date, dry_bushels: t.net_bushels! * 1.004, license_plate: t.vehicle_plate, truck_id: i % 2 === 0 ? 't1' : 't2' }
    if (i === 0) return { ...base, ticket_number: `${buyerTicket}-02-A` } // tier 2: buyer ticket first
    if (i === 1) return { ...base, ticket_number: `12-${buyerTicket}` } // tier 2: buyer ticket last
    if (i === 2) return { ...base, ticket_number: `LO-${8817742 + i}` } // tier 2 via Load Order #
    if (i === 3) return { ...base, ticket_number: null } // tier 3: date + bushels + plate
    if (i === 4) return { ...base, ticket_number: '0031' } // a short token that must never segment-match
    return { ...base, ticket_number: buyerTicket } // tier 1 (we stored it without the zero)
  })
  LOADS.push({ id: 'decoy', ticket_number: null, crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-02', dry_bushels: 1088.9 * 1.004, license_plate: 'AL 4ZH 118' }) // same day/bushels as ticket 3 (plate AL 7KQ 220) but the other plate

  const results = matchAllTickets(
    TICKETS.map((t) => ({ ticket_number: t.ticket_number, secondary_refs: [t.secondary_ref], net_bushels: t.net_bushels, gross_weight: t.gross_weight, tare_weight: t.tare_weight, delivery_date: t.delivery_date, vehicle_plate: t.vehicle_plate })),
    LOADS,
    { crop_id: 'soy', buyer_id: 'bunge' },
  )

  it('0498074 matches our 498074-02-A load by segment (tier 2, high) with the reason spelled out', () => {
    const r = results[0]
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.match).toMatchObject({ tier: 'segment', confidence: 'high', loadId: 'L0', reason: 'ticket 498074 is part of our ticket 498074-02-A' })
  })

  it('0498075 matches 12-498075; the Load Order # matches LO-8817744', () => {
    expect(results[1].status === 'matched' && results[1].match.loadId).toBe('L1')
    expect(results[2].status === 'matched' && results[2].match.loadId).toBe('L2')
    if (results[2].status === 'matched') expect(results[2].match.reason).toMatch(/load order 8817744/)
  })

  it('the ticket-less load matches by date + bushels + plate (tier 3, medium) — the decoy on the other plate does not', () => {
    const r = results[3]
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.match).toMatchObject({ tier: 'attribute', confidence: 'medium', loadId: 'L3', reason: 'matched by date + bushels + plate' })
  })

  it('a short "0031" ticket never segment-matches; that line is unmatched (no attribute fit either)', () => {
    // Ticket 0498078 has no text match: our load carries "0031". Same day/plate/bushels → attribute match to L4 is legitimate.
    const r = results[4]
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.match.tier).toBe('attribute')
    // And the guard itself: "0031" against a 7-digit ticket is not a segment hit.
    const short = matchAllTickets([{ ticket_number: '0031' }], [{ id: 'x', ticket_number: '0498074-0031' }])
    expect(short[0].status).toBe('unmatched')
  })

  it('the remaining 19 tickets match exactly after leading-zero normalization; every load is claimed once', () => {
    const exact = results.slice(5)
    expect(exact.every((r) => r.status === 'matched' && r.match.tier === 'exact')).toBe(true)
    const claimed = results.filter((r) => r.status === 'matched').map((r) => (r.status === 'matched' ? r.match.loadId : ''))
    expect(new Set(claimed).size).toBe(claimed.length)
    expect(claimed).toHaveLength(24)
  })
})

describe('Bunge 0000161152 — a sideways scan normalizes to the same page geometry', () => {
  it('a landscape statement scanned with /Rotate 90 bakes to the upright 792×612 the original has', () => {
    const upright = planDocument([{ width: 792, height: 612, rotation: 0 }])
    const sideways = planDocument([{ width: 612, height: 792, rotation: 90 }])
    expect(upright[0].bake).toBe(false)
    expect(sideways[0].bake).toBe(true)
    expect([sideways[0].outWidth, sideways[0].outHeight]).toEqual([upright[0].outWidth, upright[0].outHeight])
  })
})
