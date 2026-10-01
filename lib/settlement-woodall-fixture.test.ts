import { describe, it, expect } from 'vitest'
import type { SettlementExtraction, SettlementLineExtraction } from '@/lib/pdf-upload'
import { mergeSettlements } from '@/lib/parse-merge'
import { flagSummaryLines, reconcileLines } from '@/lib/settlement-lines'
import { categoryTotals, isQualityDiscount, normalizeExtractedDiscountItems, specialDiscountCategory, sumCheck, SPECIAL_DISCOUNT_LEGEND } from '@/lib/settlement-discounts'
import { matchAllTickets, matchTicket, normalizeTicket, suffixTail, ticketTails, vehicleCorroboration, loadTicketKeys, type TicketMatchLoad } from '@/lib/ticket-matching'

// ---------------------------------------------------------------------------
// Woodall Grain settlement 76838: 29 tickets on contract 93118 (priced
// 42,969.999 bu, settled 30,647.142 bu after this statement, remaining
// 12,322.857 bu), gross $143,198.73, the only deduction a per-ticket
// "Checkoff\SPARC" line totaling $306.47 (Alabama Dept of Agriculture), net
// $142,892.26. Woodall prints long ticket numbers (530092988), exact net LB
// per ticket, and a Vehicle Id like "Green/Tinus" (truck / driver). Our
// drivers write only the tail ("2988-12"). The original PDF was not on this
// machine when the fixture was written; per-ticket figures are synthetic
// and sum exactly to the printed totals. Everything after the model is under
// test: the totals / summary guard, the checkoff + special-discount legend,
// the suffix match tier with its corroboration rules, the write-back
// payload, and the contract cross-check.
// ---------------------------------------------------------------------------

const GROSS = 143_198.73
const CHECKOFF = 306.47
const NET = 142_892.26
const SETTLED_BU = 30_647.142
const PRICED_BU = 42_969.999
const REMAINING_BU = 12_322.857

// 29 tickets: ~1,057 bu each at $4.6725; the last absorbs rounding. Net LB is
// bushels × 56 (corn), exact as Woodall prints it.
function buildTickets(): SettlementLineExtraction[] {
  const bushels = [1078.6, 1042.9, 1061.2, 1049.7, 1070.3, 1055.8, 1038.4, 1066.1, 1052.5, 1073.9, 1047.2, 1059.6, 1044.8, 1068.7, 1051.1, 1062.4, 1046.3, 1075.2, 1053.9, 1057.6, 1040.5, 1064.8, 1050.2, 1069.4, 1045.7, 1058.3, 1043.6, 1067.9, 1050.542]
  expect(bushels.reduce((s, b) => s + b, 0)).toBeCloseTo(SETTLED_BU, 3)
  const out: SettlementLineExtraction[] = []
  let grossSoFar = 0, ckSoFar = 0
  for (let i = 0; i < bushels.length; i++) {
    const last = i === bushels.length - 1
    const gross = last ? Math.round((GROSS - grossSoFar) * 100) / 100 : Math.round(bushels[i] * 4.6725 * 100) / 100
    const ck = last ? Math.round((CHECKOFF - ckSoFar) * 100) / 100 : Math.round((CHECKOFF / 29) * 100) / 100
    grossSoFar += gross; ckSoFar += ck
    out.push({
      ticket_number: String(530092960 + i), // 530092960 … 530092988
      secondary_ref: null,
      delivery_date: `2026-08-${String(Math.min(31, 20 + Math.floor(i / 3))).padStart(2, '0')}`,
      vehicle_plate: i % 3 === 0 ? 'Green/Tinus' : i % 3 === 1 ? 'White/Avery' : 'Red/Tinus',
      gross_weight: null, tare_weight: null,
      net_weight: Math.round(bushels[i] * 56),
      net_bushels: bushels[i], gross_revenue: gross, discounts: ck,
      special_discount_codes: null,
      grade_readings: { grade: '1 US #1', moisture: 14.2 + (i % 4) * 0.1, foreign_material: 0.5, test_weight: 56.4, total_damage: 0.8, heat_damage: null, splits: null, other_color: null, oil: null, protein: null },
    })
  }
  return out
}

const TICKETS = buildTickets()

// What a naive read also returns: the Totals row, the Deduction Summary and
// the Remit amount as "tickets". The guard must drop all three.
const TOTAL_ROWS: SettlementLineExtraction[] = [
  { ticket_number: 'Totals', net_bushels: SETTLED_BU, gross_revenue: GROSS, discounts: CHECKOFF },
  { ticket_number: 'Deduction Summary', net_bushels: 0, gross_revenue: 0, discounts: CHECKOFF },
  { ticket_number: '76838', net_bushels: SETTLED_BU, gross_revenue: NET, discounts: 0 }, // Remit / Payment Amount restating the settlement
]

const WOODALL: SettlementExtraction = {
  buyer_name: 'Woodall Grain Company', settlement_date: '2026-09-02', settlement_number: '76838',
  contract_number: '93118',
  payment_number: null, check_number: '41877', payment_date: '2026-09-03',
  statement_reported_total: NET, statement_reported_gross: GROSS, statement_reported_bushels: SETTLED_BU,
  contract_summary: { contract_number: '93118', priced_bushels: PRICED_BU, settled_bushels: SETTLED_BU, remaining_bushels: REMAINING_BU },
  line_items: [...TICKETS, ...TOTAL_ROWS],
  discount_items: [
    { category: 'other', description: 'Checkoff\\SPARC — Alabama Dept of Agriculture', amount: CHECKOFF, rate_note: '$0.01 per bu', quantity_basis: `${SETTLED_BU} bu`, deduction_kind: 'price' },
  ],
}

describe('Woodall 76838 — the totals guard and reconciliation', () => {
  const merged = mergeSettlements([WOODALL])
  const guards = flagSummaryLines(merged.line_items, { settlementNumber: merged.settlement_number })

  it('keeps the 29 tickets and drops the Totals row, the Deduction Summary and the Remit amount', () => {
    const kept = merged.line_items.filter((_, i) => !guards[i].flagged)
    expect(kept).toHaveLength(29)
    expect(kept.every((l) => /^5300929\d\d$/.test(l.ticket_number ?? ''))).toBe(true)
    expect(merged.line_items.filter((_, i) => guards[i].flagged).map((l) => l.ticket_number)).toEqual(['Totals', 'Deduction Summary', '76838'])
  })

  it('reconciles gross $143,198.73 − $306.47 = $142,892.26', () => {
    const kept = merged.line_items.filter((_, i) => !guards[i].flagged)
    expect(kept.reduce((s, l) => s + (l.gross_revenue ?? 0), 0)).toBeCloseTo(GROSS, 2)
    expect(kept.reduce((s, l) => s + (l.discounts ?? 0), 0)).toBeCloseTo(CHECKOFF, 2)
    const rec = reconcileLines(merged.line_items.map((l, i) => ({ ...l, excluded: guards[i].flagged })), merged.statement_reported_total)
    expect(rec.linesTotal).toBeCloseTo(NET, 2)
    expect(rec.mismatch).toBe(false)
    expect(merged.statement_reported_gross).toBeCloseTo(GROSS, 2)
  })

  it('carries the contract summary through the merge and links the contract', () => {
    expect(merged.contract_number).toBe('93118')
    expect(merged.contract_summary).toEqual({ contract_number: '93118', priced_bushels: PRICED_BU, settled_bushels: SETTLED_BU, remaining_bushels: REMAINING_BU })
    expect(PRICED_BU - SETTLED_BU).toBeCloseTo(REMAINING_BU, 3)
  })

  it('each ticket carries the grade text and the MST / FM / TW / DMG readings, and the exact net pounds', () => {
    const t = merged.line_items[0]
    expect(t.grade_readings).toMatchObject({ grade: '1 US #1', moisture: 14.2, foreign_material: 0.5, test_weight: 56.4, total_damage: 0.8 })
    expect(t.net_weight).toBe(Math.round(1078.6 * 56))
    expect(t.vehicle_plate).toBe('Green/Tinus')
  })
})

describe('Woodall 76838 — Checkoff\\SPARC is checkoff, the only deduction; special-discount legend', () => {
  const items = normalizeExtractedDiscountItems(WOODALL.discount_items)

  it('files the SPARC line as checkoff ($306.47) under the agency wording; quality discounts are zero', () => {
    expect(items).toHaveLength(1)
    expect(items[0].category).toBe('checkoff')
    expect(items[0].description).toMatch(/Alabama Dept of Agriculture/)
    expect(categoryTotals(items).get('checkoff')).toBeCloseTo(CHECKOFF, 2)
    expect(isQualityDiscount('checkoff')).toBe(false)
    expect(sumCheck(items, CHECKOFF).mismatch).toBe(false)
  })

  it('maps the Special Discounts legend: Sour → musty_sour, Heating → heat_damage, DLQ → damage; Aflatoxin / Infested / Product stay other', () => {
    expect(SPECIAL_DISCOUNT_LEGEND.map((l) => `${l.code} ${l.label} → ${l.category}`)).toEqual([
      '1 Aflatoxin → other', '2 Sour → musty_sour', '3 Infested/Weevily → other', '4 Heating → heat_damage', '5 DLQ → damage', '6 Product → other',
    ])
    expect(specialDiscountCategory('Special Disc 2 — Sour')).toBe('musty_sour')
    expect(specialDiscountCategory('Heating')).toBe('heat_damage')
    expect(specialDiscountCategory('5 DLQ')).toBe('damage')
    expect(specialDiscountCategory('1 Aflatoxin')).toBe('other')
    const sour = normalizeExtractedDiscountItems([{ category: 'other', description: 'Special Disc 2 Sour', amount: 12.5, rate_note: null, quantity_basis: null, deduction_kind: 'price' }])
    expect(sour[0].category).toBe('musty_sour')
    // An explicit quality category from the model is never overridden by the legend.
    const kept = normalizeExtractedDiscountItems([{ category: 'moisture_shrink', description: 'Sour', amount: 1, rate_note: null, quantity_basis: null, deduction_kind: 'price' }])
    expect(kept[0].category).toBe('moisture_shrink')
  })
})

describe('Woodall 76838 — suffix matching (tier 2b): long buyer tickets stored as short tails', () => {
  const t28 = TICKETS[28] // 530092988 · 1,050.542 bu · 58,830 LB · White/Avery · 2026-08-29

  it('the tail helpers: segments ≥ 4 digits and the numeric core; shorter tails never count', () => {
    expect(ticketTails('2988-12')).toEqual(['2988'])
    expect(ticketTails('92988-A')).toEqual(['92988'])
    expect(ticketTails('#92988')).toEqual(['92988'])
    expect(ticketTails('12-2988')).toEqual(['2988'])
    expect(ticketTails('988-1')).toEqual([]) // never glued into "9881"
    expect(suffixTail('530092988', '2988-12')).toBe('2988')
    expect(suffixTail('530092988', '92988-A')).toBe('92988')
    expect(suffixTail('530092988', '12-2988')).toBe('2988')
    expect(suffixTail('530092988', '988')).toBeNull()
    expect(suffixTail('530092988', '1292988')).toBe('92988') // the last five digits agree inside our longer number
    expect(suffixTail('530092988', 'TKT 7092988')).toBe('092988') // six trailing digits agree here
    expect(suffixTail('530092988', '530092988')).toBeNull() // equal is tier 1, not a suffix
  })

  it('"2988-12" ↔ 530092988 with the 58,847 LB and 8/29 corroboration → suffix, high, pre-checked', () => {
    const loads: TicketMatchLoad[] = [
      { id: 'ours', ticket_number: '2988-12', crop_id: 'corn', to_buyer_id: 'woodall', date: t28.delivery_date, net_weight: t28.net_weight, dry_bushels: t28.net_bushels! * 1.003, truck_name: 'White' },
      { id: 'other', ticket_number: '4411-07', crop_id: 'corn', to_buyer_id: 'woodall', date: '2026-08-10', net_weight: 60_000 },
    ]
    const r = matchTicket({ ticket_number: t28.ticket_number, net_weight: t28.net_weight, net_bushels: t28.net_bushels, delivery_date: t28.delivery_date, vehicle_plate: t28.vehicle_plate }, loads, { buyer_id: 'woodall', crop_id: 'corn', settlement_tickets: TICKETS.map((t) => t.ticket_number) })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') {
      expect(r.match.tier).toBe('suffix')
      expect(r.match.confidence).toBe('high')
      expect(r.match.loadId).toBe('ours')
      expect(r.match.reason).toMatch(/our 2988-12 ends the buyer's 530092988 \(last 4 digits …2988\)/)
      expect(r.match.reason).toMatch(/date \+ pounds \+ truck agree/)
    }
  })

  it('a five-digit tail matches on its own (medium, "check"); with the date agreeing it is high', () => {
    const base: TicketMatchLoad = { id: 'ours', ticket_number: '92988-A', crop_id: 'corn', to_buyer_id: 'woodall' }
    const line = { ticket_number: '530092988', net_weight: 58_847, delivery_date: '2026-08-29', vehicle_plate: 'Green/Tinus' }
    const alone = matchTicket(line, [{ ...base, date: '2026-07-01', net_weight: 40_000 }], { settlement_tickets: ['530092988'] })
    expect(alone.status).toBe('matched')
    if (alone.status === 'matched') {
      expect(alone.match).toMatchObject({ tier: 'suffix', confidence: 'medium', loadId: 'ours' })
      expect(alone.match.reason).toMatch(/last 5 digits …92988\) · check the date and weight/)
    }
    const dated = matchTicket(line, [{ ...base, date: '2026-08-30' }], { settlement_tickets: ['530092988'] })
    expect(dated.status === 'matched' && dated.match.tier === 'suffix' && dated.match.confidence).toBe('high')
    // Five agreeing digits at the END of our longer number count the same way.
    const inside = matchTicket(line, [{ id: 'ours', ticket_number: '1292988', date: '2026-07-01' }], { settlement_tickets: ['530092988'] })
    expect(inside.status === 'matched' && inside.match.loadId).toBe('ours')
  })

  it('a four-digit tail needs one attribute: alone it is not a suffix match', () => {
    const base: TicketMatchLoad = { id: 'ours', ticket_number: '2988-12', crop_id: 'corn', to_buyer_id: 'woodall' }
    const line = { ticket_number: '530092988', net_weight: 58_847, delivery_date: '2026-08-29' }
    expect(matchTicket(line, [{ ...base, date: '2026-07-01', net_weight: 40_000 }], { settlement_tickets: ['530092988'] }).status).toBe('unmatched')
    const dateOnly = matchTicket(line, [{ ...base, date: '2026-08-30' }], { settlement_tickets: ['530092988'] })
    expect(dateOnly.status === 'matched' && dateOnly.match.confidence).toBe('medium')
  })

  it('two buyer tickets on the statement sharing the tail, or two of our loads ending the same way → the user picks', () => {
    const loads: TicketMatchLoad[] = [{ id: 'ours', ticket_number: '2988-12', date: '2026-08-29', net_weight: 58_847 }]
    const r = matchTicket({ ticket_number: '530092988', net_weight: 58_847, delivery_date: '2026-08-29' }, loads, { settlement_tickets: ['530092988', '530082988'] })
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') expect(r.candidates[0].tier).toBe('suffix')
    const twoOfOurs = matchTicket({ ticket_number: '530092988' }, [{ id: 'a', ticket_number: '92988-1' }, { id: 'b', ticket_number: '92988-2' }], { settlement_tickets: ['530092988'] })
    expect(twoOfOurs.status).toBe('ambiguous')
  })

  it('a 3-digit tail is refused — it falls to the attribute tier only', () => {
    const loads: TicketMatchLoad[] = [{ id: 'ours', ticket_number: '988-12', date: '2026-08-29', net_weight: 58_847, dry_bushels: 1_050.5 }]
    const r = matchTicket({ ticket_number: '530092988', net_weight: 58_847, net_bushels: 1_050.542, delivery_date: '2026-08-29' }, loads, { settlement_tickets: ['530092988'] })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.match.tier).toBe('attribute')
  })

  it('the Vehicle Id corroborates by truck name or driver, never by an unrelated word', () => {
    expect(vehicleCorroboration('Green/Tinus', { truck_name: 'Green', license_plate: null, driver: null })).toEqual(['truck'])
    expect(vehicleCorroboration('Green/Tinus', { truck_name: 'Truck 21', license_plate: null, driver: 'J. Tinus' })).toEqual(['driver'])
    expect(vehicleCorroboration('Green/Tinus', { truck_name: 'White', license_plate: 'AL 4ZH 118', driver: 'Avery' })).toEqual([])
    expect(vehicleCorroboration('AL 4ZH 118', { truck_name: 'White', license_plate: 'AL-4ZH-118', driver: null })).toEqual(['plate'])
  })

  it('matches the whole statement: tails for the first three loads, exact for the rest, every load claimed once', () => {
    const loads: TicketMatchLoad[] = TICKETS.map((t, i) => {
      const digits = t.ticket_number!
      const base = { id: `L${i}`, crop_id: 'corn', to_buyer_id: 'woodall', date: t.delivery_date, net_weight: t.net_weight, dry_bushels: t.net_bushels! * 1.002, truck_name: i % 3 === 0 ? 'Green' : i % 3 === 1 ? 'White' : 'Red' }
      if (i === 0) return { ...base, ticket_number: `${digits.slice(-4)}-12` }
      if (i === 1) return { ...base, ticket_number: `${digits.slice(-5)}-A` }
      if (i === 2) return { ...base, ticket_number: `12-${digits.slice(-4)}` }
      return { ...base, ticket_number: digits }
    })
    const results = matchAllTickets(TICKETS.map((t) => ({ ticket_number: t.ticket_number, net_weight: t.net_weight, net_bushels: t.net_bushels, delivery_date: t.delivery_date, vehicle_plate: t.vehicle_plate })), loads, { buyer_id: 'woodall', crop_id: 'corn' })
    expect(results.slice(0, 3).map((r) => r.status === 'matched' ? r.match.tier : r.status)).toEqual(['suffix', 'suffix', 'suffix'])
    expect(results.slice(3).every((r) => r.status === 'matched' && r.match.tier === 'exact')).toBe(true)
    const claimed = results.map((r) => (r.status === 'matched' ? r.match.loadId : ''))
    expect(new Set(claimed).size).toBe(29)
  })
})

describe('Woodall 76838 — the write-back and the paid badge', () => {
  it('the buyer ticket is stored on the load (ours untouched); a re-issued statement then matches exactly', () => {
    // The review's write-back rule: tier other than exact-on-ours → buyer_ticket_number.
    const load = { id: 'ours', ticket_number: '2988-12', buyer_ticket_number: null as string | null }
    const buyerTicket = '530092988'
    const patch: Record<string, unknown> = {}
    if (normalizeTicket(buyerTicket) !== normalizeTicket(load.ticket_number)) patch.buyer_ticket_number = buyerTicket
    expect(patch).toEqual({ buyer_ticket_number: '530092988' })
    expect('ticket_number' in patch).toBe(false)
    const reissued = matchTicket({ ticket_number: '530092988' }, [{ id: 'ours', ticket_number: '2988-12', buyer_ticket_number: '530092988' }])
    expect(reissued.status === 'matched' && reissued.match.tier).toBe('exact')
    if (reissued.status === 'matched') expect(reissued.match.reason).toMatch(/buyer's ticket stored on our 2988-12/)
    expect(loadTicketKeys({ ticket_number: '2988-12', buyer_ticket_number: '530092988' })).toEqual(['2988-12', '530092988'])
  })

  it('the contract cross-check: the buyer\'s remaining vs ours, flagged past 1%', () => {
    const check = (deliveredBu: number) => {
      const ours = Math.max(0, PRICED_BU - deliveredBu)
      const theirs = REMAINING_BU
      return { ours, disagree: Math.abs(ours - theirs) / Math.max(ours, theirs, 1) > 0.01 }
    }
    expect(check(SETTLED_BU).disagree).toBe(false)
    expect(check(SETTLED_BU - 1_050).disagree).toBe(true) // one load missing on our side
  })
})
