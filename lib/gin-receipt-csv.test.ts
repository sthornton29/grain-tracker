// The gin's CSV export of Statements of Ginning (lib/gin-receipt-csv).
// The fixture mirrors the real 2026-10-17 export block for block (three
// statements in one file; two kept here, trimmed to a few bales each). The
// totals are the real ones, so the add-up checks exercise the mismatch path
// only where the fixture deliberately drops rows.

import { describe, it, expect } from 'vitest'
import { csvDateToIso, looksLikeGinReceiptCsv, parseGinReceiptCsv, GinReceiptCsvError } from '@/lib/gin-receipt-csv'
import { groupStatementPages, statementIdentity } from '@/lib/gin-statements'
import { splitCsvRows } from '@/lib/csv-rows'
import { parseCsv } from '@/lib/csv'

const CRLF = (s: string) => s.replace(/\n/g, '\r\n')

/** Statement 1: 3 loads = 3 modules and the totals add up; 4 of 70 bales kept (count check fires on the page, weights deliberately short). */
const BLOCK_CREEK = `,Producer:
VIEW CELESTE FARM LLC
P. O. BOX 356
COURTLAND AL 35618
256/637-2281,Farm:
7282
DUPES FARM

Field:
CREEK BOTTOM
Producer Totals,Statement,Farm YTD,Producer YTD

Module:,3,10,29
Weight:,83220,293780,845160
Bales:,70,246,683
Bale Wt:,33922,118676,338480
Avg Bale Wt:,485,482,496
Seed:,42255,146008,419261
Avg Seed:,623,615,619
Lint Turnout %:,40.76%,40.4%,40.05%
Lint Turnout lb/bl:,1227,1238,1248
Load #,Rolls,Gross,Tare,Net

33589,6,64760,31400,33360
33591,4,48000,31400,16600
33590,6,64660,31400,33260

 ,PBI,Date Ginned,Net
1,183387,10/16/2026,507
2,183388,10/16/2026,499
3,183389,10/15/2026,489
4,183390,10/16/2026,490
`

/** Statement 2: two loads kept of nine (the load-table checks fire), two bales. */
const BLOCK_RAILROAD = `,Producer:
VIEW CELESTE FARM LLC
P. O. BOX 356
COURTLAND AL 35618
256/637-2281,Farm:
7557
SYKES POND

Field:
RAILROAD
Producer Totals,Statement,Farm YTD,Producer YTD

Module:,9,9,29
Weight:,284320,284320,845160
Bales:,225,225,683
Bale Wt:,112845,112845,338480
Avg Bale Wt:,502,502,496
Seed:,141269,141269,419261
Avg Seed:,626,626,619
Lint Turnout %:,39.69%,39.69%,40.05%
Lint Turnout lb/bl:,1260,1260,1248
Load #,Rolls,Gross,Tare,Net

33592,6,65720,31400,34320
33600,3,47700,31400,16300

 ,PBI,Date Ginned,Net
1,183457,10/16/2026,536
2,183458,10/16/2026,539
`

const FILE = CRLF(BLOCK_CREEK + BLOCK_RAILROAD)

describe('parseGinReceiptCsv', () => {
  it('reads one statement per Producer block, mapped to the PDF page shape', () => {
    const { pages } = parseGinReceiptCsv(FILE, { cropYear: 2026 })
    expect(pages).toHaveLength(2)
    const p = pages[0]
    expect(p.page).toBe(1)
    expect(p.has_totals_block).toBe(true)
    expect(p.producer).toBe('VIEW CELESTE FARM LLC')
    expect(p.farm_number).toBe('7282')
    expect(p.farm_name).toBe('DUPES FARM')
    expect(p.field).toBe('CREEK BOTTOM')
    // The gin is not printed: picked on the review card.
    expect(p.gin_name).toBeNull()
    expect(p.gin_code).toBeNull()
    expect(p.statement_number).toBeNull()
    expect(p.totals).toEqual({
      modules_count: 3, total_seed_cotton_weight: 83220, bales_count: 70, total_bale_weight: 33922,
      avg_bale_weight: 485, seed_lbs: 42255, lint_turnout_pct: 40.76, lint_lbs_per_bale: 1227,
    })
    expect(p.farm_ytd).toEqual({ modules: 10, seed_cotton_lbs: 293780, bales: 246, bale_weight: 118676 })
    expect(p.loads).toEqual([
      { load_number: '33589', rolls: 6, gross: 64760, tare: 31400, net: 33360 },
      { load_number: '33591', rolls: 4, gross: 48000, tare: 31400, net: 16600 },
      { load_number: '33590', rolls: 6, gross: 64660, tare: 31400, net: 33260 },
    ])
    expect(p.bales).toEqual([
      { pbi_number: '183387', net_weight_lbs: 507 }, { pbi_number: '183388', net_weight_lbs: 499 },
      { pbi_number: '183389', net_weight_lbs: 489 }, { pbi_number: '183390', net_weight_lbs: 490 },
    ])
    expect(p.bale_row_first).toBe(1)
    expect(p.bale_row_last).toBe(4)
  })

  it('dates the statement by the LAST day a bale on it was ginned', () => {
    const { pages } = parseGinReceiptCsv(FILE, { cropYear: 2026 })
    expect(pages[0].statement_date).toBe('2026-10-16') // 10/15 and 10/16 in the list
    expect(pages[1].statement_date).toBe('2026-10-16')
  })

  it('crop year: the year being worked when the ginning dates belong to it (or the January after); else the date year', () => {
    expect(parseGinReceiptCsv(FILE, { cropYear: 2026 }).pages[0].crop_year).toBe(2026)
    // Ginning running into January still belongs to the crop year.
    const jan = FILE.replace(/10\/1[56]\/2026/g, '01/08/2027')
    expect(parseGinReceiptCsv(jan, { cropYear: 2026 }).pages[0].crop_year).toBe(2026)
    expect(parseGinReceiptCsv(jan, { cropYear: 2026 }).pages[0].statement_date).toBe('2027-01-08')
    // The user is on another year: the ginning date wins.
    expect(parseGinReceiptCsv(FILE, { cropYear: 2024 }).pages[0].crop_year).toBe(2026)
    expect(parseGinReceiptCsv(FILE).pages[0].crop_year).toBe(2026)
  })

  it('the second statement keeps its own farm, field, totals and Farm YTD', () => {
    const { pages } = parseGinReceiptCsv(FILE, { cropYear: 2026 })
    const p = pages[1]
    expect(p.page).toBe(2)
    expect(p.farm_number).toBe('7557')
    expect(p.farm_name).toBe('SYKES POND')
    expect(p.field).toBe('RAILROAD')
    expect(p.totals?.modules_count).toBe(9)
    expect(p.totals?.bales_count).toBe(225)
    expect(p.farm_ytd).toEqual({ modules: 9, seed_cotton_lbs: 284320, bales: 225, bale_weight: 112845 })
    expect(p.loads.map((l) => l.load_number)).toEqual(['33592', '33600'])
  })

  it('warns when a load table or bale list does not add up to the totals (informational)', () => {
    const { warnings } = parseGinReceiptCsv(FILE, { cropYear: 2026 })
    // Creek Bottom: loads add up (3 lines, 83,220); the trimmed bale list does not.
    expect(warnings).toContain('farm 7282 · CREEK BOTTOM: the bale list adds up to 1,985 lbs lint; the totals say 33,922.')
    expect(warnings.some((w) => w.startsWith('farm 7282 · CREEK BOTTOM: the load table'))).toBe(false)
    // Railroad: two of nine loads kept.
    expect(warnings).toContain('farm 7557 · RAILROAD: the load table has 2 lines but the totals say 9 modules.')
    expect(warnings).toContain('farm 7557 · RAILROAD: the load table adds up to 50,620 lbs seed cotton; the totals say 284,320.')
  })

  it('a full export with nothing trimmed warns about nothing', () => {
    // Creek Bottom's real 70-bale list is 33,922 lbs: rebuild it as 70 rows that sum exactly.
    const weights = Array.from({ length: 70 }, (_, i) => (i < 69 ? 485 : 33922 - 485 * 69))
    const rows = weights.map((w, i) => `${i + 1},${183387 + i},10/16/2026,${w}`).join('\n')
    const full = BLOCK_CREEK.replace(/1,183387[\s\S]*$/, rows + '\n')
    const { pages, warnings } = parseGinReceiptCsv(full, { cropYear: 2026 })
    expect(pages[0].bales).toHaveLength(70)
    expect(warnings).toEqual([])
  })

  it('groups through lib/gin-statements like a scanned PDF: one statement per block, identified by farm, field, date and totals', () => {
    const { pages } = parseGinReceiptCsv(FILE, { cropYear: 2026 })
    const statements = groupStatementPages(pages)
    expect(statements).toHaveLength(2)
    expect(statements[1].boundary).toBe('totals_block')
    expect(statements[0].receipt_date).toBe('2026-10-16')
    expect(statements[0].crop_year).toBe(2026)
    expect(statementIdentity(statements[0])).toBe('T|NA|7282|CREEK-BOTTOM|20261016|3|83220|70')
    // The gin chosen on the review card gives the identity its gin.
    expect(statementIdentity({ ...statements[0], gin_code: '40614' })).toBe('T|40614|7282|CREEK-BOTTOM|20261016|3|83220|70')
  })

  it('tolerates a BOM, LF line endings, quoted cells and the labels in other columns', () => {
    const lf = '﻿' + BLOCK_CREEK.replace('CREEK BOTTOM', '"CREEK, BOTTOM"').replace(',Producer:', 'Producer:,VIEW CELESTE FARM LLC')
    const { pages } = parseGinReceiptCsv(lf, { cropYear: 2026 })
    expect(pages[0].field).toBe('CREEK, BOTTOM')
    expect(pages[0].producer).toBe('VIEW CELESTE FARM LLC')
    expect(pages[0].bales).toHaveLength(4)
  })

  it('refuses a file that is not this export, in plain words', () => {
    expect(() => parseGinReceiptCsv('load_number,net\n123,456\n')).toThrow(GinReceiptCsvError)
    expect(() => parseGinReceiptCsv('load_number,net\n123,456\n')).toThrow(/gin receipt export/)
    expect(looksLikeGinReceiptCsv('load_number,net\n123,456\n')).toBe(false)
    expect(looksLikeGinReceiptCsv(FILE)).toBe(true)
  })

  it('csvDateToIso reads the gin’s m/d/yyyy and an ISO date', () => {
    expect(csvDateToIso('10/5/2026')).toBe('2026-10-05')
    expect(csvDateToIso('10/15/26')).toBe('2026-10-15')
    expect(csvDateToIso('2026-10-15')).toBe('2026-10-15')
    expect(csvDateToIso('Oct 15')).toBeNull()
  })
})

describe('splitCsvRows (the one tokenizer) and parseCsv on top of it', () => {
  it('keeps blank rows and untrimmed cells; parseCsv drops the empties and trims', () => {
    const text = '﻿a, b\r\n\r\n1,"x, y"\r\n,\r\n2,"z"\n'
    expect(splitCsvRows(text)).toEqual([['a', ' b'], [''], ['1', 'x, y'], ['', ''], ['2', 'z']])
    expect(parseCsv(text)).toEqual({ headers: ['a', 'b'], rows: [['1', 'x, y'], ['2', 'z']] })
  })
})
