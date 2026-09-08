'use client'

// The two shared pieces of manual-quote UI (082):
//
//   <QuoteChip quote />           — the provenance chip. A live quote renders
//                                   nothing; a manual one always shows the amber
//                                   "manual · 9/2" chip, red past a month, with
//                                   the staleness warning in its title.
//   <ManualQuoteControl … />      — the inline "enter price" box that replaces a
//                                   blank/"no quote" wherever a price is missing,
//                                   and the "edit" affordance on an existing
//                                   manual quote. Saves to manual_market_quotes
//                                   (one row per org × symbol) in the commodity's
//                                   stored unit; the caller receives the saved
//                                   Quote and every surface that reads the seam
//                                   picks it up on its next fetch.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getOrgId } from '@/lib/org'
import { commodityForSymbol, fmtQuote, parseManualQuoteInput, quoteProvenance, type Quote } from '@/lib/quotes'

const toneCls: Record<'neutral' | 'amber' | 'red', string> = {
  neutral: 'bg-slate-100 text-slate-600',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
}

export function QuoteChip({ quote, className }: { quote: Pick<Quote, 'source' | 'priceDate' | 'enteredAt'> | null | undefined; className?: string }) {
  const p = quoteProvenance(quote)
  if (!p.chip) return null
  return (
    <span
      title={p.warning ? `${p.warning} ${p.title}` : p.title}
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none cursor-help ${toneCls[p.tone]} ${className ?? ''}`}
    >
      {p.chip}{p.tone === 'red' ? ' · update' : p.warning ? ' · old' : ''}
    </span>
  )
}

/** Save (insert or replace) the org's manual quote for a symbol. `price` is
 *  already in the stored unit (parseManualQuoteInput). Returns the Quote. */
export async function saveManualQuote(args: {
  symbol: string
  price: number
  note?: string | null
}): Promise<{ quote: Quote | null; error: string | null }> {
  const supabase = createClient()
  const orgId = await getOrgId(supabase)
  if (!orgId) return { quote: null, error: 'Could not tell which operation you belong to — contact support.' }
  const entered_at = new Date().toISOString()
  const symbol = args.symbol.toUpperCase()
  const { error } = await supabase
    .from('manual_market_quotes')
    .upsert({ org_id: orgId, contract_symbol: symbol, price: args.price, entered_at, note: args.note ?? null }, { onConflict: 'org_id,contract_symbol' })
  if (error) {
    const msg = /relation .* does not exist|schema cache/i.test(error.message)
      ? 'Saving a manual price needs a database update — contact support.'
      : error.message
    return { quote: null, error: msg }
  }
  return { quote: { symbol, price: args.price, priceDate: entered_at.slice(0, 10), stale: false, source: 'manual', enteredAt: entered_at }, error: null }
}

/**
 * Inline manual-quote entry. Three states:
 *   no quote            → "enter price" input + Save (the blank never shows);
 *   manual quote        → the chip + "edit" (opens the same input, prefilled);
 *   live quote          → renders nothing unless `alwaysShowEdit` (the price
 *                         board lets a manual fallback be maintained even
 *                         while live coverage is up).
 */
export default function ManualQuoteControl({
  symbol,
  quote,
  onSaved,
  compact,
  label,
  disabled,
}: {
  symbol: string
  quote: Quote | null | undefined
  onSaved: (q: Quote) => void
  compact?: boolean
  /** Prompt text when no quote exists (default "enter price"). */
  label?: string
  disabled?: boolean
}) {
  const commodity = useMemo(() => commodityForSymbol(symbol), [symbol])
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isManual = quote?.source === 'manual'
  const isLive = quote?.source === 'live'

  if (isLive) return null
  const unitHint = commodity === 'Cotton' ? '$/lb or ¢/lb' : '$/bu'

  async function save() {
    setErr(null)
    const price = parseManualQuoteInput(commodity, raw)
    if (price == null) { setErr(commodity === 'Cotton' ? 'Enter a price like 0.7265 or 72.65.' : 'Enter a price like 4.50.'); return }
    setBusy(true)
    const { quote: saved, error } = await saveManualQuote({ symbol, price })
    setBusy(false)
    if (error || !saved) { setErr(error ?? 'Could not save.'); return }
    setOpen(false)
    setRaw('')
    onSaved(saved)
  }

  if (!open) {
    return (
      <span className={`inline-flex items-center gap-1 ${compact ? 'text-[11px]' : 'text-xs'}`}>
        {isManual && <QuoteChip quote={quote} />}
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setRaw(isManual && quote ? String(commodity === 'Cotton' ? quote.price / 100 : quote.price) : ''); setOpen(true) }}
          className="text-brand-deep underline decoration-dotted underline-offset-2 disabled:opacity-50"
          title={isManual ? 'Change the manual price' : `No live price for ${symbol} — enter one; it is saved and used everywhere`}
        >
          {isManual ? 'edit' : (label ?? 'enter price')}
        </button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 flex-wrap text-xs">
      <input
        autoFocus
        type="text"
        inputMode="decimal"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } if (e.key === 'Escape') setOpen(false) }}
        placeholder={unitHint}
        aria-label={`Manual price for ${symbol} (${unitHint})`}
        className="w-24 rounded-md border border-slate-300 px-1.5 py-0.5 text-xs text-right"
      />
      <button type="button" disabled={busy} onClick={() => void save()} className="rounded-md bg-brand hover:bg-brand-deep text-white px-2 py-0.5 font-semibold disabled:opacity-50">
        {busy ? '…' : 'Save'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-slate-500">Cancel</button>
      {err && <span className="text-red-600 basis-full">{err}</span>}
      {!err && isManual && quote && <span className="text-slate-400 basis-full">Now {fmtQuote(commodity, quote.price)} · saved {quote.priceDate}</span>}
    </span>
  )
}
