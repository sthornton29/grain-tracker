import { describe, it, expect } from 'vitest'
import {
  normalizeCountyName, normalizeStateCode, normalizePractice, commodityMatches,
  discoverHeader, parseBenchmarkSheet, parseBenchmarkWorkbook,
  findBenchmarkFileLinks, pickBenchmarkFile, lookupBenchmarkRows, describeFsaFileSource,
  type SheetMatrix,
} from './fsa-benchmark-file'

// A representative fixture mimicking FSA's workbook layout: a title block
// above the header row, uppercase county names, a commodity column, and
// separate irrigated/non-irrigated rows where applicable.
const FIXTURE: SheetMatrix = {
  name: '2025 Benchmarks',
  rows: [
    ['2025 ARC-County Benchmark Yields and Revenues', null, null, null, null, null],
    [null, null, null, null, null, null],
    ['State', 'County', 'Commodity', 'Irrigation Practice', 'Benchmark Yield', 'Benchmark Revenue'],
    ['ALABAMA', 'LAWRENCE', 'CORN', 'IRRIGATED', 172.4, 867.17],
    ['ALABAMA', 'LAWRENCE', 'CORN', 'NON-IRRIGATED', 118.9, 598.07],
    ['ALABAMA', 'LAWRENCE', 'SEED COTTON', 'ALL', 1387, 512.99],
    ['TENNESSEE', 'LAWRENCE', 'CORN', 'ALL', '141.2', '$710.24'],
    ['ALABAMA', 'ST. CLAIR', 'SOYBEANS', 'ALL', 41.8, 508.71],
    ['MISSISSIPPI', 'WASHINGTON', 'SORGHUM', 'ALL', 98.6, 495.97],
  ],
}

describe('name normalization', () => {
  it('matches FSA uppercase county names against our "Name County" style', () => {
    expect(normalizeCountyName('LAWRENCE')).toBe(normalizeCountyName('Lawrence County'))
    expect(normalizeCountyName('ST. CLAIR')).toBe(normalizeCountyName('St. Clair'))
    expect(normalizeCountyName('East Baton Rouge Parish')).toBe('EAST BATON ROUGE')
  })

  it('normalizes state names and codes to the 2-letter code', () => {
    expect(normalizeStateCode('ALABAMA')).toBe('AL')
    expect(normalizeStateCode('al')).toBe('AL')
    expect(normalizeStateCode('New Mexico')).toBe('NM')
    expect(normalizeStateCode('not a state')).toBeNull()
  })

  it('matches commodity names fuzzily but never across commodities', () => {
    expect(commodityMatches('Grain Sorghum', 'SORGHUM')).toBe(true)
    expect(commodityMatches('Seed Cotton', 'SEED COTTON')).toBe(true)
    expect(commodityMatches('Wheat', 'ALL WHEAT')).toBe(true)
    expect(commodityMatches('Corn', 'SEED COTTON')).toBe(false)
    expect(commodityMatches('Soybeans', 'CORN')).toBe(false)
  })

  it('normalizes practice text', () => {
    expect(normalizePractice('IRRIGATED')).toBe('irrigated')
    expect(normalizePractice('Non-Irrigated')).toBe('non_irrigated')
    expect(normalizePractice('NONIRRIGATED')).toBe('non_irrigated')
    expect(normalizePractice('ALL')).toBe('all')
    expect(normalizePractice(null)).toBe('all')
  })
})

describe('header discovery + sheet parsing', () => {
  it('discovers the header row below a title block, never by hard-coded position', () => {
    const h = discoverHeader(FIXTURE.rows)
    expect(h?.rowIndex).toBe(2)
    expect(h?.cols).toMatchObject({ state: 0, county: 1, commodity: 2, practice: 3, yield: 4, revenue: 5 })
  })

  it('parses rows with normalized names, practices, and numbers (string cells, $ and commas)', () => {
    const rows = parseBenchmarkSheet(FIXTURE)!
    expect(rows).toHaveLength(6)
    const tnCorn = rows.find((r) => r.state_code === 'TN')!
    expect(tnCorn).toMatchObject({ county: 'LAWRENCE', practice: 'all', benchmark_yield: 141.2, benchmark_revenue: 710.24 })
  })

  it('survives a shifted/reordered column layout', () => {
    const shifted: SheetMatrix = {
      name: 'Corn',
      rows: [
        ['Benchmark Yield (bu/ac)', 'County Name', 'Practice', 'State'],
        [172.4, 'LAWRENCE', 'Irrigated', 'AL'],
      ],
    }
    const rows = parseBenchmarkSheet(shifted)!
    // No commodity column → the sheet name is the commodity.
    expect(rows[0]).toMatchObject({ state_code: 'AL', county: 'LAWRENCE', commodity: 'CORN', practice: 'irrigated', benchmark_yield: 172.4 })
  })

  it("parses FSA's REAL 2026 layout: ST_Cty, Sub County, Yield Designation, 'Bench Mark (olympic avg)' columns", () => {
    // Verbatim header + representative rows from the live 2026 workbook
    // (arcco_2026_data): the benchmark-yield column never says "yield", the
    // practice column is "ARC-CO Yield Designation", and the file prints the
    // national benchmark price on every row.
    const real: SheetMatrix = {
      name: 'ARCCO 2026 (2026-01-16)',
      rows: [
        ['ARC-CO TREND ADJUSTED YIELDS, BENCHMARK YIELDS AND GUARANTEE REVENUES FOR PROGRAM YEAR 2026', null, null, null, null, null, null, null, null, null, null, null, null, 'Program Year 2026 Benchmark Yields and Revenues', null, null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null, null, null, null, null, null, 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
        [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, '(A * B)', '(90% of C)', '(12% of C)', null, null, '(F * G)', '(D - H), not less than 0', 'Lesser of E or I (capped at 12% of Benchmark)'],
        ['ST_Cty', 'State Name', 'County Name', 'Sub County', 'Crop Name', 'Unit', 'ARC-CO Yield Designation', '2020 trend adjusted (county yield or 80% of T)', '2021 trend adjusted (county yield or 80% of T)', '2022 trend adjusted (county yield or 80% of T)', '2023 trend adjusted (county yield or 80% of T)', '2024 trend adjusted (county yield or 80% of T)', null, '2026 Bench Mark (2020-24 olympic avg)', '2026 Bench Mark Price (2020-24 olympic avg)', '2026 Benchmark Revenue', '2026 Guarantee Revenue', '2026 Maximum Payment Rate', '2026 Actual Yield', '2026 National Price', '2026 Actual Revenue', '2026 Formula Payment Rate', '2026 ARC-CO Payment Rate'],
        ['01001', 'Alabama', 'Autauga', '', 'Corn', 'Bushel', 'All', 190.91, 178.56, 94.8, 188.34, 97.7, null, 154.87, 5.03, 779, 701.1, 93.48, null, null, null, null, null],
        ['01079', 'Alabama', 'Lawrence', '', 'Corn', 'Bushel', 'Irrigated', null, null, null, null, null, null, 215.81, 5.03, 1085.52, 976.97, 130.26, null, null, null, null, null],
        ['01079', 'Alabama', 'Lawrence', '', 'Corn', 'Bushel', 'Non-Irrigated', null, null, null, null, null, null, 165.08, 5.03, 830.35, 747.32, 99.64, null, null, null, null, null],
        ['38105', 'North Dakota', 'Williams', 'EAST', 'Wheat', 'Bushel', 'All', null, null, null, null, null, null, 48.2, 6.98, 336.44, 302.8, 40.37, null, null, null, null, null],
      ],
    }
    const rows = parseBenchmarkSheet(real)!
    // The sub-county row is skipped (would collide on the county key).
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ state_code: 'AL', county: 'AUTAUGA', commodity: 'CORN', practice: 'all', benchmark_yield: 154.87, benchmark_price: 5.03, benchmark_revenue: 779 })
    const lawrence = lookupBenchmarkRows(rows, { commodity: 'Corn', county: 'Lawrence', state: 'AL' })
    expect(lawrence.map((r) => [r.practice, r.benchmark_yield])).toEqual([
      ['non_irrigated', 165.08],
      ['irrigated', 215.81],
    ])
  })

  it('reports unrecognized sheets instead of guessing', () => {
    const parsed = parseBenchmarkWorkbook([
      { name: 'Notes', rows: [['This workbook explains the ARC-CO program.']] },
      FIXTURE,
    ])
    expect(parsed.sheetsParsed).toEqual(['2025 Benchmarks'])
    expect(parsed.sheetsSkipped).toEqual(['Notes'])
    expect(parseBenchmarkWorkbook([{ name: 'Notes', rows: [['prose']] }]).rows).toHaveLength(0)
  })
})

describe('county + state matching', () => {
  const rows = parseBenchmarkSheet(FIXTURE)!

  it('LAWRENCE + AL matches Lawrence County, Alabama — and returns both practices', () => {
    const matches = lookupBenchmarkRows(rows, { commodity: 'Corn', county: 'Lawrence', state: 'AL' })
    expect(matches).toEqual([
      { practice: 'non_irrigated', benchmark_yield: 118.9, benchmark_price: null, benchmark_revenue: 598.07 },
      { practice: 'irrigated', benchmark_yield: 172.4, benchmark_price: null, benchmark_revenue: 867.17 },
    ])
  })

  it("a same-named county in another state doesn't cross-match", () => {
    const tn = lookupBenchmarkRows(rows, { commodity: 'Corn', county: 'Lawrence', state: 'Tennessee' })
    expect(tn).toHaveLength(1)
    expect(tn[0].benchmark_yield).toBe(141.2)
    // And a third state's Lawrence finds nothing rather than borrowing.
    expect(lookupBenchmarkRows(rows, { commodity: 'Corn', county: 'Lawrence', state: 'MS' })).toHaveLength(0)
  })

  it('matches suffixed/punctuated county names and fuzzy commodities', () => {
    expect(lookupBenchmarkRows(rows, { commodity: 'Soybeans', county: 'St. Clair County', state: 'AL' })).toHaveLength(1)
    expect(lookupBenchmarkRows(rows, { commodity: 'Grain Sorghum', county: 'Washington', state: 'MS' })).toHaveLength(1)
  })
})

describe('finding the workbook on the program-data page', () => {
  // Mirrors fsa.usda.gov's real structure: the description sits OUTSIDE the
  // anchor, anchors read "Excel format, N MB", hrefs are often extensionless,
  // and the 2020 entry's href carries its as-of year (2022), not its data year.
  const html = `
    <html><body>
      <p>Benchmark Prices for Program Year 2025 ARC County Coverage (<a href="/documents/2025-arc-co">PDF, 73 KB</a>) (<a href="/documents/2025-arc-co-excel">Excel format, 14 KB</a>)</p>
      <p>2025 ARC-County Benchmark Yields and Revenues as of June 30, 2026 (<a href="https://www.fsa.usda.gov/documents/arcco-2025-data-20260630">Excel format, 2.4MB</a>)</p>
      <p>2024 ARC-County Benchmark Yields and Revenues as of February 02, 2026 (<a href="/documents/arcco-2024-data">Excel format, 2.6 MB</a>)</p>
      <p>2022 ARC-County Benchmark Yields and Revenues as of January 31, 2024&nbsp;(<a href="/sites/default/files/documents/arcco_2022_data-2024-01-31-.xlsx">Excel format, 1.9 MB</a>)</p>
      <p>2020 ARC-County Benchmark Yields and Revenues as of January 31, 2022 (<a href="/documents/arcco-2022-0131">Excel format, 2.19 MB</a>)</p>
      <p>Data Sources for 2019 ARC-County Benchmark Yields (<a href="/sites/default/files/documents/2019-arc-benchmark-yields-data-source.xlsx">Excel 12.3 MB</a>)</p>
      <p>2025 PLC Payment Rates (<a href="/documents/2025-plc-excel">Excel format, 13 KB</a>)</p>
    </body></html>`

  it('finds one workbook per data year — description year, not href/as-of year — resolving relative URLs', () => {
    const links = findBenchmarkFileLinks(html)
    expect(links.map((l) => l.year)).toEqual([2025, 2024, 2022, 2020])
    // 2025: absolute URL passes through.
    expect(links[0].url).toBe('https://www.fsa.usda.gov/documents/arcco-2025-data-20260630')
    // 2024: relative URL resolved against fsa.usda.gov.
    expect(links[1].url).toBe('https://www.fsa.usda.gov/documents/arcco-2024-data')
    // 2020: the href's "2022" (the as-of date) must not become the data year.
    expect(links[3].url).toBe('https://www.fsa.usda.gov/documents/arcco-2022-0131')
    // The benchmark-PRICE Excel, PLC rates, and the "Data Sources for 2019"
    // entry (no leading data year) are all excluded.
    expect(links.some((l) => /arc-co-excel|plc/.test(l.url))).toBe(false)
    expect(links.some((l) => l.year === 2019)).toBe(false)
  })

  it('picks the requested year when published, else the most recent earlier year (the fallback flag)', () => {
    const links = findBenchmarkFileLinks(html)
    expect(pickBenchmarkFile(links, 2025)?.year).toBe(2025)
    // 2026 not published yet → fall back to 2025; data_year ≠ requested flags it.
    const fallback = pickBenchmarkFile(links, 2026)
    expect(fallback?.year).toBe(2025)
    const desc = describeFsaFileSource({ dataYear: 2025, requestedYear: 2026, county: 'Lawrence', state: 'AL', fetchedAt: '2026-07-10T12:00:00Z' })
    expect(desc).toContain('FSA published file (2025 data — most recent published; 2026 not yet available)')
    expect(desc).toContain('Lawrence County, AL')
    expect(desc).toContain('retrieved 2026-07-10')
    // A gap year falls back to the closest earlier file...
    expect(pickBenchmarkFile(links, 2023)?.year).toBe(2022)
    // ...and nothing published at or before the requested year → null.
    expect(pickBenchmarkFile(links, 2019)).toBeNull()
  })
})
