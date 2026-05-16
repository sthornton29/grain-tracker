import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import SettlementPdfPanel from '@/components/settlement-pdf-panel'

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

const fmt = (n: number | null | undefined, d = 2) =>
  n == null ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d })

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

export default async function SettlementDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const [sRes, linesRes] = await Promise.all([
    supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_number, notes, source_pdf_url, buyer:buyers(name)').eq('id', params.id).single(),
    supabase
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
      .order('ticket_number'),
  ])

  const settlement = sRes.data as unknown as Settlement | null
  if (!settlement) notFound()

  const lines = (linesRes.data as unknown as Line[]) ?? []
  const matched = lines.filter((l) => l.load_id && l.load)
  const unmatched = lines.filter((l) => !l.load_id)

  // Missing loads: buyer-delivered loads under this buyer, not on this settlement,
  // with contracts whose delivery period covers settlement_date (if dates present).
  const paidTicketKeys = new Set(
    lines.map((l) => (l.ticket_number ?? '').trim().toLowerCase()).filter(Boolean)
  )
  const { data: buyerLoads } = await supabase
    .from('loads')
    .select(`
      id, date, ticket_number, net_weight, moisture, dry_bushels_override, contract_id, to_buyer_id,
      crop:crops(name, base_moisture_pct, base_lb_per_bushel),
      contract:contracts(id, contract_number, delivery_start_date, delivery_end_date)
    `)
    .eq('to_buyer_id', settlement.buyer_id)
    .eq('to_type', 'buyer')
  const allBuyerLoads = (buyerLoads as unknown as LoadShape[]) ?? []
  const missing = allBuyerLoads.filter((l) => {
    const t = (l.ticket_number ?? '').trim().toLowerCase()
    if (t && paidTicketKeys.has(t)) return false
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

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Settlement {settlement.settlement_number ?? ''}</h1>
          <p className="text-sm text-slate-500">
            {settlement.buyer?.name} · {settlement.settlement_date}
            {settlement.notes && <> · {settlement.notes}</>}
          </p>
        </div>
        <Link href="/settlements" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Back</Link>
      </div>

      <SettlementPdfPanel settlementId={settlement.id} currentUrl={settlement.source_pdf_url} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Lines" value={String(lines.length)} />
        <StatCard label="Matched" value={String(matched.length)} tone="green" />
        <StatCard label="Unmatched" value={String(unmatched.length)} tone={unmatched.length > 0 ? 'amber' : 'slate'} />
        <StatCard label="Net revenue" value={`$${fmt(totalNetRev)}`} />
      </div>

      <Section title="Matched loads" subtitle="Lines tied to a load. Diffs &gt;1% between our dry bu and their net bu are flagged.">
        {matched.length === 0 ? <Empty>None.</Empty> : (
          <Table headers={['Ticket', 'Load date', 'Crop', 'Our dry bu', 'Their net bu', 'Diff', 'Net $', '$/bu']}>
            {matched.map((l) => {
              const ld = l.load!
              const ourBu = dryBu(ld)
              const theirBu = Number(l.net_bushels ?? 0)
              const diff = ourBu > 0 ? ((theirBu - ourBu) / ourBu) * 100 : null
              const flag = diff != null && Math.abs(diff) > 1
              return (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{l.ticket_number}</td>
                  <td className="px-3 py-2">{ld.date}</td>
                  <td className="px-3 py-2">{ld.crop?.name ?? ''}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(ourBu)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(theirBu)}</td>
                  <td className={`px-3 py-2 text-right ${flag ? 'text-red-700 font-semibold' : 'text-slate-500'}`}>
                    {diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%` : ''}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">${fmt(l.net_revenue)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(l.price_per_bushel, 4)}</td>
                </tr>
              )
            })}
          </Table>
        )}
      </Section>

      <Section title="Unmatched settlement lines" subtitle="Buyer paid us, but the ticket number doesn't match any load we recorded.">
        {unmatched.length === 0 ? <Empty>None — every paid ticket matched a load.</Empty> : (
          <Table headers={['Ticket', 'Net bu', 'Gross $', 'Discounts', 'Net $', '$/bu', 'Notes']}>
            {unmatched.map((l) => (
              <tr key={l.id} className="border-t border-slate-100 bg-amber-50">
                <td className="px-3 py-2 font-semibold">{l.ticket_number || <span className="text-slate-400">—</span>}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(l.net_bushels)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(l.gross_revenue)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(l.discounts)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(l.net_revenue)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(l.price_per_bushel, 4)}</td>
                <td className="px-3 py-2 text-slate-500 text-sm">{l.notes}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Missing loads" subtitle="Loads we delivered to this buyer in the contract's delivery window that are NOT on this settlement.">
        {missing.length === 0 ? <Empty>None — every buyer-delivered load in-window is on this settlement.</Empty> : (
          <Table headers={['Date', 'Ticket', 'Crop', 'Contract', 'Dry bu']}>
            {missing.map((l) => (
              <tr key={l.id} className="border-t border-slate-100 bg-red-50">
                <td className="px-3 py-2">{l.date}</td>
                <td className="px-3 py-2">{l.ticket_number ?? <span className="text-slate-400">no ticket</span>}</td>
                <td className="px-3 py-2">{l.crop?.name ?? ''}</td>
                <td className="px-3 py-2">{l.contract?.contract_number ? `#${l.contract.contract_number}` : ''}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(dryBu(l))}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <p className="text-xs text-slate-400">
        Total net bu: {fmt(totalNetBu)} · Total net revenue: ${fmt(totalNetRev)}
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

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>{headers.map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-4 text-sm text-slate-400">{children}</div>
}

function StatCard({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'green' | 'amber' }) {
  const color =
    tone === 'green' ? 'text-green-700'
    : tone === 'amber' ? 'text-amber-700'
    : 'text-slate-700'
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  )
}
