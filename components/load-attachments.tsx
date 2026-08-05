'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  MAX_PDF_BYTES,
  uploadFileToStorage,
  deleteStorageObject,
} from '@/lib/pdf-upload'
import type { LoadAttachment } from '@/lib/types'

type Props = {
  loadId: string
}

function isImage(mime: string | null | undefined) {
  return !!mime && mime.startsWith('image/')
}

function formatSize(bytes: number | null) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function LoadAttachments({ loadId }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const inputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<LoadAttachment[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('load_attachments')
        .select('*')
        .eq('load_id', loadId)
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (error) {
        setErr(error.message)
        setItems([])
        return
      }
      setItems((data as LoadAttachment[]) ?? [])
    })()
    return () => {
      cancelled = true
    }
  }, [supabase, loadId])

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    setErr(null)

    const tooBig = files.find((f) => f.size > MAX_PDF_BYTES)
    if (tooBig) {
      setErr(`"${tooBig.name}" is larger than 20 MB. Please use a smaller file.`)
      return
    }

    setBusy(true)
    try {
      const uploaded: LoadAttachment[] = []
      for (const file of files) {
        const { publicUrl, path } = await uploadFileToStorage(
          supabase,
          file,
          'load-attachments',
        )
        const { data, error } = await supabase
          .from('load_attachments')
          .insert({
            load_id: loadId,
            file_url: publicUrl,
            file_path: path,
            file_name: file.name,
            mime_type: file.type || null,
            file_size: file.size,
          })
          .select('*')
          .single()
        if (error) throw new Error(error.message)
        uploaded.push(data as LoadAttachment)
      }
      setItems((prev) => [...(prev ?? []), ...uploaded])
    } catch (e: any) {
      setErr(e?.message ?? 'Could not upload attachment.')
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(a: LoadAttachment) {
    if (!window.confirm(`Remove "${a.file_name}"?`)) return
    setErr(null)
    try {
      const { error } = await supabase
        .from('load_attachments')
        .delete()
        .eq('id', a.id)
      if (error) throw new Error(error.message)
      // Best-effort storage cleanup.
      await deleteStorageObject(supabase, a.file_path)
      setItems((prev) => (prev ?? []).filter((x) => x.id !== a.id))
    } catch (e: any) {
      setErr(e?.message ?? 'Could not remove attachment.')
    }
  }

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold flex-1">Attachments</h2>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="text-sm rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 disabled:opacity-50"
        >
          {busy ? 'Uploading…' : '+ Attach PDF or photo'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/*"
          multiple
          onChange={onPick}
          className="hidden"
        />
      </div>
      <p className="text-xs text-slate-500">
        Attach scanned tickets, photos of the scale ticket, or any related paperwork. PDFs and images up to 20 MB.
      </p>

      {err && <p className="text-sm text-red-600">{err}</p>}

      {items == null ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-400">No attachments yet.</p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((a) => (
            <li
              key={a.id}
              className="border border-slate-200 rounded-lg p-2 flex gap-3 items-start bg-slate-50"
            >
              <a
                href={a.file_url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0"
                title={a.file_name}
              >
                {isImage(a.mime_type) ? (
                  // Native img is fine here — these are user uploads in the
                  // public bucket; next/image config would require domain set-up.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.file_url}
                    alt={a.file_name}
                    className="w-20 h-20 object-cover rounded border border-slate-200"
                  />
                ) : (
                  <div className="w-20 h-20 rounded border border-slate-200 bg-white flex items-center justify-center text-xs font-semibold text-slate-500">
                    PDF
                  </div>
                )}
              </a>
              <div className="flex-1 min-w-0">
                <a
                  href={a.file_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-sm text-brand-deep truncate"
                  title={a.file_name}
                >
                  {a.file_name}
                </a>
                <div className="text-xs text-slate-500">{formatSize(a.file_size)}</div>
                <button
                  type="button"
                  onClick={() => onDelete(a)}
                  className="mt-1 text-xs text-red-600"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
