'use client'

// The irrigated / dryland split editor for a mixed-practice planting — ONE
// form for grain (dry bushels) and cotton (lint lbs) on the Yields page.
// Typing one side fills the other with the remainder (until the other side is
// typed in by hand), and Save holds until the two sides add up to the field's
// production. The page owns where the split is saved and what it means
// (lib/yields resolvePracticeBreakout / resolveCottonPracticeBreakout); this
// form only collects two numbers that add up.

import { useState, type ReactNode } from 'react'
import { fmtInt, selectCls } from '@/components/reports/report-format'

export default function PracticeSplitEditor({
  total, unitNoun, totalLabel, decimals, initialIrr, initialDry, note, saving, error, canClear, onSave, onCancel, onClear,
}: {
  /** The field's production; irrigated + dryland must add up to it. */
  total: number
  /** 'bushels' or 'lint lbs' — the inputs and the message speak in it. */
  unitNoun: string
  /** 'Total dry bushels' / 'Total lint lbs'. */
  totalLabel: string
  /** Decimal places the remainder fills in with: 2 for bushels, 0 for lint pounds. */
  decimals: number
  initialIrr: string
  initialDry: string
  note?: ReactNode
  saving: boolean
  error: string | null
  /** A split is saved: offer Clear. */
  canClear: boolean
  onSave: (irrigated: number, dryland: number) => void
  onCancel: () => void
  onClear: () => void
}) {
  const [irr, setIrr] = useState(initialIrr)
  const [dry, setDry] = useState(initialDry)
  // Which input the user typed in last — the other one auto-fills with the
  // remainder until it has been typed in by hand.
  const [lastTouched, setLastTouched] = useState<'irr' | 'dry' | null>(null)
  const round = (n: number) => String(Number(n.toFixed(decimals)))
  // Bushels come off yield maps with two decimals, so 0.01 is plenty of slack;
  // whole pounds of lint against a total that can carry a fraction get 1 lb.
  const tolerance = decimals === 0 ? 1 : 0.01

  function typeIrr(v: string) {
    setIrr(v)
    setLastTouched('irr')
    if (lastTouched !== 'dry') setDry(v === '' ? '' : round(Math.max(0, total - (Number(v) || 0))))
  }
  function typeDry(v: string) {
    setDry(v)
    setLastTouched('dry')
    if (lastTouched !== 'irr') setIrr(v === '' ? '' : round(Math.max(0, total - (Number(v) || 0))))
  }
  const i = Number(irr || 0) || 0
  const d = Number(dry || 0) || 0
  const sumValid = Math.abs(i + d - total) < tolerance
  const step = decimals === 0 ? '1' : '0.01'
  const inputMode = decimals === 0 ? 'numeric' : 'decimal'

  return (
    <div>
      {note && <div className="text-xs text-slate-600 mb-2">{note}</div>}
      <div className="flex flex-wrap items-end gap-3">
        <div className="text-sm text-slate-600">
          {totalLabel}: <span className="font-semibold">{fmtInt(total)}</span>
        </div>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Irrigated {unitNoun}
          <input type="number" step={step} min="0" inputMode={inputMode} value={irr} onChange={(e) => typeIrr(e.target.value)} className={`${selectCls} w-40`} />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Dryland {unitNoun}
          <input type="number" step={step} min="0" inputMode={inputMode} value={dry} onChange={(e) => typeDry(e.target.value)} className={`${selectCls} w-40`} />
        </label>
        <button
          type="button"
          disabled={saving || !sumValid}
          onClick={() => onSave(i, d)}
          className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-10 text-sm font-semibold disabled:opacity-50"
        >Save</button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center min-h-10 px-3 rounded-lg border border-slate-300 bg-white text-slate-600 text-sm"
        >Cancel</button>
        {canClear && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center min-h-10 px-3 rounded-lg text-red-700 text-sm ml-auto hover:bg-red-50"
          >Clear breakout</button>
        )}
      </div>
      {!sumValid && (irr !== '' || dry !== '') && (
        <p className="text-sm text-red-600 mt-2">
          Irrigated + Dryland {unitNoun} must equal total {unitNoun} ({fmtInt(total)})
        </p>
      )}
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  )
}
