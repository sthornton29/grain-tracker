'use client'

// The one drag-and-drop wrapper for every upload surface. Wrap the existing
// picker (button + hidden <input type="file">, or a visible input) and hand
// it the SAME handler the browse path runs — a drop is just another way to
// arrive at that handler. It highlights while a file is dragged across it,
// checks dropped files against the picker's own `accept` list (the browser
// does that for a click, not for a drop), passes one file unless `multiple`,
// and never changes click-to-browse or touch behavior (drag events simply
// don't fire on a finger).
//
// While any dropzone is mounted the window swallows stray drops, so missing
// the zone by an inch doesn't navigate the tab to the dropped file.

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { dragHasFiles, filesFromDataTransfer, partitionByAccept } from '@/lib/dropzone'

type Props = {
  /** The browse handler: receives the accepted dropped file(s). */
  onFiles: (files: File[]) => void
  /** The picker's accept list. Dropped files outside it go to onReject. */
  accept?: string
  /** Pass through every accepted file; default hands over only the first. */
  multiple?: boolean
  disabled?: boolean
  /** Files outside `accept`. Show the surface's own validation message here. */
  onReject?: (rejected: File[]) => void
  /** Overlay text while dragging (default "Drop to upload"). */
  hint?: string
  className?: string
  children: ReactNode
}

let guardCount = 0
function swallow(e: Event) {
  e.preventDefault()
}

export default function Dropzone({ onFiles, accept, multiple, disabled, onReject, hint, className, children }: Props) {
  const [active, setActive] = useState(false)
  // dragenter/dragleave fire for every child crossed; a depth counter keeps
  // the highlight steady until the pointer leaves the zone itself.
  const depth = useRef(0)

  useEffect(() => {
    if (guardCount++ === 0) {
      window.addEventListener('dragover', swallow)
      window.addEventListener('drop', swallow)
    }
    return () => {
      if (--guardCount === 0) {
        window.removeEventListener('dragover', swallow)
        window.removeEventListener('drop', swallow)
      }
    }
  }, [])

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (disabled || !dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    depth.current += 1
    setActive(true)
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (disabled || !dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!active) setActive(true)
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (disabled) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setActive(false)
    void e
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    depth.current = 0
    setActive(false)
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    const dropped = filesFromDataTransfer(e.dataTransfer)
    if (dropped.length === 0) return
    const { accepted, rejected } = partitionByAccept(dropped, accept)
    const handoff = multiple ? accepted : accepted.slice(0, 1)
    if (rejected.length > 0) onReject?.(rejected)
    if (handoff.length > 0) onFiles(handoff)
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-dropzone-active={active ? 'true' : undefined}
      className={`relative ${active ? 'rounded-lg ring-2 ring-brand ring-offset-2' : ''} ${className ?? ''}`}
    >
      {children}
      {active && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand/10"
        >
          <span className="rounded-md bg-white/90 px-2 py-1 text-sm font-semibold text-brand-deep shadow-sm">
            {hint ?? 'Drop to upload'}
          </span>
        </div>
      )}
    </div>
  )
}

/** The plain-language rejection line for a surface that had no message of its
 *  own (its picker did the filtering): names what the surface accepts. */
export function rejectMessage(accepts: string, rejected: readonly File[]): string {
  const name = rejected[0]?.name
  const lead = rejected.length === 1 && name ? `"${name}" isn't a file type this accepts.` : "Those files aren't a type this accepts."
  return `${lead} ${accepts}`
}
