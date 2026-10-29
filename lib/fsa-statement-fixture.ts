// SYNTHETIC fixtures with the real SHAPES and NUMBERS of the two USDA/FSA
// Payment Statements MARTIN FARM received for program year 2025 (statement
// dates 10/13/2026 — 10 blocks over 5 pages + a blank back — and 10/14/2026 —
// 32 blocks over 14 pages). Hand-verified from the scans (2026-10-28): every
// FSA Payment ID, transaction control number, gross and crop amount below is
// as printed. The PDFs themselves are never committed; this is what the
// model's extraction of them looks like, in page order, with the fragments
// (a header at the bottom of one page, its Notes at the top of the next)
// flagged exactly as the prompt asks.

import type { FsaBlockExtraction, FsaPaymentStatementExtraction } from '@/lib/fsa-payment-statement'

type Crop = [string, number]
type Row = {
  page: number
  program: 'PLC' | 'ARC_CO'
  farm: string
  id: string
  tcn: string
  gross: number
  crops: Crop[]
  /** The Notes sit on the next page (header at a page bottom). */
  notesOnNextPage?: boolean
}

const TITLE = { PLC: 'PRICE LOSS COVERAGE', ARC_CO: 'AGRICULTURAL RISK COVERAGE PROG - COUNTY' } as const
const PROGRAM_NAME = { PLC: 'Price Loss Coverage Program', ARC_CO: 'Agriculture Risk Coverage Program-County' } as const

const NOTES_BOILERPLATE = (farm: string, program: 'PLC' | 'ARC_CO', crops: Crop[]) =>
  `Program Year: 2025, Program Name: ${PROGRAM_NAME[program]}, Farm Number: ${farm}\nCrop and Payment Amount Detail:\n${crops.map(([c, a]) => `${c} : $${a.toLocaleString('en-US', { minimumFractionDigits: 2 })}`).join(' , ')}\n-The Balanced Budget and Emergency Deficit Control Act of 1985, as amended by the Budget Control Act of 2011, requires a reduction in most federal payments obligated in 2025, which is known as a sequester. Payments issued under the 2019 Agriculture Risk Coverage and Price Loss Coverage (ARC/PLC) Program have been reduced by 5.7 percent due to sequester-related reductions.\n-You may appeal this payment and how it was calculated by filing a written request to the County Committee within 30 calendar days after you receive this statement and by explaining why you believe this payment is erroneous. If you appeal to the County Committee, you have the right to an informal hearing which you or your representative may attend either personally or by telephone. If you appeal to the County Committee, you may later appeal an adverse determination of the County Committee to the FSA State Committee or the National Appeals Division or request mediation. If you do not timely file a written appeal, this payment is a final administrative determination with respect to this matter according to the regulations at 7 CFR Part 780.`

function notesOf(r: Row) {
  return {
    program_year: 2025,
    program_name: PROGRAM_NAME[r.program],
    farm_number: r.farm,
    crop_amounts: r.crops.map(([crop, amount]) => ({ crop, amount })),
    sequester_pct: 5.7,
    text: NOTES_BOILERPLATE(r.farm, r.program, r.crops),
  }
}

/** The blocks of a statement as the model reports them: whole blocks, plus
 *  header / notes fragments where a block straddles two pages. */
function blocksOf(rows: Row[], achDate: string): FsaBlockExtraction[] {
  const out: FsaBlockExtraction[] = []
  for (const r of rows) {
    const header: FsaBlockExtraction = {
      page: r.page,
      program_title: TITLE[r.program],
      fsa_payment_id: r.id,
      farm_number: r.farm,
      transaction_control_number: r.tcn,
      gross: r.gross,
      deductions: 0,
      deduction_detail: [],
      net: r.gross,
      payment_method: 'ACH',
      bank_name: 'PNC BANK, NATIONAL ASSOCIATION',
      account_last4: '2036',
      payment_date: achDate,
      notes: r.notesOnNextPage ? null : notesOf(r),
      header_present: true,
      notes_present: !r.notesOnNextPage,
    }
    out.push(header)
    if (r.notesOnNextPage) {
      out.push({
        page: r.page + 1,
        program_title: null, fsa_payment_id: null, farm_number: null, transaction_control_number: null,
        gross: null, deductions: null, deduction_detail: null, net: null,
        payment_method: null, bank_name: null, account_last4: null, payment_date: null,
        notes: notesOf(r),
        header_present: false, notes_present: true,
      })
    }
  }
  return out
}

// ---------- 10/13/2026 — 5 pages (+ a blank back), 10 blocks, $199,464.00 ----------

export const ROWS_1013: Row[] = [
  { page: 1, program: 'PLC', farm: '5563', id: '103001783', tcn: '661126714', gross: 9357, crops: [['SEED COTTON', 8624], ['WHEAT', 733]] },
  { page: 1, program: 'ARC_CO', farm: '5563', id: '103004457', tcn: '661126733', gross: 4498, crops: [['CORN', 3528], ['SOYBEANS', 970]], notesOnNextPage: true },
  { page: 2, program: 'ARC_CO', farm: '5445', id: '103004751', tcn: '661126914', gross: 2413, crops: [['CORN', 1125], ['SOYBEANS', 1288]] },
  { page: 2, program: 'PLC', farm: '5445', id: '103005252', tcn: '661126883', gross: 29004, crops: [['SEED COTTON', 28832], ['SORGHUM', 38], ['WHEAT', 134]] },
  { page: 3, program: 'PLC', farm: '260', id: '103005756', tcn: '661143169', gross: 52586, crops: [['SEED COTTON', 52586]] },
  { page: 3, program: 'PLC', farm: '7560', id: '103007137', tcn: '661127047', gross: 48088, crops: [['SEED COTTON', 46408], ['WHEAT', 1680]] },
  { page: 3, program: 'ARC_CO', farm: '7560', id: '103007161', tcn: '661127063', gross: 3066, crops: [['CORN', 1942], ['SOYBEANS', 1124]], notesOnNextPage: true },
  { page: 4, program: 'ARC_CO', farm: '260', id: '103007391', tcn: '661143196', gross: 8232, crops: [['CORN', 5880], ['SOYBEANS', 2352]] },
  { page: 4, program: 'PLC', farm: '3309', id: '103007622', tcn: '661143307', gross: 37175, crops: [['SEED COTTON', 35332], ['WHEAT', 1843]] },
  { page: 5, program: 'ARC_CO', farm: '3309', id: '103008625', tcn: '661143338', gross: 5045, crops: [['CORN', 3248], ['SOYBEANS', 1797]] },
]

export const STATEMENT_1013: FsaPaymentStatementExtraction = {
  office_name: 'LAWRENCE FSA OFFICE',
  office_address: '13075 AL HWY 157 SUITE 3, MOULTON, AL 35650-6579',
  office_phone: '(256)974-1174',
  payee_name: 'MARTIN FARM',
  payee_address: 'PO BOX 356, COURTLAND AL 35618-0356',
  statement_date: '2026-10-13',
  summary: { gross: 199464, deductions: 0, net: 199464 },
  pages: [
    { page: 1, header_count: 2 }, { page: 2, header_count: 2 }, { page: 3, header_count: 3 },
    { page: 4, header_count: 2 }, { page: 5, header_count: 1 }, { page: 6, header_count: 0 },
  ],
  blocks: blocksOf(ROWS_1013, '2026-10-15'),
}

// ---------- 10/14/2026 — 14 pages, 32 blocks, $441,578.00 ----------

export const ROWS_1014: Row[] = [
  { page: 1, program: 'PLC', farm: '5449', id: '103008856', tcn: '661143452', gross: 18915, crops: [['SEED COTTON', 18742], ['WHEAT', 173]] },
  { page: 1, program: 'ARC_CO', farm: '5449', id: '103008882', tcn: '661143469', gross: 453, crops: [['CORN', 336], ['SOYBEANS', 117]], notesOnNextPage: true },
  { page: 2, program: 'PLC', farm: '366', id: '103010438', tcn: '661143557', gross: 4238, crops: [['SEED COTTON', 4238]] },
  { page: 2, program: 'PLC', farm: '3910', id: '103011671', tcn: '661143765', gross: 30810, crops: [['SEED COTTON', 30758], ['WHEAT', 52]] },
  { page: 3, program: 'PLC', farm: '280', id: '103012274', tcn: '661143625', gross: 31899, crops: [['CANOLA', 168], ['SEED COTTON', 31334], ['WHEAT', 397]] },
  { page: 3, program: 'ARC_CO', farm: '3910', id: '103012520', tcn: '661143785', gross: 108, crops: [['CORN', 74], ['SOYBEANS', 34]] },
  { page: 3, program: 'ARC_CO', farm: '384', id: '103012602', tcn: '661143869', gross: 8572, crops: [['SEED COTTON', 8572]], notesOnNextPage: true },
  { page: 4, program: 'ARC_CO', farm: '280', id: '103013229', tcn: '661143651', gross: 1524, crops: [['CORN', 762], ['SOYBEANS', 762]] },
  { page: 4, program: 'PLC', farm: '7559', id: '103013828', tcn: '661143932', gross: 32451, crops: [['SEED COTTON', 32154], ['SORGHUM', 78], ['WHEAT', 219]] },
  { page: 5, program: 'ARC_CO', farm: '7559', id: '103014791', tcn: '661143977', gross: 5829, crops: [['CORN', 4704], ['SOYBEANS', 1125]] },
  { page: 5, program: 'ARC_CO', farm: '406', id: '103016652', tcn: '661162283', gross: 2666, crops: [['CORN', 1176], ['SOYBEANS', 1490]] },
  { page: 5, program: 'PLC', farm: '406', id: '103017441', tcn: '661162238', gross: 30352, crops: [['SEED COTTON', 29642], ['SORGHUM', 448], ['WHEAT', 262]], notesOnNextPage: true },
  { page: 6, program: 'ARC_CO', farm: '302', id: '103017915', tcn: '661162519', gross: 1667, crops: [['CORN', 1270], ['SOYBEANS', 397]] },
  { page: 6, program: 'PLC', farm: '360', id: '103019030', tcn: '661162102', gross: 14032, crops: [['SEED COTTON', 12838], ['WHEAT', 1194]] },
  { page: 7, program: 'ARC_CO', farm: '360', id: '103019067', tcn: '661162120', gross: 2610, crops: [['CORN', 1546], ['SOYBEANS', 1064]] },
  { page: 7, program: 'ARC_CO', farm: '397', id: '103019550', tcn: '661162401', gross: 2347, crops: [['SOYBEANS', 2347]] },
  { page: 7, program: 'PLC', farm: '302', id: '103019803', tcn: '661162480', gross: 14598, crops: [['CANOLA', 56], ['SEED COTTON', 14155], ['WHEAT', 387]], notesOnNextPage: true },
  { page: 8, program: 'PLC', farm: '397', id: '103020107', tcn: '661162394', gross: 28707, crops: [['SEED COTTON', 28707]] },
  { page: 8, program: 'ARC_CO', farm: '7282', id: '103023202', tcn: '661162670', gross: 1310, crops: [['CORN', 862], ['SOYBEANS', 448]] },
  { page: 9, program: 'PLC', farm: '7558', id: '103023561', tcn: '661162794', gross: 105713, crops: [['CANOLA', 331], ['SEED COTTON', 102560], ['WHEAT', 2822]] },
  { page: 9, program: 'PLC', farm: '7282', id: '103024103', tcn: '661162640', gross: 8318, crops: [['CANOLA', 112], ['SEED COTTON', 7754], ['WHEAT', 452]] },
  { page: 9, program: 'ARC_CO', farm: '7558', id: '103024491', tcn: '661162852', gross: 7176, crops: [['CORN', 3958], ['SOYBEANS', 3218]], notesOnNextPage: true },
  { page: 10, program: 'PLC', farm: '3310', id: '103024743', tcn: '661162984', gross: 14356, crops: [['SEED COTTON', 14038], ['WHEAT', 318]] },
  { page: 10, program: 'ARC_CO', farm: '3310', id: '103024776', tcn: '661163012', gross: 2771, crops: [['CORN', 2262], ['SOYBEANS', 509]] },
  { page: 11, program: 'PLC', farm: '7553', id: '103025410', tcn: '661180114', gross: 5230, crops: [['SEED COTTON', 5230]] },
  { page: 11, program: 'ARC_CO', farm: '7283', id: '103025754', tcn: '661180233', gross: 1474, crops: [['CORN', 970], ['SOYBEANS', 504]] },
  { page: 11, program: 'PLC', farm: '252', id: '103027595', tcn: '661180387', gross: 28304, crops: [['CANOLA', 341], ['SEED COTTON', 27622], ['WHEAT', 341]], notesOnNextPage: true },
  { page: 12, program: 'PLC', farm: '7283', id: '103028235', tcn: '661180189', gross: 9394, crops: [['CANOLA', 116], ['SEED COTTON', 8718], ['WHEAT', 560]] },
  { page: 12, program: 'ARC_CO', farm: '252', id: '103028556', tcn: '661180431', gross: 2610, crops: [['CORN', 1400], ['SOYBEANS', 1210]] },
  { page: 13, program: 'PLC', farm: '388', id: '103030283', tcn: '661180543', gross: 15498, crops: [['SEED COTTON', 14654], ['WHEAT', 844]] },
  { page: 13, program: 'ARC_CO', farm: '388', id: '103031054', tcn: '661180569', gross: 2382, crops: [['CORN', 1658], ['SOYBEANS', 724]] },
  { page: 13, program: 'PLC', farm: '3217', id: '103031158', tcn: '661180681', gross: 5264, crops: [['SEED COTTON', 5264]], notesOnNextPage: true },
]

export const STATEMENT_1014: FsaPaymentStatementExtraction = {
  office_name: 'LAWRENCE FSA OFFICE',
  office_address: '13075 AL HWY 157 SUITE 3, MOULTON, AL 35650-6579',
  office_phone: '(256)974-1174',
  payee_name: 'MARTIN FARM',
  payee_address: 'PO BOX 356, COURTLAND AL 35618-0356',
  statement_date: '2026-10-14',
  summary: { gross: 441578, deductions: 0, net: 441578 },
  pages: [
    { page: 1, header_count: 2 }, { page: 2, header_count: 2 }, { page: 3, header_count: 3 }, { page: 4, header_count: 2 },
    { page: 5, header_count: 3 }, { page: 6, header_count: 2 }, { page: 7, header_count: 3 }, { page: 8, header_count: 2 },
    { page: 9, header_count: 3 }, { page: 10, header_count: 2 }, { page: 11, header_count: 3 }, { page: 12, header_count: 2 },
    { page: 13, header_count: 3 }, { page: 14, header_count: 0 },
  ],
  blocks: blocksOf(ROWS_1014, '2026-10-16'),
}

/** A statement's blocks limited to a page range — what one chunk of the
 *  chunked parse returns (pages are reported document-absolute here; the
 *  test rebases them the way lib/parse-chunked does). */
export function chunkOf(statement: FsaPaymentStatementExtraction, from: number, to: number): FsaPaymentStatementExtraction {
  const inRange = (p: number | null) => p != null && p >= from && p <= to
  return {
    ...statement,
    // Header fields print on page 1 only.
    office_name: from === 1 ? statement.office_name : null,
    office_address: from === 1 ? statement.office_address : null,
    office_phone: from === 1 ? statement.office_phone : null,
    payee_name: from === 1 ? statement.payee_name : null,
    payee_address: from === 1 ? statement.payee_address : null,
    statement_date: from === 1 ? statement.statement_date : null,
    summary: from === 1 ? statement.summary : null,
    pages: statement.pages?.filter((p) => inRange(p.page)) ?? null,
    blocks: statement.blocks?.filter((b) => inRange(b.page)) ?? null,
  }
}
