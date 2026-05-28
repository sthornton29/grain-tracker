'use client'

import PdfViewer from '@/components/pdf-viewer'
import type { DocumentSource } from '@/components/document-capture'

// The right-hand "source document" pane shown next to a review screen. Renders
// the PDF viewer for an uploaded PDF, or a scrollable gallery of the captured
// photos so the user can cross-reference each page while editing extracted rows.
type Props = {
  source: DocumentSource | null
  className?: string
  title?: string
}

export default function SourcePreview({ source, className, title = 'Source document' }: Props) {
  if (source?.kind === 'images') {
    return (
      <div className={`overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-2 ${className ?? ''}`}>
        {source.images.map((img, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={img.id}
            src={img.dataUrl}
            alt={`${title} — page ${i + 1}`}
            className="w-full rounded border border-slate-300"
          />
        ))}
      </div>
    )
  }
  return <PdfViewer file={source?.kind === 'pdf' ? source.file : null} className={className} title={title} />
}
