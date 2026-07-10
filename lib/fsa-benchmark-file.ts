// Pure parsing/matching for FSA's annual "ARC-County Benchmark Yields and
// Revenues" Excel workbook — the only place FSA publishes ARC-CO benchmark
// county YIELDS (the benchmark PRICES come in small PDFs and are seeded /
// AI-looked-up separately). Web search can't open the workbook, so the
// /api/fsa-benchmark-yield route downloads it from the ARC/PLC program-data
// page and parses it here. Everything in this module is pure and unit-tested:
// the route feeds it the page HTML and the workbook's sheets as row matrices
// (XLSX.utils.sheet_to_json(ws, { header: 1 })).
//
// FSA's column layout shifts year to year, so the header row and columns are
// DISCOVERED by scanning for recognizable header text, never hard-coded cell
// positions. A sheet with no recognizable header is skipped; a workbook where
// no sheet parses reports the sheet names so the failure is diagnosable.

export type FsaPractice = 'irrigated' | 'non_irrigated' | 'all'

export type FsaBenchmarkFileRow = {
  state_code: string // 2-letter code
  county: string // normalized: uppercase, no COUNTY/PARISH suffix, no punctuation
  commodity: string // as printed in the file, uppercased/trimmed
  practice: FsaPractice
  benchmark_yield: number | null
  // The file carries the national benchmark price too (same value every
  // county) — returned so the UI can prefer it over the seeded values.
  benchmark_price: number | null
  benchmark_revenue: number | null
}

// ---------- Name normalization ----------

const STATE_CODE_BY_NAME: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
  OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
  'PUERTO RICO': 'PR', GUAM: 'GU', 'VIRGIN ISLANDS': 'VI',
}
const STATE_CODES = new Set(Object.values(STATE_CODE_BY_NAME))

/** "Alabama"/"ALABAMA"/"AL"/"al" → "AL"; unknown → null. */
export function normalizeStateCode(input: string | null | undefined): string | null {
  const s = (input ?? '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/\./g, '')
  if (!s) return null
  if (s.length === 2 && STATE_CODES.has(s)) return s
  return STATE_CODE_BY_NAME[s] ?? null
}

/**
 * FSA prints uppercase county names without the word "County" ("LAWRENCE",
 * "ST CLAIR"); our counties table has "Lawrence", "St. Clair". Both sides
 * normalize to uppercase, punctuation stripped, COUNTY/PARISH/BOROUGH/CENSUS
 * AREA suffixes removed, whitespace collapsed.
 */
export function normalizeCountyName(input: string | null | undefined): string {
  return (input ?? '')
    .toUpperCase()
    .replace(/[.'’]/g, '')
    .replace(/\s+(COUNTY|PARISH|BOROUGH|CENSUS AREA)$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const normalizeCommodityToken = (s: string) =>
  s.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Fuzzy commodity match between our covered-commodity names and the file's
 * ("Grain Sorghum" ↔ "SORGHUM", "Seed Cotton" ↔ "SEED COTTON", "Wheat" ↔
 * "ALL WHEAT"): exact normalized equality, or every word of the shorter name
 * appearing in the longer one.
 */
export function commodityMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCommodityToken(a ?? '')
  const nb = normalizeCommodityToken(b ?? '')
  if (!na || !nb) return false
  if (na === nb) return true
  const ta = na.split(' ')
  const tb = nb.split(' ')
  const [shorter, longer] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)]
  // "GRAIN SORGHUM" ↔ "SORGHUM" matches; generic modifiers ("ALL", "GRAIN")
  // in the shorter name don't have to appear in the longer one.
  const IGNORABLE = new Set(['ALL', 'GRAIN'])
  return shorter.every((t) => longer.has(t) || IGNORABLE.has(t))
}

export function normalizePractice(input: string | null | undefined): FsaPractice {
  const s = (input ?? '').trim().toLowerCase()
  if (/non[\s-]*irr/.test(s)) return 'non_irrigated'
  if (/irr/.test(s)) return 'irrigated'
  return 'all'
}

// ---------- Header discovery + sheet parsing ----------

type Cell = string | number | null | undefined
export type SheetMatrix = { name: string; rows: Cell[][] }

type HeaderCols = {
  state: number
  county: number
  subCounty: number | null // rows with a sub-county are skipped (see parse)
  commodity: number | null // null → the sheet name is the commodity
  practice: number | null
  yield: number | null
  price: number | null
  revenue: number | null
}

const cellText = (c: Cell) => (c == null ? '' : String(c)).replace(/\s+/g, ' ').trim()

/**
 * Scan the first rows for a header row: it must name a state column, a county
 * column, and at least one of benchmark yield / benchmark revenue. Column
 * positions are whatever the scan finds — never hard-coded. The matchers are
 * verified against FSA's real 2026 header ("ST_Cty", "State Name", "County
 * Name", "Sub County", "Crop Name", "ARC-CO Yield Designation", "2026 Bench
 * Mark (2020-24 olympic avg)", "2026 Bench Mark Price (…)", "2026 Benchmark
 * Revenue", …) as well as plainer "State / County / Benchmark Yield" layouts.
 */
export function discoverHeader(rows: Cell[][], scanRows = 25): { rowIndex: number; cols: HeaderCols } | null {
  for (let i = 0; i < Math.min(rows.length, scanRows); i++) {
    const lower = (rows[i] ?? []).map((c) => cellText(c).toLowerCase())
    const find = (pred: (t: string) => boolean): number | null => {
      const j = lower.findIndex((t) => t !== '' && pred(t))
      return j === -1 ? null : j
    }
    const state = find((t) => (/^state\b/.test(t) || (/state/.test(t) && /name|abbrev/.test(t))) && !/fips|code/.test(t))
    const county = find((t) => /county|parish/.test(t) && !/sub|fips|code|yield/.test(t))
    if (state == null || county == null) continue
    // Benchmark yield, in priority order: an explicit "benchmark yield"
    // header; FSA's price/revenue-less "Bench Mark (olympic avg)" column; a
    // bare yield column that isn't the designation/trend/actual one.
    const yieldCol =
      find((t) => /yield/.test(t) && /bench/.test(t) && !/designation/.test(t)) ??
      find((t) => /bench\s*mark|benchmark/.test(t) && !/price|revenue|guarantee|payment|rate/.test(t)) ??
      find((t) => /yield/.test(t) && !/plc|designation|trend|actual/.test(t))
    const revenue =
      find((t) => /(bench\s*mark|benchmark)\s+revenue/.test(t)) ??
      find((t) => /revenue/.test(t) && !/actual|guarantee/.test(t))
    if (yieldCol == null && revenue == null) continue
    return {
      rowIndex: i,
      cols: {
        state,
        county,
        subCounty: find((t) => /sub[\s_-]*county/.test(t)),
        commodity: find((t) => (/commodity/.test(t) || /crop/.test(t)) && !/year/.test(t)),
        practice: find((t) => /designation|practice|irrigat/.test(t)),
        yield: yieldCol,
        price: find((t) => /(bench\s*mark|benchmark)\s+price/.test(t)),
        revenue,
      },
    }
  }
  return null
}

function parseNumber(c: Cell): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null
  const s = cellText(c).replace(/[$,]/g, '')
  if (!s || /^n\/?a$/i.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Parse one sheet; returns null when no recognizable header is found. */
export function parseBenchmarkSheet(sheet: SheetMatrix): FsaBenchmarkFileRow[] | null {
  const header = discoverHeader(sheet.rows)
  if (!header) return null
  const { cols } = header
  const out: FsaBenchmarkFileRow[] = []
  for (let i = header.rowIndex + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i] ?? []
    const state = normalizeStateCode(cellText(row[cols.state]))
    const county = normalizeCountyName(cellText(row[cols.county]))
    if (!state || !county) continue
    // A handful of counties are split into named sub-counties; those rows
    // would collide on the (county, commodity, practice) key and don't match
    // a plain county lookup anyway — skip them (the lookup then falls back
    // to the AI web search for such counties).
    if (cols.subCounty != null && cellText(row[cols.subCounty]) !== '') continue
    const commodityRaw = cols.commodity != null ? cellText(row[cols.commodity]) : sheet.name
    const commodity = normalizeCommodityToken(commodityRaw)
    if (!commodity) continue
    out.push({
      state_code: state,
      county,
      commodity,
      practice: cols.practice != null ? normalizePractice(cellText(row[cols.practice])) : 'all',
      benchmark_yield: cols.yield != null ? parseNumber(row[cols.yield]) : null,
      benchmark_price: cols.price != null ? parseNumber(row[cols.price]) : null,
      benchmark_revenue: cols.revenue != null ? parseNumber(row[cols.revenue]) : null,
    })
  }
  return out
}

export type ParsedWorkbook = {
  rows: FsaBenchmarkFileRow[]
  sheetsParsed: string[]
  sheetsSkipped: string[]
}

export function parseBenchmarkWorkbook(sheets: SheetMatrix[]): ParsedWorkbook {
  const rows: FsaBenchmarkFileRow[] = []
  const sheetsParsed: string[] = []
  const sheetsSkipped: string[] = []
  for (const s of sheets) {
    const parsed = parseBenchmarkSheet(s)
    if (parsed && parsed.length > 0) {
      rows.push(...parsed)
      sheetsParsed.push(s.name)
    } else {
      sheetsSkipped.push(s.name)
    }
  }
  return { rows, sheetsParsed, sheetsSkipped }
}

// ---------- Finding the workbook link on the FSA program-data page ----------

export type BenchmarkFileLink = { url: string; year: number; label: string }

/**
 * Scan the ARC/PLC program-data page HTML for the "ARC-County Benchmark
 * Yields and Revenues" workbook links, one per published program year. The
 * page's real structure (verified against fsa.usda.gov) puts the description
 * OUTSIDE the anchor, with the anchor text just "Excel format, 2 MB" and an
 * often-extensionless href:
 *   <p>2026 ARC-County Benchmark Yields and Revenues as of January 16, 2026
 *      (<a href="/documents/arcco-2026-data-2026-01-16">Excel format, 2 MB</a>)</p>
 * The DATA year is the description's leading year — never the "as of" date
 * (the 2020 file's href says 2022, its as-of date). Entries without a leading
 * year ("Data Sources for 2019 ARC-County Benchmark Yields") are skipped.
 */
export function findBenchmarkFileLinks(html: string, baseUrl = 'https://www.fsa.usda.gov'): BenchmarkFileLink[] {
  const out: BenchmarkFileLink[] = []
  // (?:^|>)\s* anchors the data year to the start of its block element, so
  // "Data Sources for 2019 ARC-County Benchmark Yields" (year mid-sentence)
  // doesn't read as a 2019 workbook.
  const entryRe = /(?:^|>)\s*(20\d{2})\s+ARC[\s-]?County\s+Benchmark\s+Yields([^<(]*)\(\s*(?:<[^>]*>\s*)*<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>\s*(?:<[^>]*>\s*)*Excel/gi
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(html)) !== null) {
    const year = Number(m[1])
    const label = `${m[1]} ARC-County Benchmark Yields${m[2].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trimEnd()}`
    const href = m[3]
    const url = /^https?:\/\//i.test(href) ? href : `${baseUrl.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`
    out.push({ url, year, label })
  }
  // Deduplicate by year, keeping the first (the page lists the newest
  // "as of" revision of a year first).
  const byYear = new Map<number, BenchmarkFileLink>()
  for (const l of out) if (!byYear.has(l.year)) byYear.set(l.year, l)
  return Array.from(byYear.values()).sort((a, b) => b.year - a.year)
}

/**
 * FSA's /documents/... links resolve to a Drupal landing PAGE, not the file —
 * the workbook itself sits behind an .xlsx link inside it (e.g.
 * "/sites/default/files/2026-01/arcco_2026_data%20%282026-01-16%29.xlsx").
 * Returns the first Excel href on such a page, or null.
 */
export function findFileUrlInDocumentPage(html: string, baseUrl = 'https://www.fsa.usda.gov'): string | null {
  const m = /href\s*=\s*["']([^"']+\.xlsx?(?:\?[^"']*)?)["']/i.exec(html)
  if (!m) return null
  const href = m[1]
  return /^https?:\/\//i.test(href) ? href : `${baseUrl.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`
}

/**
 * The file to use for a requested program year: the exact year when FSA has
 * published it, else the most recent earlier year (reported via data_year so
 * the UI can flag a fallback, matching the AI lookup's contract).
 */
export function pickBenchmarkFile(links: readonly BenchmarkFileLink[], requestedYear: number): BenchmarkFileLink | null {
  const exact = links.find((l) => l.year === requestedYear)
  if (exact) return exact
  const earlier = links.filter((l) => l.year < requestedYear).sort((a, b) => b.year - a.year)
  return earlier[0] ?? null
}

// ---------- Lookup over parsed/cached rows ----------

export type BenchmarkYieldMatch = {
  practice: FsaPractice
  benchmark_yield: number | null
  benchmark_price: number | null
  benchmark_revenue: number | null
}

/**
 * All practice rows for one commodity × county × state. FSA separates
 * irrigated/non-irrigated county yields where applicable — every practice
 * present is returned so the UI can show them.
 */
export function lookupBenchmarkRows(
  rows: ReadonlyArray<Pick<FsaBenchmarkFileRow, 'state_code' | 'county' | 'commodity' | 'practice' | 'benchmark_yield' | 'benchmark_price' | 'benchmark_revenue'>>,
  q: { commodity: string; county: string; state: string },
): BenchmarkYieldMatch[] {
  const state = normalizeStateCode(q.state)
  const county = normalizeCountyName(q.county)
  if (!state || !county) return []
  const order: Record<FsaPractice, number> = { all: 0, non_irrigated: 1, irrigated: 2 }
  return rows
    .filter((r) => r.state_code === state && r.county === county && commodityMatches(r.commodity, q.commodity))
    .map((r) => ({ practice: r.practice, benchmark_yield: r.benchmark_yield, benchmark_price: r.benchmark_price, benchmark_revenue: r.benchmark_revenue }))
    .sort((a, b) => order[a.practice] - order[b.practice])
}

/** Provenance line shown in the UI and saved to source_description. */
export function describeFsaFileSource(args: {
  dataYear: number
  requestedYear: number
  county: string
  state: string
  fetchedAt?: string | null
}): string {
  const asOf = args.fetchedAt ? `, retrieved ${String(args.fetchedAt).slice(0, 10)}` : ''
  const fallback = args.dataYear !== args.requestedYear
    ? ` — most recent published; ${args.requestedYear} not yet available`
    : ''
  return `FSA published file (${args.dataYear} data${fallback}): ARC-County Benchmark Yields and Revenues, ${args.county} County, ${args.state}${asOf}`
}
