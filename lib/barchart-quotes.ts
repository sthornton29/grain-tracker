// Server-side public futures quotes for the (unauthenticated) login page.
//
// The login page can't call the authenticated /api/* routes — middleware
// redirects unauthenticated requests to /login — so the price board is rendered
// server-side here, where BARCHART_API_KEY is available. The Barchart response
// is cached for 5 minutes (Next data cache) so heavy login traffic can't burn
// the API quota, and a short timeout + blank fallback means a slow/down Barchart
// never blocks sign-in. This module must stay server-only (it reads the key).

import { contractMonthOptions, buildContractSymbol, type Commodity } from '@/lib/hedging'

export type PublicQuote = {
  commodity: string
  contractLabel: string // e.g. "JUL 26"
  symbol: string
  price: number | null // dollars per bushel
  priceDate: string | null
}

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getQuote.json'

// The grain futures shown on the board, each at its nearby active contract.
const BOARD: Array<{ label: string; commodity: Commodity }> = [
  { label: 'Corn', commodity: 'Corn' },
  { label: 'Soybeans', commodity: 'Soybeans' },
  { label: 'Wheat', commodity: 'Chicago Wheat' },
]

export async function fetchPublicQuotes(): Promise<{ quotes: PublicQuote[]; asOf: string | null; available: boolean }> {
  const specs = BOARD.map(({ label, commodity }) => {
    const opt = contractMonthOptions(commodity, new Date(), 12)[0]
    return { label, contractLabel: opt?.label ?? '', symbol: opt ? buildContractSymbol(commodity, opt.label) : '' }
  }).filter((s) => s.symbol)

  const blank = (): PublicQuote[] => specs.map((s) => ({ commodity: s.label, contractLabel: s.contractLabel, symbol: s.symbol, price: null, priceDate: null }))

  const apiKey = process.env.BARCHART_API_KEY
  if (!apiKey || specs.length === 0) return { quotes: blank(), asOf: null, available: false }

  try {
    const symbols = specs.map((s) => s.symbol).join(',')
    const url = `${BARCHART_URL}?apikey=${encodeURIComponent(apiKey)}&symbols=${encodeURIComponent(symbols)}`
    const resp = await fetch(url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(4000) })
    const json = await resp.json().catch(() => null)
    const results: any[] = Array.isArray(json?.results) ? json.results : []
    const bySym = new Map<string, { price: number; date: string | null }>()
    for (const r of results) {
      const sym = typeof r?.symbol === 'string' ? r.symbol.toUpperCase() : null
      const raw = r?.lastPrice ?? r?.close ?? r?.settlement
      const cents = typeof raw === 'number' ? raw : Number(raw)
      if (!sym || !Number.isFinite(cents)) continue
      const ts = typeof r?.tradeTimestamp === 'string' ? r.tradeTimestamp : typeof r?.serverTimestamp === 'string' ? r.serverTimestamp : ''
      bySym.set(sym, { price: Math.round((cents / 100) * 1e4) / 1e4, date: ts ? ts.slice(0, 10) : null }) // cents/bu -> $/bu
    }
    const quotes: PublicQuote[] = specs.map((s) => {
      const hit = bySym.get(s.symbol.toUpperCase())
      return { commodity: s.label, contractLabel: s.contractLabel, symbol: s.symbol, price: hit?.price ?? null, priceDate: hit?.date ?? null }
    })
    const asOf = quotes.reduce<string | null>((m, q) => (q.priceDate && (!m || q.priceDate > m) ? q.priceDate : m), null)
    return { quotes, asOf, available: results.length > 0 }
  } catch {
    return { quotes: blank(), asOf: null, available: false }
  }
}
