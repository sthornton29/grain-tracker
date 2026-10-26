'use client'

import { useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { deleteStorageObjectByUrl } from '@/lib/pdf-upload'
import { fileToLoadDocument, uploadLoadDocument, uploadReceiptDocument } from '@/lib/cotton-load-writes'
import Dropzone, { rejectMessage } from '@/components/dropzone'
import PdfViewer from '@/components/pdf-viewer'
import { ConfirmDialog } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'

// The scanned document for ONE seed cotton load (its ticket) or ONE gin
// receipt (its Statement of Ginning): shown inline, replaceable, and
// removable. A photo becomes a one-page PDF so every stored document is a PDF.

const ACCEPT = 'application/pdf,.pdf,image/*'

const COPY = {
  load: {
    table: 'cotton_loads', heading: 'Ticket document', doc: 'ticket', add: 'Add ticket photo or PDF',
    empty: 'No ticket on file for this load. Add a photo or PDF of the module ticket so it stays with the load.',
    removeBody: 'The load itself stays. Only the scanned ticket is removed.',
    viewerTitle: (n: string) => `Ticket for load ${n}`, fileBase: (n: string) => `load-${n}`,
  },
  receipt: {
    table: 'gin_receipts', heading: 'Statement of Ginning', doc: 'statement', add: 'Add statement photo or PDF',
    empty: 'No statement on file for this gin receipt. Add the PDF or a photo of the Statement of Ginning so it stays with the receipt.',
    removeBody: 'The gin receipt itself stays. Only the scanned statement is removed.',
    viewerTitle: (n: string) => `Statement of Ginning ${n}`, fileBase: (n: string) => `gin-receipt-${n}`,
  },
} as const

export default function CottonLoadDocument({ kind = 'load', loadId, loadNumber, currentUrl, onChanged }: {
  /** Whose document this is (default a seed cotton load). */
  kind?: 'load' | 'receipt'
  /** The load's (or receipt's) id. */
  loadId: string
  /** The load number (or receipt label) — names the file and the viewer. */
  loadNumber: string
  currentUrl: string | null
  onChanged: () => void
}) {
  const c = COPY[kind]
  const badFile = `Use a PDF or a photo of the ${c.doc}.`
  const supabase = useMemo(() => createClient(), [])
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [askRemove, setAskRemove] = useState(false)

  async function upload(files: File[]) {
    if (files.length === 0) return
    setErr(null); setBusy('upload')
    try {
      const doc = await fileToLoadDocument(files[0], c.fileBase(loadNumber), badFile)
      const url = kind === 'receipt' ? await uploadReceiptDocument(supabase, doc) : await uploadLoadDocument(supabase, doc)
      const { error } = await supabase.from(c.table).update({ source_pdf_url: url }).eq('id', loadId)
      if (error) throw error
      if (currentUrl) await deleteStorageObjectByUrl(supabase, currentUrl).catch(() => {})
      onChanged()
    } catch (e: any) {
      setErr(e?.message && (/20 MB/.test(e.message) || e.message === badFile) ? e.message : reportError(e, { action: `attach the ${c.doc}`, noun: 'document' }))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!currentUrl) return
    setErr(null); setBusy('remove')
    try {
      const { error } = await supabase.from(c.table).update({ source_pdf_url: null }).eq('id', loadId)
      if (error) throw error
      await deleteStorageObjectByUrl(supabase, currentUrl).catch(() => {})
      onChanged()
    } catch (e: any) {
      setErr(reportError(e, { action: `remove the ${c.doc}`, noun: 'document' }))
    } finally {
      setBusy(null); setAskRemove(false)
    }
  }

  const btn = 'text-sm rounded-lg px-3 min-h-11 disabled:opacity-50'

  return (
    <div className="bg-white rounded-xl shadow overflow-hidden avoid-break">
      <div className="px-4 pt-3 pb-2 border-b border-slate-100 flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold flex-1">{c.heading}</h2>
        <div className="flex gap-2 flex-wrap no-print">
          {currentUrl && (
            <a href={currentUrl} target="_blank" rel="noreferrer" className={`${btn} inline-flex items-center bg-white border border-slate-300`}>Open ↗</a>
          )}
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy != null} className={`${btn} bg-white border border-slate-300 font-semibold text-brand-deep`}>
            {busy === 'upload' ? 'Uploading…' : currentUrl ? 'Replace' : c.add}
          </button>
          {currentUrl && (
            <button type="button" onClick={() => setAskRemove(true)} disabled={busy != null} className={`${btn} bg-white border border-red-300 text-red-700`}>Remove</button>
          )}
          <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void upload(f) }} />
        </div>
      </div>
      {err && <p className="px-4 pt-2 text-sm text-red-700" role="alert">{err}</p>}
      {currentUrl ? (
        <div className="p-3 h-[70vh] min-h-[420px]">
          <PdfViewer url={currentUrl} className="h-full" title={c.viewerTitle(loadNumber)} />
        </div>
      ) : (
        <Dropzone
          onFiles={(files) => void upload(files)}
          onReject={(rejected) => setErr(rejectMessage(badFile, rejected))}
          accept={ACCEPT}
          disabled={busy != null}
          hint={`Drop the ${c.doc} PDF or photo here`}
          variant="compact"
          accepts="PDF or photo"
          className="p-4"
        >
          <p className="text-sm text-slate-500">{c.empty}</p>
        </Dropzone>
      )}
      <ConfirmDialog
        open={askRemove}
        title={`Remove this ${c.doc} document?`}
        body={c.removeBody}
        confirmLabel="Remove"
        danger
        busy={busy === 'remove'}
        onConfirm={() => void remove()}
        onCancel={() => { if (busy == null) setAskRemove(false) }}
      />
    </div>
  )
}
