// The pagination guard: full pages keep fetching, a short page stops, errors
// surface, and the boundaries are exactly the inclusive .range() bounds.

import { describe, expect, it } from 'vitest'
import { fetchAllRows } from '@/lib/fetch-all-rows'

function fakeTable(rowCount: number, pageSize: number) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i }))
  const calls: Array<[number, number]> = []
  const build = (from: number, to: number) => {
    calls.push([from, to])
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
  }
  return { build, calls, run: () => fetchAllRows<{ id: number }>(build, pageSize) }
}

describe('fetchAllRows', () => {
  it('pages through a table larger than one request (the 1,000-row cap bug)', async () => {
    const t = fakeTable(2500, 1000)
    const { data, error } = await t.run()
    expect(error).toBeNull()
    expect(data).toHaveLength(2500)
    // Every row exactly once, in order.
    expect(data[0].id).toBe(0)
    expect(data[2499].id).toBe(2499)
    expect(new Set(data.map((r) => r.id)).size).toBe(2500)
    // Inclusive range bounds; the short last page stops the loop.
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('a table that ends exactly on a page boundary makes one extra empty request and stops', async () => {
    const t = fakeTable(2000, 1000)
    const { data } = await t.run()
    expect(data).toHaveLength(2000)
    expect(t.calls).toHaveLength(3) // 1000 + 1000 + 0
  })

  it('an empty table returns no rows after one request', async () => {
    const t = fakeTable(0, 1000)
    const { data, error } = await t.run()
    expect(data).toEqual([])
    expect(error).toBeNull()
    expect(t.calls).toHaveLength(1)
  })

  it('an error mid-pagination surfaces (never a silently short result treated as complete)', async () => {
    let call = 0
    const { error } = await fetchAllRows(
      () => {
        call++
        return call === 1
          ? Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null })
          : Promise.resolve({ data: null, error: { message: 'boom' } })
      },
      1000,
    )
    expect(error?.message).toBe('boom')
  })
})
