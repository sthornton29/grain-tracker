import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 2048

// AI autofill for ARC-CO benchmark data: given commodity + county + state +
// program year, use Claude with web search to look up the FSA-published ARC-CO
// benchmark (county) yield and benchmark price. FSA publishes these as public
// Excel/PDF files on fsa.usda.gov's ARC/PLC program-data page; farmdoc and
// state extension sites republish them. The route returns the values with a
// source description for USER CONFIRMATION — nothing is saved here; the
// settings UI saves to arc_benchmark_data (source='ai') only after the user
// confirms.

type LookupResult = {
  benchmark_yield: number | null
  benchmark_price: number | null
  source_description: string
  confidence: 'high' | 'low'
}

function extractJson(text: string): string {
  let s = text.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) return s.slice(first, last + 1)
  return s
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 500 })

  let body: { commodity?: unknown; county?: unknown; state?: unknown; crop_year?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const commodity = typeof body.commodity === 'string' ? body.commodity.trim() : ''
  const county = typeof body.county === 'string' ? body.county.trim() : ''
  const state = typeof body.state === 'string' ? body.state.trim() : ''
  const cropYear = Number(body.crop_year)
  if (!commodity || !county || !Number.isFinite(cropYear)) {
    return NextResponse.json({ error: 'commodity, county, and crop_year are required.' }, { status: 400 })
  }

  const prompt = `Look up the USDA FSA-published ARC-CO (Agriculture Risk Coverage – County) benchmark data for:

- Commodity: ${commodity}
- County: ${county}${state ? `, ${state}` : ''}
- Program (crop) year: ${cropYear}

You are looking for two numbers from FSA's official ARC/PLC program data (fsa.usda.gov publishes these as public Excel/PDF files on its ARC/PLC program-data page; farmdocdaily.illinois.edu and state extension sites republish the same tables):
1. The ARC-CO BENCHMARK YIELD for that county and commodity — the 5-year Olympic average trend-adjusted county yield, in bushels per acre (pounds per acre for seed cotton).
2. The ARC-CO BENCHMARK PRICE for that commodity and year — the 5-year Olympic average MYA price with effective-reference-price substitution, in dollars per bushel (dollars per pound for seed cotton). This is national, not county-specific (for reference, the FSA 2025/2026 benchmark prices are corn $5.03, soybeans $12.17, wheat $6.98).

If the county has separate irrigated/non-irrigated benchmarks, report the combined/all-practice yield if available, otherwise the non-irrigated one and say so in source_description.

Set confidence to "high" ONLY if you found the number in FSA data or a source that clearly republishes FSA data for exactly this county/commodity/year. If you cannot find the county yield, return null for it — do NOT estimate, extrapolate from nearby counties, or use NASS county yields (those are not the ARC benchmark).

Respond ONLY with JSON, no other text, no markdown fences:
{"benchmark_yield": number or null, "benchmark_price": number or null, "source_description": "one or two sentences saying where the numbers came from", "confidence": "high" or "low"}`

  const client = new Anthropic({ apiKey })
  let resp
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: prompt }],
    })
  } catch (e: any) {
    const msg = e?.error?.error?.message ?? e?.message ?? 'Anthropic API call failed.'
    return NextResponse.json({ error: `Lookup failed: ${msg}` }, { status: 500 })
  }

  // The final text block carries the JSON (earlier blocks are search calls).
  const textBlocks = resp.content.filter((c) => c.type === 'text')
  const lastText = textBlocks.length ? (textBlocks[textBlocks.length - 1] as { text: string }).text : ''
  let parsed: LookupResult
  try {
    const raw = JSON.parse(extractJson(lastText)) as Partial<LookupResult>
    parsed = {
      benchmark_yield: typeof raw.benchmark_yield === 'number' && Number.isFinite(raw.benchmark_yield) ? raw.benchmark_yield : null,
      benchmark_price: typeof raw.benchmark_price === 'number' && Number.isFinite(raw.benchmark_price) ? raw.benchmark_price : null,
      source_description: typeof raw.source_description === 'string' ? raw.source_description : '',
      confidence: raw.confidence === 'high' ? 'high' : 'low',
    }
  } catch {
    return NextResponse.json({ error: "Couldn't parse the lookup response. Enter the benchmark manually from your FSA office or fsa.usda.gov." }, { status: 500 })
  }

  return NextResponse.json({ data: parsed })
}
