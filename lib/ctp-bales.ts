// U.S. Cotton Trust Protocol bale registration (0102) — the ONE place a
// Turnrow bale becomes a Protocol registration record. Pure: the page and the
// server routes pass already-fetched rows in; nothing here touches the
// network or the database.
//
// What the Protocol wants per bale (The Seam's Partners API, and the same
// fields in its .csv / fixed-width .txt bulk files):
//   protocolId  the producer's 8-character Protocol ID  → entities.ctp_protocol_id
//   ginCode     the 5-digit USDA gin code               → the receipt's gin code, else the gin's
//   ginTag      the 7-digit bale number the gin assigned → cotton_bales.pbi_number
//   cropYear    the crop year the bale was ginned        → cotton_bales.crop_year
//   weight      lbs, whole, under 1,000                  → cotton_bales.net_weight_lbs
//   regenProgram (optional) the Field Partner's program code → ctp_settings.regen_program
//
// PBI numbers come in two shapes (lib/number-key): the 7-digit bale number a
// gin prints ("0179122", often without its leading zeros) or the full 12-digit
// tag (gin code + bale number). Both resolve here through the gin code.

import type { CottonBale, CtpBaleRegistration, Entity, Farm, Gin, GinReceipt } from '@/lib/types'
import { GIN_CODE_DIGITS, PBI_FULL_DIGITS } from '@/lib/number-key'

export const CTP_API_BASE = 'https://api.trustuscotton.org'
export const CTP_PLATFORM_URL = 'https://platform.trustuscotton.org'
export const CTP_GIN_TAG_DIGITS = 7
export const CTP_PROTOCOL_ID_LENGTH = 8
export const CTP_MAX_WEIGHT = 999
export const CTP_REGEN_PROGRAM_MAX = 10
/** Bales per API call. The platform's own file limit is 10 MB; one thousand
 *  27-byte records is a comfortable, resumable batch. */
export const CTP_BATCH_SIZE = 1000
/** Bales per inquiry call (the response carries ~15 fields per bale). */
export const CTP_INQUIRY_BATCH_SIZE = 500

const digitsOf = (raw: string | number | null | undefined) => (raw == null ? '' : String(raw).replace(/\D/g, ''))

/** The 5-digit USDA gin code, zero-padded; null when the value is not 1–5 digits. */
export function ctpGinCode(raw: string | number | null | undefined): string | null {
  const d = digitsOf(raw)
  if (!d || d.length > GIN_CODE_DIGITS) return null
  return d.padStart(GIN_CODE_DIGITS, '0')
}

/**
 * The 7-digit gin tag for a PBI. A full 12-digit tag drops its gin-code
 * prefix (and names a mismatch when a gin code is known and differs); a bale
 * number of up to 7 digits is zero-padded. Anything else is unusable.
 */
export function ctpGinTag(pbi: string | null | undefined, ginCode: string | null | undefined): { tag: string | null; problem: string | null } {
  const d = digitsOf(pbi)
  if (!d) return { tag: null, problem: 'The bale has no PBI number.' }
  if (d.length === PBI_FULL_DIGITS) {
    const prefix = d.slice(0, GIN_CODE_DIGITS)
    const gin = ctpGinCode(ginCode)
    if (gin && gin !== prefix) return { tag: null, problem: `The PBI tag starts with gin code ${prefix} but the receipt's gin is ${gin}.` }
    return { tag: d.slice(GIN_CODE_DIGITS), problem: null }
  }
  if (d.length <= CTP_GIN_TAG_DIGITS) return { tag: d.padStart(CTP_GIN_TAG_DIGITS, '0'), problem: null }
  return { tag: null, problem: `The PBI number ${pbi} is ${d.length} digits — the Protocol expects a 7-digit bale number or the 12-digit tag.` }
}

/** Trimmed, upper-cased; null unless exactly 8 letters or digits. */
export function ctpProtocolId(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase()
  return /^[A-Z0-9]{8}$/.test(s) ? s : null
}

/** Whole pounds; null outside 1–999. */
export function ctpWeight(lbs: number | string | null | undefined): number | null {
  const n = Math.round(Number(lbs))
  return Number.isFinite(n) && n >= 1 && n <= CTP_MAX_WEIGHT ? n : null
}

/** The crop years the Protocol accepts: the current one and the two before it. */
export function ctpCropYearOk(cropYear: number, today = new Date()): boolean {
  const current = today.getFullYear()
  return cropYear <= current && cropYear >= current - 2
}

/** A program code as the Protocol stores it: trimmed, upper-cased, ≤ 10 characters; null when blank. */
export function ctpRegenProgram(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase()
  if (!s) return null
  return s.length <= CTP_REGEN_PROGRAM_MAX ? s : null
}

// ---------- Rows ----------

export type CtpBaleRow = {
  baleId: string
  pbi: string
  cropYear: number
  /** The receipt (and its gin / farm / entity) the bale came from. */
  receiptId: string
  receiptNumber: string | null
  ginId: string | null
  ginName: string | null
  entityId: string | null
  entityName: string | null
  /** The record as the Protocol will receive it — null parts are problems. */
  ginCode: string | null
  ginTag: string | null
  protocolId: string | null
  weight: number | null
  /** Why the bale cannot be sent yet (empty = ready). */
  problems: string[]
  /** What Turnrow last sent / last heard, when anything. */
  registration: CtpBaleRegistration | null
}

/** The receipt columns the registration needs (the routes select only these). */
export type CtpReceiptLite = Pick<GinReceipt, 'id' | 'gin_id' | 'entity_id' | 'farm_id' | 'receipt_number' | 'gin_code' | 'statement_number'>

export type CtpRowInputs = {
  bales: readonly CottonBale[]
  receipts: readonly CtpReceiptLite[]
  gins: readonly Gin[]
  farms: readonly Pick<Farm, 'id' | 'entity_id'>[]
  entities: readonly Entity[]
  registrations: readonly CtpBaleRegistration[]
  today?: Date
}

/** The entity behind a receipt: its own, else its farm's, else the only entity there is. */
export function receiptEntity(
  receipt: Pick<GinReceipt, 'entity_id' | 'farm_id'> | undefined,
  farmById: ReadonlyMap<string, Pick<Farm, 'id' | 'entity_id'>>,
  entities: readonly Entity[],
): Entity | null {
  const byId = new Map(entities.map((e) => [e.id, e]))
  if (receipt?.entity_id && byId.has(receipt.entity_id)) return byId.get(receipt.entity_id)!
  const farmEntity = receipt?.farm_id ? farmById.get(receipt.farm_id)?.entity_id : null
  if (farmEntity && byId.has(farmEntity)) return byId.get(farmEntity)!
  const live = entities.filter((e) => !e.archived_at)
  return live.length === 1 ? live[0] : null
}

/**
 * Every bale as a Protocol record, with the problems that keep it from being
 * sent. Order follows the input bales.
 */
export function buildCtpRows(inputs: CtpRowInputs): CtpBaleRow[] {
  const receiptById = new Map(inputs.receipts.map((r) => [r.id, r]))
  const ginById = new Map(inputs.gins.map((g) => [g.id, g]))
  const farmById = new Map(inputs.farms.map((f) => [f.id, f]))
  const regByBale = new Map(inputs.registrations.map((r) => [r.bale_id, r]))
  const today = inputs.today ?? new Date()
  return inputs.bales.map((b) => {
    const receipt = receiptById.get(b.gin_receipt_id)
    const gin = receipt?.gin_id ? ginById.get(receipt.gin_id) : undefined
    const entity = receiptEntity(receipt, farmById, inputs.entities)
    const problems: string[] = []
    if (!receipt) problems.push('The bale’s gin receipt is missing.')
    const ginCodeRaw = receipt?.gin_code || gin?.gin_code || null
    let ginCode = ctpGinCode(ginCodeRaw)
    const tagged = ctpGinTag(b.pbi_number, ginCode)
    // A full 12-digit tag names its own gin when nothing else does.
    if (!ginCode && digitsOf(b.pbi_number).length === PBI_FULL_DIGITS) ginCode = digitsOf(b.pbi_number).slice(0, GIN_CODE_DIGITS)
    if (!ginCode) problems.push(gin ? `${gin.name} has no USDA gin code — add it on the gin receipt or under the gin.` : 'No gin code: the receipt names no gin.')
    if (tagged.problem) problems.push(tagged.problem)
    const protocolId = ctpProtocolId(entity?.ctp_protocol_id)
    if (!entity) problems.push('No entity: the gin receipt has no entity or farm to say whose cotton this is.')
    else if (!protocolId) problems.push(`${entity.name} has no Protocol ID yet.`)
    const weight = ctpWeight(b.net_weight_lbs)
    if (weight == null) problems.push(`Weight ${Number(b.net_weight_lbs).toLocaleString()} lbs is outside 1–999 — the Protocol refuses it.`)
    if (!ctpCropYearOk(b.crop_year, today)) problems.push(`Crop year ${b.crop_year} is outside the three years the Protocol accepts.`)
    return {
      baleId: b.id,
      pbi: b.pbi_number,
      cropYear: b.crop_year,
      receiptId: b.gin_receipt_id,
      receiptNumber: receipt?.statement_number ?? receipt?.receipt_number ?? null,
      ginId: gin?.id ?? null,
      ginName: gin?.name ?? null,
      entityId: entity?.id ?? null,
      entityName: entity?.name ?? null,
      ginCode,
      ginTag: tagged.tag,
      protocolId,
      weight,
      problems,
      registration: regByBale.get(b.id) ?? null,
    }
  })
}

/** A row the Protocol would accept as a record. */
export const ctpRowReady = (r: CtpBaleRow): boolean => r.problems.length === 0

// ---------- Status ----------

export type CtpRowState = 'not_sent' | 'sent' | 'registered' | 'pending' | 'error' | 'removed'

/**
 * Where a bale stands with the Protocol, from its registration row:
 *   not_sent   — never sent, never found there;
 *   sent       — sent, no status check since (the inline answer only says the
 *                upload was accepted; validation happens on their side);
 *   registered — the last inquiry reported it registered / verified;
 *   pending    — the inquiry reported a pending status (e.g. the producer is
 *                not yet associated with the uploading member);
 *   error      — the inquiry returned an error for the bale, or the upload
 *                itself failed;
 *   removed    — a removal correction was sent.
 */
export function ctpRowState(reg: CtpBaleRegistration | null | undefined): CtpRowState {
  if (!reg) return 'not_sent'
  if (reg.inquiry_error) return 'error'
  const status = (reg.registration_status ?? '').trim().toLowerCase()
  if (status) {
    if (/pend/.test(status)) return 'pending'
    if (/error|reject|invalid|fail/.test(status)) return 'error'
    return 'registered'
  }
  if (reg.action === 'remove') return 'removed'
  if (reg.sent_at) return 'sent'
  return 'not_sent'
}

export const CTP_STATE_LABEL: Record<CtpRowState, string> = {
  not_sent: 'Not sent',
  sent: 'Sent · awaiting check',
  registered: 'Registered',
  pending: 'Pending at the Protocol',
  error: 'Needs attention',
  removed: 'Removed',
}

/** The Regen designation the Protocol last reported, or what was sent. */
export function ctpRowRegen(reg: CtpBaleRegistration | null | undefined): string | null {
  if (!reg) return null
  return reg.checked_at ? (reg.ctp_regen_program ?? null) : (reg.regen_program ?? null)
}

// ---------- Payloads ----------

export type CtpUploadBale = { ginCode: string; ginTag: string; cropYear: number; protocolId: string; weight: number; regenProgram: string | null }
export type CtpCorrectedBale = CtpUploadBale & { correctionAction: 'C' | 'R' }
export type CtpInquiryBale = { ginCode: string; ginTag: string; cropYear: number }

/** The API's bale object for a ready row (throws on an unready one — callers filter first). */
export function ctpUploadBale(row: CtpBaleRow, regenProgram: string | null): CtpUploadBale {
  if (!ctpRowReady(row) || !row.ginCode || !row.ginTag || !row.protocolId || row.weight == null) {
    throw new Error(`Bale ${row.pbi} is not ready to send: ${row.problems.join(' ')}`)
  }
  return { ginCode: row.ginCode, ginTag: row.ginTag, cropYear: row.cropYear, protocolId: row.protocolId, weight: row.weight, regenProgram: ctpRegenProgram(regenProgram) }
}

export function ctpCorrectedBale(row: CtpBaleRow, regenProgram: string | null, action: 'C' | 'R'): CtpCorrectedBale {
  return { ...ctpUploadBale(row, regenProgram), correctionAction: action }
}

export function ctpInquiryBale(row: Pick<CtpBaleRow, 'ginCode' | 'ginTag' | 'cropYear'>): CtpInquiryBale | null {
  if (!row.ginCode || !row.ginTag) return null
  return { ginCode: row.ginCode, ginTag: row.ginTag, cropYear: row.cropYear }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------- Bulk files (the platform's "Upload Grower Bales" route) ----------

export const CTP_CSV_HEADER = ['ProtocolId', 'GinCode', 'GinTag', 'CropYear', 'BaleWeight', 'RegenProgram'] as const

/** The Protocol's CSV template: header row, one bale per row, CRLF, ASCII. */
export function ctpCsv(rows: readonly CtpBaleRow[], regenProgram: string | null): string {
  const program = ctpRegenProgram(regenProgram) ?? ''
  const lines = [CTP_CSV_HEADER.join(',')]
  for (const r of rows) {
    const b = ctpUploadBale(r, program)
    lines.push([b.protocolId, b.ginCode, b.ginTag, String(b.cropYear), String(b.weight), b.regenProgram ?? ''].join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** The fixed-width .txt record: 8 + 5 + 7 + 4 + 3 characters (27), plus the program code (up to 37). */
export function ctpFixedWidth(rows: readonly CtpBaleRow[], regenProgram: string | null): string {
  const program = ctpRegenProgram(regenProgram) ?? ''
  return rows.map((r) => {
    const b = ctpUploadBale(r, program)
    return `${b.protocolId}${b.ginCode}${b.ginTag}${String(b.cropYear).padStart(4, '0')}${String(b.weight).padStart(3, '0')}${b.regenProgram ?? ''}`
  }).join('\r\n') + (rows.length ? '\r\n' : '')
}

/** Files uploaded through the Protocol's FTP must start with "reg". */
export const ctpFileName = (cropYear: number, ext: 'csv' | 'txt') => `reg_${cropYear}.${ext}`

// ---------- Responses ----------

export type CtpUploadResponse = { uploadId: number; hasErrors: boolean; error: string | null; bales: number }
export type CtpInquiryResponseBale = {
  ginCode: number | string
  ginTag: number | string
  cropYear: number
  weight: number | null
  producerProtocolId: string | null
  registrationStatus: string | null
  shipmentStatus: string | null
  uploadDate: string | null
  pendingResolutionDate: string | null
  shipmentDate: string | null
  shipmentProtocolId: string | null
  shipmentId: number | null
  regenProgram: string | null
}
export type CtpInquiryError = { lineNumber: number; errorMessage: string | null; ginCode: string | null; ginTag: string; cropYear: number }
export type CtpInquiryResponse = { inquiryBaleResponses: CtpInquiryResponseBale[] | null; inquiryBaleErrors: CtpInquiryError[] | null; hasErrors: boolean; message: string | null }

/** The key an inquiry answer is matched back on — the response carries the gin code and tag as integers. */
export const ctpBaleKey = (ginCode: string | number | null | undefined, ginTag: string | number | null | undefined, cropYear: number) =>
  `${ctpGinCode(ginCode) ?? '?'}-${digitsOf(ginTag).padStart(CTP_GIN_TAG_DIGITS, '0')}-${cropYear}`

/** The upload response read defensively (a 422 carries the same shape). */
export function readUploadResponse(json: unknown, httpStatus: number): CtpUploadResponse {
  const o = (json ?? {}) as Partial<CtpUploadResponse> & { title?: string; detail?: string }
  const error = typeof o.error === 'string' && o.error.trim() ? o.error.trim()
    : typeof json === 'string' && json.trim() ? json.trim()
    : o.title || o.detail || (httpStatus >= 400 ? `The Protocol answered with status ${httpStatus}.` : null)
  return {
    uploadId: Number(o.uploadId ?? 0) || 0,
    hasErrors: Boolean(o.hasErrors) || httpStatus >= 400,
    error: error ?? null,
    bales: Number(o.bales ?? 0) || 0,
  }
}

/** The inquiry's answers and errors keyed for the rows that asked. */
export function readInquiryResponse(json: unknown): { byKey: Map<string, CtpInquiryResponseBale>; errorsByKey: Map<string, string>; message: string | null } {
  const o = (json ?? {}) as Partial<CtpInquiryResponse>
  const byKey = new Map<string, CtpInquiryResponseBale>()
  for (const b of o.inquiryBaleResponses ?? []) byKey.set(ctpBaleKey(b.ginCode, b.ginTag, b.cropYear), b)
  const errorsByKey = new Map<string, string>()
  for (const e of o.inquiryBaleErrors ?? []) errorsByKey.set(ctpBaleKey(e.ginCode, e.ginTag, e.cropYear), e.errorMessage || 'The Protocol could not read this bale.')
  return { byKey, errorsByKey, message: o.message ?? null }
}

// ---------- Producers (getProducers) ----------

export type CtpProducer = {
  protocolId: string
  name: string
  enrollmentStatus: string | null
  uploadEligible: string | null
  gins: Array<{ ginCode: string | null; name: string | null }>
  fppEligible: string | null
  fppRegenProgram: string | null
}

export function readProducers(json: unknown): CtpProducer[] {
  const o = (json ?? {}) as { producers?: Array<Record<string, unknown>> | null }
  return (o.producers ?? []).map((p) => {
    const first = typeof p.firstName === 'string' ? p.firstName.trim() : ''
    const last = typeof p.lastName === 'string' ? p.lastName.trim() : ''
    const entities = Array.isArray(p.entities) ? (p.entities as unknown[]).filter((e): e is string => typeof e === 'string') : []
    return {
      protocolId: String(p.protocolId ?? '').trim().toUpperCase(),
      name: [first, last].filter(Boolean).join(' ') || entities[0] || String(p.protocolId ?? ''),
      enrollmentStatus: (p.enrollmentStatus as string | null) ?? null,
      uploadEligible: (p.uploadEligible as string | null) ?? null,
      gins: Array.isArray(p.gins) ? (p.gins as Array<Record<string, unknown>>).map((g) => ({ ginCode: (g.ginCode as string | null) ?? null, name: (g.name as string | null) ?? null })) : [],
      fppEligible: (p.fppEligible as string | null) ?? null,
      fppRegenProgram: (p.fppRegenProgram as string | null) ?? null,
    }
  }).filter((p) => p.protocolId)
}

// ---------- Summary ----------

export type CtpSummary = { total: number; ready: number; blocked: number; sent: number; registered: number; pending: number; errors: number; regen: number }

export function summarizeCtpRows(rows: readonly CtpBaleRow[]): CtpSummary {
  const s: CtpSummary = { total: rows.length, ready: 0, blocked: 0, sent: 0, registered: 0, pending: 0, errors: 0, regen: 0 }
  for (const r of rows) {
    const state = ctpRowState(r.registration)
    if (state === 'not_sent') { if (ctpRowReady(r)) s.ready += 1; else s.blocked += 1 }
    else if (state === 'sent') s.sent += 1
    else if (state === 'registered') s.registered += 1
    else if (state === 'pending') s.pending += 1
    else if (state === 'error') s.errors += 1
    if (state !== 'not_sent' && state !== 'removed' && ctpRowRegen(r.registration)) s.regen += 1
  }
  return s
}
