'use client'

// Promise-style wrappers over the app dialogs so a page can replace
// `if (!confirm('…')) return` with `if (!(await confirm({ … }))) return`
// and `prompt('…')` with `await prompt({ … })` without restructuring its
// handlers. Render `{dialogs}` once anywhere in the page's tree — the
// dialogs themselves portal to document.body.

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog, PromptDialog } from '@/components/app-dialog'

export type ConfirmOptions = {
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button — deletes and other one-way actions. */
  danger?: boolean
}

export type PromptOptions = {
  title: string
  label: string
  body?: ReactNode
  initial?: string
  unit?: string
  /** Decimal keyboard on iPad (default true). */
  numeric?: boolean
  confirmLabel?: string
}

export function useDialogs() {
  const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null)
  const [promptState, setPromptState] = useState<PromptOptions | null>(null)
  const confirmResolve = useRef<((v: boolean) => void) | null>(null)
  const promptResolve = useRef<((v: string | null) => void) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    confirmResolve.current = resolve
    setConfirmState(opts)
  }), [])

  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>((resolve) => {
    promptResolve.current = resolve
    setPromptState(opts)
  }), [])

  // Stable handlers: AppModal re-runs its focus/keyboard effect whenever
  // onClose changes, so these must not be re-created per render.
  const onConfirm = useCallback(() => { confirmResolve.current?.(true); confirmResolve.current = null; setConfirmState(null) }, [])
  const onCancelConfirm = useCallback(() => { confirmResolve.current?.(false); confirmResolve.current = null; setConfirmState(null) }, [])
  const onSubmitPrompt = useCallback((v: string) => { promptResolve.current?.(v); promptResolve.current = null; setPromptState(null) }, [])
  const onCancelPrompt = useCallback(() => { promptResolve.current?.(null); promptResolve.current = null; setPromptState(null) }, [])

  const dialogs = (
    <>
      <ConfirmDialog
        open={confirmState != null}
        title={confirmState?.title ?? ''}
        body={confirmState?.body}
        confirmLabel={confirmState?.confirmLabel ?? 'OK'}
        cancelLabel={confirmState?.cancelLabel ?? 'Cancel'}
        danger={confirmState?.danger ?? false}
        onConfirm={onConfirm}
        onCancel={onCancelConfirm}
      />
      <PromptDialog
        open={promptState != null}
        title={promptState?.title ?? ''}
        body={promptState?.body}
        label={promptState?.label ?? ''}
        initial={promptState?.initial ?? ''}
        unit={promptState?.unit}
        numeric={promptState?.numeric ?? true}
        confirmLabel={promptState?.confirmLabel ?? 'Save'}
        onSubmit={onSubmitPrompt}
        onCancel={onCancelPrompt}
      />
    </>
  )

  // String-in versions for pages that already have a good sentence: the
  // first line (or the question up to "?") becomes the title, the rest the
  // body; a message that starts with a one-way verb gets the red button.
  const confirmText = useCallback((message: string, opts: Partial<ConfirmOptions> = {}) => {
    const { title, body } = splitMessage(message)
    const danger = opts.danger ?? /^(delete|forfeit|disconnect|end |revoke|remove)/i.test(message.trim())
    const confirmLabel = opts.confirmLabel ?? (/^delete/i.test(message.trim()) ? 'Delete' : 'Yes, continue')
    return confirm({ title: opts.title ?? title, body: opts.body ?? body, danger, confirmLabel, cancelLabel: opts.cancelLabel })
  }, [confirm])

  const promptText = useCallback((message: string, initial = '', opts: Partial<PromptOptions> = {}) => {
    const { title, rest } = splitMessage(message)
    const numeric = opts.numeric ?? /\$|price|amount|awp|\/lb|rate/i.test(message)
    return prompt({ title: opts.title ?? (rest ? title : 'Enter a value'), label: rest || title, initial, numeric, unit: opts.unit, confirmLabel: opts.confirmLabel })
  }, [prompt])

  return { confirm, prompt, confirmText, promptText, dialogs }
}

function splitMessage(message: string): { title: string; rest: string; body?: ReactNode } {
  const text = message.trim()
  const nl = text.indexOf('\n')
  const q = text.indexOf('?')
  let cut = -1
  if (nl >= 0 && q >= 0) cut = Math.min(nl, q + 1)
  else if (nl >= 0) cut = nl
  else if (q >= 0 && q < text.length - 1) cut = q + 1
  if (cut < 0 || cut >= text.length) return { title: text, rest: '' }
  const title = text.slice(0, cut).trim()
  const rest = text.slice(cut).trim()
  if (!rest) return { title, rest: '' }
  return { title, rest, body: <span className="whitespace-pre-wrap">{rest}</span> }
}

/** "3 fields" / "1 field" — for the counts in delete confirmations. */
export function plural(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? noun : pluralNoun}`
}
