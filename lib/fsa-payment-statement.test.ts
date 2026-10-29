import { describe, expect, it } from 'vitest'
import {
  buildLineReviews, checkStatement, commodityForCrop, isoDate, matchFarmByFsaNumber, matchPayeeEntity,
  mergeFsaPaymentStatements, normalizeFsaPaymentStatement, normalizeProgramCode, officeCountyName,
  payeeNoticeText, planStatementSave, rebaseFsaPages, reviewTotals, sequesterFraction, stitchBlocks,
  type FsaPaymentStatementExtraction, type FsaStitchedBlock,
} from './fsa-payment-statement'
import { ROWS_1013, ROWS_1014, STATEMENT_1013, STATEMENT_1014, chunkOf } from './fsa-statement-fixture'

// The two October 2026 statements, hand-verified from the scans:
//   10/13: 10 blocks, gross = net = $199,464.00, ACH 10/15/2026
//   10/14: 32 blocks, gross = net = $441,578.00, ACH 10/16/2026
//   both:  42 lines, 23 farms, $641,042.00; PLC $574,289 / ARC-CO $66,753;
//          by crop seed cotton 568,762 (PLC 560,190 + ARC-CO 8,572), corn 36,701,
//          soybeans 21,480, wheat 12,411, canola 1,124, sorghum 564; 5.7% on every line.

const COMMODITIES = ['Seed Cotton', 'Corn', 'Soybeans', 'Wheat', 'Canola', 'Grain Sorghum', 'Oats', 'Barley', 'Peanuts', 'Sesame', 'Sunflowers']
  .map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }))
const FARM_NUMBERS = [...new Set([...ROWS_1013, ...ROWS_1014].map((r) => r.farm))]
const FARMS = FARM_NUMBERS.map((n) => ({ id: `farm-${n}`, name: `Farm ${n}`, fsa_number: n, county_id: 'lawrence' }))

/** The whole statement read in one chunk: what the review sees. */
const merged = (s: FsaPaymentStatementExtraction) => mergeFsaPaymentStatements([s])
const reviews = (s: FsaPaymentStatementExtraction, existing: string[] = []) =>
  buildLineReviews({ extraction: merged(s), farms: FARMS, commodities: COMMODITIES, existingPaymentIds: new Set(existing), officeCountyId: 'lawrence' })

describe('the 10/13/2026 statement (10 blocks, $199,464)', () => {
  it('stitches to 10 complete lines whose nets sum to the statement net', () => {
    const r = reviews(STATEMENT_1013)
    expect(r).toHaveLength(10)
    expect(r.every((x) => x.block.complete)).toBe(true)
    expect(r.reduce((s, x) => s + x.net, 0)).toBe(199464)
    expect(checkStatement(merged(STATEMENT_1013)).every((c) => c.ok)).toBe(true)
  })

  it('reads the right block: PLC 5563 $9,357 = seed cotton 8,624 + wheat 733, ID 103001783, TCN 661126714', () => {
    const plc5563 = reviews(STATEMENT_1013).find((x) => x.block.fsa_payment_id === '103001783')!
    expect(plc5563.programCode).toBe('PLC')
    expect(plc5563.farmNumber).toBe('5563')
    expect(plc5563.farmId).toBe('farm-5563')
    expect(plc5563.block.transaction_control_number).toBe('661126714')
    expect(plc5563.gross).toBe(9357)
    expect(plc5563.crops).toEqual([
      { raw: 'SEED COTTON', amount: 8624, commodityId: 'seed-cotton' },
      { raw: 'WHEAT', amount: 733, commodityId: 'wheat' },
    ])
    expect(plc5563.paymentDate).toBe('2026-10-15')
    expect(plc5563.programYear).toBe(2025)
    expect(plc5563.sequesterPct).toBe(0.057)
    expect(plc5563.block.account_last4).toBe('2036')
  })

  it('the ARC-CO 5563 block (header on page 1, crop detail on page 2) comes out as ONE line with the right crops', () => {
    const r = reviews(STATEMENT_1013)
    const arc = r.filter((x) => x.farmNumber === '5563' && x.programCode === 'ARC_CO')
    expect(arc).toHaveLength(1)
    expect(arc[0].block.fsa_payment_id).toBe('103004457')
    expect(arc[0].block.page).toBe(1)
    expect(arc[0].block.notes_page).toBe(2)
    expect(arc[0].crops.map((c) => [c.raw, c.amount])).toEqual([['CORN', 3528], ['SOYBEANS', 970]])
    expect(arc[0].gross).toBe(4498)
  })
})

describe('the 10/14/2026 statement (32 blocks, $441,578)', () => {
  it('stitches to 32 complete lines, nets sum to the statement net, every check OK', () => {
    const r = reviews(STATEMENT_1014)
    expect(r).toHaveLength(32)
    expect(r.every((x) => x.block.complete)).toBe(true)
    expect(r.reduce((s, x) => s + x.net, 0)).toBe(441578)
    const checks = checkStatement(merged(STATEMENT_1014))
    expect(checks.map((c) => [c.key, c.ok])).toEqual([['crops', true], ['net', true], ['total', true], ['count', true]])
  })

  it('PLC 7558 $105,713 = canola 331 + seed cotton 102,560 + wheat 2,822; ARC-CO 384 $8,572 seed cotton; PLC 252 $28,304', () => {
    const r = reviews(STATEMENT_1014)
    const by = (id: string) => r.find((x) => x.block.fsa_payment_id === id)!
    expect(by('103023561').crops.map((c) => c.amount)).toEqual([331, 102560, 2822])
    expect(by('103023561').gross).toBe(105713)
    expect(by('103012602')).toMatchObject({ programCode: 'ARC_CO', farmNumber: '384', gross: 8572 })
    expect(by('103012602').crops).toEqual([{ raw: 'SEED COTTON', amount: 8572, commodityId: 'seed-cotton' }])
    expect(by('103027595').crops.map((c) => c.amount)).toEqual([341, 27622, 341])
    expect(by('103027595').paymentDate).toBe('2026-10-16')
  })
})

describe('both statements together', () => {
  const all = [...reviews(STATEMENT_1013), ...reviews(STATEMENT_1014)]
  it('42 lines, 23 farms, $641,042.00; PLC $574,289, ARC-CO $66,753', () => {
    const t = reviewTotals(all, COMMODITIES)
    expect(all).toHaveLength(42)
    expect(t.farms).toBe(23)
    expect(t.net).toBe(641042)
    expect(t.byProgram.get('PLC')).toBe(574289)
    expect(t.byProgram.get('ARC_CO')).toBe(66753)
  })
  it('by crop: seed cotton 568,762 (PLC 560,190 + ARC-CO 8,572), corn 36,701, soybeans 21,480, wheat 12,411, canola 1,124, sorghum 564', () => {
    const t = reviewTotals(all, COMMODITIES)
    expect(t.byCommodity.get('Seed Cotton')).toBe(568762)
    expect(t.byCommodity.get('Corn')).toBe(36701)
    expect(t.byCommodity.get('Soybeans')).toBe(21480)
    expect(t.byCommodity.get('Wheat')).toBe(12411)
    expect(t.byCommodity.get('Canola')).toBe(1124)
    expect(t.byCommodity.get('Grain Sorghum')).toBe(564)
    const scPlc = all.filter((x) => x.programCode === 'PLC').flatMap((x) => x.crops).filter((c) => c.commodityId === 'seed-cotton').reduce((s, c) => s + c.amount, 0)
    const scArc = all.filter((x) => x.programCode === 'ARC_CO').flatMap((x) => x.crops).filter((c) => c.commodityId === 'seed-cotton').reduce((s, c) => s + c.amount, 0)
    expect(scPlc).toBe(560190)
    expect(scArc).toBe(8572)
  })
  it('sequester 5.7% and program year 2025 on every line; every farm matched', () => {
    expect(all.every((x) => x.sequesterPct === 0.057 && x.programYear === 2025)).toBe(true)
    expect(all.every((x) => x.farmId != null && !x.farmAmbiguous)).toBe(true)
  })
})

describe('chunk boundaries', () => {
  /** The chunked parse reports pages RELATIVE to the chunk; the merge rebases them. */
  const relative = (s: FsaPaymentStatementExtraction, from: number): FsaPaymentStatementExtraction => ({
    ...s,
    pages: s.pages?.map((p) => ({ ...p, page: p.page == null ? null : p.page - from + 1 })) ?? null,
    blocks: s.blocks?.map((b) => ({ ...b, page: b.page == null ? null : b.page - from + 1 })) ?? null,
  })
  it('a block split across a chunk boundary (PLC 406 header on page 5, notes on page 6) comes out as ONE line', () => {
    // Chunks 1–5 | 6–10 | 11–14: the page-5 header and its page-6 notes land in different chunks.
    const parts = [[1, 5], [6, 10], [11, 14]].map(([a, b]) => rebaseFsaPages(relative(chunkOf(STATEMENT_1014, a, b), a), a))
    const out = mergeFsaPaymentStatements(parts)
    const blocks = out.blocks as FsaStitchedBlock[]
    expect(blocks).toHaveLength(32)
    const plc406 = blocks.find((b) => b.fsa_payment_id === '103017441')!
    expect(plc406.page).toBe(5)
    expect(plc406.notes_page).toBe(6)
    expect(plc406.notes?.crop_amounts?.map((c) => c.amount)).toEqual([29642, 448, 262])
    expect(blocks.filter((b) => b.farm_number === '406' && /PRICE/.test(b.program_title ?? ''))).toHaveLength(1)
    expect(checkStatement(out).every((c) => c.ok)).toBe(true)
    // Header fields come from the first chunk (page 1).
    expect(out.statement_date).toBe('2026-10-14')
    expect(out.summary?.net).toBe(441578)
  })
  it('a header-less notes fragment attaches by farm number when two headers are waiting', () => {
    const stitched = stitchBlocks([
      { ...header('A', '100', 1), notes_present: false },
      { ...header('B', '200', 1), notes_present: false },
      notesFragment('100', 2, [['CORN', 10]]),
      notesFragment('200', 2, [['WHEAT', 20]]),
    ])
    expect(stitched.find((b) => b.fsa_payment_id === 'A')?.notes?.crop_amounts?.[0].crop).toBe('CORN')
    expect(stitched.find((b) => b.fsa_payment_id === 'B')?.notes?.crop_amounts?.[0].crop).toBe('WHEAT')
  })
  it('a repeated header (the same FSA Payment ID in two chunks) is kept once', () => {
    const stitched = stitchBlocks([header('A', '100', 1), header('A', '100', 1)])
    expect(stitched).toHaveLength(1)
  })
})

describe('checks flag what is wrong', () => {
  it('a block whose crop amounts do not sum to gross is flagged; the rest pass', () => {
    const bad: FsaPaymentStatementExtraction = {
      ...STATEMENT_1013,
      blocks: STATEMENT_1013.blocks!.map((b) => (b.fsa_payment_id === '103001783' ? { ...b, notes: { ...b.notes!, crop_amounts: [{ crop: 'SEED COTTON', amount: 8000 }, { crop: 'WHEAT', amount: 733 }] } } : b)),
    }
    const checks = checkStatement(merged(bad))
    expect(checks.find((c) => c.key === 'crops')?.ok).toBe(false)
    expect(checks.find((c) => c.key === 'crops')?.detail).toContain('5563')
    expect(checks.find((c) => c.key === 'total')?.ok).toBe(true)
  })
  it('blocks not summing to the statement net reads not OK; a missing block header count reads not OK', () => {
    const short: FsaPaymentStatementExtraction = { ...STATEMENT_1013, blocks: STATEMENT_1013.blocks!.slice(0, 5) }
    const checks = checkStatement(merged(short))
    expect(checks.find((c) => c.key === 'total')?.ok).toBe(false)
    expect(checks.find((c) => c.key === 'count')?.ok).toBe(false)
  })
})

describe('re-upload', () => {
  it('the same statement saves nothing new — every line is already recorded', () => {
    const existing = STATEMENT_1013.blocks!.map((b) => b.fsa_payment_id).filter((x): x is string => x != null)
    const r = reviews(STATEMENT_1013, existing)
    expect(r.every((x) => x.alreadyRecorded && !x.include)).toBe(true)
    const plan = planStatementSave({ extraction: merged(STATEMENT_1013), reviews: r, payeeEntityId: 'martin', pageCount: 6 })
    expect(plan.lines).toHaveLength(0)
    expect(plan.alreadyRecorded).toHaveLength(10)
    expect(plan.blockers).toEqual([])
  })
  it('a fresh statement plans every line with its crops and no other-payment rows (all ARC/PLC)', () => {
    const plan = planStatementSave({ extraction: merged(STATEMENT_1014), reviews: reviews(STATEMENT_1014), payeeEntityId: 'martin', pageCount: 14 })
    expect(plan.lines).toHaveLength(32)
    expect(plan.statement).toMatchObject({ statement_date: '2026-10-14', payee_name: 'MARTIN FARM', payee_entity_id: 'martin', gross_payment: 441578, net_payment: 441578, page_count: 14 })
    expect(plan.lines.every((l) => l.otherPayment == null)).toBe(true)
    expect(plan.lines.flatMap((l) => l.crops)).toHaveLength(ROWS_1014.reduce((s, r) => s + r.crops.length, 0))
    expect(plan.lines[0].row.account_last4).toBe('2036')
  })
  it('a non-ARC/PLC block lands as an other-payment row linked to the line', () => {
    const s: FsaPaymentStatementExtraction = {
      ...STATEMENT_1013,
      blocks: [{ ...STATEMENT_1013.blocks![0], program_title: 'EMERGENCY LIVESTOCK ASSISTANCE PROGRAM', fsa_payment_id: '999', notes: { program_year: 2026, program_name: 'ELAP', farm_number: null, crop_amounts: null, sequester_pct: null, text: null } }],
    }
    const plan = planStatementSave({ extraction: merged(s), reviews: reviews(s), payeeEntityId: 'martin', pageCount: 1 })
    expect(plan.lines[0].row.program_code).toBe('OTHER')
    expect(plan.lines[0].otherPayment).toMatchObject({ program_name: 'ELAP', amount: 9357, payment_date: '2026-10-15', crop_year: 2026, entity_id: 'martin' })
  })
})

describe('normalization', () => {
  it('program titles map to codes', () => {
    expect(normalizeProgramCode('PRICE LOSS COVERAGE')).toBe('PLC')
    expect(normalizeProgramCode('AGRICULTURAL RISK COVERAGE PROG - COUNTY')).toBe('ARC_CO')
    expect(normalizeProgramCode('AGRICULTURAL RISK COVERAGE PROG - INDIVIDUAL')).toBe('ARC_IC')
    expect(normalizeProgramCode('CONSERVATION RESERVE PROGRAM')).toBe('OTHER')
    expect(normalizeProgramCode(null, 'Price Loss Coverage Program')).toBe('PLC')
  })
  it('dates, sequester fractions, and the last four digits only', () => {
    expect(isoDate('on/about 10/15/2026')).toBe('2026-10-15')
    expect(isoDate('2026-10-13')).toBe('2026-10-13')
    expect(sequesterFraction(5.7)).toBe(0.057)
    expect(sequesterFraction(0.057)).toBe(0.057)
    const n = normalizeFsaPaymentStatement({ blocks: [{ account_last4: 'account ending in 123456782036', gross: '$9,357.00', payment_date: '10/15/2026', notes: { program_year: '2025', crop_amounts: [{ crop: 'SEED COTTON', amount: '$8,624.00' }] } }] })
    expect(n.blocks?.[0].account_last4).toBe('2036')
    expect(n.blocks?.[0].gross).toBe(9357)
    expect(n.blocks?.[0].payment_date).toBe('2026-10-15')
    expect(n.blocks?.[0].notes?.crop_amounts?.[0].amount).toBe(8624)
  })
  it('crop names map to covered commodities (SEED COTTON → Seed Cotton, SORGHUM → Grain Sorghum, SOYBEAN → Soybeans)', () => {
    expect(commodityForCrop('SEED COTTON', COMMODITIES)?.name).toBe('Seed Cotton')
    expect(commodityForCrop('SORGHUM', COMMODITIES)?.name).toBe('Grain Sorghum')
    expect(commodityForCrop('SOYBEAN', COMMODITIES)?.name).toBe('Soybeans')
    expect(commodityForCrop('CANOLA', COMMODITIES)?.name).toBe('Canola')
    expect(commodityForCrop('RICE', COMMODITIES)).toBeNull()
  })
  it('farms match by FSA number within the office county; the office name gives the county', () => {
    expect(officeCountyName('LAWRENCE FSA OFFICE')).toBe('lawrence')
    expect(officeCountyName('COLBERT COUNTY FSA OFFICE')).toBe('colbert')
    const farms = [
      { id: 'a', name: 'A', fsa_number: '260', county_id: 'lawrence' },
      { id: 'b', name: 'B', fsa_number: '260', county_id: 'colbert' },
      { id: 'c', name: 'C', fsa_number: '0384', county_id: 'lawrence' },
    ]
    expect(matchFarmByFsaNumber({ fsaNumber: '260', farms, officeCountyId: 'lawrence' }).farm?.id).toBe('a')
    expect(matchFarmByFsaNumber({ fsaNumber: '260', farms })).toEqual({ farm: null, ambiguous: true })
    expect(matchFarmByFsaNumber({ fsaNumber: '384', farms }).farm?.id).toBe('c')
    expect(matchFarmByFsaNumber({ fsaNumber: '9999', farms }).farm).toBeNull()
  })
  it('the payee matches an entity by name, ignoring LLC / punctuation', () => {
    const entities = [{ id: 'tsf', name: 'Two Seasons Farm, LLC' }, { id: 'martin', name: 'Martin Farm' }]
    expect(matchPayeeEntity('MARTIN FARM', entities)?.id).toBe('martin')
    expect(matchPayeeEntity('TWO SEASONS FARM LLC', entities)?.id).toBe('tsf')
    expect(matchPayeeEntity('VIEW CELESTE FARM', entities)).toBeNull()
  })
  it('the payee notice sentence', () => {
    expect(payeeNoticeText({ payeeName: 'MARTIN FARM', programYear: 2025, farmCount: 23, turnrowEntityNames: ['View Celeste Farm, LLC', 'Two Seasons Farm, LLC'] }))
      .toBe('This statement paid MARTIN FARM for program year 2025 on 23 farms. Turnrow has View Celeste Farm, LLC / Two Seasons Farm, LLC.')
  })
})

// ---------- small builders ----------
function header(id: string, farm: string, page: number) {
  return {
    page, program_title: 'PRICE LOSS COVERAGE', fsa_payment_id: id, farm_number: farm, transaction_control_number: `t${id}`,
    gross: 100, deductions: 0, deduction_detail: [], net: 100, payment_method: 'ACH', bank_name: 'X', account_last4: '1111', payment_date: '2026-10-15',
    notes: null, header_present: true, notes_present: false,
  }
}
function notesFragment(farm: string, page: number, crops: Array<[string, number]>) {
  return {
    page, program_title: null, fsa_payment_id: null, farm_number: null, transaction_control_number: null,
    gross: null, deductions: null, deduction_detail: null, net: null, payment_method: null, bank_name: null, account_last4: null, payment_date: null,
    notes: { program_year: 2025, program_name: 'Price Loss Coverage Program', farm_number: farm, crop_amounts: crops.map(([crop, amount]) => ({ crop, amount })), sequester_pct: 5.7, text: null },
    header_present: false, notes_present: true,
  }
}
