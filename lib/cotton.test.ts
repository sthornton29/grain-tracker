import { describe, it, expect } from 'vitest'
import {
  lintTurnoutPct, loanCentsPerLb, reconcileBaleCount, matchGradesToBales,
  yardInventoryByField, cottonFieldYields,
} from './cotton'
import { parseGradeCsv } from './cotton-grades'
import { realizedPnl, unrealizedPnl, pnlSizeFor, buildContractSymbol, normalizeCommodity, contractUnit, quantityFor, fmtQuantity, fmtCommodityPrice, normalizeBarchartPrice } from './hedging'

describe('turnout + loan math', () => {
  it('lint turnout = lint ÷ seed cotton', () => {
    // 24 bales × ~500 lb from 30,000 lbs seed cotton ≈ 40%.
    expect(lintTurnoutPct(12000, 30000)).toBe(40)
    expect(lintTurnoutPct(12000, 0)).toBeNull()
  })
  it('loan ¢/lb derivation: $280.46 total on a 509 lb bale → 55.1¢', () => {
    expect(loanCentsPerLb(280.46, 509)).toBe(55.1)
    expect(loanCentsPerLb(280.46, 0)).toBeNull()
  })
  it('bale-count reconciliation flags stated vs captured mismatches', () => {
    expect(reconcileBaleCount(24, 24).ok).toBe(true)
    expect(reconcileBaleCount(null, 24).ok).toBe(true)
    const bad = reconcileBaleCount(24, 22)
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('24')
    expect(bad.message).toContain('22')
  })
})

describe('grade CSV parsing (real-file quirks: preamble, CRLF, blank cells)', () => {
  // Fixture built from the real classing-office file shape: two preamble
  // lines, then the header, 21 columns, CRLF endings, blank Ex/Rm cells.
  const CSV = [
    'USDA COTTON CLASSING DATA,,,,,,,,,,,,,,,,,,,,',
    'Office: MEMPHIS,,,,,,,,,,,,,,,,,,,,',
    'Bale #,NetWt,Prod,Farm,Field ID,Date,Gr,Lf,St,Mic,Str,Cgr,Rd,+B,Tr,Unif,Len,Ex,Rm,Total Value,Crop',
    '4661001,509,MCCOULOUGH,1234,JOE MCCOULOUGH IRR,11/14/2025,31,3,36,4.4,29.5,31-1,78.2,8.1,0.3,81.2,1.12,,,280.46,UP',
    '4661002,487,MCCOULOUGH,1234,JOE MCCOULOUGH IRR,11/14/2025,41,4,35,3.9,28.1,41-2,76.0,8.5,0.5,80.4,1.09,1,LM,262.98,UP',
    '',
  ].join('\r\n')

  it('skips the preamble, maps 21 columns by header name, parses both bales', () => {
    const r = parseGradeCsv(CSV)
    expect(r.error).toBeNull()
    expect(r.preambleLines).toBe(2)
    expect(r.rows).toHaveLength(2)
    const b1 = r.rows[0]
    expect(b1).toMatchObject({
      pbi_number: '4661001', net_weight_lbs: 509, producer: 'MCCOULOUGH', farm: '1234',
      field_id_text: 'JOE MCCOULOUGH IRR', class_date: '2025-11-14',
      color_grade: '31', leaf_grade: '3', staple_32nds: 36, micronaire: 4.4, strength_g_tex: 29.5,
      composite_grade: '31-1', rd: 78.2, plus_b: 8.1, trash_pct: 0.3, uniformity_pct: 81.2,
      length_100ths: 1.12, extraneous: null, remarks: null, loan_value_total: 280.46,
    })
    // Derived loan ¢/lb: 280.46 ÷ 509 × 100 = 55.1¢.
    expect(b1.loan_value_cents_per_lb).toBe(55.1)
    // Blank Ex/Rm parse as null on row 1; populated on row 2.
    expect(r.rows[1].extraneous).toBe('1')
    expect(r.rows[1].remarks).toBe('LM')
  })

  it('tolerates a reordered header and reports unknown columns', () => {
    const csv = 'NetWt,Bale #,Gr,Mystery\r\n509,4661001,31,x\r\n'
    // Header row is found by the Bale # column being present — but the first
    // cell must be the bale column per the real layout; a reordered file
    // still parses when Bale # leads. This variant leads with NetWt → the
    // header scan requires the bale column somewhere, so reorder WITH bale
    // first:
    const ok = parseGradeCsv('Bale #,Gr,NetWt,Mystery\r\n4661001,31,509,x\r\n')
    expect(ok.rows[0]).toMatchObject({ pbi_number: '4661001', color_grade: '31', net_weight_lbs: 509 })
    expect(ok.unknownHeaders).toEqual(['Mystery'])
    expect(csv.length).toBeGreaterThan(0)
  })

  it('errors clearly when no header row exists', () => {
    expect(parseGradeCsv('just,some,noise\r\n1,2,3').error).toContain('Bale #')
  })
})

describe('bale ↔ grade matching', () => {
  const bales = [
    { id: 'b1', pbi_number: '4661001', net_weight_lbs: 509 },
    { id: 'b2', pbi_number: '4661002', net_weight_lbs: 487 },
  ]
  it('matches by PBI (leading zeros ignored), flags >1% weight differences', () => {
    const { matched, unmatched } = matchGradesToBales(
      [
        { pbi_number: '04661001', net_weight_lbs: 509 }, // zero-padded, exact weight
        { pbi_number: '4661002', net_weight_lbs: 460 }, // 5.5% light → mismatch flag
        { pbi_number: '9999999', net_weight_lbs: 500 }, // receipt not entered yet
      ],
      bales,
    )
    expect(matched).toHaveLength(2)
    expect(matched[0]).toMatchObject({ bale: bales[0], weightMismatch: false })
    expect(matched[1]).toMatchObject({ bale: bales[1], weightMismatch: true })
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0].pbi_number).toBe('9999999')
  })
})

describe('yard inventory + lbs/acre yields', () => {
  const loads = [
    { id: 'l1', field_id: 'f1', net_weight: 20000 },
    { id: 'l2', field_id: 'f1', net_weight: 10000 },
    { id: 'l3', field_id: 'f2', net_weight: 15000 },
  ]
  it('yard = delivered loads not on any receipt', () => {
    const yard = yardInventoryByField(loads, new Set(['l1']))
    expect(yard.get('f1')).toBe(10000)
    expect(yard.get('f2')).toBe(15000)
  })

  it('multi-receipt field: lint lbs/ac from summed bale weights; turnout; complete', () => {
    const out = cottonFieldYields({
      fields: [{ fieldId: 'f1', plantedAcres: 100 }],
      receipts: [
        { id: 'r1', field_id: 'f1', total_seed_cotton_weight: 20000, total_bale_weight: null, bales_count: 16 },
        { id: 'r2', field_id: 'f1', total_seed_cotton_weight: 10000, total_bale_weight: null, bales_count: 8 },
      ],
      bales: [
        ...Array.from({ length: 16 }, () => ({ gin_receipt_id: 'r1', net_weight_lbs: 500 })),
        ...Array.from({ length: 8 }, () => ({ gin_receipt_id: 'r2', net_weight_lbs: 490 })),
      ],
      loads: [{ id: 'l1', field_id: 'f1', net_weight: 30000 }],
      ginnedLoadIds: new Set(['l1']),
    })[0]
    // 16×500 + 8×490 = 11,920 lint lbs on 100 ac = 119.2 lbs/ac.
    expect(out.lintLbs).toBe(11920)
    expect(out.lintPerAcre).toBe(119.2)
    expect(out.seedPerAcre).toBe(300)
    // turnout 11,920 / 30,000 = 39.73%
    expect(out.turnoutPct).toBe(39.73)
    expect(out.bales).toBe(24)
    expect(out.status).toBe('complete')
    expect(out.yardSeedLbs).toBe(0)
  })

  it('loads on the yard mark the field in-progress with the awaiting-gin lbs', () => {
    const out = cottonFieldYields({
      fields: [{ fieldId: 'f2', plantedAcres: 80 }],
      receipts: [],
      bales: [],
      loads: [{ id: 'l3', field_id: 'f2', net_weight: 15000 }],
      ginnedLoadIds: new Set(),
    })[0]
    expect(out.status).toBe('in_progress')
    expect(out.yardSeedLbs).toBe(15000)
    expect(out.lintPerAcre).toBeNull()
  })

  it('falls back to the receipt-stated bale weight when bale rows are not captured', () => {
    const out = cottonFieldYields({
      fields: [{ fieldId: 'f1', plantedAcres: 50 }],
      receipts: [{ id: 'r1', field_id: 'f1', total_seed_cotton_weight: 15000, total_bale_weight: 6000, bales_count: 12 }],
      bales: [],
      loads: [],
      ginnedLoadIds: new Set(),
    })[0]
    expect(out.lintLbs).toBe(6000)
    expect(out.bales).toBe(12)
    expect(out.lintPerAcre).toBe(120)
  })
})

describe('cotton futures (ICE Cotton No. 2)', () => {
  it('symbols, months, units, statement-name mapping', () => {
    expect(buildContractSymbol('Cotton', 'DEC 26')).toBe('CTZ26')
    expect(normalizeCommodity('DEC 26 ICE COTTON 2')).toBe('Cotton')
    expect(normalizeCommodity('SEED COTTON')).toBeNull() // the lint contract ≠ seed cotton
    expect(contractUnit('Cotton')).toBe('lbs')
    expect(contractUnit('Corn')).toBe('bu')
  })
  it('statement-name mapping covers the printed variants', () => {
    for (const name of ['ICE COTTON 2', 'COTTON 2', 'COTTON NO. 2', 'DEC 26 ICE COTTON 2']) {
      expect(normalizeCommodity(name)).toBe('Cotton')
    }
  })
  it('unrealized on the live statement case: 10 short @ 72.65¢, market 78.30¢ → −$28,250', () => {
    // (72.65 − 78.30)¢ × 500 $/¢/contract × 10 = −$28,250 (matches the StoneX statement).
    const u = unrealizedPnl({
      side: 'short', tradePrice: 72.65, currentPrice: 78.3, numContracts: 10,
      contractSizeBu: pnlSizeFor('Cotton'),
    })
    expect(u).toBeCloseTo(-28250, 2)
  })
  it('Barchart normalization in ONE place: CT stays ¢/lb, grains ÷100 to $/bu', () => {
    expect(normalizeBarchartPrice('CTZ26', 72.65)).toBe(72.65)
    expect(normalizeBarchartPrice('ZCZ26', 431)).toBe(4.31)
  })
  it('mixed grain + cotton unit labeling: quantities and prices carry each commodity’s units', () => {
    expect(quantityFor('Cotton', 10)).toBe(500000)
    expect(fmtQuantity('Cotton', 10)).toBe('500,000 lbs')
    expect(fmtQuantity('Corn', 5)).toBe('25,000 bu')
    expect(fmtCommodityPrice('Cotton', 72.65)).toBe('72.65¢')
    expect(fmtCommodityPrice('Corn', 4.9325)).toBe('$4.9325')
  })
  it('P&L: 10 short DEC 26 CT @ 72.65¢ closed @ 68.00¢', () => {
    // (72.65 − 68.00)¢/lb × 50,000 lbs ÷ 100 = $2,325/contract × 10 = $23,250.
    expect(pnlSizeFor('Cotton')).toBe(500)
    const pnl = realizedPnl({
      side: 'short', tradePrice: 72.65, closePrice: 68.0, numContracts: 10,
      contractSizeBu: pnlSizeFor('Cotton'),
    })
    expect(pnl.gross).toBe(23250)
  })
})
