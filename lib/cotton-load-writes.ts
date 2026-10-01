// Seed cotton load writes shared by the list, the detail page, and the gin
// receipt review. Migration 090 added `rolls`; until it is applied the same
// row goes in (or is updated) without that column, so the pages keep working
// on a database that has not been updated yet.

import type { SupabaseClient } from '@supabase/supabase-js'
import { compressImage, imagesToPdf } from '@/lib/image-capture'
import { MAX_PDF_BYTES, uploadFileToStorage } from '@/lib/pdf-upload'
import { getPdfPageCount, pickPdfPages } from '@/lib/pdf-split'
import { normalizePdfFile } from '@/lib/orientation'
import type { DocumentSource } from '@/components/document-capture'

export const COTTON_DOC_PREFIX = 'cotton-loads'

/** A whole count of rolls, or null when blank / not a number. */
export function rollsNum(s: string | number | null | undefined): number | null {
  if (s == null || String(s).trim() === '') return null
  const n = Math.round(Number(s))
  return Number.isFinite(n) && n >= 0 ? n : null
}

function isMissingRollsColumn(error: { message?: string } | null): boolean {
  return !!error?.message && /rolls/.test(error.message) && /column|schema/i.test(error.message)
}

export async function insertCottonLoads(supabase: SupabaseClient, rows: Array<Record<string, unknown>>) {
  const first = await supabase.from('cotton_loads').insert(rows)
  if (!first.error || !isMissingRollsColumn(first.error)) return first
  const stripped = rows.map(({ rolls: _rolls, ...rest }) => rest)
  return supabase.from('cotton_loads').insert(stripped)
}

export async function updateCottonLoad(supabase: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const first = await supabase.from('cotton_loads').update(patch).eq('id', id)
  if (!first.error || !isMissingRollsColumn(first.error) || !('rolls' in patch)) return first
  const { rolls: _rolls, ...rest } = patch
  if (Object.keys(rest).length === 0) return first
  return supabase.from('cotton_loads').update(rest).eq('id', id)
}

/** Turn a picked file (PDF or photo) into the one PDF a load stores. */
export async function fileToLoadDocument(file: File, baseName: string): Promise<File> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF_BYTES) throw new Error('That PDF is larger than 20 MB. Please use a smaller file.')
    return file
  }
  if (file.type.startsWith('image/')) return imagesToPdf([await compressImage(file)], baseName)
  throw new Error('Use a PDF or a photo of the ticket.')
}

export async function uploadLoadDocument(supabase: SupabaseClient, file: File): Promise<string> {
  const { publicUrl } = await uploadFileToStorage(supabase, file, COTTON_DOC_PREFIX, 'application/pdf')
  return publicUrl
}

/** The document each review row keeps: its own page(s) of the module list
 *  — the page it was read from, plus a duplicate scan's page — when every
 *  row knows its pages and they exist in the document; otherwise the whole
 *  document on every row. One File per row, in row order. */
export async function documentsForLoads(source: DocumentSource, pagesPerRow: ReadonlyArray<ReadonlyArray<number>>, onProgress?: (label: string) => void): Promise<Array<File | null>> {
  if (pagesPerRow.length === 0) return []
  let whole: File
  let pageCount: number
  if (source.kind === 'pdf') {
    onProgress?.('Preparing ticket pages…')
    whole = (await normalizePdfFile(source.file)).file
    pageCount = await getPdfPageCount(whole).catch(() => 0)
  } else {
    onProgress?.('Preparing ticket photos…')
    whole = await imagesToPdf(source.images, 'module-list')
    pageCount = source.images.length
  }
  const allKnown = pageCount > 0 && pagesPerRow.every((ps) => ps.length > 0 && ps.every((p) => p >= 1 && p <= pageCount))
  if (!allKnown) return pagesPerRow.map(() => whole)
  const out: Array<File | null> = []
  for (const ps of pagesPerRow) {
    if (source.kind === 'pdf') out.push(await pickPdfPages(whole, [...ps]))
    else out.push(await imagesToPdf(ps.map((p) => source.images[p - 1]), 'module-ticket'))
  }
  return out
}
