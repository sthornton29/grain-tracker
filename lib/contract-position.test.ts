import { describe, expect, it } from 'vitest'
import { contractPosition } from './contract-position'

describe('contractPosition', () => {
  it('splits sold / open-priced / unsold against production', () => {
    const p = contractPosition([
      { bushels: 10_000, pricingStatus: 'fully_priced', isSeed: false },
      { bushels: 5_000, pricingStatus: 'awaiting_basis', isSeed: false },
      { bushels: 2_000, pricingStatus: 'awaiting_futures', isSeed: true },
    ], 40_000)
    expect(p.soldBu).toBe(12_000)
    expect(p.openPricedBu).toBe(5_000)
    expect(p.unsoldBu).toBe(23_000)
    expect(p.overContractedBu).toBe(0)
    expect(p.contractedPct).toBeCloseTo(42.5)
  })

  it('reports unknown unsold when production is missing', () => {
    const p = contractPosition([{ bushels: 100, pricingStatus: 'fully_priced', isSeed: false }], null)
    expect(p.soldBu).toBe(100)
    expect(p.unsoldBu).toBeNull()
    expect(p.contractedPct).toBeNull()
  })

  it('flags over-contracting instead of a negative unsold', () => {
    const p = contractPosition([{ bushels: 50_000, pricingStatus: 'fully_priced', isSeed: false }], 40_000)
    expect(p.unsoldBu).toBe(0)
    expect(p.overContractedBu).toBe(10_000)
    expect(p.contractedPct).toBe(100)
  })
})
