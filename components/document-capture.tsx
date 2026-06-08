'use client'

import { useEffect, useRef, useState } from 'react'
import { compressImage, ImageDecodeError, type CapturedImage } from '@/lib/image-capture'
import { excelToPdf, isExcelFile } from '@/lib/excel-to-pdf'

// The input source a parsing screen receives once the user has a document ready:
// either a single PDF (the original upload path) or one or more compressed photos.
export type DocumentSource =
  | { kind: 'pdf'; file: File }
  | { kind: 'images'; images: CapturedImage[] }

type Props = {
  /** Fires when a document is ready to parse. PDF: immediately on pick. Photos:
   *  when the user taps "Extract from N photos". */
  onSource: (src: DocumentSource) => void
  /** Disable inputs while the parent is parsing. */
  busy?: boolean
  /** Parent's progress label (e.g. "Extracting…") shown on the primary button. */
  stageLabel?: string | null
  /** Label for the desktop "upload" button (default "Upload PDF or Image"). */
  pdfLabel?: string
  className?: string
}

// Capturing multiple pages of one document is normal for tickets and statements,
// so the camera/library always feed a collection the user reviews before extract.
export default function DocumentCapture({ onSource, busy, stageLabel, pdfLabel, className }: Props) {
  // Coarse pointer ⇒ phone/tablet ⇒ offer the camera. Desktop gets a plain file
  // picker (capture="environment" is ignored there anyway). Computed after mount
  // to stay SSR-safe.
  const [isCoarse, setIsCoarse] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    setIsCoarse(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [images, setImages] = useState<CapturedImage[]>([])
  const [compressing, setCompressing] = useState(false)
  const [converting, setConverting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const disabled = busy || compressing || converting

  async function compressAndAdd(files: File[]) {
    if (files.length === 0) return
    setErr(null)
    setCompressing(true)
    try {
      const next: CapturedImage[] = []
      for (const file of files) {
        next.push(await compressImage(file))
      }
      setImages((prev) => [...prev, ...next])
    } catch (e) {
      setErr(e instanceof ImageDecodeError ? e.message : "Couldn't process that photo.")
    } finally {
      setCompressing(false)
    }
  }

  // Desktop combined picker: a PDF (or an Excel file we convert to PDF) hands off
  // immediately; an image joins the tray.
  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so re-picking the same file fires onChange again
    if (!file) return
    if (isExcelFile(file)) {
      // Convert the spreadsheet to a PDF so it rides the same pipeline as PDFs.
      setImages([])
      setErr(null)
      setConverting(true)
      excelToPdf(file)
        .then((pdf) => onSource({ kind: 'pdf', file: pdf }))
        .catch(() => setErr("Couldn't read that Excel file. Try re-saving it as .xlsx, or export it to PDF or CSV."))
        .finally(() => setConverting(false))
      return
    }
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      setImages([])
      setErr(null)
      onSource({ kind: 'pdf', file })
      return
    }
    void compressAndAdd([file])
  }

  function onPhotoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : []
    e.target.value = ''
    void compressAndAdd(files)
  }

  function removeImage(id: string) {
    setImages((prev) => prev.filter((i) => i.id !== id))
  }

  function extract() {
    if (images.length === 0) return
    const captured = images
    setImages([]) // hand ownership to the parent; reset the tray for the next doc
    onSource({ kind: 'images', images: captured })
  }

  const btnBase = 'rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50'
  const primary = `${btnBase} bg-green-700 text-white`
  const secondary = `${btnBase} bg-white border border-slate-300 text-slate-700`

  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        {isCoarse ? (
          <>
            <button type="button" onClick={() => cameraRef.current?.click()} disabled={disabled} className={primary}>
              {stageLabel ?? (compressing ? 'Adding…' : '📷 Take Photo')}
            </button>
            <button type="button" onClick={() => libraryRef.current?.click()} disabled={disabled} className={secondary}>
              Choose from Photos
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={disabled} className={secondary}>
              {converting ? 'Converting…' : 'Upload File'}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => fileRef.current?.click()} disabled={disabled} className={primary}>
            {stageLabel ?? (converting ? 'Converting…' : compressing ? 'Adding…' : (pdfLabel ?? 'Upload PDF, image, or Excel'))}
          </button>
        )}
      </div>

      {images.length === 0 && (
        <p className="text-[11px] text-slate-400">Accepts PDF, photos, or Excel (.xlsx/.xls) — spreadsheets are converted automatically.</p>
      )}

      {isCoarse && images.length === 0 && (
        <p className="text-xs text-slate-500">
          Hold steady, capture the full document, and make sure the lighting is good.
        </p>
      )}

      {/* Captured-photo tray: review thumbnails, drop blurry ones, add more pages,
          then extract. Lives inline so it works in both toolbars and modals. */}
      {images.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={img.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.dataUrl} alt={`Page ${i + 1}`} className="h-20 w-20 object-cover rounded border border-slate-300" />
                <span className="absolute bottom-0 left-0 bg-black/60 text-white text-[10px] px-1 rounded-tr">
                  {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  disabled={disabled}
                  aria-label={`Remove page ${i + 1}`}
                  className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-red-600 text-white text-xs leading-none disabled:opacity-50"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={extract} disabled={disabled} className={primary}>
              {stageLabel ?? `Extract from ${images.length} photo${images.length === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              onClick={() => (isCoarse ? cameraRef.current?.click() : fileRef.current?.click())}
              disabled={disabled}
              className={secondary}
            >
              {compressing ? 'Adding…' : '+ Add Another Photo'}
            </button>
            <button type="button" onClick={() => setImages([])} disabled={disabled} className="text-sm text-slate-500">
              Clear
            </button>
          </div>
        </div>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Hidden inputs. capture="environment" opens the rear camera on mobile and
          is ignored on desktop. The library/file pickers omit it. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onPhotoPick} className="hidden" />
      <input ref={libraryRef} type="file" accept="image/*" multiple onChange={onPhotoPick} className="hidden" />
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={onFilePick}
        className="hidden"
      />
    </div>
  )
}
