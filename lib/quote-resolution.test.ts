import { describe, it, expect } from 'vitest'
import { pickQuote, resolveQuotes } from '@/lib/quote-resolution'
import type { SupabaseClient } from '@supabase/supabase-js'

// THE resolution order: live wins (today's cache, a fresh fetch, or the most
// recent live close); a failed or empty live fetch falls to the org's manual
// quote; neither → no quote. Manual rows are carried on every response only
// as the LAST tier — a live price always outranks them.

const TODAY = '2026-09-08'

describe('pickQuote — the pure order', () => {
  const manual = { price: 72.65, entered_at: '2026-09-02T14:00:00Z' }
  it('today\'s live cache wins over everything', () => {
    const q = pickQuote({ symbol: 'CTZ26', today: TODAY, cachedToday: { price: 74.1, price_date: TODAY }, fetched: { price: 73, price_date: TODAY }, manual })
    expect(q).toMatchObject({ price: 74.1, source: 'live', stale: false })
  })
  it('a fresh fetch beats a manual quote', () => {
    const q = pickQuote({ symbol: 'CTZ26', today: TODAY, fetched: { price: 73, price_date: TODAY }, manual })
    expect(q).toMatchObject({ price: 73, source: 'live', stale: false, entered_at: null })
  })
  it('yesterday\'s live close still beats a manual quote (stale, but live)', () => {
    const q = pickQuote({ symbol: 'ZCZ26', today: TODAY, recentLive: { price: 4.5, price_date: '2026-09-05' }, manual: { price: 4.4, entered_at: '2026-09-07T09:00:00Z' } })
    expect(q).toMatchObject({ price: 4.5, source: 'live', stale: true, price_date: '2026-09-05' })
  })
  it('no live candidate → the manual quote, labeled, dated by its entry day', () => {
    const q = pickQuote({ symbol: 'CTZ26', today: TODAY, manual })
    expect(q).toEqual({ symbol: 'CTZ26', price: 72.65, price_date: '2026-09-02', stale: true, source: 'manual', entered_at: '2026-09-02T14:00:00Z' })
  })
  it('a manual quote typed today is not stale', () => {
    expect(pickQuote({ symbol: 'CTZ26', today: TODAY, manual: { price: 72.65, entered_at: `${TODAY}T15:00:00` } }).stale).toBe(false)
  })
  it('neither → the existing no-quote row', () => {
    expect(pickQuote({ symbol: 'CTH27', today: TODAY })).toEqual({ symbol: 'CTH27', price: null, price_date: null, stale: true, source: null, entered_at: null })
  })
})

// ---- resolveQuotes against a stubbed Supabase + injectable live fetch ----

type Row = Record<string, unknown>
function stubSupabase(tables: { market_prices: Row[]; manual_market_quotes?: Row[] | 'missing' }) {
  const upserts: Row[] = []
  const query = (rows: Row[]) => {
    const filters: Array<(r: Row) => boolean> = []
    let orderDesc: string | null = null
    const chain: any = {
      select: () => chain,
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return chain },
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain },
      order: (col: string, o?: { ascending?: boolean }) => { orderDesc = o?.ascending === false ? col : null; return chain },
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        let data = rows.filter((r) => filters.every((f) => f(r)))
        if (orderDesc) data = [...data].sort((a, b) => String(b[orderDesc!]).localeCompare(String(a[orderDesc!])))
        resolve({ data, error: null })
      },
    }
    return chain
  }
  const sb = {
    from: (table: string) => {
      if (table === 'market_prices') {
        const q = query(tables.market_prices)
        q.upsert = async (rows: Row[]) => { upserts.push(...rows); return { error: null } }
        return q
      }
      if (table === 'manual_market_quotes') {
        if (tables.manual_market_quotes === 'missing') {
          const failing: any = { select: () => failing, in: () => failing, eq: () => failing, then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'relation does not exist' } }) }
          return failing
        }
        return query(tables.manual_market_quotes ?? [])
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { sb: sb as unknown as SupabaseClient, upserts }
}

const manualCotton = { org_id: 'org-1', contract_symbol: 'CTZ26', price: 72.65, entered_at: '2026-09-02T14:00:00Z' }

describe('resolveQuotes — live → manual → none', () => {
  it('a successful live fetch wins and is cached as live; the manual row is untouched', async () => {
    const { sb, upserts } = stubSupabase({ market_prices: [], manual_market_quotes: [manualCotton] })
    const res = await resolveQuotes({
      supabase: sb, symbols: ['CTZ26', 'ZCZ26'], today: TODAY, apiKey: 'k',
      live: async () => new Map([['CTZ26', { price: 74.1, price_date: TODAY }], ['ZCZ26', { price: 4.5, price_date: TODAY }]]),
    })
    expect(res.prices.find((p) => p.symbol === 'CTZ26')).toMatchObject({ price: 74.1, source: 'live' })
    expect(res.prices.find((p) => p.symbol === 'ZCZ26')).toMatchObject({ price: 4.5, source: 'live' })
    expect(upserts.map((u) => u.contract_symbol).sort()).toEqual(['CTZ26', 'ZCZ26'])
    expect(res.note).toBeUndefined()
  })

  it('the fetch fails → the manual quote for cotton, none for a grain with nothing cached, and the note', async () => {
    const { sb } = stubSupabase({ market_prices: [], manual_market_quotes: [manualCotton] })
    const res = await resolveQuotes({
      supabase: sb, symbols: ['CTZ26', 'ZCZ26'], today: TODAY, apiKey: 'k',
      live: async () => { throw new Error('ECONNRESET') },
    })
    expect(res.prices.find((p) => p.symbol === 'CTZ26')).toMatchObject({ price: 72.65, source: 'manual', entered_at: '2026-09-02T14:00:00Z', price_date: '2026-09-02', stale: true })
    expect(res.prices.find((p) => p.symbol === 'ZCZ26')).toMatchObject({ price: null, source: null })
    expect(res.note).toMatch(/Could not reach Barchart/)
  })

  it('the fetch succeeds for grains but returns nothing for cotton → live grain, manual cotton (the ICE case)', async () => {
    const { sb } = stubSupabase({ market_prices: [], manual_market_quotes: [manualCotton] })
    const res = await resolveQuotes({
      supabase: sb, symbols: ['CTZ26', 'ZCZ26'], today: TODAY, apiKey: 'k',
      live: async () => new Map([['ZCZ26', { price: 4.5, price_date: TODAY }]]),
    })
    expect(res.prices.find((p) => p.symbol === 'ZCZ26')).toMatchObject({ price: 4.5, source: 'live' })
    expect(res.prices.find((p) => p.symbol === 'CTZ26')).toMatchObject({ price: 72.65, source: 'manual' })
  })

  it('a live close from an earlier day outranks the manual row', async () => {
    const { sb } = stubSupabase({
      market_prices: [{ contract_symbol: 'CTZ26', price: 73.4, price_date: '2026-09-04' }],
      manual_market_quotes: [manualCotton],
    })
    const res = await resolveQuotes({ supabase: sb, symbols: ['CTZ26'], today: TODAY, apiKey: 'k', live: async () => new Map() })
    expect(res.prices[0]).toMatchObject({ price: 73.4, source: 'live', stale: true, price_date: '2026-09-04' })
  })

  it('no key, no cache, no manual → no quote (and the key note); 082 not applied degrades the same way', async () => {
    const none = stubSupabase({ market_prices: [], manual_market_quotes: [] })
    const r1 = await resolveQuotes({ supabase: none.sb, symbols: ['CTZ26'], today: TODAY, apiKey: null })
    expect(r1.prices[0]).toMatchObject({ price: null, source: null })
    expect(r1.note).toMatch(/BARCHART_API_KEY/)
    const missing = stubSupabase({ market_prices: [], manual_market_quotes: 'missing' })
    const r2 = await resolveQuotes({ supabase: missing.sb, symbols: ['CTZ26'], today: TODAY, apiKey: null })
    expect(r2.prices[0]).toMatchObject({ price: null, source: null })
  })

  it('service-role callers scope manual rows to their org', async () => {
    const { sb } = stubSupabase({ market_prices: [], manual_market_quotes: [manualCotton, { ...manualCotton, org_id: 'org-2', price: 99 }] })
    const mine = await resolveQuotes({ supabase: sb, symbols: ['CTZ26'], today: TODAY, apiKey: null, orgId: 'org-1' })
    expect(mine.prices[0].price).toBe(72.65)
    const theirs = await resolveQuotes({ supabase: sb, symbols: ['CTZ26'], today: TODAY, apiKey: null, orgId: 'org-2' })
    expect(theirs.prices[0].price).toBe(99)
  })

  it('dedupes and upper-cases symbols', async () => {
    const { sb } = stubSupabase({ market_prices: [], manual_market_quotes: [manualCotton] })
    const res = await resolveQuotes({ supabase: sb, symbols: ['ctz26', 'CTZ26', ' ctz26 '], today: TODAY, apiKey: null })
    expect(res.prices).toHaveLength(1)
    expect(res.prices[0].symbol).toBe('CTZ26')
  })
})
