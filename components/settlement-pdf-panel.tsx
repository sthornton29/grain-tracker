'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  MAX_PDF_BYTES,
  deleteStorageObjectByUrl,
  uploadFileToStorage,
} from '@/lib/pdf-upload'
import { compressImage, imagesToPdf, type CapturedImage } from '@/lib/image-capture'
import Dropzone, { rejectMessage } from '@/components/dropzone'
import { ConfirmDialog } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'

type Props = {
  settlementId: string
  currentUrl: string | null
}

const ACCEPT = 'application/pdf,.pdf,image/*'

export default function SettlementPdfPanel({ settlementId, currentUrl }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [askRemove, setAskRemove] = useState(false)

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    await upload(files)
  }

  // A PDF is stored as-is. Photos (one or several pages) go through the same
  // photos-to-PDF path the New Settlement upload uses, so the stored document
  // is always one PDF.
  async function upload(files: File[]) {
    setErr(null)
    setBusy('upload')
    try {
      const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
      const photos = files.filter((f) => f.type.startsWith('image/'))
      let fileToStore: File
      if (pdfs.length > 0) {
        fileToStore = pdfs[0]
        if (fileToStore.size > MAX_PDF_BYTES) { setErr('That PDF is larger than 20 MB. Please use a smaller file.'); return }
      } else if (photos.length > 0) {
        const captured: CapturedImage[] = []
        for (const p of photos) captured.push(await compressImage(p))
        fileToStore = await imagesToPdf(captured, 'settlement')
      } else {
        setErr('Use a PDF or a photo of the settlement.')
        return
      }
      const { publicUrl } = await uploadFileToStorage(
        supabase,
        fileToStore,
        'settlements',
        'application/pdf',
      )
      const { error } = await supabase
        .from('settlements')
        .update({ source_pdf_url: publicUrl })
        .eq('id', settlementId)
      if (error) throw error
      if (currentUrl) {
        // Best-effort cleanup of the replaced file.
        await deleteStorageObjectByUrl(supabase, currentUrl)
      }
      router.refresh()
    } catch (e: any) {
      setErr(reportError(e, { action: 'attach the settlement document', noun: 'document' }))
    } finally {
      setBusy(null)
    }
  }

  async function onRemove() {
    if (!currentUrl) return
    setErr(null)
    setBusy('remove')
    try {
      const { error } = await supabase
        .from('settlements')
        .update({ source_pdf_url: null })
        .eq('id', settlementId)
      if (error) throw error
      await deleteStorageObjectByUrl(supabase, currentUrl)
      router.refresh()
    } catch (e: any) {
      setErr(reportError(e, { action: 'remove the settlement document', noun: 'document' }))
    } finally {
      setBusy(null)
      setAskRemove(false)
    }
  }

  const btn = 'text-sm rounded-lg px-3 min-h-10 disabled:opacity-50'

  return (
    <Dropzone
      onFiles={(files) => void upload(files)}
      onReject={(rejected) => setErr(rejectMessage('Use the settlement PDF or a photo of it.', rejected))}
      accept={ACCEPT}
      multiple
      disabled={busy != null}
      hint="Drop the settlement PDF or photos here"
      variant="compact"
      accepts="PDF or photos"
      className="bg-white rounded-xl shadow p-3 flex flex-wrap items-center gap-2"
    >
      <span className="text-sm font-semibold text-slate-700 mr-1">Settlement document</span>
      {currentUrl ? (
        <>
          <a
            href={currentUrl}
            target="_blank"
            rel="noreferrer"
            className={`${btn} inline-flex items-center bg-brand hover:bg-brand-deep text-white`}
          >
            View document ↗
          </a>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy != null}
            className={`${btn} bg-white border border-slate-300`}
          >
            {busy === 'upload' ? 'Uploading…' : 'Replace'}
          </button>
          <button
            type="button"
            onClick={() => setAskRemove(true)}
            disabled={busy != null}
            className={`${btn} bg-white border border-red-300 text-red-700`}
          >
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        </>
      ) : (
        <>
          <span className="text-sm text-slate-500 mr-1">No document attached.</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy != null}
            className={`${btn} bg-brand hover:bg-brand-deep text-white`}
          >
            {busy === 'upload' ? 'Uploading…' : 'Attach PDF or photo'}
          </button>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={onPick}
        className="hidden"
      />
      {err && <p className="w-full text-sm text-red-700">{err}</p>}
      <ConfirmDialog
        open={askRemove}
        title="Remove the attached document?"
        body={<p>The settlement and its lines stay; only the PDF or photos are removed.</p>}
        confirmLabel="Remove"
        danger
        busy={busy === 'remove'}
        onConfirm={() => void onRemove()}
        onCancel={() => setAskRemove(false)}
      />
    </Dropzone>
  )
}
