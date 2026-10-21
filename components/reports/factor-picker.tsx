'use client'

// The Bale Quality factor picker (2026-10-20): chips to show / hide each
// grade factor, drag to reorder (and ◀ ▶ buttons, because drag-and-drop is
// unreliable on a touch screen), and the three presets.

import { useState } from 'react'
import { FACTORS, FACTOR_ORDER, FACTOR_PRESETS, type FactorKey } from '@/lib/cotton-quality'

export function FactorPicker({ value, onChange }: { value: FactorKey[]; onChange: (next: FactorKey[]) => void }) {
  const [dragging, setDragging] = useState<FactorKey | null>(null)
  const [over, setOver] = useState<FactorKey | null>(null)
  const hidden = FACTOR_ORDER.filter((k) => !value.includes(k))

  const move = (key: FactorKey, dir: -1 | 1) => {
    const i = value.indexOf(key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= value.length) return
    const next = [...value]
    next.splice(i, 1)
    next.splice(j, 0, key)
    onChange(next)
  }
  const dropOn = (target: FactorKey) => {
    if (!dragging || dragging === target) { setDragging(null); setOver(null); return }
    const next = value.filter((k) => k !== dragging)
    const j = next.indexOf(target)
    next.splice(j, 0, dragging)
    onChange(next)
    setDragging(null)
    setOver(null)
  }
  const presetMatch = (Object.keys(FACTOR_PRESETS) as Array<keyof typeof FACTOR_PRESETS>).find((p) => FACTOR_PRESETS[p].factors.join(',') === value.join(','))

  return (
    <div className="text-sm flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-500">Factors</span>
        {(Object.keys(FACTOR_PRESETS) as Array<keyof typeof FACTOR_PRESETS>).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={presetMatch === p}
            onClick={() => onChange([...FACTOR_PRESETS[p].factors])}
            className={presetMatch === p ? 'rounded-full bg-slate-800 text-white px-3 min-h-10 text-xs font-semibold' : 'rounded-full bg-white border border-slate-300 text-slate-700 px-3 min-h-10 text-xs'}
          >
            {FACTOR_PRESETS[p].label}
          </button>
        ))}
        <span className="text-xs text-slate-400">Drag a chip to reorder, or use the arrows. Tap a gray chip to add it.</span>
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {value.map((k) => (
          <span
            key={k}
            draggable
            onDragStart={() => setDragging(k)}
            onDragOver={(e) => { e.preventDefault(); if (over !== k) setOver(k) }}
            onDragLeave={() => { if (over === k) setOver(null) }}
            onDrop={(e) => { e.preventDefault(); dropOn(k) }}
            onDragEnd={() => { setDragging(null); setOver(null) }}
            className={`inline-flex items-center rounded-full bg-brand text-white text-xs font-semibold min-h-10 pl-1 pr-1 select-none ${over === k && dragging !== k ? 'ring-2 ring-brand-dark' : ''} ${dragging === k ? 'opacity-60' : ''}`}
          >
            <button type="button" aria-label={`Move ${FACTORS[k].short} left`} onClick={() => move(k, -1)} className="px-1.5 min-h-10 text-white/80 hover:text-white">◀</button>
            <button type="button" aria-pressed="true" onClick={() => onChange(value.filter((x) => x !== k))} className="px-1 min-h-10 cursor-grab">{FACTORS[k].short} ✕</button>
            <button type="button" aria-label={`Move ${FACTORS[k].short} right`} onClick={() => move(k, 1)} className="px-1.5 min-h-10 text-white/80 hover:text-white">▶</button>
          </span>
        ))}
        {hidden.map((k) => (
          <button key={k} type="button" aria-pressed="false" onClick={() => onChange([...value, k])} className="rounded-full bg-white border border-slate-300 text-slate-600 px-3 min-h-10 text-xs">
            + {FACTORS[k].short}
          </button>
        ))}
      </div>
    </div>
  )
}
