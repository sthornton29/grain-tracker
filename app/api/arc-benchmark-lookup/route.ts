import { NextRequest, NextResponse } from 'next/server'
import { parseArcBenchmarkRequest, normalizeArcBenchmarkResult } from '@/lib/ai-lookups'
import { aiWebSearchJson, AiLookupError } from '@/lib/ai-web-search'

export const runtime = 'nodejs'
export const maxDuration = 60

// AI autofill for ARC-CO benchmark data: given commodity + county + state +
// program year, use Claude with web search to look up the FSA-published ARC-CO
// benchmark (county) yield and benchmark price. FSA publishes these as public
// Excel/PDF files on fsa.usda.gov's ARC/PLC program-data page; farmdoc and
// state extension sites republish them. The route returns the values with a
// source description for USER CONFIRMATION — nothing is saved here; the
// settings UI saves to arc_benchmark_data (source='ai') only after the user
// confirms. County AND state are both required: county names repeat across
// states (30+ Washington Counties), so a bare county name is ambiguous.
// When the requested year isn't published yet, the lookup falls back to the
// MOST RECENT crop year with FSA data and reports it via data_year (the UI
// flags a prior-year result). Results are cached in-process on commodity +
// county_id + program year.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // FSA benchmark data is static once published

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const parsed = parseArcBenchmarkRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { commodity, county, state, countyId, cropYear } = parsed.value

  const prompt = `Look up the USDA FSA-published ARC-CO (Agriculture Risk Coverage – County) benchmark data for:

- Commodity: ${commodity}
- County: ${county} County, ${state}
- Program (crop) year: ${cropYear}

You are looking for two numbers from FSA's official ARC/PLC program data (fsa.usda.gov publishes these as public Excel/PDF files on its ARC/PLC program-data page; farmdocdaily.illinois.edu and state extension sites republish the same tables):
1. The ARC-CO BENCHMARK YIELD for that county and commodity — the 5-year Olympic average trend-adjusted county yield, in bushels per acre (pounds per acre for seed cotton).
2. The ARC-CO BENCHMARK PRICE for that commodity and year — the 5-year Olympic average MYA price with effective-reference-price substitution, in dollars per bushel (dollars per pound for seed cotton). This is national, not county-specific (for reference, the FSA 2025/2026 benchmark prices are corn $5.03, soybeans $12.17, wheat $6.98).

IMPORTANT: county names repeat across states — make sure the yield is for ${county} County in ${state}, not a same-named county in another state. Your source_description MUST name the county and state you found the data for (e.g. "${county} County, ${state}") so the user can verify the right county was matched.

MOST RECENT AVAILABLE YEAR: if FSA has not yet published ARC-CO benchmark data for ${cropYear} (early in a program year it often isn't out), fall back to the MOST RECENT prior crop year that HAS published FSA benchmark data for this county and commodity, and report those numbers. Set "data_year" to the crop year the numbers are actually for (${cropYear} when you found the requested year, the fallback year otherwise) and name that year in source_description. Never mix years — the yield and price must come from the same crop year's data.

If the county has separate irrigated/non-irrigated benchmarks, report the combined/all-practice yield if available, otherwise the non-irrigated one and say so in source_description.

Set confidence to "high" ONLY if you found the number in FSA data or a source that clearly republishes FSA data for exactly this county/state/commodity and the data_year you report. If you cannot find the county yield for ANY year, return null for it — do NOT estimate, extrapolate from nearby counties, or use NASS county yields (those are not the ARC benchmark).

Respond ONLY with JSON, no other text, no markdown fences:
{"benchmark_yield": number or null, "benchmark_price": number or null, "data_year": number or null, "source_description": "one or two sentences saying where the numbers came from, naming the county, state, and data year", "confidence": "high" or "low"}`

  try {
    const raw = await aiWebSearchJson({
      prompt,
      cacheKey: `arc-benchmark:${commodity.toLowerCase()}:${countyId ?? `${county.toLowerCase()}|${state.toLowerCase()}`}:${cropYear}`,
      cacheTtlMs: CACHE_TTL_MS,
      maxSearches: 6,
    })
    return NextResponse.json({ data: normalizeArcBenchmarkResult(raw, { county, state, cropYear }) })
  } catch (e) {
    if (e instanceof AiLookupError) {
      const msg = e.kind === 'parse'
        ? "Couldn't parse the lookup response. Enter the benchmark manually from your FSA office or fsa.usda.gov."
        : e.message
      return NextResponse.json({ error: msg }, { status: 500 })
    }
    throw e
  }
}
