'use client'

// The one drag-and-drop wrapper for every upload surface — and its LOOK.
// Wrap the existing picker (button + hidden <input type="file">, or a visible
// input) and hand it the SAME handler the browse path runs: a drop is just
// another way to arrive at that handler. It checks dropped files against the
// picker's own `accept` list (the browser does that for a click, not for a
// drop), passes one file unless `multiple`, and swallows stray window drops
// while mounted so missing the zone by an inch never navigates the tab.
//
// Every surface advertises itself the same way (one styling pass, not per
// page): a dashed card with the upload mark and "Drag & drop files here, or
// click to browse", the accepted types beneath, and a brand-green
// border/tint while a file is dragged across it. Clicking anywhere on the
// card that is not itself a control opens the first file input inside it.
// `variant="compact"` is the small one-line form for a screenshot or a logo;
// `variant="bare"` keeps the old behavior (no chrome) for the few surfaces
// that draw their own. On a touch device drag-and-drop is meaningless, so
// the copy reads "Tap to choose files" — no dead promise.

import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { dragHasFiles, filesFromDataTransfer, partitionByAccept } from '@/lib/dropzone'

export type DropzoneVariant = 'card' | 'compact' | 'bare'

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
  /** Plain-language accepted types shown under the headline: "PDF, photos, or Excel". */
  accepts?: string
  /** Headline override (default "Drag & drop files here, or click to browse"). */
  title?: string
  variant?: DropzoneVariant
  className?: string
  children: ReactNode
}

let guardCount = 0
function swallow(e: Event) {
  e.preventDefault()
}

/** Coarse pointer ⇒ phone/tablet: no drag-and-drop, say "tap". SSR-safe. */
export function useIsTouch(): boolean {
  const [touch, setTouch] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    setTouch(window.matchMedia('(pointer: coarse)').matches)
  }, [])
  return touch
}

export function dropzoneHeadline(args: { touch: boolean; multiple?: boolean; title?: string }): string {
  if (args.title) return args.title
  if (args.touch) return args.multiple ? 'Tap to choose files' : 'Tap to choose a file'
  return args.multiple ? 'Drag & drop files here, or click to browse' : 'Drag & drop a file here, or click to browse'
}

function UploadMark({ small }: { small?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`${small ? 'h-4 w-4' : 'h-6 w-6'} shrink-0 text-brand`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V5" />
      <path d="M8 9l4-4 4 4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"]'

export default function Dropzone({
  onFiles, accept, multiple, disabled, onReject, hint, accepts, title, variant = 'card', className, children,
}: Props) {
  const [active, setActive] = useState(false)
  const touch = useIsTouch()
  const root = useRef<HTMLDivElement>(null)
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
  function onDragLeave() {
    if (disabled) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setActive(false)
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
  // Click-to-browse anywhere on the card: forward to the first file input
  // inside, unless the click landed on a control of its own.
  function onClick(e: MouseEvent<HTMLDivElement>) {
    if (disabled || variant === 'bare') return
    const target = e.target as HTMLElement
    if (target.closest(INTERACTIVE)) return
    const input = root.current?.querySelector<HTMLInputElement>('input[type="file"]')
    input?.click()
  }

  const headline = dropzoneHeadline({ touch, multiple, title })
  const chrome =
    variant === 'card'
      ? `rounded-xl border-2 border-dashed p-3 sm:p-4 transition-colors ${active ? 'border-brand bg-brand/10' : 'border-slate-300 bg-slate-50/60 hover:border-brand/60'} ${disabled ? 'opacity-60' : 'cursor-pointer'}`
      : variant === 'compact'
        ? `rounded-lg border border-dashed px-2.5 py-2 transition-colors ${active ? 'border-brand bg-brand/10' : 'border-slate-300 bg-slate-50/60 hover:border-brand/60'} ${disabled ? 'opacity-60' : 'cursor-pointer'}`
        : active ? 'rounded-lg ring-2 ring-brand ring-offset-2' : ''

  return (
    <div
      ref={root}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      data-dropzone-active={active ? 'true' : undefined}
      data-dropzone-variant={variant}
      className={`relative ${chrome} ${className ?? ''}`}
    >
      {variant === 'card' && (
        <div className="flex items-start gap-2.5 mb-2">
          <UploadMark />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-700">{headline}</div>
            {accepts && <div className="text-xs text-slate-500">{accepts}</div>}
          </div>
        </div>
      )}
      {variant === 'compact' && (
        <div className="flex items-center gap-2 mb-1">
          <UploadMark small />
          <span className="text-xs font-medium text-slate-700">{headline}</span>
          {accepts && <span className="text-[11px] text-slate-500">· {accepts}</span>}
        </div>
      )}
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
