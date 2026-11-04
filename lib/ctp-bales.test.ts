import { describe, expect, it } from 'vitest'
import {
  buildCtpRows, chunk, ctpBaleKey, ctpCropYearOk, ctpCsv, ctpFileName, ctpFixedWidth, ctpGinCode, ctpGinTag,
  ctpInquiryBale, ctpProtocolId, ctpRegenProgram, ctpRowReady, ctpRowState, ctpUploadBale, ctpWeight,
  readInquiryResponse, readProducers, readUploadResponse, receiptEntity, summarizeCtpRows,
} from './ctp-bales'
import type { CottonBale, CtpBaleRegistration, Entity, Gin, GinReceipt } from './types'

const entity = (id: string, name: string, pid: string | null): Entity =>
  ({ id, name, notes: null, payment_limit_persons: 1, ctp_protocol_id: pid }) as Entity
const gin = (id: string, name: string, code: string | null): Gin => ({ id, name, address: null, phone: null, notes: null, gin_code: code })
const receipt = (id: string, p: Partial<GinReceipt>): GinReceipt =>
  ({ id, gin_id: null, receipt_number: `R-${id}`, receipt_date: null, entity_id: null, farm_id: null, field_id: null, crop_year: 2026, ...p }) as GinReceipt
const bale = (id: string, pbi: string, lbs: number, receiptId = 'r1', year = 2026): CottonBale =>
  ({ id, gin_receipt_id: receiptId, crop_year: year, pbi_number: pbi, net_weight_lbs: lbs, created_at: '' })
const reg = (bale_id: string, p: Partial<CtpBaleRegistration>): CtpBaleRegistration =>
  ({ id: `reg-${bale_id}`, bale_id, upload_id: null, crop_year: 2026, action: 'register', gin_code: '40614', gin_tag: '0179122', protocol_id: 'ABCD1234', weight: 500, regen_program: null, sent_at: null, registration_status: null, shipment_status: null, ctp_weight: null, ctp_protocol_id: null, ctp_regen_program: null, ctp_upload_date: null, inquiry_error: null, checked_at: null, updated_at: '', ...p })

const TODAY = new Date('2026-11-04T12:00:00')

describe('field normalizers', () => {
  it('gin code pads to five digits and refuses anything longer', () => {
    expect(ctpGinCode('40614')).toBe('40614')
    expect(ctpGinCode(7128)).toBe('07128')
    expect(ctpGinCode('Gin 40614')).toBe('40614')
    expect(ctpGinCode('406140179122')).toBeNull()
    expect(ctpGinCode('')).toBeNull()
    expect(ctpGinCode(null)).toBeNull()
  })

  it('gin tag: a bale number pads to seven digits; a 12-digit tag drops the gin prefix only when it matches', () => {
    expect(ctpGinTag('179122', '40614')).toEqual({ tag: '0179122', problem: null })
    expect(ctpGinTag('0179122', null)).toEqual({ tag: '0179122', problem: null })
    expect(ctpGinTag('406140179122', '40614')).toEqual({ tag: '0179122', problem: null })
    expect(ctpGinTag('406140179122', null)).toEqual({ tag: '0179122', problem: null })
    expect(ctpGinTag('406140179122', '07128').tag).toBeNull()
    expect(ctpGinTag('406140179122', '07128').problem).toMatch(/starts with gin code 40614/)
    expect(ctpGinTag('12345678', '40614').tag).toBeNull()
    expect(ctpGinTag('', '40614').problem).toMatch(/no PBI/)
  })

  it('protocol id, weight, crop year, program code', () => {
    expect(ctpProtocolId(' abcd1234 ')).toBe('ABCD1234')
    expect(ctpProtocolId('ABC')).toBeNull()
    expect(ctpProtocolId(null)).toBeNull()
    expect(ctpWeight(509.4)).toBe(509)
    expect(ctpWeight('499.6')).toBe(500)
    expect(ctpWeight(999.4)).toBe(999)
    expect(ctpWeight(999.6)).toBeNull()
    expect(ctpWeight(0)).toBeNull()
    expect(ctpWeight(null)).toBeNull()
    expect(ctpCropYearOk(2026, TODAY)).toBe(true)
    expect(ctpCropYearOk(2024, TODAY)).toBe(true)
    expect(ctpCropYearOk(2023, TODAY)).toBe(false)
    expect(ctpCropYearOk(2027, TODAY)).toBe(false)
    expect(ctpRegenProgram(' regen26 ')).toBe('REGEN26')
    expect(ctpRegenProgram('')).toBeNull()
    expect(ctpRegenProgram('ELEVENCHARS')).toBeNull()
  })
})

describe('buildCtpRows', () => {
  const entities = [entity('e1', 'Martin Farm', 'MF123456'), entity('e2', 'Two Seasons', null)]
  const gins = [gin('g1', 'Servico', '40614'), gin('g2', 'Other Gin', null)]
  const receipts = [
    receipt('r1', { gin_id: 'g1', entity_id: 'e1', gin_code: '40614', statement_number: 'S-100' }),
    receipt('r2', { gin_id: 'g2', farm_id: 'f2' }),          // gin without a code, entity through the farm
    receipt('r3', { gin_id: 'g1', entity_id: 'e2', gin_code: null }), // gin's code, entity without a Protocol ID
  ]
  const farms = [{ id: 'f2', entity_id: 'e1' }]

  it('resolves gin code, tag, producer and weight, and names every problem', () => {
    const rows = buildCtpRows({
      bales: [
        bale('b1', '179122', 509.4),
        bale('b2', '406140179123', 487),
        bale('b3', '179124', 1004, 'r1'),
        bale('b4', '179125', 500, 'r2'),
        bale('b5', '179126', 500, 'r3'),
        bale('b6', '179127', 500, 'r1', 2023),
        bale('b7', '179128', 500, 'missing'),
      ],
      receipts, gins, farms, entities, registrations: [], today: TODAY,
    })
    const by = new Map(rows.map((r) => [r.baleId, r]))
    expect(by.get('b1')).toMatchObject({ ginCode: '40614', ginTag: '0179122', protocolId: 'MF123456', weight: 509, entityName: 'Martin Farm', ginName: 'Servico', receiptNumber: 'S-100', problems: [] })
    expect(by.get('b2')).toMatchObject({ ginTag: '0179123', weight: 487, problems: [] })
    expect(by.get('b3')!.problems).toEqual([expect.stringMatching(/1,004 lbs is outside 1–999/)])
    // r2: Other Gin has no code and the PBI is a bare bale number → no gin code; the entity comes through the farm.
    expect(by.get('b4')).toMatchObject({ ginCode: null, entityName: 'Martin Farm', protocolId: 'MF123456' })
    expect(by.get('b4')!.problems).toEqual([expect.stringMatching(/Other Gin has no USDA gin code/)])
    // r3: the receipt has no printed code but the gin does; Two Seasons has no Protocol ID.
    expect(by.get('b5')).toMatchObject({ ginCode: '40614', ginTag: '0179126', protocolId: null })
    expect(by.get('b5')!.problems).toEqual(['Two Seasons has no Protocol ID yet.'])
    expect(by.get('b6')!.problems).toEqual([expect.stringMatching(/Crop year 2023/)])
    expect(by.get('b7')!.problems[0]).toMatch(/gin receipt is missing/)
    expect(rows.filter(ctpRowReady).map((r) => r.baleId)).toEqual(['b1', 'b2'])
  })

  it('a 12-digit tag supplies the gin code when the receipt and gin have none', () => {
    const [row] = buildCtpRows({ bales: [bale('b', '071280179122', 500, 'r2')], receipts, gins, farms, entities, registrations: [], today: TODAY })
    expect(row).toMatchObject({ ginCode: '07128', ginTag: '0179122', problems: [] })
  })

  it('the only live entity stands in when a receipt names none', () => {
    const one = [entity('e1', 'Martin Farm', 'MF123456'), { ...entity('e9', 'Old', null), archived_at: '2025-01-01' }]
    expect(receiptEntity(receipt('x', {}), new Map(), one)?.id).toBe('e1')
    expect(receiptEntity(receipt('x', {}), new Map(), entities)).toBeNull()
  })

  it('carries the registration row and reads its state', () => {
    const [row] = buildCtpRows({ bales: [bale('b1', '179122', 509)], receipts, gins, farms, entities, registrations: [reg('b1', { sent_at: '2026-11-04T00:00:00Z' })], today: TODAY })
    expect(row.registration?.bale_id).toBe('b1')
    expect(ctpRowState(row.registration)).toBe('sent')
  })
})

describe('ctpRowState', () => {
  it('reads the Protocol’s status first, then what was sent', () => {
    expect(ctpRowState(null)).toBe('not_sent')
    expect(ctpRowState(reg('b', {}))).toBe('not_sent')
    expect(ctpRowState(reg('b', { sent_at: 'x' }))).toBe('sent')
    expect(ctpRowState(reg('b', { sent_at: 'x', action: 'remove' }))).toBe('removed')
    expect(ctpRowState(reg('b', { sent_at: 'x', checked_at: 'y', registration_status: 'Verified' }))).toBe('registered')
    expect(ctpRowState(reg('b', { sent_at: 'x', checked_at: 'y', registration_status: 'Pending' }))).toBe('pending')
    expect(ctpRowState(reg('b', { sent_at: 'x', checked_at: 'y', registration_status: 'Rejected' }))).toBe('error')
    expect(ctpRowState(reg('b', { sent_at: 'x', checked_at: 'y', inquiry_error: 'Gin Code/Gin Tag was not found' }))).toBe('error')
    // Found by an inquiry without Turnrow ever sending it (the gin registered it).
    expect(ctpRowState(reg('b', { action: 'inquiry', checked_at: 'y', registration_status: 'Registered' }))).toBe('registered')
  })
})

describe('payloads and files', () => {
  const entities = [entity('e1', 'Martin Farm', 'MF123456')]
  const gins = [gin('g1', 'Servico', '40614')]
  const receipts = [receipt('r1', { gin_id: 'g1', entity_id: 'e1' })]
  const rows = buildCtpRows({ bales: [bale('b1', '179122', 509.4), bale('b2', '0179123', 487)], receipts, gins, farms: [], entities, registrations: [], today: TODAY })

  it('upload bale object, with and without the program', () => {
    expect(ctpUploadBale(rows[0], 'REGEN26')).toEqual({ ginCode: '40614', ginTag: '0179122', cropYear: 2026, protocolId: 'MF123456', weight: 509, regenProgram: 'REGEN26' })
    expect(ctpUploadBale(rows[0], null).regenProgram).toBeNull()
    expect(ctpInquiryBale(rows[1])).toEqual({ ginCode: '40614', ginTag: '0179123', cropYear: 2026 })
    const blocked = buildCtpRows({ bales: [bale('b3', '179124', 1200)], receipts, gins, farms: [], entities, registrations: [], today: TODAY })[0]
    expect(() => ctpUploadBale(blocked, null)).toThrow(/not ready/)
  })

  it('CSV matches the Protocol template; fixed width is 27 or up to 37 characters', () => {
    expect(ctpCsv(rows, 'regen26')).toBe('ProtocolId,GinCode,GinTag,CropYear,BaleWeight,RegenProgram\r\nMF123456,40614,0179122,2026,509,REGEN26\r\nMF123456,40614,0179123,2026,487,REGEN26\r\n')
    expect(ctpCsv(rows, null).split('\r\n')[1]).toBe('MF123456,40614,0179122,2026,509,')
    const txt = ctpFixedWidth(rows, null).split('\r\n')
    expect(txt[0]).toBe('MF1234564061401791222026509') // 8+5+7+4+3
    expect(txt[0]).toHaveLength(27)
    expect(ctpFixedWidth(rows, 'REGEN26').split('\r\n')[0]).toBe('MF1234564061401791222026509REGEN26')
    expect(ctpFixedWidth(rows, 'REGEN26').split('\r\n')[0]).toHaveLength(34)
    expect(ctpFixedWidth([], null)).toBe('')
    expect(ctpFileName(2026, 'csv')).toBe('reg_2026.csv')
  })

  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
  })
})

describe('responses', () => {
  it('reads the upload answer, including a 422 string body', () => {
    expect(readUploadResponse({ uploadId: 812, hasErrors: false, error: null, bales: 2 }, 200)).toEqual({ uploadId: 812, hasErrors: false, error: null, bales: 2 })
    expect(readUploadResponse({ uploadId: 0, hasErrors: true, error: 'Invalid API key', bales: 0 }, 422)).toMatchObject({ uploadId: 0, hasErrors: true, error: 'Invalid API key' })
    expect(readUploadResponse('Unauthorized', 401)).toMatchObject({ hasErrors: true, error: 'Unauthorized' })
    expect(readUploadResponse(null, 500).error).toMatch(/status 500/)
  })

  it('keys inquiry answers back to rows even though the response carries integers', () => {
    const { byKey, errorsByKey, message } = readInquiryResponse({
      inquiryBaleResponses: [{ ginCode: 40614, ginTag: 179122, cropYear: 2026, weight: 509, producerProtocolId: 'MF123456', registrationStatus: 'Verified', regenProgram: 'REGEN26' }],
      inquiryBaleErrors: [{ lineNumber: 2, errorMessage: 'Gin Code/Gin Tag was not found in the USDA Classing Database.', ginCode: '40614', ginTag: '0179123', cropYear: 2026 }],
      hasErrors: true, message: null,
    })
    expect(byKey.get(ctpBaleKey('40614', '0179122', 2026))?.registrationStatus).toBe('Verified')
    expect(errorsByKey.get(ctpBaleKey('40614', '0179123', 2026))).toMatch(/not found/)
    expect(message).toBeNull()
  })

  it('reads producers', () => {
    const list = readProducers({ cropYear: 2026, producers: [
      { firstName: 'Larkin', lastName: 'Martin', protocolId: 'mf123456', uploadEligible: 'Yes', enrollmentStatus: 'Complete', gins: [{ ginCode: '40614', name: 'Servico' }], fppEligible: 'Yes', fppRegenProgram: 'REGEN26', entities: ['Martin Farm'] },
      { protocolId: 'XY999999', entities: ['Two Seasons LLC'] },
      { protocolId: '' },
    ] })
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ protocolId: 'MF123456', name: 'Larkin Martin', uploadEligible: 'Yes', fppRegenProgram: 'REGEN26', gins: [{ ginCode: '40614', name: 'Servico' }] })
    expect(list[1]).toMatchObject({ protocolId: 'XY999999', name: 'Two Seasons LLC' })
  })
})

describe('summary', () => {
  it('counts states and Regen designations', () => {
    const entities = [entity('e1', 'Martin Farm', 'MF123456')]
    const gins = [gin('g1', 'Servico', '40614')]
    const receipts = [receipt('r1', { gin_id: 'g1', entity_id: 'e1' })]
    const rows = buildCtpRows({
      bales: [bale('b1', '1', 500), bale('b2', '2', 500), bale('b3', '3', 500), bale('b4', '4', 500), bale('b5', '5', 1500)],
      receipts, gins, farms: [], entities, today: TODAY,
      registrations: [
        reg('b1', { sent_at: 'x', regen_program: 'REGEN26' }),
        reg('b2', { sent_at: 'x', checked_at: 'y', registration_status: 'Verified', ctp_regen_program: 'REGEN26' }),
        reg('b3', { sent_at: 'x', checked_at: 'y', registration_status: 'Verified', ctp_regen_program: null }),
      ],
    })
    expect(summarizeCtpRows(rows)).toEqual({ total: 5, ready: 1, blocked: 1, sent: 1, registered: 2, pending: 0, errors: 0, regen: 2 })
  })
})
