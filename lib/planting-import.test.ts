import { describe, expect, it } from 'vitest'
import { classifyPlantingRow, varietyAdditions, type ExistingPlantingFacts, type UploadPlantingFacts } from './planting-import'

const row = (over: Partial<UploadPlantingFacts> = {}): UploadPlantingFacts => ({
  planted_acres: null,
  irrigated_acres: null,
  planting_date: '',
  notes: '',
  varietyNames: [],
  ...over,
})

const existing = (over: Partial<ExistingPlantingFacts> = {}): ExistingPlantingFacts => ({
  planted_acres: 120,
  irrigated_acres: 40,
  planting_date: '2026-04-15',
  notes: null,
  varietyNames: [],
  ...over,
})

describe('varietyAdditions', () => {
  it('returns upload names missing from the planting, by normalized key', () => {
    expect(varietyAdditions(['DG 3644 B3XF', 'P2089'], ['dg3644-b3xf'])).toEqual(['P2089'])
  })
  it('dedupes format variants within the upload list', () => {
    expect(varietyAdditions(['P2089', 'P 2089'], [])).toEqual(['P2089'])
  })
  it('ignores blanks', () => {
    expect(varietyAdditions(['', '  '], [])).toEqual([])
  })
})

describe('classifyPlantingRow — varieties count toward Update', () => {
  it('no-variety planting + upload variety → Update carrying the add', () => {
    // The Part C bug: this row used to classify Unchanged and the variety was
    // silently dropped.
    const c = classifyPlantingRow(row({ varietyNames: ['DP 2131'] }), existing({ varietyNames: [] }))
    expect(c.kind).toBe('update')
    expect(c.scalarChanged).toBe(false)
    expect(c.varietyAdds).toEqual(['DP 2131'])
  })

  it('a row identical except the variety must NOT classify Unchanged', () => {
    const c = classifyPlantingRow(
      row({ planted_acres: 120, irrigated_acres: 40, planting_date: '2026-04-15', varietyNames: ['DP 2131'] }),
      existing(),
    )
    expect(c.kind).toBe('update')
  })

  it('an additional variety on a planting that already has one → Update with only the new one added', () => {
    const c = classifyPlantingRow(
      row({ varietyNames: ['DP 2131', 'DP 2239'] }),
      existing({ varietyNames: ['DP 2131'] }),
    )
    expect(c.kind).toBe('update')
    expect(c.varietyAdds).toEqual(['DP 2239'])
  })

  it('a variety already on the planting (as a format variant) does not flag a change', () => {
    const c = classifyPlantingRow(
      row({ planted_acres: 120, varietyNames: ['dp 2131'] }),
      existing({ varietyNames: ['DP 2131'] }),
    )
    expect(c.kind).toBe('unchanged')
    expect(c.varietyAdds).toEqual([])
  })

  it('scalars still classify on their own (variety-free update)', () => {
    const c = classifyPlantingRow(row({ planted_acres: 130 }), existing())
    expect(c.kind).toBe('update')
    expect(c.scalarChanged).toBe(true)
    expect(c.varietyAdds).toEqual([])
  })

  it('blank scalars never count as changes (preserve-existing)', () => {
    const c = classifyPlantingRow(row(), existing({ varietyNames: ['DP 2131'] }))
    expect(c.kind).toBe('unchanged')
  })

  it('no existing planting → New, with its varieties as adds', () => {
    const c = classifyPlantingRow(row({ varietyNames: ['P2089', 'P 2089'] }), null)
    expect(c.kind).toBe('new')
    expect(c.varietyAdds).toEqual(['P2089'])
  })
})
