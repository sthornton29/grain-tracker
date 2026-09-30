'use client'

import { useEffect } from 'react'
import { defaultEntityId } from '@/lib/entity-default'

/**
 * The one entity picker for data-entry forms (NOT report filters).
 *
 * Single-entity operation → the entity is auto-assigned through
 * lib/entity-default's defaultEntityId: the field either disappears
 * (default) or renders pre-filled and disabled (`showWhenSingle`, for forms
 * like contracts where seeing the entity name aids confidence). The parent's
 * state is stamped via onChange exactly as if the user had picked it, so the
 * saved record is indistinguishable from a manual selection.
 *
 * Multi-entity operation → the ordinary required/optional dropdown, unchanged.
 *
 * The auto answer is derived from the `entities` prop on every render —
 * nothing is cached, so the moment a second entity exists the dropdown
 * reappears on the next render with fresh data.
 *
 * `label` renders a visible <label> around the select — and ONLY when the
 * select itself renders, so a single-entity form never shows an orphaned
 * "Entity" caption over nothing.
 */
export default function EntitySelect({
  entities, value, onChange, className, placeholder = '— entity —', showWhenSingle = false, label,
}: {
  entities: ReadonlyArray<{ id: string; name: string }>
  value: string
  onChange: (id: string) => void
  className?: string
  placeholder?: string
  /** Render a disabled, pre-filled select instead of hiding the field. */
  showWhenSingle?: boolean
  /** Visible label text above the select. */
  label?: string
}) {
  const auto = defaultEntityId(entities)

  // Auto-assign only when nothing is chosen yet — an existing record's value
  // is never rewritten (edit forms keep whatever the record carries).
  useEffect(() => {
    if (auto && !value) onChange(auto)
  }, [auto, value, onChange])

  const wrap = (node: React.ReactNode) =>
    label ? <label className="block text-sm text-slate-700">{label}<span className="block mt-1">{node}</span></label> : node

  if (auto && (!value || value === auto)) {
    if (!showWhenSingle) return null
    const name = entities[0]?.name ?? ''
    return wrap(
      <select value={auto} disabled className={className} title="Your operation has one entity, so it's filled in for you">
        <option value={auto}>{name}</option>
      </select>,
    )
  }

  return wrap(
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-label={label ? undefined : 'Entity'}>
      <option value="">{placeholder}</option>
      {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select>,
  )
}
