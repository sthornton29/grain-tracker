'use client'

// The app's own dialogs — used instead of window.confirm / alert / prompt,
// which on iPad Safari are bare system modals with no numeric keyboard, no
// counts, and no styling. Portaled to document.body (the inline-modal rule:
// a dialog rendered inside a <label> or <form> gets re-triggered by label
// activation on iPad), with role="dialog", aria-modal, Escape-to-close, a
// focus trap, and the confirm button focused on open.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function AppModal({ open, title, children, onClose, size = 'md', initialFocus = 'first' }: {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
  size?: 'sm' | 'md' | 'lg'
  /** Which element gets focus on open: the first focusable, or none. */
  initialFocus?: 'first' | 'none'
}) {
  const [mounted, setMounted] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const restore = useRef<HTMLElement | null>(null)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    restore.current = (document.activeElement as HTMLElement | null) ?? null
    const node = panel.current
    if (node && initialFocus === 'first') {
      const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>(FOCUSABLE)
      first?.focus()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      restore.current?.focus?.()
    }
  }, [open, onClose, initialFocus])

  if (!mounted || !open) return null
  const width = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-md'
  return createPortal(
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-3 sm:p-4 no-print" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        className={`bg-white rounded-xl shadow-xl p-4 sm:p-5 w-full ${width} space-y-3 max-h-[90vh] overflow-y-auto`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id="app-dialog-title" className="font-display font-semibold text-lg">{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** Yes/No confirmation. `danger` colors the confirm button red (deletes). */
export function ConfirmDialog({ open, title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, busy = false, onConfirm, onCancel }: {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <AppModal open={open} title={title} onClose={onCancel} size="sm" initialFocus="first">
      {body && <div className="text-sm text-slate-700 space-y-2">{body}</div>}
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm">{cancelLabel}</button>
        <button
          type="button"
          data-autofocus
          disabled={busy}
          onClick={onConfirm}
          className={`rounded-lg px-4 min-h-11 text-sm font-semibold text-white disabled:opacity-50 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand hover:bg-brand-deep'}`}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </AppModal>
  )
}

/** A one-button notice (replaces alert()). */
export function NoticeDialog({ open, title, body, onClose, label = 'OK' }: {
  open: boolean
  title: string
  body?: ReactNode
  onClose: () => void
  label?: string
}) {
  return (
    <AppModal open={open} title={title} onClose={onClose} size="sm">
      {body && <div className="text-sm text-slate-700 space-y-2">{body}</div>}
      <div className="flex justify-end pt-1">
        <button type="button" data-autofocus onClick={onClose} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold">{label}</button>
      </div>
    </AppModal>
  )
}

/** Ask for one value (replaces prompt()). Numeric by default with the
 *  decimal keyboard on iPad. */
export function PromptDialog({ open, title, body, label, initial = '', unit, numeric = true, confirmLabel = 'Save', onSubmit, onCancel }: {
  open: boolean
  title: string
  body?: ReactNode
  label: string
  initial?: string
  unit?: string
  numeric?: boolean
  confirmLabel?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  useEffect(() => { if (open) setValue(initial) }, [open, initial])
  return (
    <AppModal open={open} title={title} onClose={onCancel} size="sm">
      <form
        onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); onSubmit(value) }}
        className="space-y-3"
      >
        {body && <div className="text-sm text-slate-700">{body}</div>}
        <label className="block text-sm">
          <span className="text-slate-600">{label}</span>
          <span className="mt-1 flex items-center gap-2">
            <input
              data-autofocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode={numeric ? 'decimal' : 'text'}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base min-h-11"
            />
            {unit && <span className="text-sm text-slate-500 whitespace-nowrap">{unit}</span>}
          </span>
        </label>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm">Cancel</button>
          <button type="submit" className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold">{confirmLabel}</button>
        </div>
      </form>
    </AppModal>
  )
}
