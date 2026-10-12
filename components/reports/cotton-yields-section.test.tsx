// @vitest-environment jsdom

// The cotton table (092) lists EVERY cotton planting it is handed — not-yet-
// picked rows included, like the grain table — and never prints the old
// "N cotton plantings not shown" note (that note belongs to the grain table
// and only when the crop filter is not a cotton crop). The export mirrors the
// rows. Pure rendering: the page builds the rows.

import { describe, expect, it, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CottonYieldsSection, { cottonSectionExport, type CottonSectionRow } from '@/components/reports/cotton-yields-section'
import { cottonPlantingYield, resolveTurnout } from '@/lib/cotton'
import { buildCottonYieldModel } from '@/lib/cotton-yield-sources'

afterEach(cleanup)

const turnout = resolveTurnout({})
const model = buildCottonYieldModel({ sources: null, crops: [{ id: 'c', name: 'Cotton' }], assumptions: [] })
const row = (key: string, fieldName: string, seedLbs: number, status: CottonSectionRow['status']): CottonSectionRow => ({
  key, plantingId: key, fieldId: `f-${key}`, cropId: 'c', cropName: 'Cotton', year: 2026,
  farmName: 'Home', fieldName, acres: 100,
  y: cottonPlantingYield({
    plantedAcres: 100,
    loads: seedLbs > 0 ? [{ id: `l-${key}`, field_id: `f-${key}`, crop_year: 2026, net_weight: seedLbs, picked_date: '2026-10-10', delivered_date: null }] : [],
    receipts: [], bales: [], ginnedLoadIds: new Set(), turnout,
  }),
  status, autoFlag: status === 'complete' ? undefined : status, overridden: false, noBaseline: false,
})

describe('CottonYieldsSection', () => {
  const rows = [row('a', 'Wheeler Pivot', 300_000, 'complete'), row('b', 'South', 120_000, 'in_progress'), row('c', 'Back Forty', 0, 'unharvested')]

  it('renders every planting, including the not-yet-picked one, with ginning status, no Harvest column and no "not shown" note', () => {
    render(<CottonYieldsSection rows={rows} turnouts={[]} model={model} title="Cotton — 2026" canEdit={false} allowLoadLinks={false} />)
    expect(screen.getByText('Wheeler Pivot')).toBeTruthy()
    expect(screen.getByText('South')).toBeTruthy()
    expect(screen.getByText('Back Forty')).toBeTruthy()
    expect(screen.getAllByText('on yard').length).toBe(2)
    expect(screen.queryByText(/not shown/)).toBeNull()
    // No harvest status in the table: no heading, no pills.
    expect(screen.queryByText('Harvest')).toBeNull()
    expect(screen.queryByText('complete')).toBeNull()
    expect(screen.queryByText('in progress')).toBeNull()
    expect(screen.queryByText('not picked')).toBeNull()
    for (const h of ['Seed cotton lbs', 'Seed cotton lbs/ac', 'Lint lbs', 'Lint lbs/ac', 'Turnout %', 'Bales', 'Ginning']) {
      expect(screen.getByText(h)).toBeTruthy()
    }
  })

  it('an in-progress row says so in its detail, with Count anyway for editors; a not-yet-picked row says nothing was picked', () => {
    const onCountAnyway = vi.fn()
    render(<CottonYieldsSection rows={rows} turnouts={[]} model={model} title="Cotton — 2026" canEdit allowLoadLinks={false} onCountAnyway={onCountAnyway} />)
    expect(screen.queryByText('Count anyway')).toBeNull()
    fireEvent.click(screen.getByText('South'))
    expect(screen.getByText('in progress')).toBeTruthy()
    fireEvent.click(screen.getByText('Count anyway'))
    expect(onCountAnyway).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByText('Back Forty'))
    expect(screen.getByText(/Nothing picked from this field yet/)).toBeTruthy()
  })

  it('a field counted as finished by hand reads like any other row; Undo only appears once that row is opened', () => {
    const counted = { ...row('d', 'River Bottom', 90_000, 'complete'), autoFlag: 'in_progress' as const, overridden: true }
    const onUndoCount = vi.fn()
    render(<CottonYieldsSection rows={[counted]} turnouts={[]} model={model} title="Cotton — 2026" canEdit allowLoadLinks={false} onUndoCount={onUndoCount} />)
    expect(screen.queryByText('counted')).toBeNull()
    expect(screen.queryByText('Undo')).toBeNull()
    fireEvent.click(screen.getByText('River Bottom'))
    expect(screen.getByText(/Counted as finished/)).toBeTruthy()
    fireEvent.click(screen.getByText('Undo'))
    expect(onUndoCount).toHaveBeenCalledWith('d')
  })

  it('read-only viewers see the counted note but no Undo', () => {
    const counted = { ...row('d', 'River Bottom', 90_000, 'complete'), autoFlag: 'in_progress' as const, overridden: true }
    render(<CottonYieldsSection rows={[counted]} turnouts={[]} model={model} title="Cotton — 2026" canEdit={false} allowLoadLinks={false} onUndoCount={() => {}} />)
    fireEvent.click(screen.getByText('River Bottom'))
    expect(screen.getByText(/Counted as finished/)).toBeTruthy()
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('the export mirrors the rows (one line per planting + a total)', () => {
    const section = cottonSectionExport(rows, 'Cotton — 2026')
    expect(section.rows).toHaveLength(4)
    expect(section.rows[2][1]).toBe('Back Forty')
    expect(section.rows[2][12]).toBe('not picked')
    expect(section.rows[0][6]).toBe(120_000) // 300,000 × 40%
    expect(section.rows[0][7]).toBe('est. (40% assumed)')
    expect(section.rowMeta?.at(-1)).toBe('total')
  })
})
