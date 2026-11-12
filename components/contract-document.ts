'use client'

// AI contract document read: the one path from a contract PDF/photo to the
// editable contract form, and the one attach-on-save. Used by the New
// Contract page (the everyday path) and Settings → Contracts (bulk list).

import type { SupabaseClient } from '@supabase/supabase-js'
import { emptyContractForm, type ContractFormState } from '@/components/contract-form'
import { basisFromCashFutures } from '@/lib/contracts'
import { uploadFileToStorage, type ContractExtraction } from '@/lib/pdf-upload'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeContracts } from '@/lib/parse-merge'
import { imagesToPdf } from '@/lib/image-capture'
import { findBestMatch } from '@/lib/fuzzy'
import type { DocumentSource } from '@/components/document-capture'
import type { Buyer, Crop } from '@/lib/types'

// Map an AI contract extraction onto the editable form. Buyer/crop are fuzzy-
// matched to existing records; everything is editable before saving.
export function contractExtractionToForm(x: ContractExtraction, buyers: Buyer[], crops: Crop[], baseEntityId: string): ContractFormState {
  const buyer = x.buyer_name ? findBestMatch(x.buyer_name, buyers, (b) => b.name) : null
  const crop = x.crop ? findBestMatch(x.crop, crops, (c) => c.name) : null
  const fee = x.service_fee ?? 0
  // When the contract gives both a futures and a cash price, derive the basis
  // (cash − futures + fee) so it's internally consistent — the AI sometimes
  // flips the basis sign. Otherwise keep whatever basis was extracted.
  const basisStr = x.futures_price != null && x.cash_price != null
    ? String(basisFromCashFutures(x.cash_price, x.futures_price, fee))
    : x.basis != null ? String(x.basis) : ''
  return {
    ...emptyContractForm,
    entity_id: baseEntityId,
    contract_number: x.contract_number ?? '',
    buyer_id: buyer?.id ?? '',
    crop_id: crop?.id ?? '',
    contract_type: x.contract_type ?? 'forward',
    contract_month: x.contract_month ? x.contract_month.toUpperCase() : '',
    crop_year: x.crop_year != null ? String(x.crop_year) : '',
    contracted_bushels: x.contracted_bushels != null ? String(x.contracted_bushels) : '',
    futures_price: x.futures_price != null ? String(x.futures_price) : '',
    basis: basisStr,
    cash_price: x.cash_price != null ? String(x.cash_price) : '',
    service_fee: x.service_fee != null ? String(x.service_fee) : '',
    delivery_type: x.delivery_type ?? 'pickup',
    delivery_start_date: x.delivery_start_date ?? '',
    delivery_end_date: x.delivery_end_date ?? '',
    notes: x.notes ?? '',
  }
}

// Chunked parse for long contract packets: one contract per document, so
// later chunks only fill fields page 1 lacked (mergeContracts).
export async function readContractDocument(src: DocumentSource, onProgress: (stage: string) => void) {
  return parseDocumentChunked<ContractExtraction>(
    src.kind === 'pdf' ? src.file : src.images,
    'contract',
    { onProgress, merge: mergeContracts },
  )
}

// Attach the read document to the saved contract. Best-effort: the contract
// is already saved, so a failed attach never undoes it.
export async function attachContractDocument(supabase: SupabaseClient, contractId: string, src: DocumentSource) {
  try {
    const attach = src.kind === 'pdf' ? src.file : await imagesToPdf(src.images, 'contract')
    const { publicUrl, path } = await uploadFileToStorage(supabase, attach, 'contract-attachments')
    await supabase.from('contract_attachments').insert({
      contract_id: contractId,
      file_url: publicUrl, file_path: path, file_name: attach.name,
      mime_type: attach.type || null, file_size: attach.size,
    })
  } catch { /* contract saved; attachment is best-effort */ }
}
