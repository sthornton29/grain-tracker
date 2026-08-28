'use client'

// The settlement's Discounts block: itemized discount lines with ¢/bu, the
// sum check against the statement's line totals, the effective price walk
// (gross → less discounts → net), and the excess-shrink line. Items are
// editable in place — settlements entered by hand, or statements the AI
// couldn't fully itemize, get their breakdown here.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  DISCOUNT_CATEGORIES,
  DISCOUNT_CATEGORY_LABELS,
  centsPerBu,
  coerceDiscountCategory,
  effectivePriceWalk,
  excessShrink,
  sumCheck,
} from '@/lib/settlement-discounts'
import type { SettlementDiscountItem } from '@/lib/types'

type ItemDraft = {
  category: string
  description: string
  amount: string
  rate_note: string
  quantity_basis: string
}

const emptyDraft = (): ItemDraft => ({ category: 'other', description: '', amount: '', rate_note: '', quantity_basis: '' })

const fmt = (n: number | null | undefined, d = 2) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtCents = (n: number | null | undefined) =>
  n == null ? '—' : `${Number(n).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}¢`

export default function DiscountsBlock({
  settlementId, initialItems, settledBu, grossRevenue, discountTotal, ourDryBu, matchedSettledBu, avgPricePerBu, canEdit,
}: {
  settlementId: string
  initialItems: SettlementDiscountItem[]
  /** Σ line net_bushels — the buyer's pay bushels (all lines). */
  settledBu: number
  grossRevenue: number
  /** Σ line discounts — the statement's authoritative total. */
  discountTotal: number
  /** Σ FSA-standard dry bushels over the MATCHED lines' loads; null when no
   *  lines are matched (the shrink comparison needs our side of the scale). */
  ourDryBu: number | null
  /** Σ pay bushels over the SAME matched lines — the like-for-like other
   *  side of the shrink comparison. */
  matchedSettledBu: number
  /** Bushels-weighted net $/bu of the matched lines (monetizes the shrink gap). */
  avgPricePerBu: number | null
  /** False for read-only roles — hides the add/edit affordances. */
  canEdit: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<SettlementDiscountItem[]>(initialItems)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ItemDraft>(emptyDraft())
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const check = sumCheck(items, discountTotal)
  const walk = effectivePriceWalk({ grossRevenue, discountTotal, settledBu })
  const shrink = ourDryBu != null && avgPricePerBu != null && matchedSettledBu > 0
    ? excessShrink({ ourDryBu, settledBu: matchedSettledBu, pricePerBu: avgPricePerBu })
    : null

  function startEdit(item: SettlementDiscountItem) {
    setEditingId(item.id)
    setAdding(false)
    setDraft({
      category: item.category,
      description: item.description ?? '',
      amount: String(item.amount ?? ''),
      rate_note: item.rate_note ?? '',
      quantity_basis: item.quantity_basis ?? '',
    })
  }

  function draftRow() {
    return {
      category: coerceDiscountCategory(draft.category),
      description: draft.description.trim() || null,
      amount: Number(draft.amount) || 0,
      rate_note: draft.rate_note.trim() || null,
      quantity_basis: draft.quantity_basis.trim() || null,
    }
  }

  async function saveDraft() {
    setErr(null)
    const row = draftRow()
    if (adding) {
      const { data, error } = await supabase
        .from('settlement_discount_items')
        .insert({ settlement_id: settlementId, ...row })
        .select('*')
        .single()
      if (error) { setErr(error.message); return }
      setItems((xs) => [...xs, data as SettlementDiscountItem])
      setAdding(false)
    } else if (editingId) {
      const { error } = await supabase
        .from('settlement_discount_items')
        .update(row)
        .eq('id', editingId)
      if (error) { setErr(error.message); return }
      setItems((xs) => xs.map((x) => (x.id === editingId ? { ...x, ...row } : x)))
      setEditingId(null)
    }
    setDraft(emptyDraft())
  }

  async function removeItem(item: SettlementDiscountItem) {
    if (!confirm('Delete this discount line?')) return
    setErr(null)
    const { error } = await supabase.from('settlement_discount_items').delete().eq('id', item.id)
    if (error) { setErr(error.message); return }
    setItems((xs) => xs.filter((x) => x.id !== item.id))
  }

  const editorRow = (
    <tr className="border-t border-slate-100 bg-slate-50 align-top">
      <td className="px-3 py-2">
        <select
          value={draft.category}
          onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
        >
          {DISCOUNT_CATEGORIES.map((c) => <option key={c} value={c}>{DISCOUNT_CATEGORY_LABELS[c]}</option>)}
        </select>
      </td>
      <td className="px-3 py-2">
        <input
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="The statement's wording"
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm w-full"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="number" step="0.01" value={draft.amount}
          onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm w-24 text-right"
        />
      </td>
      <td className="px-3 py-2 text-right text-slate-400 tabular-nums">
        {fmtCents(centsPerBu(Number(draft.amount) || 0, settledBu))}
      </td>
      <td className="px-3 py-2">
        <input
          value={draft.rate_note}
          onChange={(e) => setDraft((d) => ({ ...d, rate_note: e.target.value }))}
          placeholder="Rate, e.g. 4¢/lb under 54"
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm w-full"
        />
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <button type="button" onClick={saveDraft} className="text-green-700 font-semibold text-sm mr-2">Save</button>
        <button
          type="button"
          onClick={() => { setAdding(false); setEditingId(null); setDraft(emptyDraft()) }}
          className="text-slate-500 text-sm"
        >Cancel</button>
      </td>
    </tr>
  )

  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <div className="px-4 pt-3 pb-2 border-b border-slate-100 flex items-start gap-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Discounts</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Every deduction on this settlement, shown in dollars and in cents per settled bushel.
          </p>
        </div>
        {canEdit && !adding && editingId == null && (
          <button
            type="button"
            onClick={() => { setAdding(true); setDraft(emptyDraft()) }}
            className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-1.5"
          >
            + Add discount line
          </button>
        )}
      </div>

      {err && <p className="px-4 py-2 text-sm text-red-600">{err}</p>}

      {check.mismatch && (
        <div className="mx-4 mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
          The itemized lines add to ${fmt(check.itemizedTotal)}, but the settlement&rsquo;s discount total is ${fmt(discountTotal)} —
          a ${fmt(Math.abs(check.delta))} {check.delta > 0 ? 'overage' : 'gap'}. Part of the statement may not be itemized;
          you can add or correct the lines here.
        </div>
      )}

      {items.length === 0 && !adding ? (
        <div className="px-4 py-4 text-sm text-slate-400">
          No itemized discounts recorded{canEdit ? ' — add the statement’s deduction lines to see each one in ¢/bu' : ''}.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                {['Category', 'Statement wording', '$', '¢/bu', 'Rate', '']
                  .map((h, i) => (
                    <th key={h || i} className={`px-3 py-2 whitespace-nowrap ${h === '$' || h === '¢/bu' ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                editingId === item.id ? <EditorRowWrap key={item.id}>{editorRow}</EditorRowWrap> : (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 whitespace-nowrap">{DISCOUNT_CATEGORY_LABELS[coerceDiscountCategory(item.category)]}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {item.description ?? <span className="text-slate-300">—</span>}
                      {item.quantity_basis && <span className="text-xs text-slate-400 ml-1">({item.quantity_basis})</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">${fmt(Number(item.amount))}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtCents(centsPerBu(Number(item.amount), settledBu))}</td>
                    <td className="px-3 py-2 text-slate-500">{item.rate_note ?? ''}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      {canEdit && (
                        <>
                          <button type="button" onClick={() => startEdit(item)} className="text-brand-deep text-sm mr-2">Edit</button>
                          <button type="button" onClick={() => removeItem(item)} className="text-red-600 text-sm">Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              ))}
              {adding && editorRow}
              <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                <td className="px-3 py-2" colSpan={2}>Total discounts (statement)</td>
                <td className="px-3 py-2 text-right tabular-nums">${fmt(discountTotal)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtCents(walk.discountCentsPerBu)}</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* The effective price walk + the shrink cost the price discounts don't show. */}
      <div className="px-4 py-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Effective price</div>
          <div className="tabular-nums">
            Gross <span className="font-semibold">${fmt(walk.grossPerBu)}</span>/bu
            <span className="text-slate-400 mx-1.5">−</span>
            discounts <span className="font-semibold text-red-700">{fmtCents(walk.discountCentsPerBu)}</span>/bu
            <span className="text-slate-400 mx-1.5">=</span>
            net <span className="font-semibold">${fmt(walk.netPerBu)}</span>/bu
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Weight deduction beyond standard shrink</div>
          {shrink == null ? (
            <div className="text-slate-400">Needs matched loads with weights and moisture to compare.</div>
          ) : (
            <div className="tabular-nums">
              <span className={shrink.bu > 0 ? 'text-red-700 font-semibold' : shrink.bu < 0 ? 'text-green-700 font-semibold' : 'text-slate-500'}>
                {fmt(Math.abs(shrink.bu))} bu {shrink.bu >= 0 ? 'fewer' : 'more'} than our FSA-standard dry bushels
              </span>
              <span className="text-slate-500"> · ${fmt(Math.abs(shrink.dollars))} · {fmtCents(shrink.centsPerBu != null ? Math.abs(shrink.centsPerBu) : null)}/bu {shrink.bu >= 0 ? 'cost' : 'in your favor'}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Keyed wrapper so an in-place editor row keeps React reconciliation happy.
function EditorRowWrap({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
