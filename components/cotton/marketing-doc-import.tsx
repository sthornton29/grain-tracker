'use client'

// "Upload Marketing Document" — the AI intake point on /cotton/marketing.
// One upload (PDF or photos) is classified AND extracted in a single call
// (document_type 'cotton_marketing_document'); each category lands on its own
// pre-filled review panel that saves into the matching 044 tables:
//
//   sales_contract  → cotton_sales_contracts (dedupe on contract #: update)
//   pool_payment    → cotton_pool_payments on the matched pool contract
//   ccc_loan        → ccc_loans + the bale list through the match/conflict/
//                     unmatched partition (dedupe on loan #: add bales)
//   ldp_notice      → cotton_ldp_records + bale junction (same partition)
//   equity_sale     → updates the matched loan (status equity_sold)
//   storage_invoice → cotton_fees status 'actual' (replaces the projection slot)
//   bale_list       → pointed at "Assign bales from file" (needs a target)
//
// On a low-confidence classification the user picks the category and the
// document re-extracts with that category's focused prompt. Everything is
// confirm-before-save; nothing writes until the user clicks Save.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { BuyerPicker } from '@/components/buyer-location-pickers'
import { parseDocument } from '@/lib/pdf-upload'
import { findBestMatch } from '@/lib/fuzzy'
import { formatCottonPrice, parseCottonPriceInput } from '@/lib/hedging'
import { computeLoanPrincipal, equityOutcome, ldpRateCents } from '@/lib/cotton-sales'
import {
  COTTON_MARKETING_CATEGORIES, COTTON_MARKETING_CATEGORY_LABEL, partitionBaleAssignment,
  type BaleListExtract, type BalePartition, type CccLoanExtract, type CottonContractExtract,
  type CottonMarketingCategory, type CottonMarketingExtraction, type CottonPoolPaymentExtract,
  type EquitySaleExtract, type LdpNoticeExtract, type StorageInvoiceExtract,
} from '@/lib/cotton-doc-import'
import type {
  Buyer, CccLoan, CottonBale, CottonBaleGrade, CottonContractType, CottonDisposition,
  CottonFee, CottonSalesContract, Entity,
} from '@/lib/types'

const inputCls = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm bg-white'
const btnCls = 'rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50'
const btnGray = 'rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50'
const lbs0 = (n: number) => Math.round(n).toLocaleString()
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// ¢/lb-stored prices display as $/lb through the shared formatter.
const cents = (n: number) => formatCottonPrice(n)
const todayIso = () => new Date().toISOString().slice(0, 10)
const num = (s: string): number | null => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) ? n : null }
const str = (v: unknown): string => (v == null ? '' : String(v))
// Prefill a ¢-extracted price as a dollars string for the $/lb inputs.
const dollarsStr = (cents: unknown): string => (cents == null || !Number.isFinite(Number(cents)) ? '' : (Number(cents) / 100).toFixed(4))
const DEFAULT_LOAN_RATE = 55 // matches the marketing page's editable default

function addMonthsIso(dateIso: string, months: number): string {
  const d = new Date(dateIso + 'T00:00:00')
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

type Props = {
  cropYear: number
  entities: Entity[]
  buyers: Buyer[]
  contracts: CottonSalesContract[]
  loans: CccLoan[]
  bales: CottonBale[]
  gradeByBale: ReadonlyMap<string, CottonBaleGrade>
  dispositionByBale: ReadonlyMap<string, CottonDisposition>
  loanedBaleIds: ReadonlySet<string>
  ldpBaleIds: ReadonlySet<string>
  fees: CottonFee[]
  latestAwpCents: number | null
  loanLbsFor: (loanId: string) => number
  onBuyerCreated: (b: Buyer) => void
  onSaved: (msg: string) => Promise<void>
}

export default function MarketingDocImport(props: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [src, setSrc] = useState<DocumentSource | null>(null)
  const [result, setResult] = useState<CottonMarketingExtraction | null>(null)

  const singleEntityId = props.entities.length === 1 ? props.entities[0].id : ''

  async function runParse(source: DocumentSource, category?: CottonMarketingCategory) {
    setBusy(true); setErr(null)
    try {
      const r = await parseDocument(source.kind === 'pdf' ? source.file : source.images, 'cotton_marketing_document', category ? { category } : undefined)
      setResult(r)
      setSrc(source)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Extraction failed.')
    } finally { setBusy(false) }
  }

  function reset() { setSrc(null); setResult(null); setErr(null) }

  async function saved(msg: string) {
    reset(); setOpen(false)
    await props.onSaved(msg)
  }

  if (!open) {
    return <button type="button" className={btnCls} onClick={() => setOpen(true)}>Upload marketing document</button>
  }

  const category = result?.document_category ?? null
  const lowConfidence = result != null && (result.confidence === 'low' || category == null || result.extracted == null)

  return (
    <div className="w-full rounded-xl border-2 border-green-600 bg-white shadow p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="font-semibold flex-1">Upload marketing document
          <span className="ml-2 text-sm font-normal text-slate-500">contract · pool payment · CCC loan · LDP · equity sale · storage invoice</span>
        </h2>
        <button type="button" className={btnGray} onClick={() => { reset(); setOpen(false) }}>Close</button>
      </div>

      {!result && (
        <>
          <DocumentCapture onSource={(s) => void runParse(s)} busy={busy} stageLabel={busy ? 'Classifying & extracting…' : null} pdfLabel="Upload PDF or Image" />
          <p className="text-xs text-slate-500">The AI classifies the document and extracts its fields in one pass. You review everything before anything saves.</p>
        </>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${result.confidence === 'high' ? 'bg-green-100 text-green-800' : result.confidence === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
              {category ? COTTON_MARKETING_CATEGORY_LABEL[category] : 'Unclassified'} · {result.confidence} confidence
            </span>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              Wrong category?
              <select
                className={inputCls} value={category ?? ''} disabled={busy}
                onChange={(e) => { const c = e.target.value as CottonMarketingCategory; if (c && src) void runParse(src, c) }}
              >
                <option value="">— re-extract as… —</option>
                {COTTON_MARKETING_CATEGORIES.map((c) => <option key={c} value={c}>{COTTON_MARKETING_CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
            <button type="button" className={btnGray} onClick={reset}>Start over</button>
          </div>

          {lowConfidence && (
            <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-900">
              The AI wasn&apos;t sure what this document is{category ? ` (best guess: ${COTTON_MARKETING_CATEGORY_LABEL[category]})` : ''} — pick the category above and it will re-read the document with that category&apos;s focused extraction.
            </div>
          )}

          {!lowConfidence && category === 'sales_contract' && (
            <ContractReview {...props} supabase={supabase} extracted={result.extracted as CottonContractExtract} singleEntityId={singleEntityId} onDone={saved} onErr={setErr} />
          )}
          {!lowConfidence && category === 'pool_payment' && (
            <PoolPaymentReview {...props} supabase={supabase} extracted={result.extracted as CottonPoolPaymentExtract} onDone={saved} onErr={setErr} />
          )}
          {!lowConfidence && category === 'ccc_loan' && (
            <LoanReview {...props} supabase={supabase} extracted={result.extracted as CccLoanExtract} singleEntityId={singleEntityId} onDone={saved} onErr={setErr} />
          )}
          {!lowConfidence && category === 'ldp_notice' && (
            <LdpReview {...props} supabase={supabase} extracted={result.extracted as LdpNoticeExtract} singleEntityId={singleEntityId} onDone={saved} onErr={setErr} />
          )}
          {!lowConfidence && category === 'equity_sale' && (
            <EquityReview {...props} supabase={supabase} extracted={result.extracted as EquitySaleExtract} onDone={saved} onErr={setErr} />
          )}
          {!lowConfidence && category === 'storage_invoice' && (
            <StorageInvoiceReview {...props} supabase={supabase} extracted={result.extracted as StorageInvoiceExtract} singleEntityId={singleEntityId} onDone={saved} onErr={setErr} />
          )}
          {!lowConfidence && category === 'bale_list' && (
            <div className="text-sm text-slate-700">
              This looks like a plain bale-number list ({((result.extracted as BaleListExtract)?.bale_pbis ?? []).length} numbers).
              A list needs a destination — open a CCC loan, LDP, or contract workflow below and use <strong>Assign bales from file</strong> there.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type PanelProps = Props & {
  supabase: ReturnType<typeof createClient>
  singleEntityId?: string
  onDone: (msg: string) => Promise<void>
  onErr: (e: string) => void
}

const fail = (onErr: (e: string) => void) => (e: unknown) => onErr(e instanceof Error ? e.message : 'Unexpected error')

// ---------------------------------------------------------------------------
// Sales contract
// ---------------------------------------------------------------------------
function ContractReview({ supabase, extracted: x, buyers, contracts, entities, cropYear, singleEntityId, onBuyerCreated, onDone, onErr }: PanelProps & { extracted: CottonContractExtract }) {
  const matchedBuyer = useMemo(() => findBestMatch(x.buyer, buyers, (b) => b.name), [x.buyer, buyers])
  const [f, setF] = useState(() => ({
    contract_type: (x.contract_type ?? 'fixed_price') as CottonContractType,
    contract_number: str(x.contract_number),
    buyer_id: matchedBuyer?.id ?? '',
    entity_id: singleEntityId ?? '',
    contract_date: str(x.contract_date) || todayIso(),
    commitment_basis: (x.committed_acres != null && x.committed_bales == null ? 'acres' : 'bales') as 'bales' | 'acres',
    committed_bales: str(x.committed_bales),
    committed_acres: str(x.committed_acres),
    price_cents_per_lb: dollarsStr(x.price_cents_per_lb),
    basis_cents: dollarsStr(x.basis_cents),
    futures_month: str(x.futures_month) || 'DEC 26',
    delivery_start: str(x.delivery_start),
    delivery_end: str(x.delivery_end),
    notes: str(x.notes),
  }))
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))

  // Dedupe on the natural key: an existing contract with the same number
  // (this crop year) is UPDATED in place, never duplicated.
  const existing = useMemo(() => {
    const n = f.contract_number.trim().toLowerCase()
    return n === '' ? null : contracts.find((c) => (c.contract_number ?? '').trim().toLowerCase() === n) ?? null
  }, [f.contract_number, contracts])

  async function save() {
    const payload = {
      entity_id: f.entity_id || null, crop_year: x.crop_year ?? cropYear, buyer_id: f.buyer_id || null,
      contract_type: f.contract_type, contract_number: f.contract_number.trim() || null,
      contract_date: f.contract_date || null, commitment_basis: f.commitment_basis,
      committed_bales: f.commitment_basis === 'bales' ? num(f.committed_bales) : null,
      committed_acres: f.commitment_basis === 'acres' ? num(f.committed_acres) : null,
      price_cents_per_lb: f.contract_type === 'spot' || f.contract_type === 'fixed_price' ? parseCottonPriceInput(f.price_cents_per_lb) : null,
      basis_cents: f.contract_type === 'on_call' ? parseCottonPriceInput(f.basis_cents, { centsThreshold: 0.25 }) : null,
      futures_month: f.contract_type === 'on_call' ? (f.futures_month.trim() || null) : null,
      pricing_status: f.contract_type === 'pool' ? 'pool_open' : f.contract_type === 'on_call' ? 'awaiting_futures' : 'fully_priced',
      delivery_start: f.delivery_start || null, delivery_end: f.delivery_end || null, notes: f.notes.trim() || null,
    }
    try {
      if (existing) {
        const keepStatus = existing.contract_type === 'on_call' && existing.futures_fixed_cents != null
        const { error } = await supabase.from('cotton_sales_contracts')
          .update(keepStatus ? { ...payload, pricing_status: existing.pricing_status } : payload).eq('id', existing.id)
        if (error) throw new Error(error.message)
        await onDone(`Contract ${f.contract_number || ''} updated from the document.`)
      } else {
        const { error } = await supabase.from('cotton_sales_contracts').insert(payload)
        if (error) throw new Error(error.message)
        await onDone('Contract saved from the document.')
      }
    } catch (e) { fail(onErr)(e) }
  }

  return (
    <div className="rounded-lg border border-slate-300 p-3 space-y-2">
      <div className="font-semibold text-sm">Sales contract — review &amp; save</div>
      {existing && (
        <p className="text-xs text-amber-700">Contract #{existing.contract_number} already exists — saving <strong>updates</strong> it (never duplicated).</p>
      )}
      {x.buyer && !matchedBuyer && <p className="text-xs text-slate-500">AI read the buyer as “{x.buyer}” — no match on file; pick or add below.</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <label className="flex flex-col gap-1">Type
          <select value={f.contract_type} onChange={(e) => set('contract_type', e.target.value as CottonContractType)} className={inputCls}>
            <option value="spot">Spot</option><option value="fixed_price">Fixed price</option>
            <option value="on_call">On-call</option><option value="pool">Pool</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">Contract #
          <input value={f.contract_number} onChange={(e) => set('contract_number', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Buyer / merchant / pool
          <BuyerPicker value={f.buyer_id} onChange={(id) => set('buyer_id', id)} buyers={buyers} onCreated={onBuyerCreated} className={inputCls} />
        </label>
        {entities.length > 1 && (
          <label className="flex flex-col gap-1">Entity
            <select value={f.entity_id} onChange={(e) => set('entity_id', e.target.value)} className={inputCls}>
              <option value="">— entity —</option>
              {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">Date
          <input type="date" value={f.contract_date} onChange={(e) => set('contract_date', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Commitment
          <select value={f.commitment_basis} onChange={(e) => set('commitment_basis', e.target.value as 'bales' | 'acres')} className={inputCls}>
            <option value="bales">Bales</option><option value="acres">Acres</option>
          </select>
        </label>
        {f.commitment_basis === 'bales' ? (
          <label className="flex flex-col gap-1">Committed bales
            <input type="number" value={f.committed_bales} onChange={(e) => set('committed_bales', e.target.value)} className={inputCls} />
          </label>
        ) : (
          <label className="flex flex-col gap-1">Committed acres
            <input type="number" step="0.01" value={f.committed_acres} onChange={(e) => set('committed_acres', e.target.value)} className={inputCls} />
          </label>
        )}
        {(f.contract_type === 'spot' || f.contract_type === 'fixed_price') && (
          <label className="flex flex-col gap-1">Price ($/lb)
            <input type="text" inputMode="decimal" value={f.price_cents_per_lb} onChange={(e) => set('price_cents_per_lb', e.target.value)} className={inputCls} placeholder="0.7400" />
          </label>
        )}
        {f.contract_type === 'on_call' && (
          <>
            <label className="flex flex-col gap-1">Basis ($/lb, +/-)
              <input type="text" inputMode="decimal" value={f.basis_cents} onChange={(e) => set('basis_cents', e.target.value)} className={inputCls} placeholder="-0.0250" />
            </label>
            <label className="flex flex-col gap-1">Futures month
              <input value={f.futures_month} onChange={(e) => set('futures_month', e.target.value)} className={inputCls} />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1">Delivery start
          <input type="date" value={f.delivery_start} onChange={(e) => set('delivery_start', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Delivery end
          <input type="date" value={f.delivery_end} onChange={(e) => set('delivery_end', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 col-span-2">Notes
          <input value={f.notes} onChange={(e) => set('notes', e.target.value)} className={inputCls} />
        </label>
      </div>
      <button type="button" className={btnCls} onClick={save}>{existing ? 'Update existing contract' : 'Save contract'}</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pool payment
// ---------------------------------------------------------------------------
function PoolPaymentReview({ supabase, extracted: x, buyers, contracts, onDone, onErr }: PanelProps & { extracted: CottonPoolPaymentExtract }) {
  const poolContracts = useMemo(() => contracts.filter((c) => c.contract_type === 'pool'), [contracts])
  // Contract match: number first, then the buyer name against the pool contracts' buyers.
  const preselected = useMemo(() => {
    const n = str(x.contract_number).trim().toLowerCase()
    const byNumber = n !== '' ? poolContracts.find((c) => (c.contract_number ?? '').trim().toLowerCase() === n) : null
    if (byNumber) return byNumber
    const buyer = findBestMatch(x.buyer, buyers, (b) => b.name)
    return buyer ? poolContracts.find((c) => c.buyer_id === buyer.id) ?? null : null
  }, [x, poolContracts, buyers])
  const [f, setF] = useState(() => ({
    contract_id: preselected?.id ?? (poolContracts.length === 1 ? poolContracts[0].id : ''),
    payment_type: (x.payment_type ?? 'progress') as 'initial_advance' | 'progress' | 'final_settlement',
    amount: str(x.amount),
    cents_per_lb_equivalent: dollarsStr(x.cents_per_lb_equivalent),
    payment_date: str(x.payment_date) || todayIso(),
  }))
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))
  const buyerName = (id: string | null) => (id ? buyers.find((b) => b.id === id)?.name ?? '—' : '—')

  async function save() {
    const amount = num(f.amount)
    if (!f.contract_id) { onErr('Pick the pool contract this payment belongs to.'); return }
    if (amount == null) { onErr('Enter the payment amount.'); return }
    try {
      const { error } = await supabase.from('cotton_pool_payments').insert({
        contract_id: f.contract_id, payment_type: f.payment_type, amount,
        cents_per_lb_equivalent: parseCottonPriceInput(f.cents_per_lb_equivalent), payment_date: f.payment_date || null, status: 'received',
      })
      if (error) throw new Error(error.message)
      await onDone(`Pool ${f.payment_type.replace('_', ' ')} of ${usd(amount)} recorded.`)
    } catch (e) { fail(onErr)(e) }
  }

  return (
    <div className="rounded-lg border border-slate-300 p-3 space-y-2">
      <div className="font-semibold text-sm">Pool payment — review &amp; save into the contract&apos;s ledger</div>
      {poolContracts.length === 0 && <p className="text-xs text-amber-700">No pool contracts on file for this crop year — save the pool agreement first.</p>}
      {x.buyer && !preselected && poolContracts.length > 1 && <p className="text-xs text-slate-500">AI read the pool as “{x.buyer}” — pick the contract below.</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <label className="flex flex-col gap-1 col-span-2">Pool contract
          <select value={f.contract_id} onChange={(e) => set('contract_id', e.target.value)} className={inputCls}>
            <option value="">— pick —</option>
            {poolContracts.map((c) => <option key={c.id} value={c.id}>{c.contract_number ?? 'pool'} — {buyerName(c.buyer_id)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Type
          <select value={f.payment_type} onChange={(e) => set('payment_type', e.target.value as typeof f.payment_type)} className={inputCls}>
            <option value="initial_advance">Initial advance</option>
            <option value="progress">Progress</option>
            <option value="final_settlement">Final settlement</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">Amount ($)
          <input type="number" step="0.01" value={f.amount} onChange={(e) => set('amount', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">$/lb equivalent
          <input type="text" inputMode="decimal" value={f.cents_per_lb_equivalent} onChange={(e) => set('cents_per_lb_equivalent', e.target.value)} className={inputCls} placeholder="0.6500" />
        </label>
        <label className="flex flex-col gap-1">Date
          <input type="date" value={f.payment_date} onChange={(e) => set('payment_date', e.target.value)} className={inputCls} />
        </label>
      </div>
      <button type="button" className={btnCls} disabled={!f.contract_id || num(f.amount) == null} onClick={save}>Record pool payment</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared partition table for the loan / LDP panels
// ---------------------------------------------------------------------------
function PartitionSummary({ p, targetLabel }: { p: BalePartition; targetLabel: string }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="rounded-full bg-green-100 text-green-800 px-2 py-0.5 font-semibold tabular-nums">{p.matchedCount} matched · {lbs0(p.matchedLbs)} lbs</span>
        <span className={`rounded-full px-2 py-0.5 font-semibold tabular-nums ${p.conflicts.length > 0 ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-500'}`}>{p.conflicts.length} blocked</span>
        <span className={`rounded-full px-2 py-0.5 font-semibold tabular-nums ${p.unmatched.length > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}>{p.unmatched.length} not on file</span>
      </div>
      {p.conflicts.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50/50 p-1.5 max-h-32 overflow-y-auto">
          {p.conflicts.map((c) => <div key={c.baleId} className="text-red-700"><span className="font-mono">{c.pbi}</span> — {c.reason}</div>)}
          <div className="text-red-800 font-semibold mt-0.5">Blocked bales are left off the {targetLabel}.</div>
        </div>
      )}
      {p.unmatched.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50/50 p-1.5">
          <span className="font-semibold text-amber-800">Not on file: </span>
          <span className="font-mono text-amber-900 break-words">{p.unmatched.join(', ')}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CCC loan
// ---------------------------------------------------------------------------
function LoanReview({ supabase, extracted: x, loans, bales, gradeByBale, dispositionByBale, loanedBaleIds, ldpBaleIds, entities, cropYear, singleEntityId, onDone, onErr }: PanelProps & { extracted: CccLoanExtract }) {
  const [f, setF] = useState(() => ({
    loan_number: str(x.loan_number),
    entry_date: str(x.entry_date) || todayIso(),
    maturity_date: str(x.maturity_date),
    rate: dollarsStr(x.loan_rate_base_cents) || (DEFAULT_LOAN_RATE / 100).toFixed(4),
    entity_id: singleEntityId ?? '',
  }))
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))

  const partition = useMemo(() => partitionBaleAssignment({
    tokens: (x.bale_pbis ?? []).map(String), bales, dispositionByBale, loanedBaleIds, ldpBaleIds, target: 'loan',
  }), [x.bale_pbis, bales, dispositionByBale, loanedBaleIds, ldpBaleIds])

  // Dedupe on loan_number: the document for an existing OPEN loan ADDS its
  // clean matched bales to that loan instead of creating a duplicate. A CLOSED
  // loan with the same number blocks the save outright (likely a re-upload).
  const sameNumber = useMemo(() => {
    const n = f.loan_number.trim().toLowerCase()
    return n === '' ? null : loans.find((l) => (l.loan_number ?? '').trim().toLowerCase() === n) ?? null
  }, [f.loan_number, loans])
  const existing = sameNumber?.status === 'open' ? sameNumber : null
  const closedDuplicate = sameNumber != null && sameNumber.status !== 'open' ? sameNumber : null

  const principal = useMemo(() => computeLoanPrincipal(
    partition.matched.map((m) => ({
      net_weight_lbs: m.lbs,
      loan_value_cents_per_lb: gradeByBale.get(m.baleId)?.loan_value_cents_per_lb ?? null,
    })),
    parseCottonPriceInput(f.rate) ?? DEFAULT_LOAN_RATE,
  ), [partition, gradeByBale, f.rate])

  async function save() {
    if (partition.matchedCount === 0) { onErr('No assignable bales matched — nothing to save.'); return }
    if (closedDuplicate) { onErr(`Loan ${closedDuplicate.loan_number} is already ${closedDuplicate.status.replace('_', ' ')} — not saved twice.`); return }
    const rate = parseCottonPriceInput(f.rate) ?? DEFAULT_LOAN_RATE
    const summaryLine = `${partition.matchedCount} bales · ${lbs0(partition.matchedLbs)} lbs · computed principal ${usd(principal.principalTotal)}` +
      (x.principal_total != null ? `\nDocument states principal ${usd(Number(x.principal_total))}` : '')
    try {
      if (existing) {
        if (!confirm(`Add to EXISTING loan ${existing.loan_number}:\n\n${summaryLine}\n\nBlocked/unmatched numbers are skipped.`)) return
        const { error } = await supabase.from('ccc_loan_bales').insert(partition.matched.map((m) => ({ loan_id: existing.id, bale_id: m.baleId })))
        if (error) throw new Error(error.message)
        await upsertDispositions(supabase, partition.matched.map((m) => m.baleId), 'ccc_loan', { loan_id: existing.id, disposition_date: f.entry_date })
        // Recompute the principal across the union of the loan's bales.
        const { data: allJunction } = await supabase.from('ccc_loan_bales').select('bale_id').eq('loan_id', existing.id)
        const ids = ((allJunction ?? []) as Array<{ bale_id: string }>).map((r) => r.bale_id)
        const baleById = new Map(bales.map((b) => [b.id, b]))
        const p = computeLoanPrincipal(
          ids.map((id) => ({
            net_weight_lbs: Number(baleById.get(id)?.net_weight_lbs ?? 0),
            loan_value_cents_per_lb: gradeByBale.get(id)?.loan_value_cents_per_lb ?? null,
          })),
          Number(existing.loan_rate_base_cents),
        )
        const { error: e2 } = await supabase.from('ccc_loans').update({ principal_total: p.principalTotal, pending_classing: p.pendingClassing }).eq('id', existing.id)
        if (e2) throw new Error(e2.message)
        await onDone(`${partition.matchedCount} bales added to loan ${existing.loan_number} — principal now ${usd(p.principalTotal)}.`)
      } else {
        if (!confirm(`Enter NEW CCC loan ${f.loan_number || '(no number)'}:\n\n${summaryLine}\n\nBlocked/unmatched numbers are skipped.`)) return
        const { data, error } = await supabase.from('ccc_loans').insert({
          entity_id: f.entity_id || null, crop_year: x.crop_year ?? cropYear,
          loan_number: f.loan_number.trim() || null,
          entry_date: f.entry_date, maturity_date: f.maturity_date || addMonthsIso(f.entry_date, 9),
          loan_rate_base_cents: rate, principal_total: principal.principalTotal,
          pending_classing: principal.pendingClassing, status: 'open',
        }).select('id').single()
        if (error || !data) throw new Error(error?.message ?? 'insert failed')
        const loanId = (data as { id: string }).id
        const { error: e2 } = await supabase.from('ccc_loan_bales').insert(partition.matched.map((m) => ({ loan_id: loanId, bale_id: m.baleId })))
        if (e2) throw new Error(e2.message)
        await upsertDispositions(supabase, partition.matched.map((m) => m.baleId), 'ccc_loan', { loan_id: loanId, disposition_date: f.entry_date })
        await onDone(`Loan ${f.loan_number || ''} entered — ${partition.matchedCount} bales, principal ${usd(principal.principalTotal)}${principal.pendingClassing ? ' (pending classing)' : ''}.`)
      }
    } catch (e) { fail(onErr)(e) }
  }

  return (
    <div className="rounded-lg border border-slate-300 p-3 space-y-2">
      <div className="font-semibold text-sm">CCC loan — review &amp; save</div>
      {existing && (
        <p className="text-xs text-amber-700">Loan #{existing.loan_number} already exists (open) — saving <strong>adds the matched bales to it</strong> and recomputes the principal; no duplicate loan is created.</p>
      )}
      {closedDuplicate && (
        <p className="text-xs text-red-700">Loan #{closedDuplicate.loan_number} is already on file and {closedDuplicate.status.replace('_', ' ')} — this looks like a re-upload; saving is blocked. Change the loan # if this really is a different loan.</p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <label className="flex flex-col gap-1">Loan #
          <input value={f.loan_number} onChange={(e) => set('loan_number', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Entry date
          <input type="date" value={f.entry_date} onChange={(e) => set('entry_date', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Maturity (blank = entry + 9 mo)
          <input type="date" value={f.maturity_date} onChange={(e) => set('maturity_date', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Base loan rate ($/lb)
          <input type="text" inputMode="decimal" value={f.rate} onChange={(e) => set('rate', e.target.value)} className={inputCls} placeholder="0.5500" />
        </label>
        {entities.length > 1 && !existing && (
          <label className="flex flex-col gap-1">Entity
            <select value={f.entity_id} onChange={(e) => set('entity_id', e.target.value)} className={inputCls}>
              <option value="">— entity —</option>
              {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <PartitionSummary p={partition} targetLabel="loan" />
      {partition.matchedCount > 0 && (
        <p className="text-sm tabular-nums">
          Computed principal (classing loan values, base rate where unclassed): <strong>{usd(principal.principalTotal)}</strong>
          {principal.pendingClassing && <span className="text-amber-700"> — some bales unclassed; recompute after grades import</span>}
          {x.principal_total != null && Math.abs(Number(x.principal_total) - principal.principalTotal) > 1 && (
            <span className="text-amber-700"> · document states {usd(Number(x.principal_total))} — review before saving</span>
          )}
        </p>
      )}
      <button type="button" className={btnCls} disabled={partition.matchedCount === 0 || closedDuplicate != null} onClick={save}>
        {existing ? `Add ${partition.matchedCount} bales to loan ${existing.loan_number}` : `Enter loan (${partition.matchedCount} bales)`}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LDP notice
// ---------------------------------------------------------------------------
function LdpReview({ supabase, extracted: x, bales, dispositionByBale, loanedBaleIds, ldpBaleIds, latestAwpCents, cropYear, singleEntityId, onDone, onErr }: PanelProps & { extracted: LdpNoticeExtract }) {
  const [f, setF] = useState(() => ({
    ldp_date: str(x.ldp_date) || todayIso(),
    awp_cents: dollarsStr(x.awp_cents) || (latestAwpCents != null ? (latestAwpCents / 100).toFixed(4) : ''),
    rate: dollarsStr(x.ldp_rate_cents),
  }))
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))

  const partition = useMemo(() => partitionBaleAssignment({
    tokens: (x.bale_pbis ?? []).map(String), bales, dispositionByBale, loanedBaleIds, ldpBaleIds, target: 'ldp',
  }), [x.bale_pbis, bales, dispositionByBale, loanedBaleIds, ldpBaleIds])

  const awpV = parseCottonPriceInput(f.awp_cents)
  // The LDP rate is small (0–15¢) — the guard threshold drops to 0.25.
  const rate = parseCottonPriceInput(f.rate, { centsThreshold: 0.25 }) ?? (awpV != null ? ldpRateCents(DEFAULT_LOAN_RATE, awpV) : null)
  const computedTotal = rate != null ? Math.round(((rate * partition.matchedLbs) / 100) * 100) / 100 : null

  async function save() {
    if (partition.matchedCount === 0) { onErr('No LDP-eligible bales matched — nothing to save.'); return }
    if (awpV == null || rate == null) { onErr('Enter the AWP ($/lb, e.g. 0.5143).'); return }
    if (rate <= 0) { onErr(`AWP ${cents(awpV)} is at/above the loan rate — no LDP is payable.`); return }
    const total = x.total_payment != null ? Number(x.total_payment) : computedTotal ?? 0
    if (!confirm(`Record LDP:\n\n${partition.matchedCount} bales · ${lbs0(partition.matchedLbs)} lbs\nRate ${cents(rate)}/lb → ${usd(computedTotal ?? 0)} computed${x.total_payment != null ? `\nDocument states ${usd(Number(x.total_payment))} (saved)` : ''}\n\nThese bales become CCC-loan-INELIGIBLE.`)) return
    try {
      const { data, error } = await supabase.from('cotton_ldp_records').insert({
        entity_id: singleEntityId || null, crop_year: x.crop_year ?? cropYear,
        ldp_date: f.ldp_date, awp_cents: awpV, ldp_rate_cents: rate, total_payment: total, status: 'received',
      }).select('id').single()
      if (error || !data) throw new Error(error?.message ?? 'insert failed')
      const { error: e2 } = await supabase.from('cotton_ldp_bales').insert(partition.matched.map((m) => ({ ldp_id: (data as { id: string }).id, bale_id: m.baleId })))
      if (e2) throw new Error(e2.message)
      await onDone(`LDP recorded — ${usd(total)} on ${lbs0(partition.matchedLbs)} lbs.`)
    } catch (e) { fail(onErr)(e) }
  }

  return (
    <div className="rounded-lg border border-slate-300 p-3 space-y-2">
      <div className="font-semibold text-sm">LDP notice — review &amp; save</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <label className="flex flex-col gap-1">LDP date
          <input type="date" value={f.ldp_date} onChange={(e) => set('ldp_date', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">AWP ($/lb)
          <input type="text" inputMode="decimal" value={f.awp_cents} onChange={(e) => set('awp_cents', e.target.value)} className={inputCls} placeholder="0.5143" />
        </label>
        <label className="flex flex-col gap-1">LDP rate ($/lb, blank = loan rate − AWP)
          <input type="text" inputMode="decimal" value={f.rate} onChange={(e) => set('rate', e.target.value)} className={inputCls} placeholder="0.0360" />
        </label>
      </div>
      <PartitionSummary p={partition} targetLabel="LDP" />
      {partition.matchedCount > 0 && rate != null && (
        <p className="text-sm tabular-nums">Rate <strong>{cents(rate)}/lb</strong> × {lbs0(partition.matchedLbs)} lbs → <strong>{usd(computedTotal ?? 0)}</strong>{x.total_payment != null ? ` · document states ${usd(Number(x.total_payment))}` : ''}</p>
      )}
      <button type="button" className={btnCls} disabled={partition.matchedCount === 0} onClick={save}>Record LDP ({partition.matchedCount} bales)</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Equity sale confirmation
// ---------------------------------------------------------------------------
function EquityReview({ supabase, extracted: x, loans, buyers, loanLbsFor, onBuyerCreated, onDone, onErr }: PanelProps & { extracted: EquitySaleExtract }) {
  const openLoans = useMemo(() => loans.filter((l) => l.status === 'open'), [loans])
  const matchedLoan = useMemo(() => {
    const n = str(x.loan_number).trim().toLowerCase()
    return n === '' ? null : openLoans.find((l) => (l.loan_number ?? '').trim().toLowerCase() === n) ?? null
  }, [x.loan_number, openLoans])
  const matchedBuyer = useMemo(() => findBestMatch(x.buyer, buyers, (b) => b.name), [x.buyer, buyers])
  const [f, setF] = useState(() => ({
    loan_id: matchedLoan?.id ?? (openLoans.length === 1 ? openLoans[0].id : ''),
    cents: dollarsStr(x.equity_cents_per_lb),
    buyer_id: matchedBuyer?.id ?? '',
    date: str(x.sale_date) || todayIso(),
  }))
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))

  const loan = openLoans.find((l) => l.id === f.loan_id) ?? null
  const eq = parseCottonPriceInput(f.cents, { centsThreshold: 0.25 })
  const preview = loan && eq != null && eq >= 0
    ? equityOutcome({ principalTotal: Number(loan.principal_total), lbs: loanLbsFor(loan.id), equityCentsPerLb: eq })
    : null

  async function save() {
    if (!loan || eq == null || eq < 0) { onErr('Pick the loan and enter the equity ($/lb, e.g. 0.0800).'); return }
    const o = equityOutcome({ principalTotal: Number(loan.principal_total), lbs: loanLbsFor(loan.id), equityCentsPerLb: eq })
    if (!confirm(`Equity sale on ${loan.loan_number ?? 'loan'} at ${cents(eq)}/lb:\n\nEquity received: ${usd(o.equityTotal)}\nEffective sale price: ${cents(o.effectiveCentsPerLb)}/lb (loan + equity)\n\nBales are final — the merchant owns them.`)) return
    try {
      const { error } = await supabase.from('ccc_loans').update({
        status: 'equity_sold', outcome_date: f.date || todayIso(), equity_cents_per_lb: eq,
        equity_total: o.equityTotal, buyer_id: f.buyer_id || null,
      }).eq('id', loan.id)
      if (error) throw new Error(error.message)
      await onDone(`Equity sold on ${loan.loan_number ?? 'loan'} — ${usd(o.equityTotal)} at an effective ${cents(o.effectiveCentsPerLb)}/lb.`)
    } catch (e) { fail(onErr)(e) }
  }

  return (
    <div className="rounded-lg border border-slate-300 p-3 space-y-2">
      <div className="font-semibold text-sm">Equity sale confirmation — review &amp; apply to the loan</div>
      {x.loan_number && !matchedLoan && <p className="text-xs text-amber-700">Document references loan “{x.loan_number}” — no OPEN loan with that number; pick below.</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <label className="flex flex-col gap-1">CCC loan
          <select value={f.loan_id} onChange={(e) => set('loan_id', e.target.value)} className={inputCls}>
            <option value="">— open loans —</option>
            {openLoans.map((l) => <option key={l.id} value={l.id}>{l.loan_number ?? l.entry_date} — {usd(Number(l.principal_total))}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Equity ($/lb over the loan)
          <input type="text" inputMode="decimal" value={f.cents} onChange={(e) => set('cents', e.target.value)} className={inputCls} placeholder="0.0800" />
        </label>
        <label className="flex flex-col gap-1">Equity purchaser
          <BuyerPicker value={f.buyer_id} onChange={(id) => set('buyer_id', id)} buyers={buyers} onCreated={onBuyerCreated} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Sale date
          <input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} className={inputCls} />
        </label>
      </div>
      {preview && (
        <p className="text-sm tabular-nums">→ equity <strong>{usd(preview.equityTotal)}</strong> · effective <strong>{cents(preview.effectiveCentsPerLb)}/lb</strong>
          {x.equity_total != null && Math.abs(Number(x.equity_total) - preview.equityTotal) > 1 && (
            <span className="text-amber-700"> · document states {usd(Number(x.equity_total))} — review</span>
          )}
        </p>
      )}
      <button type="button" className={btnCls} disabled={!loan || eq == null || eq < 0} onClick={save}>Confirm equity sale</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Warehouse / storage invoice → an ACTUAL fee row (replaces the projection slot)
// ---------------------------------------------------------------------------
function StorageInvoiceReview({ supabase, extracted: x, loans, fees, cropYear, singleEntityId, onDone, onErr }: PanelProps & { extracted: StorageInvoiceExtract }) {
  const matchedLoan = useMemo(() => {
    const n = str(x.loan_number).trim().toLowerCase()
    return n === '' ? null : loans.find((l) => (l.loan_number ?? '').trim().toLowerCase() === n) ?? null
  }, [x.loan_number, loans])
  const [f, setF] = useState(() => ({
    fee_type: (x.fee_type ?? 'storage_monthly') as NonNullable<StorageInvoiceExtract['fee_type']>,
    amount: str(x.amount_total),
    fee_date: str(x.fee_date) || todayIso(),
    invoice_number: str(x.invoice_number),
    loan_id: matchedLoan?.id ?? '',
    notes: str(x.notes),
  }))
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))

  // Dedupe on the invoice number (stored in notes — 044 has no invoice column):
  // an actual fee row already carrying this number blocks a double entry.
  const duplicate = useMemo(() => {
    const n = f.invoice_number.trim()
    return n !== '' ? fees.find((fee) => fee.status === 'actual' && (fee.notes ?? '').includes(`Inv ${n}`)) ?? null : null
  }, [f.invoice_number, fees])

  async function save() {
    const amount = num(f.amount)
    if (amount == null) { onErr('Enter the invoiced amount.'); return }
    if (duplicate) { onErr(`Invoice ${f.invoice_number} is already recorded as an actual fee — not saved twice.`); return }
    try {
      const notes = [f.invoice_number.trim() ? `Inv ${f.invoice_number.trim()}` : '', f.notes.trim()].filter(Boolean).join(' — ') || null
      const { error } = await supabase.from('cotton_fees').insert({
        entity_id: singleEntityId || null, crop_year: x.crop_year ?? cropYear,
        fee_type: f.fee_type, basis: 'flat', rate: null,
        loan_id: f.loan_id || null, contract_id: null,
        amount_total: amount, status: 'actual', fee_date: f.fee_date || null, notes,
      })
      if (error) throw new Error(error.message)
      await onDone(`Fee invoice recorded — ${usd(amount)} (${f.fee_type.replace(/_/g, ' ')}). Actuals replace the matching projection slot.`)
    } catch (e) { fail(onErr)(e) }
  }

  return (
    <div className="rounded-lg border border-slate-300 p-3 space-y-2">
      <div className="font-semibold text-sm">Storage / fee invoice — review &amp; save as an actual fee</div>
      {duplicate && <p className="text-xs text-red-700">Invoice {f.invoice_number} already recorded ({usd(Number(duplicate.amount_total))} on {duplicate.fee_date ?? '—'}) — duplicate blocked.</p>}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <label className="flex flex-col gap-1">Fee type
          <select value={f.fee_type} onChange={(e) => set('fee_type', e.target.value as typeof f.fee_type)} className={inputCls}>
            {(['warehouse_receiving', 'storage_monthly', 'classing', 'checkoff', 'loan_interest', 'loan_servicing', 'pool_deduction', 'merchant_fee', 'other'] as const).map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">Amount ($)
          <input type="number" step="0.01" value={f.amount} onChange={(e) => set('amount', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Invoice #
          <input value={f.invoice_number} onChange={(e) => set('invoice_number', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">Date
          <input type="date" value={f.fee_date} onChange={(e) => set('fee_date', e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">CCC loan (optional)
          <select value={f.loan_id} onChange={(e) => set('loan_id', e.target.value)} className={inputCls}>
            <option value="">—</option>
            {loans.map((l) => <option key={l.id} value={l.id}>{l.loan_number ?? l.entry_date}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 col-span-2">Notes
          <input value={f.notes} onChange={(e) => set('notes', e.target.value)} className={inputCls} />
        </label>
      </div>
      <button type="button" className={btnCls} disabled={num(f.amount) == null || duplicate != null} onClick={save}>Record actual fee</button>
    </div>
  )
}

// Write (or update) one disposition row per bale — same upsert the page uses.
async function upsertDispositions(
  supabase: ReturnType<typeof createClient>,
  baleIds: string[],
  disposition: CottonDisposition,
  patch: { loan_id?: string; contract_id?: string; disposition_date?: string },
) {
  for (const bale_id of baleIds) {
    const { error } = await supabase.from('cotton_bale_dispositions').upsert(
      { bale_id, disposition, contract_id: patch.contract_id ?? null, loan_id: patch.loan_id ?? null, disposition_date: patch.disposition_date ?? todayIso() },
      { onConflict: 'bale_id' },
    )
    if (error) throw new Error(error.message)
  }
}
