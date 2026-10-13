import { describe, expect, it } from 'vitest'
import { contractPosition, spotPositionContract } from './contract-position'

describe('contractPosition', () => {
  it('counts the spot contract\'s priced bushels as sold, never its unpriced ones', () => {
    const spot = spotPositionContract({ bushels: 4793.9, summary: { unpricedBushels: 944.23 } })
    expect(spot).toEqual({ bushels: 4793.9 - 944.23, pricingStatus: 'fully_priced', isSeed: false })
    const p = contractPosition([
      { bushels: 10_000, pricingStatus: 'fully_priced', isSeed: false },
      spot,
    ], 40_000)
    expect(p.soldBu).toBeCloseTo(10_000 + 4793.9 - 944.23, 6)
    expect(p.openPricedBu).toBe(0)
  })

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
