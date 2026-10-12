// @vitest-environment jsdom

// The per-crop header cards: the headline yield carries a thousands comma
// (cotton lint runs past 1,000 lbs/ac), and a cotton crop card shows the
// ginned / not-ginned split under the headline plus TWO trackers — percent
// picked (the harvest tracker, reworded) and percent ginned (acres all
// ginned over every cotton acre planted).

import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import AvgYieldHeader from '@/components/reports/avg-yield-header'
import type { CropAverage, HarvestProgress } from '@/lib/yields'
import type { CottonCropProgress } from '@/lib/cotton-field-yields'

afterEach(cleanup)

const averages = new Map<string, CropAverage>([
  ['cotton', { cropId: 'cotton', acres: 350, dryBu: 430_956, yield: 430_956 / 350 }],
  ['corn', { cropId: 'corn', acres: 400, dryBu: 80_000, yield: 200 }],
])
const progress = new Map<string, HarvestProgress>([
  ['cotton', { cropId: 'cotton', completedAcres: 350, inProgressAcres: 60, remainingAcres: 80, totalAcres: 490, pctComplete: (350 / 490) * 100 }],
  ['corn', { cropId: 'corn', completedAcres: 400, inProgressAcres: 0, remainingAcres: 100, totalAcres: 500, pctComplete: 80 }],
])
const cotton: CottonCropProgress = {
  acresPlanted: 490, acresGinned: 250, acresPartlyGinned: 60, pctGinned: (250 / 490) * 100,
  seedLbs: 965_220, ginnedSeedLbs: 795_220, yardSeedLbs: 170_000,
  ginned: { acres: 250, lintLbs: 282_956, lintPerAcre: 282_956 / 250, lintBasis: 'actual' },
  unginned: { acres: 100, lintLbs: 148_000, lintPerAcre: 1480, lintBasis: 'estimated_turnout' },
  turnoutLabel: '40% (assumed)',
}
const name = (id: string) => (id === 'cotton' ? 'Cotton' : 'Corn')
const unitOf = (id: string) => (id === 'cotton' ? 'lbs' as const : 'bu' as const)

describe('AvgYieldHeader', () => {
  it('a yield over 1,000 is comma-grouped in the headline', () => {
    render(<AvgYieldHeader averages={averages} cropName={name} progress={progress} unitOf={unitOf} />)
    expect(screen.getByText('1,231.3')).toBeTruthy()
    expect(screen.getByText('200.0')).toBeTruthy()
  })
  it('a cotton card shows the ginned / not-ginned split and both trackers; grain cards are unchanged', () => {
    render(<AvgYieldHeader averages={averages} cropName={name} progress={progress} unitOf={unitOf} cotton={(id) => (id === 'cotton' ? cotton : null)} />)
    expect(screen.getByText('ginned')).toBeTruthy()
    expect(screen.getByText('1,131.8')).toBeTruthy()
    expect(screen.getByText('not ginned yet')).toBeTruthy()
    expect(screen.getByText('1,480.0')).toBeTruthy()
    expect(screen.getByText('est.')).toBeTruthy()
    expect(screen.getByText('71% picked')).toBeTruthy()
    expect(screen.getByText('51% ginned')).toBeTruthy()
    expect(screen.getByText(/250 ginned · 60 partly · 180 not ginned/)).toBeTruthy()
    expect(screen.getByText('80% harvested')).toBeTruthy()
    expect(screen.queryByText('80% picked')).toBeNull()
  })
  it('without the cotton prop the cotton card reads like grain (harvested, one tracker)', () => {
    render(<AvgYieldHeader averages={averages} cropName={name} progress={progress} unitOf={unitOf} />)
    expect(screen.getByText('71% harvested')).toBeTruthy()
    expect(screen.queryByText(/ginned/)).toBeNull()
  })
})
