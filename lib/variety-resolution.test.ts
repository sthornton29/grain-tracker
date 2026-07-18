import { describe, expect, it } from 'vitest'
import {
  buildVarietyMergePlan,
  buildVarietyPlan,
  findSimilarVarietyGroups,
  keysNear,
  resolveVarietyName,
  resolvedName,
  varietyKey,
} from './variety-resolution'

describe('varietyKey', () => {
  it('treats format variants as the same key', () => {
    expect(varietyKey('DG 3644 B3XF')).toBe('DG3644B3XF')
    expect(varietyKey('DG3644B3XF')).toBe('DG3644B3XF')
    expect(varietyKey('dg 3644-b3xf')).toBe('DG3644B3XF')
    expect(varietyKey('  DG 3644  B3XF ')).toBe('DG3644B3XF')
    expect(varietyKey('P.2089')).toBe('P2089')
  })
  it('is empty for blank input', () => {
    expect(varietyKey('')).toBe('')
    expect(varietyKey('  - . ')).toBe('')
    expect(varietyKey(null)).toBe('')
  })
})

describe('resolveVarietyName', () => {
  const existing = ['DG 3644 B3XF', 'AG38X8', 'P2089']

  it('auto-links normalized-exact format variants to the stored spelling', () => {
    for (const raw of ['DG3644B3XF', 'dg 3644-b3xf', 'DG 3644 B3XF', 'D.G. 3644 B3XF']) {
      expect(resolveVarietyName(raw, existing)).toEqual({ status: 'matched', canonical: 'DG 3644 B3XF' })
    }
  })

  it('flags a near name (edit distance ≤2) as possible — never auto-links', () => {
    const r = resolveVarietyName('DG 3646 B3XF', existing)
    expect(r.status).toBe('possible')
    expect(r.status === 'possible' && r.candidates).toEqual(['DG 3644 B3XF'])
  })

  it('flags a brand-prefix variant (same numeric tail) as possible', () => {
    const r = resolveVarietyName('Dyna-Gro 3644B3XF', existing)
    expect(r.status).toBe('possible')
    expect(r.status === 'possible' && r.candidates).toEqual(['DG 3644 B3XF'])
  })

  it('flags a substring as possible ("3644B3XF" vs "DG 3644 B3XF")', () => {
    const r = resolveVarietyName('3644B3XF', existing)
    expect(r.status).toBe('possible')
    expect(r.status === 'possible' && r.candidates).toEqual(['DG 3644 B3XF'])
  })

  it('keeps genuinely distinct names distinct', () => {
    expect(resolveVarietyName('DG 3799 B3XF', existing)).toEqual({ status: 'new' })
    expect(resolveVarietyName('DKC65-95', existing)).toEqual({ status: 'new' })
  })
})

describe('keysNear', () => {
  it('is symmetric and rejects equal or empty keys', () => {
    expect(keysNear('DG3644B3XF', 'DG3644B3XF')).toBe(false)
    expect(keysNear('', 'DG3644B3XF')).toBe(false)
    expect(keysNear('DG3646B3XF', 'DG3644B3XF')).toBe(true)
    expect(keysNear('DG3644B3XF', 'DG3646B3XF')).toBe(true)
  })
  it('does not flag tiny fragments as substrings', () => {
    expect(keysNear('AG', 'AG38X8')).toBe(false)
  })
})

describe('buildVarietyPlan', () => {
  const existing = ['DG 3644 B3XF', 'AG38X8']

  it('collapses within-file format variants to one new variety', () => {
    const plan = buildVarietyPlan(
      [
        { rowIndex: 0, name: 'DKC65-95' },
        { rowIndex: 1, name: 'DKC 65-95' },
        { rowIndex: 2, name: 'dkc 65.95' },
      ],
      existing,
    )
    expect(plan.items).toHaveLength(1)
    expect(plan.created).toBe(1)
    expect(plan.items[0].name).toBe('DKC65-95') // first-seen spelling wins
    expect(plan.items[0].rowIndexes).toEqual([0, 1, 2])
    expect(plan.items[0].spellings).toEqual(['DKC65-95', 'DKC 65-95', 'dkc 65.95'])
  })

  it('counts matched / possible / created groups for the preview summary', () => {
    const plan = buildVarietyPlan(
      [
        { rowIndex: 0, name: 'DG3644B3XF' }, // matched (format variant)
        { rowIndex: 1, name: 'AG38X8' }, // matched (exact)
        { rowIndex: 2, name: 'DG 3646 B3XF' }, // possible (near)
        { rowIndex: 3, name: 'P2089' }, // new
      ],
      existing,
    )
    expect(plan.matched).toBe(2)
    expect(plan.possible).toBe(1)
    expect(plan.created).toBe(1)
  })

  it('handles a mixed file exercising all three outcomes with collapse', () => {
    const plan = buildVarietyPlan(
      [
        { rowIndex: 0, name: 'dg 3644-b3xf' }, // matched
        { rowIndex: 1, name: 'DG 3644 B3XF' }, // matched, same group
        { rowIndex: 2, name: 'Dyna-Gro 3644B3XF' }, // possible (brand prefix)
        { rowIndex: 3, name: 'P2089' }, // new
        { rowIndex: 4, name: 'P 2089' }, // new, collapses with row 3
        { rowIndex: 5, name: '' }, // blank: ignored, never dropped rows' concern
      ],
      existing,
    )
    expect(plan.items).toHaveLength(3)
    expect(plan.matched).toBe(1)
    expect(plan.possible).toBe(1)
    expect(plan.created).toBe(1)
    const matched = plan.items.find((i) => i.resolution.status === 'matched')!
    expect(matched.rowIndexes).toEqual([0, 1])
    const created = plan.items.find((i) => i.resolution.status === 'new')!
    expect(created.name).toBe('P2089')
    expect(created.rowIndexes).toEqual([3, 4])
  })
})

describe('resolvedName', () => {
  const existing = ['DG 3644 B3XF']

  it('returns the canonical spelling for matches', () => {
    const plan = buildVarietyPlan([{ rowIndex: 0, name: 'dg3644b3xf' }], existing)
    expect(resolvedName(plan.items[0])).toBe('DG 3644 B3XF')
  })

  it('blocks (null) on an undecided possible match, honors either decision', () => {
    const plan = buildVarietyPlan([{ rowIndex: 0, name: 'DG 3646 B3XF' }], existing)
    const item = plan.items[0]
    expect(resolvedName(item)).toBeNull()
    expect(resolvedName(item, { useExisting: 'DG 3644 B3XF' })).toBe('DG 3644 B3XF')
    expect(resolvedName(item, { useExisting: null })).toBe('DG 3646 B3XF')
  })

  it('lets a new variety be renamed inline before creation', () => {
    const plan = buildVarietyPlan([{ rowIndex: 0, name: 'P2089' }], existing)
    expect(resolvedName(plan.items[0])).toBe('P2089')
    expect(resolvedName(plan.items[0], { useExisting: null, newName: 'P 2089 AM' })).toBe('P 2089 AM')
  })
})

describe('findSimilarVarietyGroups', () => {
  it('groups normalized-equal and near-equal names, most-used first', () => {
    const groups = findSimilarVarietyGroups([
      { name: 'DG 3644 B3XF', plantings: 8 },
      { name: 'DG3644B3XF', plantings: 2 },
      { name: 'Dyna-Gro 3644B3XF', plantings: 1 },
      { name: 'AG38X8', plantings: 5 }, // no partner: not reported
      { name: 'P2089', plantings: 4 },
      { name: 'P 2089', plantings: 1 },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].map((u) => u.name)).toEqual(['DG 3644 B3XF', 'DG3644B3XF', 'Dyna-Gro 3644B3XF'])
    expect(groups[1].map((u) => u.name)).toEqual(['P2089', 'P 2089'])
  })

  it('does not group genuinely distinct products', () => {
    const groups = findSimilarVarietyGroups([
      { name: 'DG 3644 B3XF', plantings: 3 },
      { name: 'DG 3799 B3XF', plantings: 3 },
    ])
    expect(groups).toHaveLength(0)
  })
})

describe('buildVarietyMergePlan', () => {
  it('re-links every planting to the canonical name and deletes redundant rows', () => {
    const plan = buildVarietyMergePlan(
      [
        { id: 'a', plantingId: 'p1', name: 'DG3644B3XF', acres: 40, bushels: null },
        { id: 'b', plantingId: 'p2', name: 'DG3644B3XF', acres: 60, bushels: 900 },
        { id: 'c', plantingId: 'p3', name: 'DG 3644 B3XF', acres: 100, bushels: null },
      ],
      'DG 3644 B3XF',
    )
    // p3 already carries the canonical spelling alone — untouched.
    expect(plan.updates).toEqual([
      { id: 'a', variety: 'DG 3644 B3XF', acres: 40, bushels: null },
      { id: 'b', variety: 'DG 3644 B3XF', acres: 60, bushels: 900 },
    ])
    expect(plan.deletes).toEqual([])
    expect(plan.affectedPlantings).toBe(2)
  })

  it('coalesces a planting that recorded two spellings into one row, summing acres', () => {
    const plan = buildVarietyMergePlan(
      [
        { id: 'a', plantingId: 'p1', name: 'DG3644B3XF', acres: 40, bushels: 500 },
        { id: 'b', plantingId: 'p1', name: 'DG 3644 B3XF', acres: 60, bushels: 700 },
      ],
      'DG 3644 B3XF',
    )
    // The row already spelled canonically survives; the variant is deleted.
    expect(plan.updates).toEqual([{ id: 'b', variety: 'DG 3644 B3XF', acres: 100, bushels: 1200 }])
    expect(plan.deletes).toEqual(['a'])
    expect(plan.affectedPlantings).toBe(1)
  })
})
