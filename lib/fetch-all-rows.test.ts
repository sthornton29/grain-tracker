// The pagination guard: cap-agnostic termination (a short page ends the read
// only after the server has proven it can fill a page; otherwise probe on to
// an empty page), errors surface, and requests resume at the received count.

import { describe, expect, it } from 'vitest'
import { fetchAllRows } from '@/lib/fetch-all-rows'

/** A fake table that serves at most `serverCap` rows per request, regardless
 *  of how many the range asks for — exactly PostgREST's db-max-rows. */
function fakeTable(rowCount: number, opts: { pageSize: number; serverCap?: number }) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i }))
  const calls: Array<[number, number]> = []
  const cap = opts.serverCap ?? opts.pageSize
  const build = (from: number, to: number) => {
    calls.push([from, to])
    const want = Math.min(to - from + 1, cap)
    return Promise.resolve({ data: rows.slice(from, from + want), error: null })
  }
  return { calls, run: () => fetchAllRows<{ id: number }>(build, opts.pageSize) }
}

describe('fetchAllRows', () => {
  it('pages through a table larger than one request (the 1,000-row cap bug)', async () => {
    const t = fakeTable(2500, { pageSize: 1000 })
    const { data, error } = await t.run()
    expect(error).toBeNull()
    expect(data).toHaveLength(2500)
    // Every row exactly once, in order.
    expect(data[0].id).toBe(0)
    expect(data[2499].id).toBe(2499)
    expect(new Set(data.map((r) => r.id)).size).toBe(2500)
    // Two full pages prove the server fills pages; the short third ends it.
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('NEVER trusts pageSize as the server cap: a lower db-max-rows still reads everything', async () => {
    // Server silently serves at most 500/request while we ask for 1,000 —
    // the exact config change that would have resurrected the harvest bug.
    const t = fakeTable(2500, { pageSize: 1000, serverCap: 500 })
    const { data, error } = await t.run()
    expect(error).toBeNull()
    expect(data).toHaveLength(2500)
    expect(new Set(data.map((r) => r.id)).size).toBe(2500)
    // Requests resume at the received count and only an empty page ends it.
    expect(t.calls).toEqual([[0, 999], [500, 1499], [1000, 1999], [1500, 2499], [2000, 2999], [2500, 3499]])
  })

  it('a table smaller than one page confirms the end with one empty probe', async () => {
    const t = fakeTable(800, { pageSize: 1000 })
    const { data } = await t.run()
    expect(data).toHaveLength(800)
    expect(t.calls).toEqual([[0, 999], [800, 1799]])
  })

  it('a table ending exactly on a page boundary stops after one empty page', async () => {
    const t = fakeTable(2000, { pageSize: 1000 })
    const { data } = await t.run()
    expect(data).toHaveLength(2000)
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('an empty table returns no rows after one request', async () => {
    const t = fakeTable(0, { pageSize: 1000 })
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
