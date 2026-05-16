'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  MAX_PDF_BYTES,
  deleteStorageObjectByUrl,
  uploadFileToStorage,
} from '@/lib/pdf-upload'

type Props = {
  settlementId: string
  currentUrl: string | null
}

export default function SettlementPdfPanel({ settlementId, currentUrl }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr(null)
    if (file.size > MAX_PDF_BYTES) {
      setErr('That PDF is larger than 20 MB. Please use a smaller file.')
      return
    }
    setBusy('upload')
    try {
      const { publicUrl } = await uploadFileToStorage(
        supabase,
        file,
        'settlements',
        'application/pdf',
      )
      const { error } = await supabase
        .from('settlements')
        .update({ source_pdf_url: publicUrl })
        .eq('id', settlementId)
      if (error) throw new Error(error.message)
      if (currentUrl) {
        // Best-effort cleanup of the replaced file.
        await deleteStorageObjectByUrl(supabase, currentUrl)
      }
      router.refresh()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not attach PDF.')
    } finally {
      setBusy(null)
    }
  }

  async function onRemove() {
    if (!currentUrl) return
    if (!window.confirm('Remove the attached settlement PDF?')) return
    setErr(null)
    setBusy('remove')
    try {
      const { error } = await supabase
        .from('settlements')
        .update({ source_pdf_url: null })
        .eq('id', settlementId)
      if (error) throw new Error(error.message)
      await deleteStorageObjectByUrl(supabase, currentUrl)
      router.refresh()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not remove PDF.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow p-3 flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-slate-700 mr-1">Settlement PDF</span>
      {currentUrl ? (
        <>
          <a
            href={currentUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm rounded-lg bg-green-700 text-white px-3 py-2"
          >
            View settlement PDF ↗
          </a>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy != null}
            className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2 disabled:opacity-50"
          >
            {busy === 'upload' ? 'Uploading…' : 'Replace'}
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy != null}
            className="text-sm rounded-lg bg-white border border-red-300 text-red-700 px-3 py-2 disabled:opacity-50"
          >
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        </>
      ) : (
        <>
          <span className="text-sm text-slate-500 mr-1">No PDF attached.</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy != null}
            className="text-sm rounded-lg bg-green-700 text-white px-3 py-2 disabled:opacity-50"
          >
            {busy === 'upload' ? 'Uploading…' : 'Attach Settlement PDF'}
          </button>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        onChange={onPick}
        className="hidden"
      />
      {err && <p className="w-full text-sm text-red-600">{err}</p>}
    </div>
  )
}
