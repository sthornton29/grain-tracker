'use client'

// A one-column name list (trucks, hauler trucks): add, rename, delete. Used
// embedded in settings pages, so the heading level is a prop — a page
// already has its H1. Deletes go through the app's confirm dialog and are
// blocked (with a count) when loads still point at the row.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { reportError } from '@/lib/friendly-error'
import { useDialogs, plural } from '@/components/use-dialogs'

type Row = { id: string } & Record<string, any>

type Props = {
  title: string
  table: string
  /** Column on the row that holds the text value. Usually "name" or "name_or_number". */
  labelColumn: 'name' | 'name_or_number'
  placeholder?: string
  /** What one row is called in messages ("truck"). Defaults from the title. */
  noun?: string
  /** Heading level: 'h1' when this is the page, 'h2' when embedded under a page H1. */
  heading?: 'h1' | 'h2'
  /** Where rows are referenced from, so a delete can be blocked with a count
   *  ("KB Wild has 12 loads and can't be deleted"). */
  usedBy?: { table: string; column: string; noun: string }
  /** What to do instead of the first row ("add the first one above"). */
  emptyHint?: string
}

export default function SimpleCrud({ title, table, labelColumn, placeholder, noun, heading = 'h1', usedBy, emptyHint }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[]>([])
  const [value, setValue] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, dialogs } = useDialogs()
  const what = noun ?? title.toLowerCase().replace(/s$/, '')

  async function refresh() {
    const { data, error } = await supabase.from(table).select('*').order(labelColumn)
    if (error) { setErr(reportError(error, { action: `load your ${title.toLowerCase()}`, noun: what })); return }
    setRows((data as Row[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const nameTaken = (name: string, exceptId?: string) =>
    rows.some((r) => r.id !== exceptId && String(r[labelColumn] ?? '').trim().toLowerCase() === name.toLowerCase())

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const name = value.trim()
    if (!name) return
    if (nameTaken(name)) { setErr(`A ${what} named “${name}” already exists.`); return }
    const { error } = await supabase.from(table).insert({ [labelColumn]: name })
    if (error) { setErr(reportError(error, { action: `add the ${what}`, noun: what, name })); return }
    setValue(''); setErr(null); refresh()
  }

  async function save(id: string) {
    const name = editingValue.trim()
    if (!name) return
    if (nameTaken(name, id)) { setErr(`A ${what} named “${name}” already exists.`); return }
    const { error } = await supabase.from(table).update({ [labelColumn]: name }).eq('id', id)
    if (error) { setErr(reportError(error, { action: `rename the ${what}`, noun: what, name })); return }
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(r: Row) {
    setErr(null)
    const name = String(r[labelColumn] ?? '')
    if (usedBy) {
      const { count } = await supabase.from(usedBy.table).select('id', { count: 'exact', head: true }).eq(usedBy.column, r.id)
      if ((count ?? 0) > 0) {
        setErr(`${name} has ${plural(count ?? 0, usedBy.noun)} recorded against it, so it can’t be deleted. Rename it instead if it’s no longer in use.`)
        return
      }
    }
    const ok = await confirm({ title: `Delete ${name}?`, body: `This ${what} will be removed from the list. Records already entered keep the name as it was.`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    setBusy(true)
    const { error } = await supabase.from(table).delete().eq('id', r.id)
    setBusy(false)
    if (error) { setErr(reportError(error, { action: `delete the ${what}`, noun: what, name })); return }
    refresh()
  }

  const Heading = heading
  const inputId = `simple-crud-${table}-add`
  const btnCls = 'min-h-11 px-3 rounded-lg text-sm font-semibold'

  return (
    <div className="space-y-4">
      <Heading className={heading === 'h1' ? 'text-2xl font-bold' : 'text-lg font-semibold'}>{title}</Heading>

      <form onSubmit={add} className="flex gap-2 items-end">
        <label htmlFor={inputId} className="flex-1 block text-sm text-slate-700">
          {placeholder ?? `New ${what}`}
          <input
            id={inputId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder ?? `Add ${what}`}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-11"
          />
        </label>
        <button className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold">Add</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <ul className="bg-white rounded-xl shadow divide-y">
        {rows.length === 0 && (
          <li className="px-4 py-6 text-center text-slate-500">
            No {title.toLowerCase()} yet — {emptyHint ?? 'add the first one above'}.
          </li>
        )}
        {rows.map((r) => (
          <li key={r.id} className="px-3 sm:px-4 py-1.5 flex items-center gap-2">
            {editingId === r.id ? (
              <>
                <input
                  autoFocus
                  aria-label={`Rename ${r[labelColumn]}`}
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(r.id) } if (e.key === 'Escape') setEditingId(null) }}
                  className="flex-1 min-w-0 rounded-lg border border-slate-300 px-3 py-2 min-h-11"
                />
                <button type="button" onClick={() => save(r.id)} className={`${btnCls} text-green-700`}>Save</button>
                <button type="button" onClick={() => setEditingId(null)} className={`${btnCls} text-slate-500`}>Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1 min-w-0 truncate py-2">{r[labelColumn]}</span>
                <button
                  type="button"
                  onClick={() => { setEditingId(r.id); setEditingValue(r[labelColumn]) }}
                  className={`${btnCls} text-brand-deep`}
                >Edit</button>
                <button type="button" disabled={busy} onClick={() => remove(r)} className={`${btnCls} text-red-600 disabled:opacity-50`}>Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {dialogs}
    </div>
  )
}
