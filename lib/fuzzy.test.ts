import { describe, it, expect } from 'vitest'
import { findBestMatch } from '@/lib/fuzzy'

const fields = [
  { id: 'a', name: 'Creek Bottom' }, { id: 'b', name: 'Driveway North' }, { id: 'c', name: 'Driveway South' }, { id: 'd', name: 'Rooster' },
  { id: 'e', name: 'Wheeler Pivot' }, { id: 'f', name: 'Highway 20' },
]
const name = (f: { name: string }) => f.name

describe('findBestMatch', () => {
  it('exact and case-insensitive names win', () => {
    expect(findBestMatch('creek bottom', fields, name)?.id).toBe('a')
    expect(findBestMatch('HIGHWAY 20', fields, name)?.id).toBe('f')
  })

  it('a name printed without its spaces still finds the field (the gin export: DRIVEWAYSOUTH → Driveway South, never Driveway North)', () => {
    expect(findBestMatch('DRIVEWAYSOUTH', fields, name)?.id).toBe('c')
    expect(findBestMatch('DRIVEWAYNORTH', fields, name)?.id).toBe('b')
    expect(findBestMatch('WHEELERPIVOT', fields, name)?.id).toBe('e')
  })

  it('a squeezed partial still ranks below a real containment and never invents a match', () => {
    expect(findBestMatch('PIVOT', fields, name)?.id).toBe('e')
    expect(findBestMatch('BACK FORTY', fields, name)).toBeNull()
  })
})
