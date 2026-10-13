// The sale picker's pure parts (094, 2026-10-13) — option labels, the
// open/completed split, the overfill prompt sentence and the split-row math
// behind components/sale-picker.tsx. Kept out of the component so the
// wording and the bushel arithmetic are unit-tested (lib/sale-picker.test.ts).
//
// A "choice" is one of the three ways a load is sold, as the <select> sees
// it: 'contract:<id>' · 'spot' · 'price_later' · '' (nothing picked yet).
// Split rows carry a choice + typed bushels; the LAST row always takes what
// is left of the load, so the parts can never fail to add up by a rounding
// hair — sharesFromParts then turns bushels into shares summing to exactly 1.

import {
  overfillSplit, sharesFromParts, validateSaleRows,
  type LoadSaleInput, type SalePart, type SaleType,
} from './load-sales'

export type SaleChoice =
  | { kind: 'contract'; contractId: string }
  | { kind: 'spot' }
  | { kind: 'price_later' }
  | null

export const SPOT_OPTION_LABEL = 'Spot (price at delivery)'
export const PRICE_LATER_OPTION_LABEL = 'Price later (DP / stored at buyer)'

export function choiceToValue(c: SaleChoice): string {
  if (!c) return ''
  if (c.kind === 'contract') return `contract:${c.contractId}`
  return c.kind
}

export function parseChoiceValue(v: string | null | undefined): SaleChoice {
  if (!v) return null
  if (v === 'spot') return { kind: 'spot' }
  if (v === 'price_later') return { kind: 'price_later' }
  if (v.startsWith('contract:') && v.length > 'contract:'.length) return { kind: 'contract', contractId: v.slice('contract:'.length) }
  return null
}

/** The choice a sale row expresses. */
export function choiceOfRow(r: Pick<LoadSaleInput, 'sale_type' | 'contract_id'> | null | undefined): SaleChoice {
  if (!r) return null
  if (r.sale_type === 'contract') return r.contract_id ? { kind: 'contract', contractId: r.contract_id } : null
  return { kind: r.sale_type }
}

export function sameChoice(a: SaleChoice, b: SaleChoice): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'contract' && b.kind === 'contract' ? a.contractId === b.contractId : true
}

export const fmtBu = (n: number): string => Math.round(n).toLocaleString('en-US')

/** Bushels still open on a contract — never negative. */
export function remainingBushels(contractedBu: number, deliveredBu: number): number {
  return Math.max(0, Number(contractedBu) - deliveredBu)
}

export type PickerContract = {
  id: string
  contract_number: string
  contracted_bushels: number | string
  completed_at?: string | null
}

/** Open = not marked complete and still short of its contracted bushels. */
export function isContractOpen(c: PickerContract, deliveredBu: number): boolean {
  if (c.completed_at != null) return false
  return remainingBushels(Number(c.contracted_bushels), deliveredBu) > 0
}

/** "#2002960604-10 · 45,000 bu · 1,234 bu left" — or "· complete". */
export function contractOptionLabel(c: PickerContract, deliveredBu: number): string {
  const total = Number(c.contracted_bushels)
  const tail = isContractOpen(c, deliveredBu) ? `${fmtBu(remainingBushels(total, deliveredBu))} bu left` : 'complete'
  return `#${c.contract_number} · ${fmtBu(total)} bu · ${tail}`
}

/** Open contracts first (in the order given), completed ones after. */
export function partitionContracts<T extends PickerContract>(
  contracts: ReadonlyArray<T>,
  deliveredByContract: ReadonlyMap<string, number>,
): { open: T[]; completed: T[] } {
  const open: T[] = [], completed: T[] = []
  for (const c of contracts) (isContractOpen(c, deliveredByContract.get(c.id) ?? 0) ? open : completed).push(c)
  return { open, completed }
}

/** "Contract 2002960604-10 has 58 bu left. Send the other 913 bu to:" */
export function overfillPromptText(contractNumber: string, remainingBu: number, overflowBu: number): string {
  return `Contract ${contractNumber} has ${fmtBu(remainingBu)} bu left. Send the other ${fmtBu(overflowBu)} bu to:`
}

/** Does picking this contract for a load of `loadBu` overfill it? */
export function overfillFor(loadBu: number, contractedBu: number, deliveredBu: number): { remaining: number; overflow: number } | null {
  const remaining = remainingBushels(contractedBu, deliveredBu)
  if (!(loadBu > 0) || !(remaining > 0)) return null
  const { overflow } = overfillSplit(loadBu, remaining)
  return overflow > 0 ? { remaining, overflow } : null
}

/** The split the overfill prompt builds: what fits on the contract, the
 *  rest on the destination picked. A 1,000 bu load onto a contract with
 *  300 left → 300 / 700, shares .3 / .7. */
export function overfillRows(
  loadBu: number,
  remainingBu: number,
  contractId: string,
  overflowTo: Exclude<SaleChoice, null>,
): LoadSaleInput[] {
  const { onContract, overflow } = overfillSplit(loadBu, remainingBu)
  const parts: SalePart[] = [{ sale_type: 'contract', contract_id: contractId, bushels: onContract }]
  if (overflow > 0) {
    parts.push(
      overflowTo.kind === 'contract'
        ? { sale_type: 'contract', contract_id: overflowTo.contractId, bushels: overflow }
        : { sale_type: overflowTo.kind, bushels: overflow },
    )
  }
  return sharesFromParts(parts, loadBu)
}

// ---------- split rows ----------

export type SplitDraftRow = {
  choice: SaleChoice
  /** Typed bushels; ignored on the last row (it takes the remainder). */
  bushels: string
  /** Optional typed bid on a spot part. */
  bid: string
}

function num(s: string): number | null {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** What the last row takes: the load minus every earlier row's bushels. */
export function splitRemainder(rows: ReadonlyArray<Pick<SplitDraftRow, 'bushels'>>, loadBu: number): number {
  const earlier = rows.slice(0, -1).reduce((s, r) => s + (num(r.bushels) ?? 0), 0)
  return Math.round((loadBu - earlier) * 1000) / 1000
}

/** Each row's effective bushels (the last one = remainder). */
export function splitRowBushels(rows: ReadonlyArray<Pick<SplitDraftRow, 'bushels'>>, loadBu: number): number[] {
  return rows.map((r, i) => (i === rows.length - 1 ? splitRemainder(rows, loadBu) : num(r.bushels) ?? 0))
}

/** The farmer-facing problem with a split, or null when it is ready to save. */
export function splitDraftError(rows: ReadonlyArray<SplitDraftRow>, loadBu: number): string | null {
  if (rows.length < 2) return 'A split needs at least two parts.'
  if (!(loadBu > 0)) return 'Enter the load’s weight first so the parts can add up.'
  if (rows.some((r) => !r.choice)) return 'Pick a sale for every part of the load.'
  const bu = splitRowBushels(rows, loadBu)
  for (let i = 0; i < rows.length - 1; i++) if (!(bu[i] > 0)) return 'Every part of the load needs bushels.'
  if (!(bu[bu.length - 1] > 0)) return 'The parts add up to more than the load — nothing is left for the last part.'
  return validateSaleRows(splitDraftToRows(rows, loadBu))
}

/** Split rows → sale rows (shares summing to exactly 1). Rows with no choice
 *  are written as contract parts without a contract so validateSaleRows
 *  names the gap; callers show splitDraftError instead of saving. */
export function splitDraftToRows(rows: ReadonlyArray<SplitDraftRow>, loadBu: number): LoadSaleInput[] {
  const bu = splitRowBushels(rows, loadBu)
  const parts: SalePart[] = rows.map((r, i) => {
    const sale_type: SaleType = r.choice ? r.choice.kind : 'contract'
    const bid = r.choice?.kind === 'spot' ? num(r.bid) : null
    return {
      sale_type,
      contract_id: r.choice?.kind === 'contract' ? r.choice.contractId : null,
      bushels: bu[i],
      spot_price: bid != null && bid > 0 ? bid : null,
      spot_price_source: bid != null && bid > 0 ? 'entered' : null,
    }
  })
  return sharesFromParts(parts, loadBu)
}

/** Saved rows → editable split rows (bushels = share × the load's dry bushels). */
export function rowsToSplitDraft(rows: ReadonlyArray<LoadSaleInput>, loadBu: number): SplitDraftRow[] {
  const draft = rows.map((r) => ({
    choice: choiceOfRow(r),
    bushels: loadBu > 0 ? String(Math.round(r.share * loadBu * 10) / 10) : '',
    bid: r.sale_type === 'spot' && r.spot_price_source === 'entered' && r.spot_price != null ? String(r.spot_price) : '',
  }))
  while (draft.length < 2) draft.push({ choice: null, bushels: '', bid: '' })
  return draft
}
