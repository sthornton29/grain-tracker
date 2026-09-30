import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { relinkSettlementLines } from '@/lib/settlement-link'
import { fmtDate } from '@/lib/format-date'
import { fmtInt, fmtUsd, fmtNum, signedTone, toneText, theadCls, type Tone } from '@/components/reports/report-kit'
import SettlementPdfPanel from '@/components/settlement-pdf-panel'
import LineMatchSelect, { type LoadOption } from './line-match-select'
import AddLineButton from './add-line-button'
import DiscountsBlock from './discounts-block'
import SettlementHeaderActions from './header-actions'
import type { SettlementDiscountItem } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Settlement = {
  id: string
  buyer_id: string
  settlement_date: string
  settlement_number: string | null
  notes: string | null
  source_pdf_url: string | null
  buyer: { name: string } | null
}

type Line = {
  id: string
  ticket_number: string | null
  load_id: string | null
  net_bushels: number
  gross_revenue: number
  discounts: number
  net_revenue: number | null
  price_per_bushel: number | null
  notes: string | null
  load: LoadShape | null
}

type LoadShape = {
  id: string
  date: string
  ticket_number: string | null
  net_weight: number | null
  moisture: number | null
  dry_bushels_override: number | null
  contract_id: string | null
  to_buyer_id: string | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  contract: { id: string; contract_number: string; delivery_start_date: string | null; delivery_end_date: string | null } | null
}

function dryBu(l: LoadShape) {
  const { dryBushels } = computeBushels({
    netWeightLb: l.net_weight,
    moisturePct: l.moisture,
    baseMoisturePct: l.crop?.base_moisture_pct ?? null,
    baseLbPerBushel: l.crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: l.dry_bushels_override,
  })
  return dryBushels ?? 0
}

// The banner the New Settlement screen sends the user here with when the
// header saved but part of the detail did not.
const SAVED_NOTES: Record<string, string> = {
  'partial-lines': 'Saved, but the line detail didn’t come through — add the lines here, or contact support.',
  'partial-items': 'Saved with its lines, but the itemized discounts didn’t come through — add them in the Discounts block below, or contact support.',
  'partial-writeback': 'Saved. A couple of matched loads couldn’t be updated with the statement’s ticket or grade readings — nothing is missing from the settlement itself.',
}

export default async function SettlementDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { saved?: string } }) {
  const supabase = createClient()

  const sRes = await supabase
    .from('settlements')
    .select('id, buyer_id, settlement_date, settlement_number, notes, source_pdf_url, buyer:buyers(name)')
    .eq('id', params.id)
    .single()
  const settlement = sRes.data as unknown as Settlement | null
  if (!settlement) notFound()

  // Persist unambiguous ticket→load matches before reading, so what is stored
  // matches what this screen shows — keeping the list's Unmatched count and every
  // export consistent with the Review screen (no more view-time-only re-pairing).
  await relinkSettlementLines(supabase, params.id)

  const linesRes = await supabase
    .from('settlement_lines')
    .select(`
      id, ticket_number, load_id, net_bushels, gross_revenue, discounts, net_revenue, price_per_bushel, notes,
      load:loads(
        id, date, ticket_number, net_weight, moisture, dry_bushels_override, contract_id, to_buyer_id,
        crop:crops(name, base_moisture_pct, base_lb_per_bushel),
        contract:contracts(id, contract_number, delivery_start_date, delivery_end_date)
      )
    `)
    .eq('settlement_id', params.id)
    .order('ticket_number')

  const lines = (linesRes.data as unknown as Line[]) ?? []

  // Missing loads: buyer-delivered loads under this buyer with NO settlement info
  // on any settlement for this buyer (not just this one), inside the contract's
  // delivery window when dates are present.
  const { data: buyerSettlements } = await supabase
    .from('settlements')
    .select('id')
    .eq('buyer_id', settlement.buyer_id)
  const buyerSettlementIds = (buyerSettlements ?? []).map((s) => s.id)
  const { data: buyerSettlementLines } = buyerSettlementIds.length
    ? await supabase
        .from('settlement_lines')
        .select('load_id, ticket_number')
        .in('settlement_id', buyerSettlementIds)
    : { data: [] as { load_id: string | null; ticket_number: string | null }[] }
  const settledLoadIds = new Set<string>()
  const settledTicketKeys = new Set<string>()
  for (const sl of buyerSettlementLines ?? []) {
    if (sl.load_id) settledLoadIds.add(sl.load_id)
    const t = (sl.ticket_number ?? '').trim().toLowerCase()
    if (t) settledTicketKeys.add(t)
  }

  const { data: buyerLoads } = await fetchAllRows((f, t) => supabase
    .from('loads')
    .select(`
      id, date, ticket_number, net_weight, moisture, dry_bushels_override, contract_id, to_buyer_id,
      crop:crops(name, base_moisture_pct, base_lb_per_bushel),
      contract:contracts(id, contract_number, delivery_start_date, delivery_end_date)
    `)
    .eq('to_buyer_id', settlement.buyer_id)
    .eq('to_type', 'buyer')
    .order('id')
    .range(f, t))
  const allBuyerLoads = (buyerLoads as unknown as LoadShape[]) ?? []

  // After the relink above, a line's load_id is persisted for every unambiguous
  // ticket match, so "matched" simply means the FK resolved to a load. Lines we
  // couldn't auto-match split into two cases: a ticket that matches MORE than one
  // buyer load (ambiguous — needs a manual pick) versus a ticket that matches
  // none (no load recorded). Both get a manual-match dropdown.
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  const ticketCounts = new Map<string, number>()
  for (const l of allBuyerLoads) {
    const t = norm(l.ticket_number)
    if (t) ticketCounts.set(t, (ticketCounts.get(t) ?? 0) + 1)
  }
  const matched = lines.filter((l) => l.load)
  const unresolved = lines.filter((l) => !l.load)
  const ambiguous = unresolved.filter((l) => (ticketCounts.get(norm(l.ticket_number)) ?? 0) > 1)
  const noMatch = unresolved.filter((l) => (ticketCounts.get(norm(l.ticket_number)) ?? 0) <= 1)
  const unmatchedCount = ambiguous.length + noMatch.length

  // Candidate loads for the manual-match dropdown.
  const loadOption = (l: LoadShape): LoadOption => ({
    id: l.id,
    label: `${fmtDate(l.date)} · ${l.ticket_number ? '#' + l.ticket_number : 'no ticket'} · ${l.crop?.name ?? ''} · ${fmtInt(dryBu(l))} bu`,
  })
  const allLoadOptions: LoadOption[] = [...allBuyerLoads]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(loadOption)
  // For an ambiguous line, offer the loads that share its ticket first.
  const optionsForTicket = (ticket: string | null): LoadOption[] => {
    const t = norm(ticket)
    const same = allBuyerLoads.filter((l) => norm(l.ticket_number) === t)
    return same.length ? same.map(loadOption) : allLoadOptions
  }

  const missing = allBuyerLoads.filter((l) => {
    if (settledLoadIds.has(l.id)) return false
    const t = (l.ticket_number ?? '').trim().toLowerCase()
    if (t && settledTicketKeys.has(t)) return false
    if (l.contract?.delivery_start_date || l.contract?.delivery_end_date) {
      const s = l.contract.delivery_start_date ? new Date(l.contract.delivery_start_date) : null
      const e = l.contract.delivery_end_date ? new Date(l.contract.delivery_end_date) : null
      const d = new Date(settlement.settlement_date)
      if (s && d < s) return false
      if (e && d > e) return false
    }
    return true
  })

  const totalNetBu = lines.reduce((s, l) => s + Number(l.net_bushels ?? 0), 0)
  const totalNetRev = lines.reduce((s, l) => s + Number(l.net_revenue ?? 0), 0)
  const totalGross = lines.reduce((s, l) => s + Number(l.gross_revenue ?? 0), 0)
  const totalDisc = lines.reduce((s, l) => s + Number(l.discounts ?? 0), 0)

  // The shrink comparison's inputs, over the MATCHED lines only (our dry-bu
  // figure needs a load): our FSA-standard dry bushels vs their pay bushels,
  // and their bushel-weighted net price to monetize the gap.
  const matchedTheirBu = matched.reduce((s, l) => s + Number(l.net_bushels ?? 0), 0)
  const matchedOurDry = matched.reduce((s, l) => s + dryBu(l.load!), 0)
  const matchedNetRev = matched.reduce((s, l) => s + Number(l.net_revenue ?? 0), 0)
  const avgMatchedPrice = matchedTheirBu > 0 ? matchedNetRev / matchedTheirBu : null

  const { data: discountItems } = await supabase
    .from('settlement_discount_items')
    .select('*')
    .eq('settlement_id', params.id)
    .order('created_at')

  const savedNote = searchParams?.saved ? SAVED_NOTES[searchParams.saved] ?? null : null
  const numCls = 'px-3 py-2 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Settlement {settlement.settlement_number ?? ''}</h1>
          <p className="text-sm text-slate-500">
            {settlement.buyer?.name} · {fmtDate(settlement.settlement_date)}
            {settlement.notes && <> · {settlement.notes}</>}
          </p>
        </div>
        <SettlementHeaderActions
          settlementId={settlement.id}
          settlementDate={settlement.settlement_date}
          settlementNumber={settlement.settlement_number}
          notes={settlement.notes}
        />
        <Link href="/settlements" className="rounded-lg bg-white border border-slate-300 px-3 min-h-10 inline-flex items-center text-sm">Back</Link>
      </div>

      {savedNote && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          {savedNote}
        </div>
      )}

      <SettlementPdfPanel settlementId={settlement.id} currentUrl={settlement.source_pdf_url} />

      {/* Net revenue leads — it is the number the check is for. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="col-span-2 bg-white rounded-xl shadow p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Net revenue</div>
          <div className="text-3xl font-bold mt-1 tabular-nums text-slate-900">{fmtUsd(totalNetRev)}</div>
          <div className="text-xs text-slate-500 mt-0.5">{fmtInt(totalNetBu)} settled bu{totalNetBu > 0 ? ` · ${fmtUsd(totalNetRev / totalNetBu, 2)}/bu` : ''}</div>
        </div>
        <StatCard label="Gross revenue" value={fmtUsd(totalGross)} />
        <StatCard label="Discounts" value={fmtUsd(totalDisc)} tone={totalDisc > 0 ? 'warning' : 'muted'} />
        <StatCard label="Matched lines" value={`${matched.length} of ${lines.length}`} tone={matched.length === lines.length && lines.length > 0 ? 'favorable' : 'neutral'} />
        <StatCard label="Need matching" value={String(unmatchedCount)} tone={unmatchedCount > 0 ? 'warning' : 'muted'} />
      </div>

      <DiscountsBlock
        settlementId={settlement.id}
        initialItems={(discountItems as SettlementDiscountItem[]) ?? []}
        settledBu={totalNetBu}
        grossRevenue={totalGross}
        discountTotal={totalDisc}
        ourDryBu={matched.length > 0 ? matchedOurDry : null}
        matchedSettledBu={matchedTheirBu}
        avgPricePerBu={avgMatchedPrice}
        canEdit
      />

      <Section title="Matched loads" subtitle="Lines tied to a load. Their net bushels beside our dry bushels — green when they paid on more than we weighed, red when less; anything over 1% either way is worth a look.">
        {matched.length === 0 ? <Empty>None yet.</Empty> : (
          <Table headers={['Ticket', 'Load date', 'Crop', 'Our dry bu', 'Their net bu', 'Difference', 'Net $', '$/bu']} rightFrom={3}>
            {matched.map((l) => {
              const ld = l.load!
              const ourBu = dryBu(ld)
              const theirBu = Number(l.net_bushels ?? 0)
              const diff = ourBu > 0 ? ((theirBu - ourBu) / ourBu) * 100 : null
              const big = diff != null && Math.abs(diff) > 1
              return (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{l.ticket_number}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><Link href={`/loads/${ld.id}`} className="text-brand-deep hover:underline">{fmtDate(ld.date)}</Link></td>
                  <td className="px-3 py-2">{ld.crop?.name ?? ''}</td>
                  <td className={numCls}>{fmtInt(ourBu)}</td>
                  <td className={numCls}>{fmtInt(theirBu)}</td>
                  <td className={`${numCls} ${toneText(signedTone(diff))} ${big ? 'font-semibold' : ''}`}>
                    {diff != null ? `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${fmtNum(Math.abs(diff), 1)}%` : ''}
                  </td>
                  <td className={numCls}>{fmtUsd(l.net_revenue, 2)}</td>
                  <td className={numCls}>{l.price_per_bushel != null ? fmtUsd(l.price_per_bushel, 2) : ''}</td>
                </tr>
              )
            })}
          </Table>
        )}
      </Section>

      <Section title="Needs matching" subtitle="The buyer paid these tickets, but Turnrow couldn't tie each one to a single load. Pick the right load and it saves right away.">
        {unmatchedCount === 0 ? <Empty>None — every paid ticket matched a load.</Empty> : (
          <Table headers={['Ticket', 'Why', 'Net bu', 'Net $', '$/bu', 'Match to load']} rightFrom={2} rightTo={4}>
            {ambiguous.map((l) => (
              <tr key={l.id} className="border-t border-slate-100 bg-amber-50">
                <td className="px-3 py-2 font-semibold">{l.ticket_number || <span className="text-slate-400">—</span>}</td>
                <td className="px-3 py-2"><span className="rounded-full bg-amber-200 text-amber-900 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">Several loads share this ticket</span></td>
                <td className={numCls}>{fmtInt(l.net_bushels)}</td>
                <td className={numCls}>{fmtUsd(l.net_revenue, 2)}</td>
                <td className={numCls}>{l.price_per_bushel != null ? fmtUsd(l.price_per_bushel, 2) : ''}</td>
                <td className="px-3 py-2"><LineMatchSelect settlementId={settlement.id} lineId={l.id} currentLoadId={l.load_id} options={optionsForTicket(l.ticket_number)} ticket={l.ticket_number} /></td>
              </tr>
            ))}
            {noMatch.map((l) => (
              <tr key={l.id} className="border-t border-slate-100 bg-slate-50">
                <td className="px-3 py-2 font-semibold">{l.ticket_number || <span className="text-slate-400">—</span>}</td>
                <td className="px-3 py-2"><span className="rounded-full bg-slate-200 text-slate-700 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">No load with this ticket</span></td>
                <td className={numCls}>{fmtInt(l.net_bushels)}</td>
                <td className={numCls}>{fmtUsd(l.net_revenue, 2)}</td>
                <td className={numCls}>{l.price_per_bushel != null ? fmtUsd(l.price_per_bushel, 2) : ''}</td>
                <td className="px-3 py-2"><LineMatchSelect settlementId={settlement.id} lineId={l.id} currentLoadId={l.load_id} options={allLoadOptions} ticket={l.ticket_number} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Missing loads" subtitle="Loads you delivered to this buyer inside the contract's delivery window that aren't on any settlement yet — the ones you haven't been paid for. Add line puts one on this settlement, tied to the load, so you only type the dollars.">
        {missing.length === 0 ? <Empty>None — every load delivered to this buyer in the window has been settled.</Empty> : (
          <Table headers={['Date', 'Ticket', 'Crop', 'Contract', 'Dry bu', '']} rightFrom={4} rightTo={4}>
            {missing.map((l) => (
              <tr key={l.id} className="border-t border-slate-100 bg-amber-50">
                <td className="px-3 py-2 whitespace-nowrap"><Link href={`/loads/${l.id}`} className="text-brand-deep hover:underline font-semibold">{fmtDate(l.date)}</Link></td>
                <td className="px-3 py-2">{l.ticket_number ?? <span className="text-slate-400">no ticket</span>}</td>
                <td className="px-3 py-2">{l.crop?.name ?? ''}</td>
                <td className="px-3 py-2">{l.contract?.contract_number ? <Link href={`/contracts/${l.contract.id}`} className="text-brand-deep hover:underline">#{l.contract.contract_number}</Link> : ''}</td>
                <td className={numCls}>{fmtInt(dryBu(l))}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <AddLineButton settlementId={settlement.id} loadId={l.id} ticketNumber={l.ticket_number} dryBushels={dryBu(l)} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <p className="text-xs text-slate-400">
        Total settled: {fmtInt(totalNetBu)} bu · Net revenue: {fmtUsd(totalNetRev)}
      </p>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <div className="px-4 pt-3 pb-2 border-b border-slate-100">
        <h2 className="font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

// rightFrom / rightTo: the header columns (inclusive) that are numeric and
// right-aligned; the rest are left.
function Table({ headers, children, rightFrom = 999, rightTo = 999 }: { headers: string[]; children: React.ReactNode; rightFrom?: number; rightTo?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className={theadCls}>
          <tr>{headers.map((h, i) => <th key={`${h}-${i}`} className={`${i >= rightFrom && i <= rightTo ? 'text-right' : 'text-left'} px-3 py-2 whitespace-nowrap`}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-4 text-sm text-slate-400">{children}</div>
}

function StatCard({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${toneText(tone)}`}>{value}</div>
    </div>
  )
}
