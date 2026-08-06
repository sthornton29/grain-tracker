import { describe, it, expect } from 'vitest'
import {
  type OnHandBag,
  cellFor,
  cellTotal,
  applyTransfers,
  orgTotal,
  estimateTransferBushels,
  overInventoryMessage,
  percentFull,
  percentFullLabel,
  capacityStatus,
  siteCapacitySummary,
} from './bin-inventory'

const CORN = 'crop-corn'
const BEANS = 'crop-beans'

function bagWith(cells: { bin: string; crop: string; loadBacked?: number; beginning?: number; emptyAdj?: number }[]): OnHandBag {
  const bag: OnHandBag = new Map()
  for (const c of cells) {
    const cell = cellFor(bag, c.bin, c.crop)
    cell.loadBacked += c.loadBacked ?? 0
    cell.beginning += c.beginning ?? 0
    cell.emptyAdj += c.emptyAdj ?? 0
  }
  return bag
}

describe('estimateTransferBushels', () => {
  it('multiplies throughput by hours run (850 bu/hr × 2.5 hr = 2,125 bu)', () => {
    expect(estimateTransferBushels(850, 2.5)).toBe(2125)
  })

  it('rounds to 2 decimals', () => {
    expect(estimateTransferBushels(333.33, 1.5)).toBe(500)
    expect(estimateTransferBushels(101.7, 0.33)).toBe(33.56)
  })

  it('returns null until both inputs are positive numbers', () => {
    expect(estimateTransferBushels(null, 2)).toBeNull()
    expect(estimateTransferBushels(850, null)).toBeNull()
    expect(estimateTransferBushels(0, 2)).toBeNull()
    expect(estimateTransferBushels(850, 0)).toBeNull()
    expect(estimateTransferBushels(-100, 2)).toBeNull()
    expect(estimateTransferBushels(NaN, 2)).toBeNull()
  })
})

describe('applyTransfers — inventory conservation', () => {
  it('subtracts from the source and adds to the destination for the same crop', () => {
    const bag = bagWith([
      { bin: 'wet', crop: CORN, loadBacked: 11400 },
      { bin: 'dry', crop: CORN, loadBacked: 2000 },
    ])
    applyTransfers(bag, [{ from_bin_id: 'wet', to_bin_id: 'dry', crop_id: CORN, bushels: 5000 }])
    expect(cellTotal(bag.get('wet')!.get(CORN)!)).toBeCloseTo(6400, 6)
    expect(cellTotal(bag.get('dry')!.get(CORN)!)).toBeCloseTo(7000, 6)
  })

  it('conserves the operation total across any set of transfers', () => {
    const bag = bagWith([
      { bin: 'wet', crop: CORN, loadBacked: 11400 },
      { bin: 'dry', crop: CORN, loadBacked: 2000 },
      { bin: 'south', crop: BEANS, beginning: 4200 },
    ])
    const before = orgTotal(bag)
    applyTransfers(bag, [
      { from_bin_id: 'wet', to_bin_id: 'dry', crop_id: CORN, bushels: 5000 },
      { from_bin_id: 'dry', to_bin_id: 'south', crop_id: CORN, bushels: 1500 },
      { from_bin_id: 'south', to_bin_id: 'wet', crop_id: BEANS, bushels: 200 },
    ])
    expect(orgTotal(bag)).toBeCloseTo(before, 6)
  })

  it('a wet→dry transfer after drying nets zero (dry-basis both sides)', () => {
    const bag = bagWith([
      { bin: 'wet', crop: CORN, loadBacked: 10000 },
      { bin: 'dry', crop: CORN },
    ])
    applyTransfers(bag, [{ from_bin_id: 'wet', to_bin_id: 'dry', crop_id: CORN, bushels: 10000 }])
    expect(cellTotal(bag.get('wet')!.get(CORN)!)).toBeCloseTo(0, 6)
    expect(cellTotal(bag.get('dry')!.get(CORN)!)).toBeCloseTo(10000, 6)
    expect(orgTotal(bag)).toBeCloseTo(10000, 6)
  })

  it('creates a crop row in the destination when the crop was not there yet', () => {
    const bag = bagWith([
      { bin: 'a', crop: CORN, loadBacked: 3000 },
      { bin: 'b', crop: BEANS, loadBacked: 100 },
    ])
    applyTransfers(bag, [{ from_bin_id: 'a', to_bin_id: 'b', crop_id: CORN, bushels: 1200 }])
    expect(cellTotal(bag.get('b')!.get(CORN)!)).toBeCloseTo(1200, 6)
  })

  it('skips bins not seeded in the bag and ignores non-positive bushels', () => {
    const bag = bagWith([{ bin: 'a', crop: CORN, loadBacked: 3000 }])
    applyTransfers(bag, [
      { from_bin_id: 'ghost', to_bin_id: 'a', crop_id: CORN, bushels: 500 },
      { from_bin_id: 'a', to_bin_id: 'ghost', crop_id: CORN, bushels: 500 },
      { from_bin_id: 'a', to_bin_id: 'a2', crop_id: CORN, bushels: 0 },
    ])
    // Ghost destination still debits the source (the grain left this bin),
    // ghost source still credits the destination.
    expect(cellTotal(bag.get('a')!.get(CORN)!)).toBeCloseTo(3000 + 500 - 500, 6)
  })

  it('never touches load-backed, beginning, or cleanout components — transfers are not loads', () => {
    const bag = bagWith([
      { bin: 'wet', crop: CORN, loadBacked: 11400, beginning: 500, emptyAdj: 100 },
      { bin: 'dry', crop: CORN, loadBacked: 2000 },
    ])
    // Yields/production/contract deliveries/marketing all aggregate loads,
    // which feed only the loadBacked component. Assert transfers leave every
    // load-derived component untouched.
    const loadBackedBefore = [...bag.values()].flatMap((m) => [...m.values()]).reduce((s, c) => s + c.loadBacked, 0)
    applyTransfers(bag, [{ from_bin_id: 'wet', to_bin_id: 'dry', crop_id: CORN, bushels: 5000 }])
    const wet = bag.get('wet')!.get(CORN)!
    expect(wet.loadBacked).toBe(11400)
    expect(wet.beginning).toBe(500)
    expect(wet.emptyAdj).toBe(100)
    const loadBackedAfter = [...bag.values()].flatMap((m) => [...m.values()]).reduce((s, c) => s + c.loadBacked, 0)
    expect(loadBackedAfter).toBe(loadBackedBefore)
  })
})

describe('overInventoryMessage — warn but never block', () => {
  it('is silent when moving no more than what the bin shows', () => {
    expect(overInventoryMessage({ moving: 11400, onHandBu: 11400, fromBinName: 'Wet Bin', cropName: 'Corn' })).toBeNull()
    expect(overInventoryMessage({ moving: 5000, onHandBu: 11400, fromBinName: 'Wet Bin', cropName: 'Corn' })).toBeNull()
  })

  it('tolerates rounding noise at the threshold', () => {
    expect(overInventoryMessage({ moving: 11400.004, onHandBu: 11400, fromBinName: 'Wet Bin', cropName: 'Corn' })).toBeNull()
  })

  it('warns with the bin, crop, and both amounts when moving more than on hand', () => {
    const msg = overInventoryMessage({ moving: 12000, onHandBu: 11400, fromBinName: 'Wet Bin', cropName: 'Corn' })
    expect(msg).toBe('Moving 12,000 bu but Wet Bin shows 11,400 bu of Corn — inventory estimates may be imprecise. Continue?')
  })

  it('shows 0 on hand (not a negative number) when the bin math has gone negative', () => {
    const msg = overInventoryMessage({ moving: 100, onHandBu: -50, fromBinName: 'Bin 3', cropName: 'Soybeans' })
    expect(msg).toContain('shows 0 bu of Soybeans')
  })
})

describe('percentFull / capacityStatus', () => {
  it('computes percent of rated capacity', () => {
    expect(percentFull(21250, 42500)).toBeCloseTo(50, 6)
    expect(percentFull(0, 42500)).toBe(0)
  })

  it('is null when no capacity is set (bin renders as before)', () => {
    expect(percentFull(5000, null)).toBeNull()
    expect(percentFull(5000, 0)).toBeNull()
  })

  it('clamps negative on-hand to 0 but does NOT cap above 100', () => {
    expect(percentFull(-200, 1000)).toBe(0)
    expect(percentFull(1150, 1000)).toBeCloseTo(115, 6)
  })

  it('status: ok below 90, amber from 90, red at/over 100', () => {
    expect(capacityStatus(89.9)).toBe('ok')
    expect(capacityStatus(90)).toBe('near_full')
    expect(capacityStatus(99.9)).toBe('near_full')
    expect(capacityStatus(100)).toBe('over')
    expect(capacityStatus(140)).toBe('over')
  })

  it('label shows ">100%" instead of clipping', () => {
    expect(percentFullLabel(72.4)).toBe('72%')
    expect(percentFullLabel(100)).toBe('100%')
    expect(percentFullLabel(100.6)).toBe('>100%')
    expect(percentFullLabel(140)).toBe('>100%')
  })
})

describe('siteCapacitySummary — partial capacities', () => {
  it('sums only bins that have a capacity and reports the ones that do not', () => {
    const s = siteCapacitySummary([
      { capacityBu: 10000, totalBu: 8000 },
      { capacityBu: 20000, totalBu: 10000 },
      { capacityBu: null, totalBu: 5000 },
    ])
    expect(s.capacityBu).toBe(30000)
    expect(s.bushelsInCapacityBins).toBe(18000)
    expect(s.pct).toBeCloseTo(60, 6)
    expect(s.binsWithCapacity).toBe(2)
    expect(s.binsWithoutCapacity).toBe(1)
  })

  it('grain in a no-capacity bin cannot push the site percent up', () => {
    const withGrainInUncapped = siteCapacitySummary([
      { capacityBu: 10000, totalBu: 9000 },
      { capacityBu: null, totalBu: 50000 },
    ])
    expect(withGrainInUncapped.pct).toBeCloseTo(90, 6)
  })

  it('is null when no bin has a capacity', () => {
    const s = siteCapacitySummary([
      { capacityBu: null, totalBu: 5000 },
      { capacityBu: null, totalBu: 2000 },
    ])
    expect(s.pct).toBeNull()
    expect(s.capacityBu).toBe(0)
  })

  it('site percent can exceed 100 when the capacity bins are over-full', () => {
    const s = siteCapacitySummary([
      { capacityBu: 10000, totalBu: 12000 },
      { capacityBu: 5000, totalBu: 4000 },
    ])
    expect(s.pct).toBeCloseTo((16000 / 15000) * 100, 6)
  })
})
