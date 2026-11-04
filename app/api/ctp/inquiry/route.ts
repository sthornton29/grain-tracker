// POST /api/ctp/inquiry — ask the U.S. Cotton Trust Protocol where bales
// stand (baleInquiry) and record the answer on each bale's registration row.
// The upload call only acknowledges receipt; validation ("gin tag not in the
// USDA classing database", "producer not associated with the uploader", the
// Regen designation) shows up here. A bale the Protocol knows that Turnrow
// never sent (the gin or a merchant registered it) gets a row too, marked
// 'inquiry', so the page can say so.
//
// Body: { crop_year: number, bale_ids?: string[] }  — no ids = every bale of the year that has a gin code and tag.

import { NextRequest, NextResponse } from 'next/server'
import { ctpCall, ctpContext, ctpFailureMessage, ctpKeyMissingResponse, readCropYear, readIdList } from '@/lib/ctp-server'
import { fetchAll } from '@/lib/partner-api-server'
import { CTP_INQUIRY_BATCH_SIZE, buildCtpRows, chunk, ctpBaleKey, ctpInquiryBale, readInquiryResponse, type CtpReceiptLite } from '@/lib/ctp-bales'
import type { CottonBale, CtpBaleRegistration, Entity, Farm, Gin } from '@/lib/types'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const ctx = await ctpContext()
  if (ctx instanceof NextResponse) return ctx
  if (!ctx.apiKey) return ctpKeyMissingResponse()
  const body = ((await req.json().catch(() => null)) ?? {}) as { crop_year?: unknown; bale_ids?: unknown }
  const cropYear = readCropYear(body.crop_year)
  if (!cropYear) return NextResponse.json({ error: 'Choose a crop year.' }, { status: 400 })
  const onlyIds = readIdList(body.bale_ids)
  const { service, orgId } = ctx

  let bales: CottonBale[]
  let receipts: CtpReceiptLite[]
  let gins: Gin[]
  let farms: Pick<Farm, 'id' | 'entity_id'>[]
  let entities: Entity[]
  let registrations: CtpBaleRegistration[]
  try {
    const baleSelect = 'id, gin_receipt_id, crop_year, pbi_number, net_weight_lbs, created_at'
    bales = onlyIds.length
      ? (await Promise.all(chunk(onlyIds, 200).map((ids) =>
          fetchAll<CottonBale>((f, t) => service.from('cotton_bales').select(baleSelect).eq('org_id', orgId).eq('crop_year', cropYear).in('id', ids).order('id').range(f, t)),
        ))).flat()
      : await fetchAll<CottonBale>((f, t) => service.from('cotton_bales').select(baleSelect).eq('org_id', orgId).eq('crop_year', cropYear).order('id').range(f, t))
    ;[receipts, gins, farms, entities, registrations] = await Promise.all([
      fetchAll<CtpReceiptLite>((f, t) => service.from('gin_receipts').select('id, gin_id, receipt_number, receipt_date, entity_id, farm_id, field_id, crop_year, gin_code, statement_number').eq('org_id', orgId).eq('crop_year', cropYear).order('id').range(f, t)),
      fetchAll<Gin>((f, t) => service.from('gins').select('id, name, address, phone, notes, gin_code').eq('org_id', orgId).order('id').range(f, t)),
      fetchAll<Pick<Farm, 'id' | 'entity_id'>>((f, t) => service.from('farms').select('id, entity_id').eq('org_id', orgId).order('id').range(f, t)),
      fetchAll<Entity>((f, t) => service.from('entities').select('id, name, notes, payment_limit_persons, entity_role, archived_at, ctp_protocol_id').eq('org_id', orgId).order('id').range(f, t)),
      fetchAll<CtpBaleRegistration>((f, t) => service.from('ctp_bale_registrations').select('*').eq('org_id', orgId).eq('crop_year', cropYear).order('id').range(f, t)),
    ])
  } catch (e) {
    console.error('[ctp/inquiry] read failed', e)
    return NextResponse.json({ error: 'The bales could not be read — try again, or contact support.' }, { status: 500 })
  }

  // Only bales with a usable gin code + tag can be asked about.
  const rows = buildCtpRows({ bales, receipts, gins, farms, entities, registrations }).filter((r) => r.ginCode && r.ginTag)
  if (rows.length === 0) return NextResponse.json({ ok: true, checked: 0, found: 0, errors: 0, notFound: 0, message: 'No bale has a gin code and tag the Protocol could look up.' })

  const now = new Date().toISOString()
  let found = 0
  let errors = 0
  let notFound = 0
  let message: string | null = null
  for (const batch of chunk(rows, CTP_INQUIRY_BATCH_SIZE)) {
    let r
    try {
      r = await ctpCall(ctx.apiKey, '/api/BaleRegistration/baleInquiry', { body: { bales: batch.map((row) => ctpInquiryBale(row)) } })
    } catch (e) {
      console.error('[ctp/inquiry] call failed', e)
      return NextResponse.json({ error: 'Could not reach the Protocol — check the connection and try again.', checked: found + errors + notFound }, { status: 502 })
    }
    if (!r.ok && r.status !== 422) return NextResponse.json({ error: ctpFailureMessage(r), checked: found + errors + notFound }, { status: r.status === 401 || r.status === 403 ? 400 : 502 })
    const answer = readInquiryResponse(r.json)
    if (answer.message) message = answer.message
    const upserts: Array<Record<string, unknown>> = []
    for (const row of batch) {
      const key = ctpBaleKey(row.ginCode, row.ginTag, row.cropYear)
      const hit = answer.byKey.get(key)
      const err = answer.errorsByKey.get(key)
      const existing = row.registration
      if (hit) {
        found += 1
        upserts.push({
          org_id: orgId, bale_id: row.baleId, crop_year: cropYear,
          action: existing?.action ?? 'inquiry', upload_id: existing?.upload_id ?? null,
          gin_code: row.ginCode, gin_tag: row.ginTag,
          protocol_id: existing?.protocol_id ?? null, weight: existing?.weight ?? null, regen_program: existing?.regen_program ?? null, sent_at: existing?.sent_at ?? null,
          registration_status: hit.registrationStatus ?? null, shipment_status: hit.shipmentStatus ?? null,
          ctp_weight: hit.weight ?? null, ctp_protocol_id: hit.producerProtocolId ?? null, ctp_regen_program: hit.regenProgram ?? null,
          ctp_upload_date: hit.uploadDate ?? null, inquiry_error: null, checked_at: now,
        })
      } else if (err) {
        errors += 1
        // "not found" on a bale Turnrow never sent is not an error — it simply isn't registered.
        if (!existing && /not found|no record|does not exist/i.test(err)) { errors -= 1; notFound += 1; continue }
        upserts.push({
          org_id: orgId, bale_id: row.baleId, crop_year: cropYear,
          action: existing?.action ?? 'inquiry', upload_id: existing?.upload_id ?? null,
          gin_code: row.ginCode, gin_tag: row.ginTag,
          protocol_id: existing?.protocol_id ?? null, weight: existing?.weight ?? null, regen_program: existing?.regen_program ?? null, sent_at: existing?.sent_at ?? null,
          registration_status: null, shipment_status: null, ctp_weight: null, ctp_protocol_id: null, ctp_regen_program: null, ctp_upload_date: null,
          inquiry_error: err, checked_at: now,
        })
      } else {
        notFound += 1
        if (existing) {
          // Sent, but the Protocol has nothing under this gin code / tag: say so on the row.
          upserts.push({ ...registrationPatch(existing, row.ginCode!, row.ginTag!, orgId, cropYear), inquiry_error: 'The Protocol has no record of this bale — it may still be processing, or the gin code / tag may differ from what the gin registered.', checked_at: now })
        }
      }
    }
    if (upserts.length) {
      const { error } = await service.from('ctp_bale_registrations').upsert(upserts, { onConflict: 'org_id,bale_id' })
      if (error) {
        console.error('[ctp/inquiry] upsert failed', error.message)
        return NextResponse.json({ error: 'The Protocol answered but Turnrow could not record it — contact support.' }, { status: 500 })
      }
    }
  }
  return NextResponse.json({ ok: true, checked: rows.length, found, errors, notFound, message })
}

function registrationPatch(existing: CtpBaleRegistration, ginCode: string, ginTag: string, orgId: string, cropYear: number): Record<string, unknown> {
  return {
    org_id: orgId, bale_id: existing.bale_id, crop_year: cropYear, action: existing.action, upload_id: existing.upload_id,
    gin_code: ginCode, gin_tag: ginTag, protocol_id: existing.protocol_id, weight: existing.weight, regen_program: existing.regen_program, sent_at: existing.sent_at,
    registration_status: null, shipment_status: null, ctp_weight: null, ctp_protocol_id: null, ctp_regen_program: null, ctp_upload_date: null,
  }
}
