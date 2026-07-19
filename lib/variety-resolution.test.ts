import { describe, expect, it } from 'vitest'
import {
  buildVarietyMergePlan,
  buildVarietyPlan,
  dismissalKey,
  findSimilarVarietyPairs,
  keysNear,
  numericCore,
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

describe('numericCore', () => {
  it('is everything from the first digit on', () => {
    expect(numericCore('DG3644B3XF')).toBe('3644B3XF')
    expect(numericCore('DYNAGRO3644B3XF')).toBe('3644B3XF')
    expect(numericCore('6835')).toBe('6835')
    expect(numericCore('DK6835')).toBe('6835')
  })
  it('is empty for digitless names', () => {
    expect(numericCore('ROUNDUPREADY')).toBe('')
    expect(numericCore('')).toBe('')
  })
})

describe('keysNear — strict: identical numeric core only', () => {
  it('is symmetric and rejects equal or empty keys', () => {
    expect(keysNear('DG3644B3XF', 'DG3644B3XF')).toBe(false)
    expect(keysNear('', 'DG3644B3XF')).toBe(false)
    expect(keysNear('6835', 'DK6835')).toBe(true)
    expect(keysNear('DK6835', '6835')).toBe(true)
  })

  it('flags brand-prefix variants of the same product', () => {
    expect(keysNear('DK6835', 'DEKALB6835')).toBe(true) // long vs short brand
    expect(keysNear('3644B3XF', 'DG3644B3XF')).toBe(true) // bare vs branded
  })

  it('NEVER flags different numeric cores, no matter how close (real catalog cases)', () => {
    expect(keysNear(varietyKey('DK 65-95'), varietyKey('DK 68-35'))).toBe(false)
    expect(keysNear(varietyKey('DK 68-35'), varietyKey('DK 68-39'))).toBe(false)
    expect(keysNear(varietyKey('47XF2'), varietyKey('55XF5'))).toBe(false)
    expect(keysNear(varietyKey('43XF5'), varietyKey('55XF5'))).toBe(false)
    expect(keysNear(varietyKey('DP 2131'), varietyKey('DP 2239'))).toBe(false)
    expect(keysNear('DG3644B3XF', 'DG3646B3XF')).toBe(false) // edit distance 1, different product
  })

  it('a differing trait tail is a different product even with the same leading number', () => {
    expect(keysNear(varietyKey('47XF2'), varietyKey('47XF6'))).toBe(false)
    // Missing vs present trait tail also differs in trait letters: not candidates.
    expect(keysNear('DK6835', 'DK6835B3XF')).toBe(false)
  })

  it('digitless names are never near anything', () => {
    expect(keysNear('AG', 'AG38X8')).toBe(false)
    expect(keysNear('ROUNDUPREADY', 'ROUNDUPREADYTWO')).toBe(false)
  })
})

describe('resolveVarietyName', () => {
  const existing = ['DG 3644 B3XF', 'AG38X8', 'P2089']

  it('auto-links normalized-exact format variants to the stored spelling', () => {
    for (const raw of ['DG3644B3XF', 'dg 3644-b3xf', 'DG 3644 B3XF', 'D.G. 3644 B3XF']) {
      expect(resolveVarietyName(raw, existing)).toEqual({ status: 'matched', canonical: 'DG 3644 B3XF' })
    }
  })

  it('flags a brand-prefix variant (identical numeric core) as possible — never auto-links', () => {
    const r = resolveVarietyName('Dyna-Gro 3644B3XF', existing)
    expect(r.status).toBe('possible')
    expect(r.status === 'possible' && r.candidates).toEqual(['DG 3644 B3XF'])
    const bare = resolveVarietyName('3644B3XF', existing)
    expect(bare.status).toBe('possible')
  })

  it('does NOT flag a near-but-different product ("DG 3646" vs "DG 3644")', () => {
    expect(resolveVarietyName('DG 3646 B3XF', existing)).toEqual({ status: 'new' })
  })

  it('imports a different product cleanly as new instead of prompting ("DP 2239" vs "DP 2131")', () => {
    expect(resolveVarietyName('DP 2239', ['DP 2131'])).toEqual({ status: 'new' })
    expect(resolveVarietyName('55XF5', ['47XF2'])).toEqual({ status: 'new' })
    expect(resolveVarietyName('47XF6', ['47XF2'])).toEqual({ status: 'new' })
  })

  it('keeps genuinely distinct names distinct', () => {
    expect(resolveVarietyName('DG 3799 B3XF', existing)).toEqual({ status: 'new' })
    expect(resolveVarietyName('DKC65-95', existing)).toEqual({ status: 'new' })
  })

  it('honors dismissals: a "keep both" pair never re-prompts', () => {
    const key = varietyKey('DK 68-35') // 'DK6835'
    const dismissed = new Set([dismissalKey(key, varietyKey('68-35'))])
    expect(resolveVarietyName('68-35', ['DK 68-35'], dismissed)).toEqual({ status: 'new' })
    // Without the dismissal the same pair prompts.
    expect(resolveVarietyName('68-35', ['DK 68-35']).status).toBe('possible')
  })
})

describe('dismissalKey', () => {
  it('is order-insensitive', () => {
    expect(dismissalKey('B', 'A')).toBe('A|B')
    expect(dismissalKey('A', 'B')).toBe('A|B')
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
        { rowIndex: 2, name: 'Dyna-Gro 3644 B3XF' }, // possible (brand-prefix variant)
        { rowIndex: 3, name: 'P2089' }, // new
        { rowIndex: 4, name: 'DG 3646 B3XF' }, // new (different product, strict rules)
      ],
      existing,
    )
    expect(plan.matched).toBe(2)
    expect(plan.possible).toBe(1)
    expect(plan.created).toBe(2)
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

  it('passes dismissals through to resolution', () => {
    const dismissed = new Set([dismissalKey('DYNAGRO3644B3XF', 'DG3644B3XF')])
    const plan = buildVarietyPlan([{ rowIndex: 0, name: 'Dyna-Gro 3644 B3XF' }], existing, dismissed)
    expect(plan.items[0].resolution.status).toBe('new')
  })
})

describe('resolvedName', () => {
  const existing = ['DG 3644 B3XF']

  it('returns the canonical spelling for matches', () => {
    const plan = buildVarietyPlan([{ rowIndex: 0, name: 'dg3644b3xf' }], existing)
    expect(resolvedName(plan.items[0])).toBe('DG 3644 B3XF')
  })

  it('blocks (null) on an undecided possible match, honors either decision', () => {
    const plan = buildVarietyPlan([{ rowIndex: 0, name: 'Dyna-Gro 3644 B3XF' }], existing)
    const item = plan.items[0]
    expect(item.resolution.status).toBe('possible')
    expect(resolvedName(item)).toBeNull()
    expect(resolvedName(item, { useExisting: 'DG 3644 B3XF' })).toBe('DG 3644 B3XF')
    expect(resolvedName(item, { useExisting: null })).toBe('Dyna-Gro 3644 B3XF')
  })

  it('lets a new variety be renamed inline before creation', () => {
    const plan = buildVarietyPlan([{ rowIndex: 0, name: 'P2089' }], existing)
    expect(resolvedName(plan.items[0])).toBe('P2089')
    expect(resolvedName(plan.items[0], { useExisting: null, newName: 'P 2089 AM' })).toBe('P 2089 AM')
  })
})

describe('findSimilarVarietyPairs', () => {
  it('emits one pair per true variant, most-used spelling first', () => {
    const pairs = findSimilarVarietyPairs([
      { name: '68-35', plantings: 2 },
      { name: 'DK 68-35', plantings: 8 },
      { name: 'P2089', plantings: 4 },
      { name: 'P 2089', plantings: 1 },
      { name: 'AG38X8', plantings: 5 }, // no partner: not reported
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[0].a.name).toBe('DK 68-35')
    expect(pairs[0].b.name).toBe('68-35')
    expect(pairs[0].exact).toBe(false) // brand-prefix variant
    expect(pairs[1].a.name).toBe('P2089')
    expect(pairs[1].b.name).toBe('P 2089')
    expect(pairs[1].exact).toBe(true) // pure format variant
  })

  it('does NOT pair genuinely distinct products (the over-grouping regression)', () => {
    expect(findSimilarVarietyPairs([
      { name: 'DK 65-95', plantings: 3 },
      { name: 'DK 68-35', plantings: 3 },
      { name: 'DK 68-39', plantings: 3 },
    ])).toHaveLength(0)
    expect(findSimilarVarietyPairs([
      { name: '47XF2', plantings: 2 },
      { name: '55XF5', plantings: 2 },
      { name: '43XF5', plantings: 2 },
    ])).toHaveLength(0)
    expect(findSimilarVarietyPairs([
      { name: 'DP 2131', plantings: 1 },
      { name: 'DP 2239', plantings: 1 },
    ])).toHaveLength(0)
  })

  it('never chains: three spellings sharing a core give three independent pairs', () => {
    const pairs = findSimilarVarietyPairs([
      { name: '3644 B3XF', plantings: 1 },
      { name: 'DG 3644 B3XF', plantings: 5 },
      { name: 'Dyna-Gro 3644 B3XF', plantings: 2 },
    ])
    expect(pairs).toHaveLength(3)
    for (const p of pairs) expect(p.a.plantings).toBeGreaterThanOrEqual(p.b.plantings)
  })

  it('excludes dismissed pairs', () => {
    const dismissed = new Set([dismissalKey(varietyKey('68-35'), varietyKey('DK 68-35'))])
    expect(findSimilarVarietyPairs(
      [
        { name: '68-35', plantings: 2 },
        { name: 'DK 68-35', plantings: 8 },
      ],
      dismissed,
    )).toHaveLength(0)
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
