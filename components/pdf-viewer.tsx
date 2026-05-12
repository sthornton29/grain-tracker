'use client'

import { useEffect, useState } from 'react'

// Lightweight PDF preview using the browser's built-in viewer via <object>.
// Accepts either a File (turned into an object URL) or a remote URL.
// Caller is responsible for revoking object URLs by remounting (key change).

type Props = {
  file?: File | null
  url?: string | null
  className?: string
  title?: string
}

export default function PdfViewer({ file, url, className, title = 'PDF preview' }: Props) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setObjectUrl(null)
      return
    }
    const u = URL.createObjectURL(file)
    setObjectUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  const src = objectUrl ?? url ?? null

  if (!src) {
    return (
      <div className={`flex items-center justify-center text-sm text-slate-400 bg-slate-50 rounded-lg ${className ?? ''}`}>
        No PDF loaded yet.
      </div>
    )
  }

  return (
    <object
      data={src}
      type="application/pdf"
      title={title}
      className={`w-full h-full rounded-lg border border-slate-200 ${className ?? ''}`}
    >
      <div className="p-3 text-sm text-slate-600">
        Your browser can&apos;t display this PDF inline.{' '}
        <a href={src} target="_blank" rel="noreferrer" className="text-green-700 underline">
          Open in a new tab
        </a>
        .
      </div>
    </object>
  )
}
