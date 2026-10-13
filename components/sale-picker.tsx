'use client'

// How a buyer load is sold — the ONE picker (094, 2026-10-13), used by the
// load form (and reusable anywhere a load's sale is chosen).
//
//   * one <select>: this buyer's OPEN contracts for the crop + year first
//     ("#2002960604-10 · 45,000 bu · 1,234 bu left"), then Spot, Price
//     later, then the completed contracts (still selectable — a late load
//     can legitimately land on a contract already marked done);
//   * Spot shows "Bid $/bu (if you know it)" — blank means the form asks
//     lib/spot-estimate for an estimate when it saves;
//   * "+ Split this load" turns the choice into allocation rows (sale +
//     bushels; the last row takes the remainder);
//   * the OVERFILL prompt: picking a contract with fewer bushels left than
//     the load opens a modal — "Contract … has 58 bu left. Send the other
//     913 bu to:" — whose buttons build the split (lib/sale-picker
//     overfillRows). "Keep it all on this contract" is always an option.
//
// Value in / value out is the seam's LoadSaleInput[] (lib/load-sales); the
// pure math and wording live in lib/sale-picker.ts. The modal is AppModal
// (portaled to document.body — the picker sits inside a <form>, and an
// inline modal inside a label breaks on iPad). Every control ≥ 44px.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppModal } from '@/components/app-dialog'
import { singleSaleRow, type LoadSaleInput } from '@/lib/load-sales'
import {
  PRICE_LATER_OPTION_LABEL, SPOT_OPTION_LABEL, choiceOfRow, choiceToValue, contractOptionLabel, fmtBu, overfillFor,
  overfillPromptText, overfillRows, parseChoiceValue, partitionContracts, remainingBushels, rowsToSplitDraft, sameChoice,
  splitDraftError, splitDraftToRows, splitRowBushels, type PickerContract, type SaleChoice, type SplitDraftRow,
} from '@/lib/sale-picker'

export type SalePickerContract = PickerContract & { buyer_id?: string | null }

type Props = {
  /** This buyer's contracts for the load's crop + crop year. */
  contracts: ReadonlyArray<SalePickerContract>
  buyerName: string
  /** The load's dry bushels so far (0 while the weights are blank). */
  loadDryBu: number
  /** Delivered dry bushels per contract, EXCLUDING the load being edited. */
  deliveredByContract: ReadonlyMap<string, number>
  value: ReadonlyArray<LoadSaleInput>
  /** Rows to save + the farmer-facing reason they can't be saved yet (null when fine). */
  onChange: (rows: LoadSaleInput[], error: string | null) => void
  /** True while the form can't offer contracts yet (no crop year picked). */
  disabled?: boolean
  disabledNote?: string
  /** The form's input class so the picker matches its neighbours. */
  inputClassName?: string
}

const DEFAULT_INPUT = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 min-h-11 text-base bg-white'
const BID_INPUT = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 min-h-12 text-base bg-white tabular-nums'
const QUIET_BTN = 'rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm'
const MODAL_BTN = 'w-full rounded-lg border px-3 min-h-12 text-left text-sm font-semibold'
const OVERFILL_DELAY_MS = 700

function numStr(s: string): number | null {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

export default function SalePicker({
  contracts, buyerName, loadDryBu, deliveredByContract, value, onChange, disabled, disabledNote, inputClassName,
}: Props) {
  const inputCls = inputClassName ?? DEFAULT_INPUT
  const { open, completed } = useMemo(() => partitionContracts(contracts, deliveredByContract), [contracts, deliveredByContract])
  const contractById = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts])

  // Split rows are local draft state (typed bushels); null = single choice.
  const [draft, setDraft] = useState<SplitDraftRow[] | null>(null)
  const [bidText, setBidText] = useState<string>('')
  // The overfill prompt, and the contracts the user said "keep it all" on.
  const [overfill, setOverfill] = useState<{ contractId: string; remaining: number; overflow: number } | null>(null)
  const keepAllRef = useRef<Set<string>>(new Set())

  const singleChoice: SaleChoice = value.length === 1 ? choiceOfRow(value[0]) : null
  const isSplit = draft != null
  // The rows this picker last handed up: a value that is one of ours needs
  // no sync (the draft already describes it); anything else came from the
  // form (defaults, Save & New, a cleared crop, an edited load's rows).
  const emittedRef = useRef<ReadonlyArray<LoadSaleInput> | null>(null)
  function emit(rows: LoadSaleInput[], err: string | null) {
    emittedRef.current = rows
    onChange(rows, err)
  }

  // Keep the local state in step with a value the FORM set: cleared → back
  // to the empty single choice; a split (editing a split load) → the split
  // editor with its rows; one row → the single choice, with an entered bid
  // showing (Save & New carry-over).
  useEffect(() => {
    if (emittedRef.current === value) return
    if (value.length === 0) {
      setDraft(null)
      setBidText('')
      return
    }
    if (value.length > 1) {
      setDraft(rowsToSplitDraft(value, loadDryBu))
      return
    }
    setDraft(null)
    const r = value[0]
    const entered = r.sale_type === 'spot' && r.spot_price_source === 'entered' && r.spot_price != null ? r.spot_price : null
    setBidText((t) => (numStr(t) === entered ? t : entered != null ? String(entered) : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Re-emit split rows when the load's bushels change — the shares are
  // relative to the load, and the last row takes the new remainder.
  useEffect(() => {
    if (!draft) return
    emit(splitDraftToRows(draft, loadDryBu), splitDraftError(draft, loadDryBu))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDryBu])

  // The overfill check: a single contract choice whose remaining bushels
  // are fewer than the load. Debounced so it doesn't pop mid-keystroke
  // while the weights are being typed.
  const singleContractId = singleChoice?.kind === 'contract' ? singleChoice.contractId : null
  const deliveredOnSingle = singleContractId ? deliveredByContract.get(singleContractId) ?? 0 : 0
  useEffect(() => {
    if (!singleContractId || isSplit) { setOverfill(null); return }
    if (keepAllRef.current.has(singleContractId)) return
    const c = contractById.get(singleContractId)
    if (!c) return
    const over = overfillFor(loadDryBu, Number(c.contracted_bushels), deliveredOnSingle)
    if (!over) { setOverfill(null); return }
    const t = setTimeout(() => setOverfill({ contractId: singleContractId, ...over }), OVERFILL_DELAY_MS)
    return () => clearTimeout(t)
  }, [singleContractId, isSplit, loadDryBu, deliveredOnSingle, contractById])

  function emitSingle(choice: SaleChoice, bid: string) {
    if (!choice) { emit([], null); return }
    if (choice.kind === 'contract') { emit(singleSaleRow({ sale_type: 'contract', contract_id: choice.contractId }), null); return }
    const price = choice.kind === 'spot' ? numStr(bid) : null
    emit(singleSaleRow({ sale_type: choice.kind, spot_price: price, spot_price_source: price != null ? 'entered' : null }), null)
  }

  function pickSingle(v: string) {
    const choice = parseChoiceValue(v)
    if (choice?.kind === 'contract') keepAllRef.current.delete(choice.contractId)
    emitSingle(choice, bidText)
  }

  function changeBid(v: string) {
    setBidText(v)
    if (singleChoice?.kind === 'spot') emitSingle(singleChoice, v)
  }

  function emitDraft(rows: SplitDraftRow[]) {
    setDraft(rows)
    emit(splitDraftToRows(rows, loadDryBu), splitDraftError(rows, loadDryBu))
  }

  function startSplit() {
    const rows = rowsToSplitDraft(value.length > 0 ? value : [], loadDryBu)
    if (value.length === 1) rows[0].bushels = ''
    if (singleChoice?.kind === 'spot') rows[0].bid = bidText
    emitDraft(rows)
  }

  function endSplit() {
    const first = draft?.[0]?.choice ?? null
    setDraft(null)
    emitSingle(first, first?.kind === 'spot' ? draft?.[0]?.bid ?? '' : '')
  }

  // Stable (AppModal re-arms its focus trap whenever onClose changes).
  const keepAll = useCallback(() => {
    setOverfill((o) => {
      if (o) keepAllRef.current.add(o.contractId)
      return null
    })
  }, [])

  function applyOverfill(to: Exclude<SaleChoice, null> | 'keep') {
    if (!overfill) return
    if (to === 'keep') { keepAll(); return }
    const rows = overfillRows(loadDryBu, overfill.remaining, overfill.contractId, to)
    setOverfill(null)
    setDraft(rowsToSplitDraft(rows, loadDryBu))
    emit(rows, null)
  }

  const optionGroups = (
    <>
      {open.length > 0 && (
        <optgroup label="Open contracts">
          {open.map((c) => (
            <option key={c.id} value={choiceToValue({ kind: 'contract', contractId: c.id })}>
              {contractOptionLabel(c, deliveredByContract.get(c.id) ?? 0)}
            </option>
          ))}
        </optgroup>
      )}
      <option value="spot">{SPOT_OPTION_LABEL}</option>
      <option value="price_later">{PRICE_LATER_OPTION_LABEL}</option>
      {completed.length > 0 && (
        <optgroup label="Completed">
          {completed.map((c) => (
            <option key={c.id} value={choiceToValue({ kind: 'contract', contractId: c.id })}>
              {contractOptionLabel(c, deliveredByContract.get(c.id) ?? 0)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )

  const overfillContract = overfill ? contractById.get(overfill.contractId) : null
  const otherOpen = overfill ? open.filter((c) => c.id !== overfill.contractId) : []
  const splitBu = draft ? splitRowBushels(draft, loadDryBu) : []
  const draftError = draft ? splitDraftError(draft, loadDryBu) : null

  return (
    <div className="space-y-2">
      {!isSplit ? (
        <>
          <label className="block text-sm text-slate-700">
            Sale
            <select
              value={choiceToValue(singleChoice)}
              onChange={(e) => pickSingle(e.target.value)}
              className={inputCls}
              disabled={disabled}
              aria-label="How this load is sold"
            >
              <option value="">{disabled ? disabledNote ?? 'Select crop year first' : '— pick how this load is sold —'}</option>
              {!disabled && optionGroups}
            </select>
            <span className="mt-1 block text-xs text-slate-500 font-normal">
              {buyerName ? `${buyerName}’s contracts for this crop and year, then spot or price later.` : 'Contracts for this crop and year, then spot or price later.'}
            </span>
          </label>
          {singleChoice?.kind === 'spot' && (
            <label className="block text-sm text-slate-700">
              Bid $/bu <span className="text-xs text-slate-400">(if you know it)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                value={bidText}
                onChange={(e) => changeBid(e.target.value)}
                className={BID_INPUT}
                placeholder="e.g. 13.74"
              />
              <span className="mt-1 block text-xs text-slate-500 font-normal">
                Leave it blank and Turnrow estimates the price from the futures market and this buyer’s recent basis until the settlement arrives.
              </span>
            </label>
          )}
          {!disabled && (
            <button type="button" onClick={startSplit} className={QUIET_BTN}>
              + Split this load
            </button>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-700 flex-1">Split across {draft.length} sales</span>
            <button type="button" onClick={endSplit} className={QUIET_BTN}>Use one sale</button>
          </div>
          {draft.map((row, i) => {
            const isLast = i === draft.length - 1
            return (
              <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 w-12 shrink-0">Part {i + 1}</span>
                  <select
                    value={choiceToValue(row.choice)}
                    onChange={(e) => emitDraft(draft.map((r, j) => (j === i ? { ...r, choice: parseChoiceValue(e.target.value) } : r)))}
                    className="flex-1 min-w-0 rounded-lg border border-slate-300 px-2 py-2 min-h-11 text-base bg-white"
                    aria-label={`Sale for part ${i + 1}`}
                  >
                    <option value="">— pick a sale —</option>
                    {optionGroups}
                  </select>
                  {draft.length > 2 && (
                    <button
                      type="button"
                      onClick={() => emitDraft(draft.filter((_, j) => j !== i))}
                      className="text-red-600 text-base min-h-11 min-w-11 px-2 rounded-lg"
                      aria-label={`Remove part ${i + 1}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 w-12 shrink-0">Bushels</span>
                  {isLast ? (
                    <div className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 min-h-11 flex items-center text-base tabular-nums text-slate-700">
                      remainder: {loadDryBu > 0 ? `${fmtBu(Math.max(0, splitBu[i]))} bu` : '—'}
                    </div>
                  ) : (
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.1"
                      min="0"
                      value={row.bushels}
                      onChange={(e) => emitDraft(draft.map((r, j) => (j === i ? { ...r, bushels: e.target.value } : r)))}
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-2 min-h-11 text-base bg-white tabular-nums"
                      aria-label={`Bushels for part ${i + 1}`}
                    />
                  )}
                  {row.choice?.kind === 'contract' && (() => {
                    const c = contractById.get(row.choice.contractId)
                    if (!c) return null
                    const left = remainingBushels(Number(c.contracted_bushels), deliveredByContract.get(c.id) ?? 0)
                    return <span className="text-xs text-slate-500 whitespace-nowrap">{fmtBu(left)} bu left</span>
                  })()}
                </div>
                {row.choice?.kind === 'spot' && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 w-12 shrink-0">Bid $/bu</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.0001"
                      min="0"
                      value={row.bid}
                      onChange={(e) => emitDraft(draft.map((r, j) => (j === i ? { ...r, bid: e.target.value } : r)))}
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-2 min-h-12 text-base bg-white tabular-nums"
                      placeholder="if you know it"
                      aria-label={`Bid for part ${i + 1}`}
                    />
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => emitDraft([...draft, { choice: null, bushels: '', bid: '' }])} className={QUIET_BTN}>
              + Add another part
            </button>
            <span className="text-xs text-slate-500">
              {loadDryBu > 0 ? `${fmtBu(loadDryBu)} bu in this load` : 'Enter the weights to see the bushels.'}
            </span>
          </div>
          {draftError && <p className="text-xs text-red-700">{draftError}</p>}
        </div>
      )}

      <AppModal
        open={overfill != null && overfillContract != null}
        title="This load overfills the contract"
        onClose={keepAll}
        size="sm"
      >
        {overfill && overfillContract && (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">{overfillPromptText(overfillContract.contract_number, overfill.remaining, overfill.overflow)}</p>
            <div className="space-y-2">
              {otherOpen.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyOverfill({ kind: 'contract', contractId: c.id })}
                  className={`${MODAL_BTN} border-slate-300 bg-white hover:bg-slate-50`}
                >
                  {contractOptionLabel(c, deliveredByContract.get(c.id) ?? 0)}
                </button>
              ))}
              <button type="button" onClick={() => applyOverfill({ kind: 'spot' })} className={`${MODAL_BTN} border-slate-300 bg-white hover:bg-slate-50`}>
                Spot (price at delivery)
              </button>
              <button type="button" onClick={() => applyOverfill({ kind: 'price_later' })} className={`${MODAL_BTN} border-slate-300 bg-white hover:bg-slate-50`}>
                Price later (DP / stored at buyer)
              </button>
              <button type="button" onClick={() => applyOverfill('keep')} className={`${MODAL_BTN} border-brand text-brand-deep bg-white hover:bg-brand/10`}>
                Keep it all on this contract
              </button>
            </div>
          </div>
        )}
      </AppModal>
    </div>
  )
}
