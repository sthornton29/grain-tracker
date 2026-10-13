'use client'

// The settlement's sale review (094): per matched load, ours vs the buyer's
// allocation with the buyer's pre-selected and "Keep ours"; "Link to
// contract" for a contract number the buyer printed that is not on file;
// "It's spot" for an "S12"-style number. Shared by the New Settlement
// screen and the saved settlement's "Re-read contract assignments" action.
// Pure decisions live in lib/settlement-sale-review.ts.

import Link from 'next/link'
import {
  compareText,
  describeTheirs,
  groupsNeedingReview,
  possiblySpotLines,
  saleChipLabel,
  spotPriceChangeText,
  unresolvedContractTexts,
  type ContractLinks,
  type ReviewContract,
  type SaleChoice,
  type SaleReviewGroup,
} from '@/lib/settlement-sale-review'

export type SaleReviewProps = {
  groups: ReadonlyArray<SaleReviewGroup>
  /** This buyer's contracts, any crop year, for the link select. */
  contracts: ReadonlyArray<ReviewContract>
  contractNumberById: (id: string) => string | null | undefined
  buyerName: string
  choices: ReadonlyMap<string, SaleChoice>
  onChoice: (ticketKey: string, choice: SaleChoice) => void
  links: ContractLinks
  onLink: (textKey: string, contractId: string | null) => void
  onConfirmSpot: (lineIndexes: number[]) => void
  /** Where a missing contract gets created. */
  newContractHref: string
  /** "9/25/2026 · #1-47-0502289" for the load a group matched. */
  loadLabel?: (loadId: string) => string
  /** Hide the "every sale agrees" line (the caller prints its own summary). */
  quiet?: boolean
}

export function SaleChip({ line, fallbackContractNumber, className = '' }: {
  line: { sale_type?: string | null; contract_number_text?: string | null }
  fallbackContractNumber?: string | null
  className?: string
}) {
  const label = saleChipLabel(line, fallbackContractNumber)
  const tone = label === 'Spot' ? 'bg-sky-100 text-sky-800'
    : label === 'Price later' ? 'bg-violet-100 text-violet-800'
    : label.includes('possibly spot') ? 'bg-amber-100 text-amber-800'
    : label === 'Sale not set' ? 'bg-slate-100 text-slate-500'
    : 'bg-green-100 text-green-800'
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${tone} ${className}`}>{label}</span>
}

export default function SettlementSaleReview(p: SaleReviewProps) {
  const unresolved = unresolvedContractTexts(p.groups)
  const maybeSpot = possiblySpotLines(p.groups)
  const needing = groupsNeedingReview(p.groups).filter((g) => g.unresolved.length === 0)
  const matchedCount = p.groups.filter((g) => g.loadId).length
  const sortedContracts = [...p.contracts].sort((a, b) => (b.crop_year ?? 0) - (a.crop_year ?? 0) || a.contract_number.localeCompare(b.contract_number))
  const contractLabel = (c: ReviewContract) => `#${c.contract_number}${c.crop_year != null ? ` · ${c.crop_year} crop` : ''}`

  if (unresolved.length === 0 && maybeSpot.length === 0 && needing.length === 0) {
    if (p.quiet || matchedCount === 0) return null
    return <p className="text-xs text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">The sales on this statement agree with your loads.</p>
  }

  return (
    <div className="space-y-3">
      {unresolved.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 space-y-2" role="alert">
          <p className="font-semibold">{unresolved.length === 1 ? 'A contract number on this statement isn’t on file' : `${unresolved.length} contract numbers on this statement aren’t on file`} for {p.buyerName || 'this buyer'}.</p>
          <p className="text-xs">Link each one to the contract it is, or create the contract. Until then the loads under it keep their current sale.</p>
          <ul className="space-y-2">
            {unresolved.map((u) => (
              <li key={u.key} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">Contract {u.text}</span>
                <span className="text-xs text-amber-800">({u.lineCount} line{u.lineCount === 1 ? '' : 's'})</span>
                <select
                  value={p.links.get(u.key) ?? ''}
                  onChange={(e) => p.onLink(u.key, e.target.value || null)}
                  className="rounded-lg border border-slate-300 bg-white px-2 min-h-11 text-sm max-w-[18rem]"
                  aria-label={`Link contract ${u.text} to one of your contracts`}
                >
                  <option value="">Link to contract…</option>
                  {sortedContracts.map((c) => <option key={c.id} value={c.id}>{contractLabel(c)}</option>)}
                </select>
                <Link href={p.newContractHref} target="_blank" rel="noreferrer" className="inline-flex items-center min-h-11 px-2 text-sm underline text-brand-deep">Create contract ↗</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {maybeSpot.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex flex-wrap items-center gap-2">
          <span>
            {[...new Set(maybeSpot.map((m) => m.text))].map((t) => <span key={t} className="font-mono mr-1">{t}</span>)}
            looks like the number some elevators give a spot sale. Treated as a contract unless you say it’s spot.
          </span>
          <button type="button" onClick={() => p.onConfirmSpot(maybeSpot.map((m) => m.index))} className="rounded-lg bg-white border border-amber-400 px-3 min-h-11 text-sm font-semibold">It’s spot</button>
        </div>
      )}

      {needing.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
          <div className="px-3 py-2">
            <h3 className="font-semibold text-sm">Sale per load</h3>
            <p className="text-xs text-slate-500">Where the buyer applied a load differently from your records. The buyer’s version is picked; choose Keep ours to leave the load as you had it. The settlement’s price is used either way.</p>
          </div>
          {needing.map((g) => {
            const choice = (g.ours?.length ?? 0) === 0 ? 'theirs' : p.choices.get(g.ticketKey) ?? 'theirs'
            const onlyPrice = !g.differs && g.spotPriceChange != null
            return (
              <div key={g.ticketKey} className="px-3 py-2 text-sm space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold">Ticket {g.ticket ?? '—'}</span>
                  {g.loadId && p.loadLabel && <span className="text-xs text-slate-500">{p.loadLabel(g.loadId)}</span>}
                  {g.group.split && <span className="rounded-full bg-sky-100 text-sky-800 px-2 py-0.5 text-[11px] font-semibold">split across two sales</span>}
                  {g.lines.map((l) => <SaleChip key={l.index} line={l} />)}
                </div>
                {onlyPrice ? (
                  <p className="text-xs text-slate-600">Spot price: {spotPriceChangeText(g.spotPriceChange!)}.</p>
                ) : (
                  <>
                    <p className="text-xs text-slate-600">{compareText(g, p.contractNumberById, p.buyerName)}</p>
                    {(g.ours?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`Sale for ticket ${g.ticket ?? ''}`}>
                        <label className={`inline-flex items-center gap-2 rounded-lg border px-3 min-h-11 cursor-pointer ${choice === 'theirs' ? 'border-brand bg-green-50' : 'border-slate-300 bg-white'}`}>
                          <input type="radio" name={`sale-${g.ticketKey}`} checked={choice === 'theirs'} onChange={() => p.onChoice(g.ticketKey, 'theirs')} className="w-4 h-4" />
                          <span className="text-sm">{p.buyerName || 'Buyer'}: {describeTheirs(g.theirs, p.contractNumberById)}</span>
                        </label>
                        <label className={`inline-flex items-center gap-2 rounded-lg border px-3 min-h-11 cursor-pointer ${choice === 'ours' ? 'border-brand bg-green-50' : 'border-slate-300 bg-white'}`}>
                          <input type="radio" name={`sale-${g.ticketKey}`} checked={choice === 'ours'} onChange={() => p.onChoice(g.ticketKey, 'ours')} className="w-4 h-4" />
                          <span className="text-sm">Keep ours</span>
                        </label>
                      </div>
                    )}
                    {g.spotPriceChange && <p className="text-xs text-slate-500">Spot price: {spotPriceChangeText(g.spotPriceChange)}.</p>}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
