import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { parseArcBenchmarkRequest } from '@/lib/ai-lookups'
import {
  findBenchmarkFileLinks, pickBenchmarkFile, findFileUrlInDocumentPage, parseBenchmarkWorkbook,
  lookupBenchmarkRows, normalizeStateCode, normalizeCountyName, describeFsaFileSource,
  type ParsedWorkbook, type BenchmarkYieldMatch,
} from '@/lib/fsa-benchmark-file'

export const runtime = 'nodejs'
export const maxDuration = 60

// ARC-CO benchmark COUNTY YIELDS from FSA's own published Excel workbook
// ("ARC-County Benchmark Yields and Revenues") — the AI web-search lookup can
// find benchmark PRICES (published in small PDFs) but cannot open this
// workbook, so yields come from here. Flow:
//   1. Serve from fsa_benchmark_cache when the requested year × state ×
//      county × commodity is already ingested.
//   2. On a miss, and at most once daily per year × state
//      (fsa_benchmark_fetches), fetch the FSA ARC/PLC program-data page,
//      locate the workbook link for the requested year (falling back to the
//      most recent published year, reported via data_year), download + parse
//      it (header-row discovery — FSA's layout shifts year to year), and cache
//      the requested state's rows.
//   3. Like every lookup here: values are returned for USER CONFIRMATION —
//      this route never writes arc_benchmark_data.
// A county/commodity the file doesn't carry returns not_found so the client
// can offer the AI web-search fallback.

const FSA_PAGE_URL = 'https://www.fsa.usda.gov/resources/programs/arc-plc/program-data'
const FETCH_GUARD_MS = 24 * 60 * 60 * 1000
const INSERT_CHUNK = 1000

// Parsed-workbook memo so adding several states (or concurrent lookups) never
// re-downloads the multi-megabyte file within the hour.
const wbMemo = new Map<string, { expires: number; promise: Promise<ParsedWorkbook> }>()

async function downloadAndParseWorkbook(url: string): Promise<ParsedWorkbook> {
  const now = Date.now()
  const hit = wbMemo.get(url)
  if (hit && hit.expires > now) return hit.promise
  const promise = (async () => {
    const headers = { 'user-agent': 'grain-tracker (benchmark lookup)' }
    let resp = await fetch(url, { cache: 'no-store', headers })
    if (!resp.ok) throw new Error(`FSA file download failed (HTTP ${resp.status}).`)
    let buf = await resp.arrayBuffer()
    // FSA's /documents/... links land on a Drupal page, not the workbook —
    // follow the .xlsx link inside it.
    if ((resp.headers.get('content-type') ?? '').includes('html')) {
      const fileUrl = findFileUrlInDocumentPage(new TextDecoder().decode(buf))
      if (!fileUrl) throw new Error('FSA document page had no Excel link — the page format may have changed.')
      resp = await fetch(fileUrl, { cache: 'no-store', headers })
      if (!resp.ok) throw new Error(`FSA workbook download failed (HTTP ${resp.status}).`)
      buf = await resp.arrayBuffer()
    }
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheets = wb.SheetNames.map((name) => ({
      name,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) as (string | number | null)[][],
    }))
    const parsed = parseBenchmarkWorkbook(sheets)
    if (parsed.rows.length === 0) {
      console.error(
        `[fsa-benchmark-yield] Workbook layout not recognized at ${url} — no sheet had a header row naming state/county/benchmark yield. Sheets: ${parsed.sheetsSkipped.join(', ')}`,
      )
      throw new Error('FSA workbook layout not recognized — the file format may have changed.')
    }
    return parsed
  })()
  wbMemo.set(url, { expires: now + 60 * 60 * 1000, promise })
  promise.catch(() => { if (wbMemo.get(url)?.promise === promise) wbMemo.delete(url) })
  return promise
}

type CacheRow = {
  data_year: number
  state_code: string
  county: string
  commodity: string
  practice: 'irrigated' | 'non_irrigated' | 'all'
  benchmark_yield: number | null
  benchmark_price: number | null
  benchmark_revenue: number | null
  fetched_at: string
  source_url: string | null
}

type CacheHit = { rows: BenchmarkYieldMatch[]; dataYear: number; fetchedAt: string | null; fileUrl: string | null }

// Newest cached year ≤ the requested one that actually has this commodity.
function bestCacheHit(cached: CacheRow[], q: { commodity: string; county: string; state: string }): CacheHit | null {
  const years = Array.from(new Set(cached.map((r) => r.data_year))).sort((a, b) => b - a)
  for (const y of years) {
    const yearRows = cached.filter((r) => r.data_year === y)
    const rows = lookupBenchmarkRows(yearRows, q)
    if (rows.length > 0) {
      return { rows, dataYear: y, fetchedAt: yearRows[0]?.fetched_at ?? null, fileUrl: yearRows[0]?.source_url ?? null }
    }
  }
  return null
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const parsed = parseArcBenchmarkRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { commodity, county, state, cropYear } = parsed.value
  const stateCode = normalizeStateCode(state)
  if (!stateCode) return NextResponse.json({ error: `Unrecognized state "${state}".` }, { status: 400 })
  const countyNorm = normalizeCountyName(county)
  const q = { commodity, county, state: stateCode }

  const supabase = createClient()
  const readCache = async (): Promise<CacheHit | null> => {
    const { data } = await supabase
      .from('fsa_benchmark_cache')
      .select('data_year, state_code, county, commodity, practice, benchmark_yield, benchmark_price, benchmark_revenue, fetched_at, source_url')
      .eq('state_code', stateCode)
      .eq('county', countyNorm)
      .lte('data_year', cropYear)
      .order('data_year', { ascending: false })
    return bestCacheHit((data ?? []) as CacheRow[], q)
  }

  const respond = (hit: CacheHit) =>
    NextResponse.json({
      data: {
        rows: hit.rows,
        data_year: hit.dataYear,
        requested_year: cropYear,
        county,
        state: stateCode,
        fetched_at: hit.fetchedAt,
        file_url: hit.fileUrl,
        source_description: describeFsaFileSource({
          dataYear: hit.dataYear, requestedYear: cropYear, county, state: stateCode, fetchedAt: hit.fetchedAt,
        }),
      },
    })

  // 1. Cache hit on the requested year — no network at all.
  let hit = await readCache()
  if (hit && hit.dataYear === cropYear) return respond(hit)

  // 2. Requested year not cached: hit fsa.usda.gov at most once a day per
  //    year × state, whatever the outcome.
  const guardAfter = new Date(Date.now() - FETCH_GUARD_MS).toISOString()
  const { data: recentChecks } = await supabase
    .from('fsa_benchmark_fetches')
    .select('id, file_year, checked_at')
    .eq('requested_year', cropYear)
    .eq('state_code', stateCode)
    .gte('checked_at', guardAfter)
    .order('checked_at', { ascending: false })
    .limit(1)
  const checkedRecently = (recentChecks ?? []).length > 0

  let fetchError: string | null = null
  if (!checkedRecently) {
    try {
      const pageResp = await fetch(FSA_PAGE_URL, { cache: 'no-store', headers: { 'user-agent': 'grain-tracker (benchmark lookup)' } })
      if (!pageResp.ok) throw new Error(`FSA program-data page returned HTTP ${pageResp.status}.`)
      const links = findBenchmarkFileLinks(await pageResp.text())
      const pick = pickBenchmarkFile(links, cropYear)
      if (pick) {
        // Only download when this file-year × state isn't ingested yet — a
        // county missing from an ingested slice is missing from the file too.
        const { count } = await supabase
          .from('fsa_benchmark_cache')
          .select('id', { count: 'exact', head: true })
          .eq('data_year', pick.year)
          .eq('state_code', stateCode)
        if (!count) {
          const parsedWb = await downloadAndParseWorkbook(pick.url)
          // Belt and suspenders on the unique key: keep the first row per
          // (county, commodity, practice) so one malformed duplicate line in
          // the file can't fail the whole ingest.
          const seen = new Set<string>()
          const stateRows = parsedWb.rows.filter((r) => {
            if (r.state_code !== stateCode) return false
            const key = `${r.county}|${r.commodity}|${r.practice}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          const now = new Date().toISOString()
          await supabase.from('fsa_benchmark_cache').delete().eq('data_year', pick.year).eq('state_code', stateCode)
          for (let i = 0; i < stateRows.length; i += INSERT_CHUNK) {
            const chunk = stateRows.slice(i, i + INSERT_CHUNK).map((r) => ({
              data_year: pick.year, state_code: r.state_code, county: r.county, commodity: r.commodity,
              practice: r.practice, benchmark_yield: r.benchmark_yield, benchmark_price: r.benchmark_price,
              benchmark_revenue: r.benchmark_revenue, source_url: pick.url, fetched_at: now,
            }))
            const { error } = await supabase.from('fsa_benchmark_cache').insert(chunk)
            if (error) throw new Error(`Could not cache the parsed FSA rows: ${error.message}`)
          }
        }
      }
      await supabase.from('fsa_benchmark_fetches').insert({
        requested_year: cropYear, state_code: stateCode, file_year: pick?.year ?? null, file_url: pick?.url ?? null,
      })
    } catch (e: any) {
      fetchError = e?.message ?? 'Could not reach fsa.usda.gov.'
      console.error(`[fsa-benchmark-yield] ${fetchError}`)
    }
    hit = await readCache()
  }

  // 3. Serve the best year available (flagged via data_year when earlier than
  //    requested), or report not_found so the client can offer the AI fallback.
  if (hit) return respond(hit)
  if (fetchError) {
    return NextResponse.json(
      { error: `FSA benchmark file lookup failed: ${fetchError} Try the AI web-search fallback or enter the yield manually.` },
      { status: 502 },
    )
  }
  return NextResponse.json({
    data: {
      rows: [], not_found: true, data_year: null, requested_year: cropYear, county, state: stateCode,
      source_description: `No FSA benchmark-file row found for ${commodity} — ${county} County, ${stateCode}.`,
    },
  })
}
