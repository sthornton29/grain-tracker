// Checkoff paid by crop × crop year (086) — the number a farmer claims when
// a state refunds checkoff on request. Pure: the settlements page summary,
// the Season Summary and the Ask Turnrow get_checkoff_paid tool all sum the
// same way from settlement_discount_items rows in the 'checkoff' category
// (price-kind dollars), keyed to the crop / crop year the settlement's
// matched loads carry, with ¢/bu over the settled bushels.

import { coerceDeductionKind, coerceDiscountCategory, centsPerBu } from '@/lib/settlement-discounts'

export type CheckoffSettlementInput = {
  settlementId: string
  buyerId: string | null
  settlementDate: string | null
  /** From the matched loads (mode); null when the settlement has no matched load. */
  cropId: string | null
  cropYear: number | null
  settledBu: number
  items: ReadonlyArray<{ category: string; amount: number | string | null; deduction_kind?: string | null; description?: string | null }>
}

export type CheckoffRow = {
  cropId: string | null
  cropYear: number | null
  dollars: number
  settledBu: number
  centsPerBu: number | null
  settlements: number
  /** Settlement ids that carried checkoff (for drill-down). */
  settlementIds: string[]
}

const num = (v: number | string | null | undefined) => (v == null || v === '' ? 0 : Number(v) || 0)

/** Dollars of checkoff on one settlement (price-kind 'checkoff' items). */
export function settlementCheckoffDollars(items: CheckoffSettlementInput['items']): number {
  let d = 0
  for (const i of items) {
    if (coerceDeductionKind(i.deduction_kind) !== 'price') continue
    if (coerceDiscountCategory(i.category) !== 'checkoff') continue
    d += num(i.amount)
  }
  return Math.round(d * 100) / 100
}

/** Same for fees. */
export function settlementFeeDollars(items: CheckoffSettlementInput['items']): number {
  let d = 0
  for (const i of items) {
    if (coerceDeductionKind(i.deduction_kind) !== 'price') continue
    if (coerceDiscountCategory(i.category) !== 'fee') continue
    d += num(i.amount)
  }
  return Math.round(d * 100) / 100
}

/** Checkoff paid per crop × crop year. Settlements with no checkoff still
 *  contribute their settled bushels to the ¢/bu denominator of their crop
 *  year (the rate is "per bushel sold"), but a crop × year with no checkoff
 *  at all is omitted. */
export function checkoffByCrop(settlements: ReadonlyArray<CheckoffSettlementInput>): CheckoffRow[] {
  const m = new Map<string, CheckoffRow>()
  for (const s of settlements) {
    const key = `${s.cropId ?? ''}|${s.cropYear ?? ''}`
    const row = m.get(key) ?? { cropId: s.cropId, cropYear: s.cropYear, dollars: 0, settledBu: 0, centsPerBu: null, settlements: 0, settlementIds: [] }
    const d = settlementCheckoffDollars(s.items)
    row.settledBu += s.settledBu
    if (d > 0) { row.dollars += d; row.settlements += 1; row.settlementIds.push(s.settlementId) }
    m.set(key, row)
  }
  return [...m.values()]
    .filter((r) => r.dollars > 0)
    .map((r) => ({ ...r, dollars: Math.round(r.dollars * 100) / 100, centsPerBu: centsPerBu(r.dollars, r.settledBu) }))
    .sort((a, b) => (b.cropYear ?? 0) - (a.cropYear ?? 0) || (a.cropId ?? '').localeCompare(b.cropId ?? ''))
}
