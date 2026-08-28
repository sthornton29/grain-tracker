import { describe, it, expect } from 'vitest'
import type { SettlementExtraction } from '@/lib/pdf-upload'
import { mergeSettlements } from '@/lib/parse-merge'
import { normalizeExtractedDiscountItems, sumCheck } from '@/lib/settlement-discounts'
import { settlementLostRevenue } from '@/lib/lost-revenue'

// Fixture-shaped extractions modeling three REAL statement formats buyers
// use (representative synthetics until real statements replace them — the
// shapes mirror what the hardened prompt instructs the model to emit).
// These pin the POST-EXTRACTION pipeline: merge → normalize → sum check →
// lost-revenue normalization. The AI itself isn't under test here.

// ---- Format 1: a line-item itemizer (named charges, one per deduction) ----
const LINE_ITEM_STATEMENT: SettlementExtraction = {
  buyer_name: 'Farmers Elevator', settlement_date: '2026-10-12', settlement_number: '88214',
  line_items: [
    { ticket_number: '5001', net_bushels: 980.2, gross_revenue: 4302.1, discounts: 96.44 },
    { ticket_number: '5002', net_bushels: 1010.8, gross_revenue: 4436.4, discounts: 71.2 },
  ],
  discount_items: [
    { category: 'drying', description: 'DRYING CHG', amount: 118.4, rate_note: '$.025 per 1/2% over 15%', quantity_basis: '1,991.0 bu @ 16.8%', deduction_kind: 'price' },
    { category: 'test_weight', description: 'TW DISC 53.8#', amount: 39.82, rate_note: '2¢/lb under 54', quantity_basis: null, deduction_kind: 'price' },
    { category: 'other', description: 'IL CORN CHECKOFF', amount: 9.42, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
  ],
}

// ---- Format 2: footnote codes + a combined "LESS DISCOUNTS" total the
//      model could NOT attribute to categories (goes to 'other', verbatim,
//      never guessed into a real category) ----
const FOOTNOTE_STATEMENT: SettlementExtraction = {
  buyer_name: 'River Terminal', settlement_date: '2026-11-02', settlement_number: 'RT-1180',
  line_items: [
    { ticket_number: '77201', net_bushels: 1500, gross_revenue: 6600, discounts: 105 },
  ],
  discount_items: [
    { category: 'other', description: 'LESS DISCOUNTS (codes D, K — legend illegible)', amount: 105, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
  ],
}

// ---- Format 3: a weight-math buyer (no dollar discounts — pay bushels
//      quietly reduced below gross in the bushel column) ----
const WEIGHT_MATH_STATEMENT: SettlementExtraction = {
  buyer_name: 'ProGrain', settlement_date: '2026-10-20', settlement_number: null,
  line_items: [
    { ticket_number: '3301', net_bushels: 962.4, gross_revenue: 4041.99, discounts: 0 },
  ],
  discount_items: [
    // Gross 1,001.0 bu shown, pay 962.4 — the prompt says: emit a weight
    // item with the implied bushels, amount 0 (the statement never prices it).
    { category: 'moisture_shrink', description: 'SHRINK 17.9% → 15.0%', amount: 0, rate_note: '1.4%/pt', quantity_basis: '38.6 bu', deduction_kind: 'weight' },
  ],
}

describe('format 1 — line-item itemizer', () => {
  const merged = mergeSettlements([LINE_ITEM_STATEMENT])
  const items = normalizeExtractedDiscountItems(merged.discount_items)
  it('all three lines normalize as price deductions with verbatim wording', () => {
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.deduction_kind === 'price')).toBe(true)
    expect(items.map((i) => i.category)).toEqual(['drying', 'test_weight', 'other'])
    expect(items[0].description).toBe('DRYING CHG')
  })
  it('reconciles: itemized $167.64 vs line discounts $167.64 — no flag', () => {
    const lineTotal = LINE_ITEM_STATEMENT.line_items.reduce((t, l) => t + (l.discounts ?? 0), 0)
    const check = sumCheck(items, lineTotal)
    expect(check.itemizedTotal).toBeCloseTo(167.64, 10)
    expect(check.mismatch).toBe(false)
  })
})

describe('format 2 — footnote codes / combined less-discounts', () => {
  const items = normalizeExtractedDiscountItems(mergeSettlements([FOOTNOTE_STATEMENT]).discount_items)
  it('an unattributable total stays in "other" with the statement wording — never guessed', () => {
    expect(items).toHaveLength(1)
    expect(items[0].category).toBe('other')
    expect(items[0].description).toContain('LESS DISCOUNTS')
  })
  it('still reconciles against the stated total', () => {
    expect(sumCheck(items, 105).mismatch).toBe(false)
  })
  it('an under-itemized version flags the gap', () => {
    // Only $60 of the $105 attributed → mismatch fires.
    const partial = [{ ...items[0], amount: 60 }]
    const check = sumCheck(partial, 105)
    expect(check.delta).toBeCloseTo(-45, 10)
    expect(check.mismatch).toBe(true)
  })
})

describe('format 3 — weight-math buyer', () => {
  const items = normalizeExtractedDiscountItems(mergeSettlements([WEIGHT_MATH_STATEMENT]).discount_items)
  it('the weight item never enters the dollar sum check (nothing to check)', () => {
    expect(items[0].deduction_kind).toBe('weight')
    expect(sumCheck(items, 0).mismatch).toBe(false)
  })
  it('lost revenue values the gap ONCE from the reconciliation, categorized by the weight item', () => {
    const lost = settlementLostRevenue({
      items,
      // Our FSA math says 1,001.0 dry bu; they paid 962.4 at $4.20.
      loads: [{ bu: 962.4, ourDryBu: 1001.0, pricePerBu: 4.2 }],
    })
    expect(lost.priceDollars).toBe(0)
    expect(lost.volumeDollars).toBeCloseTo(38.6 * 4.2, 10) // $162.12
    // Categorized as moisture/drying by the itemized shrink line.
    expect(lost.byGroup.moistureDrying).toBeCloseTo(162.12, 10)
    expect(lost.byGroup.weightDeduction).toBeCloseTo(0, 10)
  })
})

describe('chunk merging keeps kinds distinct', () => {
  it('a price and a weight item sharing wording never merge into one', () => {
    const merged = mergeSettlements([
      { buyer_name: null, settlement_date: null, settlement_number: null, line_items: [], discount_items: [
        { category: 'moisture_shrink', description: 'SHRINK', amount: 40, rate_note: null, quantity_basis: null, deduction_kind: 'price' },
      ] },
      { buyer_name: null, settlement_date: null, settlement_number: null, line_items: [], discount_items: [
        { category: 'moisture_shrink', description: 'SHRINK', amount: 0, rate_note: null, quantity_basis: '20 bu', deduction_kind: 'weight' },
      ] },
    ])
    expect(merged.discount_items).toHaveLength(2)
  })
})
