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
import { cottonPracticeYields } from '@/lib/yields'
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
    // Statuses carry the screen's colors; nothing ginned / no bales is a blank, not a dash or a 0.
    expect(section.rows[1][12]).toEqual({ v: 'in progress', tone: 'warning' })
    expect(section.rows[0][13]).toEqual({ v: 'on yard', tone: 'warning' })
    expect(section.rows[2][13]).toBe('')
    expect(section.rows[0][11]).toBe('')
    // Farm + Field are the frozen identifying columns of the 14.
    expect(section.freezeColumns).toBe(2)
  })
})

// Irrigated / dryland (2026-11-18): the grain table's breakdown, in lint lbs.
describe('CottonYieldsSection — irrigated / dryland breakdown', () => {
  const BREAKDOWN = { irrigated: true, dryland: true, total: true, fallback: null, allocate: true } as const
  const IRRIGATED_ONLY = { irrigated: true, dryland: false, total: false, fallback: 'irrigated', allocate: false } as const
  const withPractice = (r: CottonSectionRow, irr: number, dry: number, split?: [number, number]): CottonSectionRow => ({
    ...r,
    acres: irr + dry,
    practice: cottonPracticeYields({
      irrigated_acres: irr, dryland_acres: dry,
      irrigated_bushels: split ? split[0] : null, dryland_bushels: split ? split[1] : null, yield_breakout_entered: split != null,
    }, r.y.lintLbs),
  })
  // Seed cotton at the assumed 40%: Dry Hill 200,000 → 80,000 lint on 100 dryland
  // acres; Wheeler Pivot 300,000 → 120,000 lint on 80 irrigated + 20 dryland.
  const dryHill = withPractice(row('d', 'Dry Hill', 200_000, 'complete'), 0, 100)
  const pivot = withPractice(row('w', 'Wheeler Pivot', 300_000, 'complete'), 80, 20)
  const picking = withPractice(row('p', 'River South', 100_000, 'in_progress'), 60, 10)
  const split = (openId: string | null = null, onOpen = vi.fn()) => ({ canEdit: true, openId, onOpen, renderEditor: () => <div>split editor here</div> })

  it('shows the grain table\'s columns; a mixed field reads — until it is split, and offers Allocate once picked out', () => {
    const onOpen = vi.fn()
    render(<CottonYieldsSection rows={[dryHill, pivot, picking]} turnouts={[]} model={model} title="Cotton — 2026" canEdit allowLoadLinks={false} practiceColumns={BREAKDOWN} split={split(null, onOpen)} />)
    for (const h of ['Irr ac', 'Dry ac', 'Irrigated lint lbs/ac', 'Dryland lint lbs/ac', 'Lint lbs/ac']) expect(screen.getByText(h)).toBeTruthy()
    // Dry Hill: all its lint on the dryland side.
    expect(screen.getAllByText('800.0').length).toBeGreaterThan(0)
    expect(screen.getByText('Allocate after harvest')).toBeTruthy()
    fireEvent.click(screen.getByText('Allocate irr/dry'))
    expect(onOpen).toHaveBeenCalledWith('w')
  })

  it('a saved split reads per side; the total row divides each side\'s known lint by its acres', () => {
    const splitPivot = withPractice(row('w', 'Wheeler Pivot', 300_000, 'complete'), 80, 20, [90_000, 30_000])
    render(<CottonYieldsSection rows={[dryHill, splitPivot]} turnouts={[]} model={model} title="Cotton — 2026" canEdit allowLoadLinks={false} practiceColumns={BREAKDOWN} split={split('w')} />)
    expect(screen.getAllByText('1,125.0').length).toBe(2) // the row and the total (the only irrigated field)
    expect(screen.getByText('1,500.0')).toBeTruthy()
    expect(screen.getByText('916.7')).toBeTruthy() // (80,000 + 30,000) ÷ (100 + 20)
    // The open split renders the page's editor in its own row, and its button steps aside.
    expect(screen.getByText('split editor here')).toBeTruthy()
    expect(screen.queryByText('Edit breakout')).toBeNull()
  })

  it('Irrigated only: one side, no total, and an unsplit mixed field falls back to its whole lint per acre (as grain does)', () => {
    render(<CottonYieldsSection rows={[pivot]} turnouts={[]} model={model} title="Cotton — 2026" canEdit allowLoadLinks={false} practiceColumns={IRRIGATED_ONLY} />)
    expect(screen.queryByText('Lint lbs/ac')).toBeNull()
    expect(screen.queryByText('Dryland lint lbs/ac')).toBeNull()
    expect(screen.getAllByText('1,200.0').length).toBe(2) // 120,000 ÷ 100 planted acres, row + total
    expect(screen.queryByText('Allocate irr/dry')).toBeNull()
  })

  it('the export carries the same columns in the same order, blanks where the screen shows —', () => {
    const section = cottonSectionExport([dryHill, pivot], 'Cotton — 2026', BREAKDOWN)
    expect(section.columns.map((c) => c.label)).toEqual([
      'Farm', 'Field', 'Year', 'Acres', 'Irr ac', 'Dry ac', 'Seed cotton lbs', 'Seed cotton lbs/ac', 'Lint lbs', 'Lint basis',
      'Irrigated lint lbs/ac', 'Dryland lint lbs/ac', 'Lint lbs/ac', 'Turnout %', 'Turnout basis', 'Bales', 'Harvest status', 'Ginning status',
    ])
    expect(section.rows[0][4]).toBe('') // Dry Hill: no irrigated acres
    expect(section.rows[0][11]).toBe(800)
    expect(section.rows[1][10]).toBe('') // Wheeler Pivot: not split yet
    expect(section.rows[1][11]).toBe('')
    expect(section.rows[0]).toHaveLength(section.columns.length)
    expect(section.rows.at(-1)).toHaveLength(section.columns.length)
    // Without practice columns the export is the 14 columns it always was.
    expect(cottonSectionExport([dryHill]).columns).toHaveLength(14)
  })
})

// "Look at the real file": the Yields page's cotton export with the breakdown
// on — EXPORT_DUMP_DIR=<folder> npx vitest run components/reports/cotton-yields-section.test.tsx
describe('cotton yields export — the sample file', () => {
  it('builds (and writes yields-cotton-breakdown.xlsx / .pdf when EXPORT_DUMP_DIR is set)', async () => {
    const { dumpExport } = await import('@/lib/export-dump')
    const mk = (key: string, farm: string, field: string, seed: number, irr: number, dry: number, split?: [number, number]): CottonSectionRow => {
      const r = { ...row(key, field, seed, 'complete'), farmName: farm }
      return {
        ...r, acres: irr + dry,
        y: cottonPlantingYield({ plantedAcres: irr + dry, loads: [{ id: `l-${key}`, field_id: `f-${key}`, crop_year: 2026, net_weight: seed, picked_date: '2026-10-10', delivered_date: null }], receipts: [], bales: [], ginnedLoadIds: new Set(), turnout }),
        practice: cottonPracticeYields({ irrigated_acres: irr, dryland_acres: dry, irrigated_bushels: split?.[0] ?? null, dryland_bushels: split?.[1] ?? null, yield_breakout_entered: split != null }, seed * 0.4),
      }
    }
    const rows = [
      mk('rs', 'River', 'River South', 959_160, 235.53, 33.65, [355_000, 28_664]),
      mk('wp', 'Lamon', 'Wheeler Pivot', 828_760, 205, 44.88),
      mk('d1', 'Cottontown', 'Bottom 40', 210_000, 0, 96.4),
      mk('d2', 'Cottontown', 'Hill Field', 180_500, 0, 88.2),
      mk('d3', 'River', 'River North', 402_300, 0, 171.6),
    ]
    const payload = {
      title: 'Cotton Yields by Field',
      filters: '2026 Crop Year · All Entities · Cotton · Irrigated / Dryland breakdown',
      sections: [cottonSectionExport(rows, 'By Field', { irrigated: true, dryland: true, total: true, fallback: null, allocate: true })],
    }
    const { xlsx } = await dumpExport('yields-cotton-breakdown', payload)
    expect(xlsx.byteLength).toBeGreaterThan(1000)
  })
})
