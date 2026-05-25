// Client-side helpers for the AI PDF parsing flow:
//   * fileToBase64       — read a File as a base64 string (no data: prefix)
//   * parseDocument      — POST to /api/parse-document and return the JSON
//   * uploadPdfToStorage — push the PDF to Supabase storage and return a URL
//
// The Anthropic API key never touches the browser — these helpers only know
// how to talk to /api/parse-document on the same origin.

import type { SupabaseClient } from '@supabase/supabase-js'

export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const PDF_BUCKET = 'documents'

export class PdfTooLargeError extends Error {
  constructor() {
    super('That PDF is larger than 20 MB. Please use a smaller file.')
    this.name = 'PdfTooLargeError'
  }
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export type DocumentType = 'settlement' | 'tickets' | 'brokerage_statement'

export type SettlementExtraction = {
  buyer_name: string | null
  settlement_date: string | null
  settlement_number: string | null
  line_items: Array<{
    ticket_number: string | null
    net_bushels: number | null
    gross_revenue: number | null
    discounts: number | null
  }>
}

export type TicketExtraction = {
  ticket_number: string | null
  date: string | null
  time: string | null
  truck: string | null
  crop: string | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  moisture: number | null
  test_weight: number | null
  from_type: 'field' | 'bin' | null
  from_name: string | null
  to_type: 'bin' | 'buyer' | null
  to_name: string | null
}

export type TicketsExtraction = {
  tickets: TicketExtraction[]
}

export type BrokerageOpenPosition = {
  trade_date: string | null
  side: 'long' | 'short' | null
  num_contracts: number | null
  commodity: string | null
  contract_month: string | null
  trade_price: number | null
  unrealized_pnl: number | null
}

export type BrokerageClosedTrade = {
  open_trade_date: string | null
  close_trade_date: string | null
  side: 'long' | 'short' | null
  num_contracts: number | null
  commodity: string | null
  contract_month: string | null
  open_price: number | null
  close_price: number | null
  realized_pnl: number | null
}

export type BrokerageOpenOption = {
  trade_date: string | null
  side: 'buy' | 'sell' | null
  option_type: 'put' | 'call' | null
  num_contracts: number | null
  commodity: string | null
  underlying_contract_month: string | null
  strike_price: number | null
  premium_cents: number | null
  unrealized_pnl: number | null
}

export type BrokerageClosedOption = {
  open_trade_date: string | null
  close_trade_date: string | null
  side: 'buy' | 'sell' | null
  option_type: 'put' | 'call' | null
  num_contracts: number | null
  commodity: string | null
  underlying_contract_month: string | null
  strike_price: number | null
  open_premium_cents: number | null
  close_premium_cents: number | null
  realized_pnl: number | null
}

export type BrokerageStatementExtraction = {
  statement_date: string | null
  open_positions: BrokerageOpenPosition[]
  closed_trades: BrokerageClosedTrade[]
  open_options?: BrokerageOpenOption[]
  closed_options?: BrokerageClosedOption[]
  account_summary: {
    beginning_balance: number | null
    ending_balance: number | null
    open_trade_equity: number | null
    total_equity: number | null
    margin_requirement: number | null
    excess_equity: number | null
  } | null
}

export async function parseDocument(file: File, documentType: 'settlement'): Promise<SettlementExtraction>
export async function parseDocument(file: File, documentType: 'tickets'): Promise<TicketsExtraction>
export async function parseDocument(file: File, documentType: 'brokerage_statement'): Promise<BrokerageStatementExtraction>
export async function parseDocument(
  file: File,
  documentType: DocumentType,
): Promise<SettlementExtraction | TicketsExtraction | BrokerageStatementExtraction> {
  if (file.size > MAX_PDF_BYTES) throw new PdfTooLargeError()
  const pdf_base64 = await fileToBase64(file)
  const res = await fetch('/api/parse-document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pdf_base64, document_type: documentType }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = body?.error || `Server returned ${res.status}.`
    throw new Error(msg)
  }
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new Error('Malformed response from server.')
  }
  return body.data as SettlementExtraction | TicketsExtraction | BrokerageStatementExtraction
}

// Uploads to the public "documents" bucket and returns the public URL.
// Path is randomized so two scans with the same filename don't clobber.
export async function uploadPdfToStorage(
  supabase: SupabaseClient,
  file: File,
  prefix: 'settlements' | 'tickets',
): Promise<string> {
  const { publicUrl } = await uploadFileToStorage(supabase, file, prefix, 'application/pdf')
  return publicUrl
}

// Generic uploader — accepts any file (PDF, image, etc.) and returns both the
// public URL and the storage path. Callers need the path to delete the object
// later (parsing the public URL is brittle if the bucket name ever changes).
export async function uploadFileToStorage(
  supabase: SupabaseClient,
  file: File,
  prefix: string,
  contentType?: string,
): Promise<{ publicUrl: string; path: string }> {
  const rand = Math.random().toString(36).slice(2, 10)
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const path = `${prefix}/${Date.now()}-${rand}-${safeName}`
  const { error } = await supabase.storage
    .from(PDF_BUCKET)
    .upload(path, file, {
      contentType: contentType ?? file.type ?? 'application/octet-stream',
      upsert: false,
    })
  if (error) throw new Error(`Could not upload file: ${error.message}`)
  const { data } = supabase.storage.from(PDF_BUCKET).getPublicUrl(path)
  return { publicUrl: data.publicUrl, path }
}

// Best-effort delete: pulls the path out of a Supabase public URL of the form
// .../storage/v1/object/public/<bucket>/<path>. Silently no-ops if the URL
// isn't in that shape (e.g., legacy data, manually entered link).
export async function deleteStorageObjectByUrl(
  supabase: SupabaseClient,
  url: string,
): Promise<void> {
  const marker = `/object/public/${PDF_BUCKET}/`
  const i = url.indexOf(marker)
  if (i < 0) return
  const path = decodeURIComponent(url.slice(i + marker.length))
  if (!path) return
  await supabase.storage.from(PDF_BUCKET).remove([path])
}
