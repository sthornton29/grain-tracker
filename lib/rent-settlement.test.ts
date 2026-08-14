// Rent Settlement math — hand-verified worked examples.
//
// Behavior pinned:
//   * 1/3–2/3 crop share with 50/50 drying: 30,000 bu × 1/3 = 10,000 bu @
//     $4.50 = $45,000 gross, minus half of $3,000 drying = $43,500 due;
//   * flex lease: $200/ac cash base × 100 ac + a $2,500 entered bonus;
//   * cash lease: trivially the stated annual amount;
//   * gap detection BLOCKS generation with named gaps (missing drying total,
//     unconfirmed reference price, no settled sales);
//   * landowner-sells-own leases produce bushels-only lines (no invented $);
//   * share bushels reconcile with the Share Rent report's landlord bushels
//     when the lease % equals the farm's landlord_share_percentage;
//   * the export payload derives entirely from the statement (source labels
//     included) — branding is attached by the caller (see branding.test.ts).

import { describe, expect, it } from 'vitest'
import {
  buildSettlement,
  detectGaps,
  parseLeaseTerms,
  settlementExportPayload,
  sharePctFor,
  type CropProductionInput,
  type LeaseTermsShape,
} from './rent-settlement'

const THIRD = 100 / 3

const shareLease = (over: Partial<LeaseTermsShape> = {}): LeaseTermsShape => ({
  leaseType: 'crop_share',
  shareTerms: { defaultPct: THIRD, byCrop: {} },
  expenseTerms: [{ category: 'drying', landownerPct: 50, note: null }],
  pricingMethod: { method: 'operator_actual', reference: null },
  cashTerms: null,
  flexTerms: [],
  paymentTiming: 'within 30 days of harvest',
  ...over,
})

const corn = (over: Partial<CropProductionInput> = {}): CropProductionInput => ({
  cropName: 'Corn', totalBu: 30_000, acres: 200, actualPricePerBu: 4.5, ...over,
})

describe('detectGaps', () => {
  it('a shared expense is always a named gap (Turnrow does not itemize drying)', () => {
    const gaps = detectGaps({ terms: shareLease(), production: [corn()], totalAcres: 200 })
    expect(gaps).toHaveLength(1)
    expect(gaps[0].key).toBe('expense|drying|Corn')
    expect(gaps[0].label).toContain('drying')
    expect(gaps[0].label).toContain('50/50')
  })

  it('operator-marketed crop with no settled sales → price gap; with sales → none', () => {
    const noSales = detectGaps({ terms: shareLease({ expenseTerms: [] }), production: [corn({ actualPricePerBu: null })], totalAcres: 200 })
    expect(noSales.map((g) => g.key)).toEqual(['price|Corn'])
    const withSales = detectGaps({ terms: shareLease({ expenseTerms: [] }), production: [corn()], totalAcres: 200 })
    expect(withSales).toHaveLength(0)
  })

  it('a reference price is ALWAYS a confirm gap, even when settled sales exist', () => {
    const terms = shareLease({ expenseTerms: [], pricingMethod: { method: 'reference', reference: { description: 'average October price at Farmers Elevator' } } })
    const gaps = detectGaps({ terms, production: [corn()], totalAcres: 200 })
    expect(gaps.map((g) => g.key)).toEqual(['price|Corn'])
    expect(gaps[0].label).toContain('Farmers Elevator')
  })

  it('landowner-sells-own needs no price; cash lease without amounts needs one', () => {
    const own = shareLease({ expenseTerms: [], pricingMethod: { method: 'landowner_sells_own', reference: null } })
    expect(detectGaps({ terms: own, production: [corn({ actualPricePerBu: null })], totalAcres: 200 })).toHaveLength(0)
    const cash: LeaseTermsShape = { ...shareLease(), leaseType: 'cash', shareTerms: null, expenseTerms: [], cashTerms: null }
    expect(detectGaps({ terms: cash, production: [], totalAcres: 0 }).map((g) => g.key)).toEqual(['cash|amount'])
  })
})

describe('buildSettlement — worked examples', () => {
  it('refuses to generate with unresolved gaps, naming them', () => {
    const result = buildSettlement({
      terms: shareLease(), production: [corn()], totalAcres: 200,
      gapValues: {}, cropYear: 2026, landownerName: 'Jones Family', generatedAt: '2026-08-14T12:00:00Z',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.gaps.map((g) => g.key)).toEqual(['expense|drying|Corn'])
  })

  it('1/3–2/3 share with 50/50 drying: 10,000 bu @ $4.50 − $1,500 drying = $43,500', () => {
    const result = buildSettlement({
      terms: shareLease(), production: [corn()], totalAcres: 200,
      gapValues: { 'expense|drying|Corn': 3000 },
      cropYear: 2026, landownerName: 'Jones Family', generatedAt: '2026-08-14T12:00:00Z',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const s = result.statement
    expect(s.sections).toHaveLength(1)
    const [share, drying] = s.sections[0].lines
    expect(share.quantityBu).toBe(10_000)
    expect(share.pricePerBu).toBe(4.5)
    expect(share.amount).toBe(45_000)
    expect(share.source).toBe('account') // price came from settled sales
    expect(drying.amount).toBe(-1_500)
    expect(drying.source).toBe('entered')
    expect(s.sections[0].subtotal).toBe(43_500)
    expect(s.totalDue).toBe(43_500)
    expect(s.bushelsOnly).toBe(false)
  })

  it('a confirmed reference price is labeled as such and overrides settled sales', () => {
    const terms = shareLease({ expenseTerms: [], pricingMethod: { method: 'reference', reference: { description: 'October average' } } })
    const result = buildSettlement({
      terms, production: [corn({ actualPricePerBu: 4.5 })], totalAcres: 200,
      gapValues: { 'price|Corn': 4.2 },
      cropYear: 2026, landownerName: 'Jones', generatedAt: '2026-08-14T12:00:00Z',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const line = result.statement.sections[0].lines[0]
    expect(line.pricePerBu).toBe(4.2)
    expect(line.amount).toBe(42_000)
    expect(line.source).toBe('reference')
  })

  it('flex lease: $200/ac × 100 ac + $2,500 entered bonus = $22,500', () => {
    const terms: LeaseTermsShape = {
      leaseType: 'flex', shareTerms: null, expenseTerms: [],
      pricingMethod: null,
      cashTerms: { perAcre: 200, totalAnnual: null },
      flexTerms: [{ description: 'Bonus: 1/3 of gross revenue above $850/acre' }],
      paymentTiming: null,
    }
    const result = buildSettlement({
      terms, production: [], totalAcres: 100,
      gapValues: { 'flex|0': 2500 },
      cropYear: 2026, landownerName: 'Hill Trust', generatedAt: '2026-08-14T12:00:00Z',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.statement.sections.map((s) => s.subtotal)).toEqual([20_000, 2_500])
    expect(result.statement.totalDue).toBe(22_500)
  })

  it('cash lease is trivially the stated annual amount', () => {
    const terms: LeaseTermsShape = {
      leaseType: 'cash', shareTerms: null, expenseTerms: [], pricingMethod: null,
      cashTerms: { perAcre: null, totalAnnual: 15_000 }, flexTerms: [], paymentTiming: 'March 1',
    }
    const result = buildSettlement({ terms, production: [], totalAcres: 0, gapValues: {}, cropYear: 2026, landownerName: 'Smith', generatedAt: '2026-08-14T12:00:00Z' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.statement.totalDue).toBe(15_000)
  })

  it('landowner-sells-own: bushels-only share line, expenses still net', () => {
    const terms = shareLease({ pricingMethod: { method: 'landowner_sells_own', reference: null } })
    const result = buildSettlement({
      terms, production: [corn({ actualPricePerBu: null })], totalAcres: 200,
      gapValues: { 'expense|drying|Corn': 3000 },
      cropYear: 2026, landownerName: 'Jones', generatedAt: '2026-08-14T12:00:00Z',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [share, drying] = result.statement.sections[0].lines
    expect(share.amount).toBeNull()
    expect(share.quantityBu).toBe(10_000)
    expect(drying.amount).toBe(-1_500)
    expect(result.statement.totalDue).toBe(-1_500) // the landowner owes their drying share
    expect(result.statement.bushelsOnly).toBe(true)
  })

  it('per-crop share % overrides the default (case-insensitive crop match)', () => {
    const terms = shareLease({ expenseTerms: [], shareTerms: { defaultPct: 25, byCrop: { corn: 50 } } })
    expect(sharePctFor(terms, 'Corn')).toBe(50)
    expect(sharePctFor(terms, 'Soybean')).toBe(25)
  })
})

describe('reconciliation with the Share Rent report', () => {
  it('lease % == farm landlord % → share bushels equal the report’s landlord bushels', () => {
    // Share Rent report math: landlordBu = Σ(field dryBu) × pct/100 per farm.
    const fieldDryBu = [12_345.67, 8_901.23, 4_567.89]
    const farmPct = 33.33
    const reportLandlordBu = Math.round(fieldDryBu.reduce((s, b) => s + b, 0) * (farmPct / 100) * 100) / 100
    const totalBu = fieldDryBu.reduce((s, b) => s + b, 0)
    const result = buildSettlement({
      terms: shareLease({ expenseTerms: [], shareTerms: { defaultPct: farmPct, byCrop: {} } }),
      production: [corn({ totalBu, actualPricePerBu: 4 })],
      totalAcres: 200, gapValues: {}, cropYear: 2026, landownerName: 'Jones', generatedAt: '2026-08-14T12:00:00Z',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.statement.sections[0].lines[0].quantityBu).toBeCloseTo(reportLandlordBu, 2)
  })
})

describe('parseLeaseTerms (jsonb tolerance)', () => {
  it('parses a full row and survives junk', () => {
    const shape = parseLeaseTerms({
      lease_type: 'crop_share',
      share_terms: { defaultPct: THIRD, byCrop: { Corn: 40, junk: 'x' } },
      expense_terms: [{ category: 'drying', landownerPct: 50 }, { category: 'nonsense', landownerPct: 25 }, 'garbage', { category: 'hauling', landownerPct: 0 }],
      pricing_method: { method: 'reference', reference: { description: 'October avg' } },
      cash_terms: null,
      flex_terms: [{ description: 'bonus clause' }, {}],
      payment_timing: 'Dec 1',
    })
    expect(shape.leaseType).toBe('crop_share')
    expect(shape.shareTerms?.byCrop).toEqual({ Corn: 40 })
    expect(shape.expenseTerms).toEqual([
      { category: 'drying', landownerPct: 50, note: null },
      { category: 'other', landownerPct: 25, note: null }, // unknown category → other
    ])
    expect(shape.pricingMethod?.reference?.description).toBe('October avg')
    expect(shape.flexTerms).toEqual([{ description: 'bonus clause' }])
  })

  it('unknown lease_type falls back to crop_share; empty jsonb stays null', () => {
    const shape = parseLeaseTerms({ lease_type: 'weird' })
    expect(shape.leaseType).toBe('crop_share')
    expect(shape.shareTerms).toBeNull()
    expect(shape.pricingMethod).toBeNull()
  })
})

describe('settlementExportPayload', () => {
  it('carries every line with its source label, subtotals, total, and signature block', () => {
    const result = buildSettlement({
      terms: shareLease(), production: [corn()], totalAcres: 200,
      gapValues: { 'expense|drying|Corn': 3000 },
      cropYear: 2026, landownerName: 'Jones Family', generatedAt: '2026-08-14T12:00:00Z',
    })
    if (!result.ok) throw new Error('unexpected gaps')
    const payload = settlementExportPayload({ statement: result.statement, landownerAddress: '100 River Rd\nDecatur, AL' })
    expect(payload.title).toBe('Rent Settlement — 2026 Crop Year')
    expect(payload.filters).toContain('Jones Family')
    expect(payload.filters).toContain('100 River Rd, Decatur, AL')
    expect(payload.filename).toBe('rent-settlement-jones-family-2026')
    const flat = JSON.stringify(payload)
    expect(flat).toContain('From farm records')
    expect(flat).toContain('Entered at settlement')
    expect(flat).toContain('Landowner signature')
    const totalSection = payload.sections.find((s) => s.title === 'Amount due')!
    expect(totalSection.rows[0]).toContain(43_500)
  })
})
