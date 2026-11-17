// The pagination guard: cap-agnostic termination (a short page ends the read
// only after the server has proven it can fill a page; otherwise probe on to
// an empty page), errors surface, and requests resume at the received count.

import { describe, expect, it } from 'vitest'
import { fetchAllRows, fetchAllRowsParallel } from '@/lib/fetch-all-rows'

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

// The pages-together read for big tables (the cotton per-bale tables every
// cotton report waits on). Same result as the loop, fewer seconds — and the
// loop again the moment anything does not add up.
describe('fetchAllRowsParallel', () => {
  function table(rowCount: number, opts: { serverCap?: number; failPage?: number } = {}) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i }))
    const calls: Array<[number, number]> = []
    let inFlight = 0
    let peak = 0
    const build = async (from: number, to: number) => {
      calls.push([from, to])
      inFlight++
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight--
      if (opts.failPage != null && from === opts.failPage * 1000 && calls.filter(([f]) => f === from).length === 1) return { data: null, error: { message: 'boom' } }
      const want = Math.min(to - from + 1, opts.serverCap ?? 1000)
      return { data: rows.slice(from, from + want), error: null }
    }
    return { calls, build, peak: () => peak }
  }
  const counted = (n: number | null, error: { message: string } | null = null) => () => Promise.resolve({ count: n, error })

  it('fetches every page of a big table at once, every row once and in order', async () => {
    const t = table(7636)
    const { data, error } = await fetchAllRowsParallel<{ id: number }>(counted(7636), t.build)
    expect(error).toBeNull()
    expect(data).toHaveLength(7636)
    expect(data.map((r) => r.id)).toEqual(Array.from({ length: 7636 }, (_, i) => i))
    expect(t.calls).toHaveLength(8) // eight pages, no probing request
    expect(t.peak()).toBe(8) // all in flight together
  })

  it('a table that fits one page takes the plain loop (nothing to parallelize)', async () => {
    const t = table(308)
    const { data } = await fetchAllRowsParallel<{ id: number }>(counted(308), t.build)
    expect(data).toHaveLength(308)
    expect(t.calls[0]).toEqual([0, 999])
    expect(t.peak()).toBe(1)
  })

  it('falls back to the loop when the count is unavailable, wrong, or a page fails — never a short read', async () => {
    // No count (an error, or a client that does not return one).
    for (const count of [counted(null), counted(5000, { message: 'no' }), () => Promise.reject(new Error('down')) as never, (() => Promise.resolve({})) as never]) {
      const t = table(2500)
      const { data, error } = await fetchAllRowsParallel<{ id: number }>(count, t.build)
      expect(error).toBeNull()
      expect(data).toHaveLength(2500)
    }
    // The server serves fewer rows per request than a page asks for: the pages come back short, so the loop takes over.
    const capped = table(2500, { serverCap: 400 })
    const a = await fetchAllRowsParallel<{ id: number }>(counted(2500), capped.build)
    expect(a.data).toHaveLength(2500)
    expect(a.data.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i))
    // Rows were added after the count: the total no longer matches, so the loop reads them all.
    const grew = table(2600)
    const b = await fetchAllRowsParallel<{ id: number }>(counted(2500), grew.build)
    expect(b.data).toHaveLength(2600)
    // One page errors once: the loop retries the whole read.
    const flaky = table(2500, { failPage: 1 })
    const c = await fetchAllRowsParallel<{ id: number }>(counted(2500), flaky.build)
    expect(c.error).toBeNull()
    expect(c.data).toHaveLength(2500)
  })
})
