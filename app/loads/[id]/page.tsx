import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { computeBushels } from '@/lib/shrink'
import { CONTRACT_TYPE_LABEL } from '@/lib/contracts'
import LoadAttachments from '@/components/load-attachments'
import LoadPdfBar from './load-pdf-bar'
import DeleteLoadButton from './delete-load-button'
import type { ExportPayload, ExportSection } from '@/lib/exports'

export const dynamic = 'force-dynamic'

// Read-only load detail — everything about one load on a single, printable page:
// identity/logistics, weights/bushels, the split breakdown, the linked contract,
// and the payment (from the settlement that matched this load's ticket). Distinct
// from /loads/[id]/edit (the form). "Edit" and "Print / PDF" actions sit up top;
// the document below prints clean (nav + buttons are no-print).

type LoadShape = {
  id: string
  date: string
  time: string | null
  ticket_number: string | null
  crop_year: number | null
  gross_weight: number | null
  tare_weight: number | null
  net_weight: number | null
  moisture: number | null
  test_weight: number | null
  dry_bushels_override: number | null
  from_type: 'field' | 'bin' | null
  to_type: 'bin' | 'buyer' | null
  truck: { name_or_number: string } | null
  crop: { name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null } | null
  from_field: { name_or_number: string; farm: { name: string; fsa_number: string | null } | null } | null
  from_bin: { name_or_number: string } | null
  to_bin: { name_or_number: string } | null
  to_buyer: { name: string } | null
  contract: {
    id: string
    contract_number: string
    contract_type: 'forward' | 'hta' | 'basis'
    buyer: { name: string } | null
    delivery_location: { name: string } | null
  } | null
}

type SplitShape = {
  id: string
  field_id: string
  net_weight: number
  percentage: number
  wet_bushels: number | null
  dry_bushels: number | null
  field: { name_or_number: string } | null
}

type SettlementLineShape = {
  id: string
  ticket_number: string | null
  load_id: string | null
  net_bushels: number
  gross_revenue: number
  discounts: number
  net_revenue: number | null
  price_per_bushel: number | null
  settlement: {
    id: string
    settlement_number: string | null
    settlement_date: string
    buyer: { name: string } | null
  } | null
}

type PaymentState = 'paid' | 'ambiguous' | 'unpaid' | 'na'

const LINE_SELECT = `
  id, ticket_number, load_id, net_bushels, gross_revenue, discounts, net_revenue, price_per_bushel,
  settlement:settlements(id, settlement_number, settlement_date, buyer:buyers(name))
`

const fmt = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d })
const usd = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`

export default async function LoadDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('loads')
    .select(`
      id, date, time, ticket_number, crop_year,
      gross_weight, tare_weight, net_weight, moisture, test_weight, dry_bushels_override,
      from_type, to_type,
      truck:trucks(name_or_number),
      crop:crops(name, base_moisture_pct, base_lb_per_bushel),
      from_field:fields!loads_from_field_id_fkey(name_or_number, farm:farms(name, fsa_number)),
      from_bin:bins!loads_from_bin_id_fkey(name_or_number),
      to_bin:bins!loads_to_bin_id_fkey(name_or_number),
      to_buyer:buyers(name),
      contract:contracts(id, contract_number, contract_type, buyer:buyers(name), delivery_location:delivery_locations(name))
    `)
    .eq('id', params.id)
    .single()
  if (error || !data) notFound()
  const load = data as unknown as LoadShape

  const ticket = load.ticket_number?.trim() || null

  // Splits, the matching settlement line(s), and the attachment count — fetched
  // in parallel. Payment matches by the persisted load_id FK first (authoritative
  // after the settlement screen's relink), then by ticket number.
  const [splitsRes, fkLinesRes, ticketLinesRes, ticketLoadCountRes, attachmentRes] = await Promise.all([
    supabase.from('load_splits').select('id, field_id, net_weight, percentage, wet_bushels, dry_bushels, field:fields(name_or_number)').eq('load_id', params.id),
    supabase.from('settlement_lines').select(LINE_SELECT).eq('load_id', params.id),
    ticket ? supabase.from('settlement_lines').select(LINE_SELECT).ilike('ticket_number', ticket) : Promise.resolve({ data: [] }),
    ticket ? supabase.from('loads').select('id', { count: 'exact', head: true }).ilike('ticket_number', ticket) : Promise.resolve({ count: 1 }),
    supabase.from('load_attachments').select('id', { count: 'exact', head: true }).eq('load_id', params.id),
  ])

  const splits = ((splitsRes.data as unknown as SplitShape[]) ?? []).sort((a, b) => b.net_weight - a.net_weight)
  const fkLine = ((fkLinesRes.data as unknown as SettlementLineShape[]) ?? [])[0] ?? null
  const ticketLines = (ticketLinesRes.data as unknown as SettlementLineShape[]) ?? []
  const sameTicketLoadCount = (ticketLoadCountRes as { count: number | null }).count ?? 1
  const attachmentCount = (attachmentRes as { count: number | null }).count ?? 0

  // Resolve the payment state. Only buyer-delivered loads can be settled.
  let paymentLine: SettlementLineShape | null = null
  let paymentState: PaymentState
  if (load.to_type !== 'buyer') {
    paymentState = 'na'
  } else if (fkLine) {
    paymentLine = fkLine
    paymentState = 'paid'
  } else if (ticket && ticketLines.length > 0) {
    paymentLine = ticketLines[0]
    paymentState = sameTicketLoadCount > 1 ? 'ambiguous' : 'paid'
  } else {
    paymentState = 'unpaid'
  }

  const { wetBushels, dryBushels } = computeBushels({
    netWeightLb: load.net_weight,
    moisturePct: load.moisture,
    baseMoisturePct: load.crop?.base_moisture_pct ?? null,
    baseLbPerBushel: load.crop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: load.dry_bushels_override,
  })

  // Discrepancy (paid only): our dry bu vs their settled net bu, flagged > 1%
  // — the same rule the settlement reconciliation screen uses.
  const ourBu = dryBushels ?? 0
  const theirBu = paymentState === 'paid' && paymentLine ? Number(paymentLine.net_bushels ?? 0) : null
  const diffPct = theirBu != null && ourBu > 0 ? ((theirBu - ourBu) / ourBu) * 100 : null
  const diffFlag = diffPct != null && Math.abs(diffPct) > 1

  const fromText = load.from_type === 'field'
    ? (splits.length > 0
        ? `Split — ${splits.length} fields`
        : `${load.from_field?.name_or_number ?? '—'}${load.from_field?.farm?.name ? ` · ${load.from_field.farm.name}` : ''}`)
    : load.from_type === 'bin'
      ? `Bin — ${load.from_bin?.name_or_number ?? '—'}`
      : '—'
  const toText = load.to_type === 'bin'
    ? `Bin — ${load.to_bin?.name_or_number ?? '—'}`
    : load.to_type === 'buyer'
      ? `${load.to_buyer?.name ?? '—'}${load.contract?.delivery_location?.name ? ` · ${load.contract.delivery_location.name}` : ''}`
      : '—'
  const dateTime = `${load.date}${load.time ? ` · ${load.time.slice(0, 5)}` : ''}`

  // ---- Export payload (jsPDF / Excel), mirroring the on-screen document ----
  const KV: ExportSection['columns'] = [{ label: 'Field' }, { label: 'Value', align: 'right' }]
  const sections: ExportSection[] = []
  sections.push({
    title: 'Load & Logistics',
    columns: KV,
    rows: [
      ['Date / time', dateTime],
      ['Ticket #', ticket ?? '—'],
      ['Truck', load.truck?.name_or_number ?? '—'],
      ['Crop', load.crop?.name ?? '—'],
      ['Crop year', load.crop_year != null ? String(load.crop_year) : '—'],
      ['From', fromText],
      ['To', toText],
      ['Contract', load.contract ? `#${load.contract.contract_number}` : '—'],
    ],
  })
  sections.push({
    title: 'Weights & Bushels',
    columns: KV,
    rows: [
      ['Gross (lb)', fmt(load.gross_weight, 0)],
      ['Tare (lb)', fmt(load.tare_weight, 0)],
      ['Net (lb)', fmt(load.net_weight, 0)],
      ['Moisture', load.moisture != null ? `${load.moisture}%` : '—'],
      ['Test weight', load.test_weight != null ? `${load.test_weight} lb/bu` : '—'],
      ['Wet bushels', fmt(wetBushels)],
      ['Dry bushels', `${fmt(dryBushels)}${load.dry_bushels_override != null ? ' (manual override)' : ''}`],
    ],
  })
  if (splits.length > 0) {
    sections.push({
      title: `Split across ${splits.length} fields`,
      columns: [{ label: 'Field' }, { label: 'Net lb', align: 'right' }, { label: '%', align: 'right' }, { label: 'Wet bu', align: 'right' }, { label: 'Dry bu', align: 'right' }],
      rows: splits.map((s) => [s.field?.name_or_number ?? '—', fmt(s.net_weight, 0), `${s.percentage.toFixed(1)}%`, fmt(s.wet_bushels), fmt(s.dry_bushels)]),
    })
  }
  if (load.contract) {
    sections.push({
      title: 'Contract',
      columns: KV,
      rows: [
        ['Contract #', `#${load.contract.contract_number}`],
        ['Type', CONTRACT_TYPE_LABEL[load.contract.contract_type] ?? load.contract.contract_type],
        ['Buyer', load.contract.buyer?.name ?? load.to_buyer?.name ?? '—'],
        ...(load.contract.delivery_location?.name ? [['Delivery location', load.contract.delivery_location.name] as (string | number)[]] : []),
      ],
    })
  }
  sections.push({
    title: 'Payment',
    columns: KV,
    rows:
      paymentState === 'na'
        ? [['Status', 'Stored in bin — not a buyer sale']]
        : paymentState === 'unpaid'
          ? [['Status', 'Unpaid — no settlement matched to this ticket']]
          : paymentState === 'ambiguous'
            ? [
                ['Status', 'Ambiguous — multiple loads share this ticket'],
                ['Settlement #', paymentLine?.settlement?.settlement_number ?? '—'],
              ]
            : [
                ['Status', 'Paid'],
                ['Settlement #', paymentLine?.settlement?.settlement_number ?? '—'],
                ['Settlement date', paymentLine?.settlement?.settlement_date ?? '—'],
                ['Buyer', paymentLine?.settlement?.buyer?.name ?? '—'],
                ['Their net bu', fmt(paymentLine?.net_bushels)],
                ['Our dry bu', fmt(ourBu)],
                ['Diff', diffPct != null ? `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%${diffFlag ? ' (over 1%)' : ''}` : '—'],
                ['Gross revenue', usd(paymentLine?.gross_revenue)],
                ['Discounts', usd(paymentLine?.discounts)],
                ['Net revenue', usd(paymentLine?.net_revenue)],
                ['$ / bu', fmt(paymentLine?.price_per_bushel, 4)],
              ],
  })
  sections.push({
    title: 'Attachments',
    columns: KV,
    rows: [['Files on file', String(attachmentCount)]],
  })

  const payload: ExportPayload = {
    title: ticket ? `Load — Ticket #${ticket}` : `Load — ${load.date}`,
    filters: [load.crop?.name, dateTime, load.crop_year != null ? `${load.crop_year} crop` : null].filter(Boolean).join(' · '),
    filename: `load-${ticket ?? load.date}`,
    singleSheet: true,
    sections,
  }

  return (
    <div className="space-y-4">
      {/* Header + actions. Buttons are no-print; the document below prints clean. */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold">{ticket ? `Load · Ticket #${ticket}` : `Load · ${load.date}`}</h1>
          <p className="text-sm text-slate-500">
            {[load.crop?.name, dateTime, load.crop_year != null ? `${load.crop_year} crop` : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap no-print">
          <Link href="/loads" className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Back</Link>
          <Link href={`/loads/${load.id}/edit`} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm font-semibold text-brand-deep">Edit</Link>
          <DeleteLoadButton loadId={load.id} />
          <LoadPdfBar payload={payload} />
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Dry bushels" value={fmt(dryBushels)} />
        <StatCard label="Net weight" value={`${fmt(load.net_weight, 0)} lb`} />
        <StatCard label="Crop" value={load.crop?.name ?? '—'} />
        <StatCard label="Payment"><PaymentBadge state={paymentState} /></StatCard>
      </div>

      <Section title="Load & Logistics">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 px-4 py-3">
          <Def label="Date / time" value={dateTime} />
          <Def label="Ticket #" value={ticket ?? '—'} />
          <Def label="Truck" value={load.truck?.name_or_number ?? '—'} />
          <Def label="Crop" value={`${load.crop?.name ?? '—'}${load.crop_year != null ? ` · ${load.crop_year} crop` : ''}`} />
          <Def label="From" value={fromText} />
          <Def label="To" value={toText} />
        </dl>
      </Section>

      <Section title="Weights & Bushels">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 px-4 py-3">
          <Def label="Gross (lb)" value={fmt(load.gross_weight, 0)} />
          <Def label="Tare (lb)" value={fmt(load.tare_weight, 0)} />
          <Def label="Net (lb)" value={fmt(load.net_weight, 0)} />
          <Def label="Moisture" value={load.moisture != null ? `${load.moisture}%` : '—'} />
          <Def label="Test weight" value={load.test_weight != null ? `${load.test_weight} lb/bu` : '—'} />
          <Def label="Wet bushels" value={fmt(wetBushels)} />
          <Def label="Dry bushels" value={fmt(dryBushels)} sub={load.dry_bushels_override != null ? 'manual override' : undefined} />
        </dl>
      </Section>

      {splits.length > 0 && (
        <Section title={`Split across ${splits.length} fields`}>
          <Table headers={['Field', 'Net lb', '%', 'Wet bu', 'Dry bu']}>
            {splits.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{s.field?.name_or_number ?? '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{s.net_weight.toLocaleString()}</td>
                <td className="px-3 py-2 text-right font-mono">{s.percentage.toFixed(1)}%</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(s.wet_bushels)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(s.dry_bushels)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {load.contract && (
        <Section title="Contract">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 px-4 py-3">
            <Def label="Contract #" value={`#${load.contract.contract_number}`} />
            <Def label="Type" value={CONTRACT_TYPE_LABEL[load.contract.contract_type] ?? load.contract.contract_type} />
            <Def label="Buyer" value={load.contract.buyer?.name ?? load.to_buyer?.name ?? '—'} />
            {load.contract.delivery_location?.name && <Def label="Delivery location" value={load.contract.delivery_location.name} />}
          </dl>
          <div className="px-4 pb-3 no-print">
            <Link href={`/contracts/${load.contract.id}`} className="text-brand-deep text-sm font-semibold">View contract →</Link>
          </div>
        </Section>
      )}

      <Section title="Payment">
        {paymentState === 'na' ? (
          <p className="px-4 py-3 text-sm text-slate-500">Delivered to a bin (storage), not sold to a buyer — no settlement applies.</p>
        ) : paymentState === 'unpaid' ? (
          <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
            <PaymentBadge state="unpaid" />
            <span className="text-sm text-slate-600">No settlement record matched to this ticket yet.</span>
          </div>
        ) : paymentState === 'ambiguous' ? (
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <PaymentBadge state="ambiguous" />
              <span className="text-sm text-slate-600">More than one load shares this ticket number, so we can&apos;t be sure which load this settlement paid. Open the settlement to confirm the match.</span>
            </div>
            {paymentLine?.settlement && (
              <Link href={`/settlements/${paymentLine.settlement.id}`} className="text-brand-deep text-sm font-semibold no-print">
                View settlement {paymentLine.settlement.settlement_number ? `#${paymentLine.settlement.settlement_number}` : ''} →
              </Link>
            )}
          </div>
        ) : (
          <div className="px-4 py-3 space-y-3">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2">
              <Def label="Settlement #" value={paymentLine?.settlement?.settlement_number ?? '—'} />
              <Def label="Settlement date" value={paymentLine?.settlement?.settlement_date ?? '—'} />
              <Def label="Buyer" value={paymentLine?.settlement?.buyer?.name ?? '—'} />
              <Def label="$ / bu" value={fmt(paymentLine?.price_per_bushel, 4)} />
              <Def label="Their net bu" value={fmt(paymentLine?.net_bushels)} />
              <Def label="Gross revenue" value={usd(paymentLine?.gross_revenue)} />
              <Def label="Discounts" value={usd(paymentLine?.discounts)} />
              <Def label="Net revenue" value={usd(paymentLine?.net_revenue)} />
            </dl>
            <div className="text-sm flex items-center gap-2 flex-wrap">
              <span className="text-slate-500">Our dry {fmt(ourBu)} bu vs their {fmt(theirBu)} bu:</span>
              <span className={diffFlag ? 'text-red-700 font-semibold' : 'text-slate-600'}>
                {diffPct != null ? `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%` : '—'}{diffFlag ? ' — over 1% discrepancy' : ''}
              </span>
            </div>
            {paymentLine?.settlement && (
              <Link href={`/settlements/${paymentLine.settlement.id}`} className="text-brand-deep text-sm font-semibold no-print">View settlement →</Link>
            )}
          </div>
        )}
      </Section>

      {/* Attachments — managed on screen; the PDF/print just notes the count. */}
      <p className="hidden print:block text-sm text-slate-500">{attachmentCount} attachment{attachmentCount === 1 ? '' : 's'} on file.</p>
      <div className="no-print">
        <LoadAttachments loadId={load.id} />
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow overflow-hidden avoid-break">
      <div className="px-4 pt-3 pb-2 border-b border-slate-100">
        <h2 className="font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  )
}

function Def({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500 uppercase tracking-wide">{label}</dt>
      <dd className="text-sm text-slate-900 tabular-nums">{value}{sub && <span className="ml-1 text-xs text-amber-700">({sub})</span>}</dd>
    </div>
  )
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>{headers.map((h, i) => <th key={h} className={`px-3 py-2 whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function StatCard({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums text-slate-900">{children ?? value}</div>
    </div>
  )
}

function PaymentBadge({ state }: { state: PaymentState }) {
  const map: Record<PaymentState, { text: string; cls: string }> = {
    paid: { text: 'Paid', cls: 'bg-green-100 text-green-800' },
    unpaid: { text: 'Unpaid', cls: 'bg-amber-100 text-amber-800' },
    ambiguous: { text: 'Ambiguous', cls: 'bg-orange-100 text-orange-800' },
    na: { text: 'Stored', cls: 'bg-slate-100 text-slate-600' },
  }
  const { text, cls } = map[state]
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${cls}`}>{text}</span>
}
