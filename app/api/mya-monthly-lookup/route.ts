import { NextRequest, NextResponse } from 'next/server'
import {
  parseMyaMonthlyRequest, normalizeMyaMonthlyResult, elapsedMarketingMonths, monthKey,
} from '@/lib/ai-lookups'
import { aiWebSearchJson, AiLookupError } from '@/lib/ai-web-search'

export const runtime = 'nodejs'
export const maxDuration = 60

// AI autofill for the mya_monthly_prices table: given commodity + marketing
// year (2025 corn = Sep 2025 – Aug 2026), use Claude with web search to
// retrieve the USDA NASS monthly average prices received by farmers for the
// elapsed months of the marketing year. NASS publishes these in Quick Stats
// (quickstats.nass.usda.gov) and the monthly Agricultural Prices report;
// farmdoc and extension sites republish them. Same pattern as
// /api/arc-benchmark-lookup: the route returns values for USER CONFIRMATION —
// nothing is saved here; the MYA panel saves confirmed months (source='ai')
// only after the user confirms. Cached in-process on commodity + marketing
// year (short TTL — NASS revises recent months monthly).

const CACHE_TTL_MS = 30 * 60 * 1000
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const parsed = parseMyaMonthlyRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { commodity, marketingYear, startMonth, unit } = parsed.value

  const elapsed = elapsedMarketingMonths(startMonth, marketingYear, new Date())
  if (elapsed.length === 0) {
    return NextResponse.json(
      { error: `The ${marketingYear} marketing year for ${commodity} hasn't started yet (it begins ${MONTH_NAME[startMonth - 1]} ${marketingYear}) — there are no monthly prices to look up.` },
      { status: 400 },
    )
  }

  const endMonth = ((startMonth + 10) % 12) + 1
  const unitTxt = unit === 'pound'
    ? 'dollars per pound ($/lb — NASS reports upland cotton lint in cents per pound and cottonseed in dollars per ton; for cotton, report the lint price converted to $/lb and say so in source_description)'
    : 'dollars per bushel ($/bu)'

  const prompt = `Look up the USDA NASS monthly average prices received by farmers (U.S. national) for:

- Commodity: ${commodity}
- Marketing year: ${marketingYear} (${MONTH_NAME[startMonth - 1]} ${marketingYear} – ${MONTH_NAME[endMonth - 1]} ${marketingYear + 1})

NASS publishes these in the monthly Agricultural Prices report and in Quick Stats (quickstats.nass.usda.gov); farmdoc and university extension sites republish the same tables. You need the national monthly average price received by farmers, in ${unitTxt}, for each of these elapsed months of the marketing year:

${elapsed.map((m) => `- ${monthKey(m)} (${MONTH_NAME[m.month - 1]} ${m.year})`).join('\n')}

For any month NASS has not yet published, return price null and status "not_yet_published". Do NOT estimate, interpolate, use futures prices, or use season-average forecasts — only actual NASS monthly prices received. The one or two most recent published months are often preliminary (mid-month) values; report them anyway and note it in source_description. Say in source_description which NASS release (e.g. "USDA NASS Agricultural Prices, June ${marketingYear + 1} release") or which republication the numbers came from. Set confidence to "high" ONLY if the numbers come from NASS data or a source that clearly republishes NASS data for exactly this commodity and these months.

Respond ONLY with JSON, no other text, no markdown fences:
{"commodity": "${commodity}", "marketing_year": ${marketingYear}, "monthly_prices": [{"month": "YYYY-MM", "price": number or null, "status": "published" or "not_yet_published"}], "source_description": "which release/source the numbers came from", "confidence": "high" or "low"}`

  try {
    const raw = await aiWebSearchJson({
      prompt,
      cacheKey: `mya-monthly:${commodity.toLowerCase()}:${marketingYear}:${startMonth}`,
      cacheTtlMs: CACHE_TTL_MS,
      maxSearches: 8,
      maxTokens: 3072,
    })
    return NextResponse.json({ data: normalizeMyaMonthlyResult(raw, startMonth, marketingYear) })
  } catch (e) {
    if (e instanceof AiLookupError) {
      const msg = e.kind === 'parse'
        ? "Couldn't parse the lookup response. Enter the monthly prices manually from the NASS Agricultural Prices report."
        : e.message
      return NextResponse.json({ error: msg }, { status: 500 })
    }
    throw e
  }
}
