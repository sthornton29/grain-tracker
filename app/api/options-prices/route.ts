import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

const BARCHART_URL = 'https://ondemand.websol.barchart.com/getFuturesOptions.json'

// Each request identifies one held option by its underlying contract, type, and
// strike (in dollars/bu). The client matches the returned cents/bu back by id.
type OptionRequest = {
  id: string
  root: string // e.g. 'ZC'
  contract: string // underlying symbol, e.g. 'ZCZ26'
  optionType: 'put' | 'call'
  strike: number // dollars per bushel, e.g. 4.80
}

// Grain option strikes/premiums quote in cents. Compare a Barchart strike to
// our dollar strike allowing for either unit (480 cents vs 4.80 dollars).
function strikeMatches(barchartStrike: number, ourStrikeDollars: number): boolean {
  return (
    Math.abs(barchartStrike - ourStrikeDollars * 100) < 0.5 ||
    Math.abs(barchartStrike - ourStrikeDollars) < 0.005
  )
}

export async function POST(req: NextRequest) {
  let body: { requests?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const requests: OptionRequest[] = Array.isArray(body.requests)
    ? (body.requests as any[]).filter(
        (r) => r && typeof r.id === 'string' && typeof r.contract === 'string' && (r.optionType === 'put' || r.optionType === 'call'),
      )
    : []

  const apiKey = process.env.BARCHART_API_KEY
  const values: Record<string, number | null> = {}
  for (const r of requests) values[r.id] = null

  // Future-ready: with no key (or no options entitlement), report unavailable so
  // the UI falls back to manual current values.
  if (!apiKey || requests.length === 0) {
    return NextResponse.json({
      available: false,
      note: 'Live options pricing not available — enter current values manually.',
      values,
    })
  }

  // Fetch each (contract, type) chain once, then match strikes within it.
  const groups = new Map<string, OptionRequest[]>()
  for (const r of requests) {
    const key = `${r.contract}|${r.optionType}`
    const arr = groups.get(key) ?? []
    arr.push(r)
    groups.set(key, arr)
  }

  let anySuccess = false
  try {
    for (const [key, reqs] of groups) {
      const [contract, optionType] = key.split('|')
      const root = reqs[0].root || contract.slice(0, 2)
      const typeParam = optionType === 'put' ? 'Put' : 'Call'
      const url = `${BARCHART_URL}?apikey=${encodeURIComponent(apiKey)}&root=${encodeURIComponent(root)}&contract=${encodeURIComponent(contract)}&type=${typeParam}&fields=premium,openInterest`
      const resp = await fetch(url, { cache: 'no-store' })
      const json = await resp.json().catch(() => null)
      const results: any[] = Array.isArray(json?.results) ? json.results : []
      if (results.length === 0) continue
      anySuccess = true
      for (const r of reqs) {
        const hit = results.find((o) => {
          const s = typeof o?.strike === 'number' ? o.strike : Number(o?.strike)
          return Number.isFinite(s) && strikeMatches(s, r.strike)
        })
        const prem = hit?.premium ?? hit?.last ?? hit?.lastPrice
        const cents = typeof prem === 'number' ? prem : Number(prem)
        if (Number.isFinite(cents)) values[r.id] = cents
      }
    }
  } catch {
    return NextResponse.json({
      available: false,
      note: 'Could not reach Barchart options pricing — enter current values manually.',
      values,
    })
  }

  if (!anySuccess) {
    return NextResponse.json({
      available: false,
      note: 'Barchart returned no options data for these contracts — enter current values manually.',
      values,
    })
  }

  return NextResponse.json({ available: true, values })
}
