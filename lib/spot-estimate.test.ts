import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateSpotPrice, historyFromSettledRows, settleOnOrBefore, withSpotEstimate } from '@/lib/spot-estimate'

// The spot estimate against the database (094): the futures settle on/just
// before the delivery date, this buyer's implied basis from settled spot
// loads, the crop's assumed basis as the fallback, today's quote as the
// last resort. FIXTURE prices — nothing here is a real market value.

// A tiny Supabase double: every builder method returns the builder, and
// awaiting it hands the recorded table + filters to the test's resolver.
type Call = { table: string; filters: Array<[string, string, unknown]>; limit: number | null; single: boolean }
function fakeSupabase(resolve: (c: Call) => unknown[] | { error: string }): { client: SupabaseClient; calls: Call[] } {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [], limit: null, single: false }
      calls.push(call)
      const b: Record<string, unknown> = {}
      const chain = (op: string) => (col: string, val: unknown) => { call.filters.push([op, col, val]); return b }
      b.select = () => b
      b.eq = chain('eq'); b.lte = chain('lte'); b.gte = chain('gte'); b.in = chain('in')
      b.order = () => b
      b.limit = (n: number) => { call.limit = n; return b }
      b.maybeSingle = () => { call.single = true; return b }
      b.then = (ok: (v: unknown) => unknown) => {
        const r = resolve(call)
        if (!Array.isArray(r)) return Promise.resolve(ok({ data: null, error: { message: r.error } }))
        return Promise.resolve(ok({ data: call.single ? r[0] ?? null : r, error: null }))
      }
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const f = (col: string) => (c: Call) => c.filters.find((x) => x[1] === col)?.[2]

describe('settleOnOrBefore', () => {
  it('picks the newest row dated on or before the day, ignoring later ones', () => {
    const rows = [
      { contract_symbol: 'ZSX26', price: 13.1, price_date: '2026-09-25' },
      { contract_symbol: 'ZSX26', price: 13.2, price_date: '2026-09-28' },
      { contract_symbol: 'ZSX26', price: 13.9, price_date: '2026-09-30' },
    ]
    expect(settleOnOrBefore(rows, '2026-09-28')).toEqual({ price: 13.2, priceDate: '2026-09-28' })
    expect(settleOnOrBefore(rows, '2026-09-27')).toEqual({ price: 13.1, priceDate: '2026-09-25' })
    expect(settleOnOrBefore(rows, '2026-09-20')).toBeNull()
    expect(settleOnOrBefore([], '2026-09-20')).toBeNull()
  })
})

describe('historyFromSettledRows', () => {
  it('pairs each settled spot load with its delivery-date settle and skips rows with none', () => {
    const rows = [
      { spot_price: 13.74, load: { date: '2026-10-02' } },
      { spot_price: 13.38, load: { date: '2026-09-28' } },
      { spot_price: 13.0, load: { date: '2026-09-01' } }, // no settle on file
      { spot_price: null, load: { date: '2026-09-29' } },
      { spot_price: 12.5, load: null },
    ]
    const settles: Record<string, number> = { '2026-10-02': 13.5, '2026-09-28': 13.2 }
    const pts = historyFromSettledRows(rows, 'Soybeans', (symbol, date) => (symbol === 'ZSX26' && settles[date] != null ? { price: settles[date] } : null))
    expect(pts).toEqual([
      { date: '2026-10-02', settledPrice: 13.74, futuresSettle: 13.5 },
      { date: '2026-09-28', settledPrice: 13.38, futuresSettle: 13.2 },
    ])
  })
  it('a crop with no traded future yields no history', () => {
    expect(historyFromSettledRows([{ spot_price: 10, load: { date: '2026-10-02' } }], 'Sesame', () => ({ price: 1 }))).toEqual([])
  })
})

describe('estimateSpotPrice', () => {
  const args = { cropName: 'Soybeans', cropId: 'soy', cropYear: 2026, buyerId: 'bunge', buyerName: 'Bunge', deliveryDate: '2026-09-28' }

  it('delivery-date settle + the buyer\'s implied basis from its settled spot loads', async () => {
    const { client, calls } = fakeSupabase((c) => {
      if (c.table === 'market_prices') {
        // Both the delivery-date read and the history span read see the same fixtures.
        return [
          { contract_symbol: 'ZSX26', price: 13.2, price_date: '2026-09-28' },
          { contract_symbol: 'ZSX26', price: 13.5, price_date: '2026-10-02' },
          { contract_symbol: 'ZSX26', price: 13.1, price_date: '2026-09-25' },
        ].filter((r) => r.price_date <= (f('price_date')(c) as string))
      }
      if (c.table === 'load_sales') {
        expect(f('load.crop_id')(c)).toBe('soy')
        expect(f('load.to_buyer_id')(c)).toBe('bunge')
        return [
          { spot_price: 13.38, load: { date: '2026-09-26' } }, // 13.38 − 13.1 = +0.28
          { spot_price: 13.3, load: { date: '2026-09-20' } },  // no settle that far back in fixtures → skipped
        ]
      }
      if (c.table === 'crop_assumptions') return [{ assumed_basis: -0.4 }]
      return []
    })
    const d = await estimateSpotPrice(client, args)
    expect(d.source).toBe('estimate')
    expect(d.est_futures_symbol).toBe('ZSX26')
    expect(d.est_futures_price).toBe(13.2)
    expect(d.basisSource).toBe('buyer')
    expect(d.est_basis).toBeCloseTo(0.28, 6)
    expect(d.price).toBeCloseTo(13.48, 6)
    expect(d.label).toBe('est. $13.48 (ZSX26 9/28 close + Bunge basis +0.28)')
    expect(d.usedTodaysFutures).toBe(false)
    // The assumed basis was never needed.
    expect(calls.some((c) => c.table === 'crop_assumptions')).toBe(false)
  })

  it('no settled history → the crop\'s assumed basis', async () => {
    const { client } = fakeSupabase((c) => {
      if (c.table === 'market_prices') return [{ contract_symbol: 'ZSX26', price: 13.2, price_date: '2026-09-26' }]
      if (c.table === 'load_sales') return []
      if (c.table === 'crop_assumptions') return [{ assumed_basis: '-0.35' }]
      return []
    })
    const d = await estimateSpotPrice(client, args)
    expect(d.basisSource).toBe('assumed')
    expect(d.price).toBeCloseTo(12.85, 6)
    expect(d.label).toBe('est. $12.85 (ZSX26 9/26 close + assumed basis −0.35)')
  })

  it('no settle on file at all → today\'s quote, and the chip says so', async () => {
    const { client } = fakeSupabase((c) => {
      if (c.table === 'load_sales') return { error: 'relation "public.load_sales" does not exist' }
      return []
    })
    const d = await estimateSpotPrice(client, args, { fetchQuote: async (symbol) => (symbol === 'ZSX26' ? { price: 13.0, priceDate: '2026-10-13' } : null) })
    expect(d.usedTodaysFutures).toBe(true)
    expect(d.basisSource).toBe('assumed')
    expect(d.est_basis).toBe(0)
    expect(d.price).toBe(13)
    expect(d.label).toBe("est. $13.00 (today's futures + assumed basis +0.00)")
  })

  it('nothing anywhere → no price yet (never throws)', async () => {
    const { client } = fakeSupabase(() => ({ error: 'network' }))
    const d = await estimateSpotPrice(client, args, { fetchQuote: async () => null })
    expect(d.price).toBeNull()
    expect(d.source).toBeNull()
    expect(d.label).toBe('no price yet')
  })

  it('a crop with no futures market → no price yet, no lookups', async () => {
    const { client, calls } = fakeSupabase(() => [])
    const d = await estimateSpotPrice(client, { ...args, cropName: 'Sesame' })
    expect(d.price).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('withSpotEstimate', () => {
  const est = { price: 13.48, source: 'estimate' as const, label: '', est_futures_price: 13.2, est_futures_symbol: 'ZSX26', est_basis: 0.28, basisSource: 'buyer' as const, usedTodaysFutures: false }
  it('fills an unpriced spot row and leaves everything else alone', () => {
    expect(withSpotEstimate({ sale_type: 'spot', share: 1, spot_price: null }, est)).toMatchObject({ spot_price: 13.48, spot_price_source: 'estimate', est_futures_symbol: 'ZSX26', est_basis: 0.28 })
    expect(withSpotEstimate({ sale_type: 'spot', share: 1, spot_price: 13.74 }, est)).toEqual({ sale_type: 'spot', share: 1, spot_price: 13.74 })
    expect(withSpotEstimate({ sale_type: 'contract', share: 1 }, est)).toEqual({ sale_type: 'contract', share: 1 })
    expect(withSpotEstimate({ sale_type: 'spot', share: 1 }, { ...est, price: null })).toEqual({ sale_type: 'spot', share: 1 })
  })
})
