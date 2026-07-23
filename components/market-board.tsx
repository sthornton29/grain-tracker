// Public grain-futures board shown on the login page (market-data display).
// Presentational only — the server page fetches the quotes and passes them in.
// Includes the Barchart attribution and a delayed/informational disclaimer.

import { fmtPrice } from '@/lib/hedging'
import type { PublicQuote } from '@/lib/barchart-quotes'

export default function MarketBoard({ quotes, asOf, available }: { quotes: PublicQuote[]; asOf: string | null; available: boolean }) {
  return (
    <div className="w-full bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold text-slate-800 flex items-center gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-mark.svg" alt="" className="h-4 w-4" />
          <span className="text-brand-dark">Turnrow</span>
          <span className="text-slate-400 font-normal">·</span>
          <span>Grain Futures</span>
        </h2>
        <span className="text-xs text-slate-400">{asOf ? `As of ${asOf}` : 'Delayed'}</span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {quotes.map((q) => (
            <tr key={q.symbol} className="border-t border-slate-100 first:border-t-0">
              <td className="py-1.5 font-medium text-slate-700">{q.commodity}</td>
              <td className="py-1.5 text-slate-400 text-xs whitespace-nowrap">{q.contractLabel}</td>
              <td className="py-1.5 text-right font-mono">{q.price != null ? `${fmtPrice(q.price)}/bu` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] leading-snug text-slate-400 mt-3">
        Market data provided by Barchart. Futures prices are delayed and shown for informational purposes only — not an
        offer or solicitation to buy or sell any commodity.{!available && ' Live quotes are temporarily unavailable.'}
      </p>
    </div>
  )
}
