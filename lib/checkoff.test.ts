import { describe, it, expect } from 'vitest'
import { checkoffByCrop, settlementCheckoffDollars, settlementFeeDollars } from '@/lib/checkoff'
import { classifyDeductionDescription, coerceDiscountCategory, detailedPriceWalk, isQualityDiscount, normalizeExtractedDiscountItems, sumCheck } from '@/lib/settlement-discounts'
import { settlementLostRevenue } from '@/lib/lost-revenue'

describe('checkoff and fees are categories, not quality discounts (086)', () => {
  it('classifies checkoff under every label, fees for service charges, never quality words', () => {
    for (const d of ['National Check-Off', 'checkoff', 'CHECK OFF', 'Soybean Promotion', 'AL Soybean Board assessment', 'Alabama Wheat & Feed Grain Commission', 'I02 CHECKOFF', 'Corn Promotion Council']) {
      expect(classifyDeductionDescription(d), d).toBe('checkoff')
    }
    for (const d of ['Vehicle Inspection', 'grading fee', 'Unload fee', 'Administrative', 'I11 SERVICE CHARGE', 'Handling charge']) {
      expect(classifyDeductionDescription(d), d).toBe('fee')
    }
    for (const d of ['Moisture assessment', 'TW DISC 53.8#', 'Damage', 'FM shrink', 'drying charge']) {
      expect(classifyDeductionDescription(d), d).toBeNull()
    }
    expect(coerceDiscountCategory('check-off')).toBe('checkoff')
    expect(coerceDiscountCategory('fees')).toBe('fee')
    expect(isQualityDiscount('checkoff')).toBe(false)
    expect(isQualityDiscount('fee')).toBe(false)
    expect(isQualityDiscount('moisture_shrink')).toBe(true)
    expect(isQualityDiscount('other')).toBe(true)
  })

  it('normalization re-files a wording-identified checkoff or fee out of "other" (never the reverse)', () => {
    const items = normalizeExtractedDiscountItems([
      { category: 'other', description: 'IL CORN CHECKOFF', amount: 9.42 },
      { category: 'other', description: 'VEHICLE INSPECTION', amount: 10 },
      { category: 'moisture', description: 'MO 14.2%', amount: 396.93 },
      { category: 'checkoff', description: 'MOISTURE', amount: 1 }, // stays as extracted: quality wording never becomes checkoff
    ])
    expect(items.map((i) => i.category)).toEqual(['checkoff', 'fee', 'other', 'checkoff'])
  })

  it('the price walk shows checkoff and fees as distinct deductions', () => {
    const w = detailedPriceWalk({
      grossRevenue: 294_012.61, discountTotal: 2_125.16, settledBu: 26_000,
      items: [
        { category: 'checkoff', amount: 1_467.98 }, { category: 'fee', amount: 240 },
        { category: 'moisture_shrink', amount: 396.93 }, { category: 'heat_damage', amount: 20.25 },
        { category: 'foreign_material', amount: 0, deduction_kind: 'weight' },
      ],
    })
    expect(w.checkoffDollars).toBeCloseTo(1_467.98, 2)
    expect(w.feeDollars).toBe(240)
    expect(w.qualityDollars).toBeCloseTo(417.18, 2)
    expect(w.checkoffCentsPerBu).toBeCloseTo(5.646, 2)
    expect(w.netPerBu).toBeCloseTo((294_012.61 - 2_125.16) / 26_000, 6)
    // The stated total still reconciles over ALL price items.
    expect(sumCheck([{ category: 'checkoff', amount: 1_467.98 }, { category: 'fee', amount: 240 }, { category: 'moisture_shrink', amount: 396.93 }, { category: 'heat_damage', amount: 20.25 }], 2_125.16).mismatch).toBe(false)
  })

  it('lost revenue and the buyer comparison exclude checkoff and fees', () => {
    const lost = settlementLostRevenue({
      items: [{ category: 'checkoff', amount: 1_467.98 }, { category: 'fee', amount: 240 }, { category: 'moisture_shrink', amount: 396.93 }],
      loads: [],
    })
    expect(lost.priceDollars).toBeCloseTo(396.93, 2)
    expect(lost.byGroup.other).toBe(0)
  })

  it('checkoff paid by crop × crop year in $ and ¢/bu', () => {
    const rows = checkoffByCrop([
      { settlementId: 's1', buyerId: 'b', settlementDate: '2026-09-10', cropId: 'soy', cropYear: 2026, settledBu: 26_000, items: [{ category: 'checkoff', amount: 1_467.98 }, { category: 'fee', amount: 240 }] },
      { settlementId: 's2', buyerId: 'b', settlementDate: '2026-09-20', cropId: 'soy', cropYear: 2026, settledBu: 10_000, items: [{ category: 'moisture_shrink', amount: 50 }] }, // no checkoff, bushels still count
      { settlementId: 's3', buyerId: 'b', settlementDate: '2026-10-01', cropId: 'corn', cropYear: 2026, settledBu: 50_000, items: [{ category: 'other', amount: 9.42, description: 'x' }] },
      { settlementId: 's4', buyerId: 'b', settlementDate: '2025-10-01', cropId: 'soy', cropYear: 2025, settledBu: 20_000, items: [{ category: 'checkoff', amount: 1_000 }] },
    ])
    expect(rows.map((r) => `${r.cropId}|${r.cropYear}`)).toEqual(['soy|2026', 'soy|2025'])
    expect(rows[0].dollars).toBeCloseTo(1_467.98, 2)
    expect(rows[0].settledBu).toBe(36_000)
    expect(rows[0].centsPerBu).toBeCloseTo((1_467.98 / 36_000) * 100, 4)
    expect(rows[0].settlements).toBe(1)
    expect(settlementCheckoffDollars([{ category: 'checkoff', amount: '1467.98' }, { category: 'checkoff', amount: 5, deduction_kind: 'weight' }])).toBe(1467.98)
    expect(settlementFeeDollars([{ category: 'fee', amount: 240 }])).toBe(240)
  })
})
