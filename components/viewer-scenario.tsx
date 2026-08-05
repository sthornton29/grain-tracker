'use client'

// Small UI bits for the viewer's private assumption overrides (052).
// ScenarioChip marks a value the viewer has privately re-assumed, with a
// reset back to the official number; SupersededNotice is the one-time line
// shown when an admin change silently reverted some of their scenario.

export function ScenarioChip({ onReset }: { onReset: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] rounded-full bg-violet-100 text-violet-800 px-2 py-0.5 align-middle whitespace-nowrap no-print">
      your scenario
      <button
        type="button"
        onClick={onReset}
        title="Reset to the official value"
        className="font-bold hover:text-violet-950 leading-none"
        aria-label="Reset to the official value"
      >
        ↺
      </button>
    </span>
  )
}

export function SupersededNotice({ show, onDismiss }: { show: boolean; onDismiss: () => void }) {
  if (!show) return null
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-violet-50 border border-violet-200 text-violet-900 text-sm px-3 py-2 no-print">
      <span>Assumptions were updated by the administrator — some of your scenario values were reset to the official numbers.</span>
      <button type="button" onClick={onDismiss} className="font-bold hover:text-violet-950" aria-label="Dismiss">✕</button>
    </div>
  )
}
