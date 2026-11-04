// POST /api/ctp/upload — register bales with the U.S. Cotton Trust Protocol
// (baleUpload), or send a correction (baleCorrection: C = change the Regen
// program / weight, R = remove). Rows are rebuilt HERE from the database —
// the browser sends bale ids and choices, never the records — through the
// one seam (lib/ctp-bales buildCtpRows), so what goes out is exactly what the
// page previewed. One ctp_bale_uploads row per API call (batches of 1,000),
// one ctp_bale_registrations row per bale (upserted).
//
// Body: { crop_year: number, bale_ids: string[], action: 'register' | 'correct' | 'remove', regen: boolean }

import { NextRequest, NextResponse } from 'next/server'
import { ctpCall, ctpContext, ctpFailureMessage, ctpKeyMissingResponse, readCropYear, readIdList } from '@/lib/ctp-server'
import { fetchAll } from '@/lib/partner-api-server'
import {
  CTP_BATCH_SIZE, buildCtpRows, chunk, ctpCorrectedBale, ctpRegenProgram, ctpRowReady, ctpUploadBale, readUploadResponse,
  type CtpBaleRow, type CtpReceiptLite,
} from '@/lib/ctp-bales'
import type { CottonBale, CtpAction, CtpBaleRegistration, Entity, Farm, Gin } from '@/lib/types'

export const runtime = 'nodejs'
export const maxDuration = 60

type Body = { crop_year?: unknown; bale_ids?: unknown; action?: unknown; regen?: unknown }

export async function POST(req: NextRequest) {
  const ctx = await ctpContext()
  if (ctx instanceof NextResponse) return ctx
  if (!ctx.apiKey) return ctpKeyMissingResponse()
  const body = ((await req.json().catch(() => null)) ?? {}) as Body
  const cropYear = readCropYear(body.crop_year)
  const baleIds = readIdList(body.bale_ids)
  const action: CtpAction | null = body.action === 'register' || body.action === 'correct' || body.action === 'remove' ? body.action : null
  const regen = body.regen === true
  if (!cropYear || !action) return NextResponse.json({ error: 'Choose a crop year and what to send.' }, { status: 400 })
  if (baleIds.length === 0) return NextResponse.json({ error: 'Pick at least one bale.' }, { status: 400 })
  const regenProgram = regen ? ctpRegenProgram(ctx.regenProgram) : null
  if (regen && !regenProgram) return NextResponse.json({ error: 'Save your Regen program code on the Connection card before sending bales as U.S. Regen.' }, { status: 400 })

  // Everything the rows need, org-scoped (the service client bypasses RLS).
  const { service, orgId } = ctx
  const idChunks = chunk(baleIds, 200)
  let bales: CottonBale[]
  let receipts: CtpReceiptLite[]
  let gins: Gin[]
  let farms: Pick<Farm, 'id' | 'entity_id'>[]
  let entities: Entity[]
  let registrations: CtpBaleRegistration[]
  try {
    bales = (await Promise.all(idChunks.map((ids) =>
      fetchAll<CottonBale>((f, t) => service.from('cotton_bales').select('id, gin_receipt_id, crop_year, pbi_number, net_weight_lbs, created_at').eq('org_id', orgId).eq('crop_year', cropYear).in('id', ids).order('id').range(f, t)),
    ))).flat()
    const receiptIds = Array.from(new Set(bales.map((b) => b.gin_receipt_id)))
    ;[receipts, gins, farms, entities, registrations] = await Promise.all([
      Promise.all(chunk(receiptIds, 200).map((ids) =>
        fetchAll<CtpReceiptLite>((f, t) => service.from('gin_receipts').select('id, gin_id, receipt_number, receipt_date, entity_id, farm_id, field_id, crop_year, gin_code, statement_number').eq('org_id', orgId).in('id', ids).order('id').range(f, t)),
      )).then((r) => r.flat()),
      fetchAll<Gin>((f, t) => service.from('gins').select('id, name, address, phone, notes, gin_code').eq('org_id', orgId).order('id').range(f, t)),
      fetchAll<Pick<Farm, 'id' | 'entity_id'>>((f, t) => service.from('farms').select('id, entity_id').eq('org_id', orgId).order('id').range(f, t)),
      fetchAll<Entity>((f, t) => service.from('entities').select('id, name, notes, payment_limit_persons, entity_role, archived_at, ctp_protocol_id').eq('org_id', orgId).order('id').range(f, t)),
      Promise.all(idChunks.map((ids) =>
        fetchAll<CtpBaleRegistration>((f, t) => service.from('ctp_bale_registrations').select('*').eq('org_id', orgId).in('bale_id', ids).order('id').range(f, t)),
      )).then((r) => r.flat()),
    ])
  } catch (e) {
    console.error('[ctp/upload] read failed', e)
    return NextResponse.json({ error: 'The bales could not be read — try again, or contact support.' }, { status: 500 })
  }
  if (bales.length !== baleIds.length) {
    return NextResponse.json({ error: `${baleIds.length - bales.length} of the chosen bales are not ${cropYear} bales of this operation — refresh the page and try again.` }, { status: 400 })
  }

  const rows = buildCtpRows({ bales, receipts, gins, farms, entities, registrations })
  const blocked = rows.filter((r) => !ctpRowReady(r))
  if (blocked.length) {
    return NextResponse.json({
      error: `${blocked.length} of the chosen bales cannot be sent yet — fix what the list names and try again.`,
      blocked: blocked.slice(0, 50).map((r) => ({ bale_id: r.baleId, pbi: r.pbi, problems: r.problems })),
    }, { status: 400 })
  }

  // Send in batches; record each call and every bale it carried.
  const path = action === 'register' ? '/api/BaleRegistration/baleUpload' : '/api/BaleRegistration/baleCorrection'
  const results: Array<{ upload_id: string | null; bales: number; ctp_upload_id: number; has_errors: boolean; error: string | null; accepted: number }> = []
  let sent = 0
  let failedBatches = 0
  for (const batch of chunk(rows, CTP_BATCH_SIZE)) {
    const payload = action === 'register'
      ? { bales: batch.map((r) => ctpUploadBale(r, regenProgram)) }
      : { bales: batch.map((r) => ctpCorrectedBale(r, regenProgram, action === 'remove' ? 'R' : 'C')) }
    let status = 0
    let answer = readUploadResponse(null, 0)
    try {
      const r = await ctpCall(ctx.apiKey, path, { body: payload })
      status = r.status
      answer = readUploadResponse(r.json, r.status)
      if (!r.ok && !answer.error) answer.error = ctpFailureMessage(r)
    } catch (e) {
      answer = { uploadId: 0, hasErrors: true, error: 'Could not reach the Protocol — check the connection and try again.', bales: 0 }
      console.error('[ctp/upload] call failed', e)
    }
    const { data: uploadRow, error: uErr } = await service.from('ctp_bale_uploads').insert({
      org_id: orgId, crop_year: cropYear, action, uploaded_by: ctx.userId, bale_count: batch.length, regen_program: regenProgram,
      http_status: status || null, ctp_upload_id: answer.uploadId || null, ctp_bale_count: answer.bales, has_errors: answer.hasErrors, error: answer.error,
    }).select('id').single()
    if (uErr) console.error('[ctp/upload] log insert failed', uErr.message)
    const uploadId = (uploadRow as { id?: string } | null)?.id ?? null
    if (!answer.hasErrors) {
      const now = new Date().toISOString()
      const regRows = batch.map((r: CtpBaleRow) => ({
        org_id: orgId, bale_id: r.baleId, upload_id: uploadId, crop_year: cropYear, action,
        gin_code: r.ginCode, gin_tag: r.ginTag, protocol_id: r.protocolId, weight: r.weight, regen_program: regenProgram, sent_at: now,
        // A fresh send resets what the last status check said.
        registration_status: null, shipment_status: null, ctp_weight: null, ctp_protocol_id: null, ctp_regen_program: null, ctp_upload_date: null, inquiry_error: null, checked_at: null,
      }))
      const { error: rErr } = await service.from('ctp_bale_registrations').upsert(regRows, { onConflict: 'org_id,bale_id' })
      if (rErr) {
        console.error('[ctp/upload] registration upsert failed', rErr.message)
        return NextResponse.json({ error: 'The Protocol accepted the bales but Turnrow could not record it — contact support before sending again.', results }, { status: 500 })
      }
      sent += batch.length
    } else {
      failedBatches += 1
    }
    results.push({ upload_id: uploadId, bales: batch.length, ctp_upload_id: answer.uploadId, has_errors: answer.hasErrors, error: answer.error, accepted: answer.bales })
    if (answer.hasErrors) break // the same key / payload shape would fail again; stop and report
  }
  return NextResponse.json({ ok: failedBatches === 0, sent, failed: rows.length - sent, results })
}
