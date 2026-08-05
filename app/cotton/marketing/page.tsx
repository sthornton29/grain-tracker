'use client'

// Cotton Marketing — physical cotton: sales contracts (spot / fixed / on-call /
// pool), CCC loans (per-bale principal from classing values), LDP, fees, AWP,
// and the bale-disposition board ("where is my cotton"). Producer-only (gin
// operators never see this page). Prices are STORED in ¢/lb and DISPLAYED as
// $/lb; price inputs accept dollar-style entry (0.7425) and legacy cents
// (74.25) via the smart-magnitude guard. Weights are lbs of lint.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { BuyerPicker } from '@/components/buyer-location-pickers'
import { formatCottonPrice, parseCottonPriceInput } from '@/lib/hedging'
import MarketingDocImport from '@/components/cotton/marketing-doc-import'
import BaleFileAssign from '@/components/cotton/bale-file-assign'
import {
  buildCottonPhysicalSummary, computeLoanPrincipal, contractPricedCents,
  dispositionBoard, equityOutcome, ldpRateCents, projectBaleHandlingFees,
  projectLoanFees, projectSaleCheckoff, redemptionOutcome,
  type CottonPhysicalInputs,
} from '@/lib/cotton-sales'
import type {
  AwpWeekly, Buyer, CccLoan, CottonBale, CottonBaleDisposition, CottonBaleGrade,
  CottonContractType, CottonDisposition, CottonFee, CottonFeeSchedule,
  CottonLdpRecord, CottonPoolPayment, CottonSalesContract, Entity, Farm, Field, GinReceipt,
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

const CONTRACT_TYPE_LABEL: Record<CottonContractType, string> = {
  spot: 'Spot', fixed_price: 'Fixed price', on_call: 'On-call', pool: 'Pool',
}
const DISPOSITION_LABEL: Record<CottonDisposition, string> = {
  held: 'Held', ccc_loan: 'In CCC loan', sold_spot: 'Sold (spot)', contract_delivery: 'Contract delivery', pool: 'Pool',
}
const DEFAULT_LOAN_RATE = 55 // 2026 upland base loan rate, ¢/lb — editable per loan

function addMonthsIso(dateIso: string, months: number): string {
  const d = new Date(dateIso + 'T00:00:00')
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

export default function CottonMarketingPage() {
  const supabase = useMemo(() => createClient(), [])
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [entities, setEntities] = useState<Entity[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [receipts, setReceipts] = useState<GinReceipt[]>([])
  const [bales, setBales] = useState<CottonBale[]>([])
  const [grades, setGrades] = useState<CottonBaleGrade[]>([])
  const [dispositions, setDispositions] = useState<CottonBaleDisposition[]>([])
  const [contracts, setContracts] = useState<CottonSalesContract[]>([])
  const [poolPayments, setPoolPayments] = useState<CottonPoolPayment[]>([])
  const [loans, setLoans] = useState<CccLoan[]>([])
  const [loanBales, setLoanBales] = useState<Array<{ loan_id: string; bale_id: string }>>([])
  const [ldps, setLdps] = useState<CottonLdpRecord[]>([])
  const [ldpBales, setLdpBales] = useState<Array<{ ldp_id: string; bale_id: string }>>([])
  const [fees, setFees] = useState<CottonFee[]>([])
  const [feeSchedule, setFeeSchedule] = useState<CottonFeeSchedule | null>(null)
  const [awp, setAwp] = useState<AwpWeekly[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  async function refresh() {
    const [en, by, fa, fi, gr, cb, bg, dp, ct, pp, lo, lb, ld, ldb, fe, fs, aw] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('buyers').select('*').order('name'),
      supabase.from('farms').select('*'),
      supabase.from('fields').select('*'),
      supabase.from('gin_receipts').select('*').eq('crop_year', cropYear),
      supabase.from('cotton_bales').select('*').eq('crop_year', cropYear),
      supabase.from('cotton_bale_grades').select('*'),
      supabase.from('cotton_bale_dispositions').select('*'),
      supabase.from('cotton_sales_contracts').select('*').eq('crop_year', cropYear).order('created_at'),
      supabase.from('cotton_pool_payments').select('*').order('payment_date'),
      supabase.from('ccc_loans').select('*').eq('crop_year', cropYear).order('entry_date'),
      supabase.from('ccc_loan_bales').select('loan_id, bale_id'),
      supabase.from('cotton_ldp_records').select('*').eq('crop_year', cropYear).order('ldp_date'),
      supabase.from('cotton_ldp_bales').select('ldp_id, bale_id'),
      supabase.from('cotton_fees').select('*').eq('crop_year', cropYear).order('fee_date'),
      supabase.from('cotton_fee_schedule').select('*').eq('crop_year', cropYear).maybeSingle(),
      supabase.from('awp_weekly').select('*').order('week_effective', { ascending: false }).limit(30),
    ])
    if (ct.error?.message.includes('does not exist') || ct.error?.code === '42P01') {
      setErr('This part of Turnrow isn’t set up yet — contact support.')
    }
    setEntities((en.data as Entity[]) || [])
    setBuyers((by.data as Buyer[]) || [])
    setFarms((fa.data as Farm[]) || [])
    setFields((fi.data as Field[]) || [])
    setReceipts((gr.data as GinReceipt[]) || [])
    setBales((cb.data as CottonBale[]) || [])
    setGrades((bg.data as CottonBaleGrade[]) || [])
    setDispositions((dp.data as CottonBaleDisposition[]) || [])
    setContracts((ct.data as CottonSalesContract[]) || [])
    setPoolPayments((pp.data as CottonPoolPayment[]) || [])
    setLoans((lo.data as CccLoan[]) || [])
    setLoanBales(((lb.data as unknown) as Array<{ loan_id: string; bale_id: string }>) || [])
    setLdps((ld.data as CottonLdpRecord[]) || [])
    setLdpBales(((ldb.data as unknown) as Array<{ ldp_id: string; bale_id: string }>) || [])
    setFees((fe.data as CottonFee[]) || [])
    setFeeSchedule((fs.data as CottonFeeSchedule) || null)
    setAwp((aw.data as AwpWeekly[]) || [])
    setLoaded(true)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [cropYear])

  const gradeByBale = useMemo(() => new Map(grades.map((g) => [g.bale_id, g])), [grades])
  const baleById = useMemo(() => new Map(bales.map((b) => [b.id, b])), [bales])
  const receiptById = useMemo(() => new Map(receipts.map((r) => [r.id, r])), [receipts])
  const buyerName = (id: string | null) => (id ? buyers.find((b) => b.id === id)?.name ?? '—' : '—')
  const farmName = (id: string | null) => (id ? farms.find((f) => f.id === id)?.name ?? '' : '')
  const fieldName = (id: string | null) => (id ? fields.find((f) => f.id === id)?.name_or_number ?? '' : '')
  const latestAwp = awp[0] ?? null

  const board = useMemo(() => dispositionBoard(bales, dispositions), [bales, dispositions])
  const inputs = useMemo<CottonPhysicalInputs>(() => ({
    cropYear, bales, gradesByBale: gradeByBale, dispositions, contracts, poolPayments, loans, loanBales, ldps, fees,
  }), [cropYear, bales, gradeByBale, dispositions, contracts, poolPayments, loans, loanBales, ldps, fees])
  const summary = useMemo(() => buildCottonPhysicalSummary(inputs), [inputs])

  const dispByBale = useMemo(() => new Map(dispositions.map((d) => [d.bale_id, d])), [dispositions])
  // Disposition KIND per bale (missing row = held) — the shape the doc-import
  // and file-assign partitions consume.
  const dispositionKindByBale = useMemo(
    () => new Map<string, CottonDisposition>(dispositions.map((d) => [d.bale_id, d.disposition])),
    [dispositions],
  )
  const loanedBaleIds = useMemo(() => new Set(loanBales.map((x) => x.bale_id)), [loanBales])
  const ldpBaleIds = useMemo(() => new Set(ldpBales.map((x) => x.bale_id)), [ldpBales])
  const heldBales = useMemo(
    () => bales.filter((b) => (dispByBale.get(b.id)?.disposition ?? 'held') === 'held'),
    [bales, dispByBale],
  )

  // Write (or update) one disposition row per bale.
  async function setBaleDispositions(baleIds: string[], patch: Omit<Partial<CottonBaleDisposition>, 'bale_id'> & { disposition: CottonDisposition }) {
    for (const bale_id of baleIds) {
      const { error } = await supabase.from('cotton_bale_dispositions').upsert(
        { bale_id, disposition: patch.disposition, contract_id: patch.contract_id ?? null, loan_id: patch.loan_id ?? null, disposition_date: patch.disposition_date ?? todayIso() },
        { onConflict: 'bale_id' },
      )
      if (error) throw new Error(error.message)
    }
  }

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : 'Unexpected error')
  const done = async (msg: string) => { setBanner(msg); setErr(null); await refresh() }

  // ---------------- Sales contracts ----------------
  type ContractForm = {
    id: string | null
    entity_id: string; buyer_id: string; contract_type: CottonContractType; contract_number: string
    contract_date: string; commitment_basis: 'bales' | 'acres'; committed_bales: string; committed_acres: string
    price_cents_per_lb: string; basis_cents: string; futures_month: string
    delivery_start: string; delivery_end: string; notes: string
  }
  const emptyContract: ContractForm = {
    id: null, entity_id: entities.length === 1 ? entities[0].id : '', buyer_id: '', contract_type: 'fixed_price',
    contract_number: '', contract_date: todayIso(), commitment_basis: 'bales', committed_bales: '', committed_acres: '',
    price_cents_per_lb: '', basis_cents: '', futures_month: 'DEC 26', delivery_start: '', delivery_end: '', notes: '',
  }
  const [contractForm, setContractForm] = useState<ContractForm | null>(null)
  const cf = <K extends keyof ContractForm>(k: K, v: ContractForm[K]) => setContractForm((f) => (f ? { ...f, [k]: v } : f))

  async function saveContract() {
    if (!contractForm) return
    const f = contractForm
    const payload = {
      entity_id: f.entity_id || null, crop_year: cropYear, buyer_id: f.buyer_id || null,
      contract_type: f.contract_type, contract_number: f.contract_number.trim() || null,
      contract_date: f.contract_date || null, commitment_basis: f.commitment_basis,
      committed_bales: f.commitment_basis === 'bales' ? num(f.committed_bales) : null,
      committed_acres: f.commitment_basis === 'acres' ? num(f.committed_acres) : null,
      price_cents_per_lb: f.contract_type === 'spot' || f.contract_type === 'fixed_price' ? parseCottonPriceInput(f.price_cents_per_lb) : null,
      // Basis is small either way (-2.50¢ vs -$0.025): the guard threshold drops to 0.25.
      basis_cents: f.contract_type === 'on_call' ? parseCottonPriceInput(f.basis_cents, { centsThreshold: 0.25 }) : null,
      futures_month: f.contract_type === 'on_call' ? (f.futures_month.trim() || null) : null,
      pricing_status: f.contract_type === 'pool' ? 'pool_open' : f.contract_type === 'on_call' ? 'awaiting_futures' : 'fully_priced',
      delivery_start: f.delivery_start || null, delivery_end: f.delivery_end || null, notes: f.notes.trim() || null,
    }
    try {
      if (f.id) {
        // Editing never regresses an already-fixed on-call to awaiting.
        const existing = contracts.find((c) => c.id === f.id)
        const keepStatus = existing?.contract_type === 'on_call' && existing.futures_fixed_cents != null
        const { error } = await supabase.from('cotton_sales_contracts')
          .update(keepStatus ? { ...payload, pricing_status: existing!.pricing_status } : payload).eq('id', f.id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from('cotton_sales_contracts').insert(payload)
        if (error) throw new Error(error.message)
      }
      setContractForm(null)
      await done('Contract saved.')
    } catch (e) { fail(e) }
  }

  async function fixFutures(c: CottonSalesContract) {
    const s = prompt(`Fix the futures leg for ${c.contract_number ?? 'this on-call contract'} (${c.futures_month ?? '—'}).\nEnter the fixed futures price in $/lb (e.g. 0.7450 — legacy 74.50 also works):`)
    if (s == null) return
    const v = parseCottonPriceInput(s)
    if (v == null || v <= 0) { setErr('Enter the fixed futures price in $/lb, e.g. 0.7450'); return }
    try {
      const { error } = await supabase.from('cotton_sales_contracts')
        .update({ futures_fixed_cents: v, futures_fixed_date: todayIso(), pricing_status: 'fully_priced' }).eq('id', c.id)
      if (error) throw new Error(error.message)
      await done(`Futures fixed at ${cents(v)} — cash price ${cents((Number(c.basis_cents ?? 0)) + v)}.`)
    } catch (e) { fail(e) }
  }

  async function deleteContract(c: CottonSalesContract) {
    const assigned = dispositions.filter((d) => d.contract_id === c.id)
    if (!confirm(`Delete contract ${c.contract_number ?? ''}? ${assigned.length > 0 ? `${assigned.length} assigned bales return to Held.` : ''}`)) return
    try {
      if (assigned.length > 0) await setBaleDispositions(assigned.map((d) => d.bale_id), { disposition: 'held' })
      const { error } = await supabase.from('cotton_sales_contracts').delete().eq('id', c.id)
      if (error) throw new Error(error.message)
      await done('Contract deleted.')
    } catch (e) { fail(e) }
  }

  // Pool payment entry (per pool contract).
  async function addPoolPayment(contractId: string) {
    const amount = num(prompt('Payment amount ($):') ?? '')
    if (amount == null) return
    const type = (prompt("Type: 'initial_advance' | 'progress' | 'final_settlement'", 'progress') ?? '').trim()
    if (!['initial_advance', 'progress', 'final_settlement'].includes(type)) { setErr('Unknown pool payment type.'); return }
    const date = (prompt('Payment date (YYYY-MM-DD):', todayIso()) ?? '').trim()
    const perLb = parseCottonPriceInput(prompt('$/lb equivalent (optional — running total per lb, e.g. 0.6500):') ?? '')
    try {
      const { error } = await supabase.from('cotton_pool_payments').insert({
        contract_id: contractId, payment_type: type, amount, payment_date: date || null,
        cents_per_lb_equivalent: perLb, status: 'received',
      })
      if (error) throw new Error(error.message)
      await done('Pool payment recorded.')
    } catch (e) { fail(e) }
  }

  // ---------------- Bale picking (contracts / loans / LDP) ----------------
  const [pickFor, setPickFor] = useState<{ kind: 'contract' | 'loan' | 'ldp'; id?: string } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [pickReceipt, setPickReceipt] = useState('')

  const pickableBales = useMemo(() => {
    if (!pickFor) return []
    let list = heldBales
    if (pickFor.kind === 'loan') list = list.filter((b) => !loanedBaleIds.has(b.id) && !ldpBaleIds.has(b.id))
    if (pickFor.kind === 'ldp') list = list.filter((b) => !loanedBaleIds.has(b.id) && !ldpBaleIds.has(b.id))
    if (pickReceipt) list = list.filter((b) => b.gin_receipt_id === pickReceipt)
    return list
  }, [pickFor, heldBales, loanedBaleIds, ldpBaleIds, pickReceipt])
  const pickedLbs = useMemo(
    () => [...picked].reduce((s, id) => s + Number(baleById.get(id)?.net_weight_lbs ?? 0), 0),
    [picked, baleById],
  )

  // ---------------- CCC loans ----------------
  const [loanForm, setLoanForm] = useState<{ entity_id: string; loan_number: string; entry_date: string; rate: string } | null>(null)

  const loanPrincipalPreview = useMemo(() => {
    if (!loanForm) return null
    return computeLoanPrincipal(
      [...picked].map((id) => ({
        net_weight_lbs: Number(baleById.get(id)?.net_weight_lbs ?? 0),
        loan_value_cents_per_lb: gradeByBale.get(id)?.loan_value_cents_per_lb ?? null,
      })),
      parseCottonPriceInput(loanForm.rate) ?? DEFAULT_LOAN_RATE,
    )
  }, [loanForm, picked, baleById, gradeByBale])

  async function saveLoan() {
    if (!loanForm || picked.size === 0 || !loanPrincipalPreview) return
    const rate = parseCottonPriceInput(loanForm.rate) ?? DEFAULT_LOAN_RATE
    try {
      const { data, error } = await supabase.from('ccc_loans').insert({
        entity_id: loanForm.entity_id || null, crop_year: cropYear,
        loan_number: loanForm.loan_number.trim() || null,
        entry_date: loanForm.entry_date, maturity_date: addMonthsIso(loanForm.entry_date, 9),
        loan_rate_base_cents: rate, principal_total: loanPrincipalPreview.principalTotal,
        pending_classing: loanPrincipalPreview.pendingClassing, status: 'open',
      }).select('id').single()
      if (error || !data) throw new Error(error?.message ?? 'insert failed')
      const loanId = (data as { id: string }).id
      const { error: e2 } = await supabase.from('ccc_loan_bales').insert([...picked].map((bale_id) => ({ loan_id: loanId, bale_id })))
      if (e2) throw new Error(e2.message)
      await setBaleDispositions([...picked], { disposition: 'ccc_loan', loan_id: loanId, disposition_date: loanForm.entry_date })
      setLoanForm(null); setPickFor(null); setPicked(new Set())
      await done(`Loan entered — ${lbs0(loanPrincipalPreview.lbs)} lbs, principal ${usd(loanPrincipalPreview.principalTotal)}${loanPrincipalPreview.pendingClassing ? ' (pending classing — recompute when grades import)' : ''}.`)
    } catch (e) { fail(e) }
  }

  // Recompute a pending-classing loan's principal from newly-imported grades.
  async function recomputeLoan(loan: CccLoan) {
    const ids = loanBales.filter((x) => x.loan_id === loan.id).map((x) => x.bale_id)
    const p = computeLoanPrincipal(
      ids.map((id) => ({
        net_weight_lbs: Number(baleById.get(id)?.net_weight_lbs ?? 0),
        loan_value_cents_per_lb: gradeByBale.get(id)?.loan_value_cents_per_lb ?? null,
      })),
      Number(loan.loan_rate_base_cents),
    )
    try {
      const { error } = await supabase.from('ccc_loans').update({ principal_total: p.principalTotal, pending_classing: p.pendingClassing }).eq('id', loan.id)
      if (error) throw new Error(error.message)
      await done(p.pendingClassing ? 'Recomputed — some bales still lack classing.' : `Principal recomputed from classing: ${usd(p.principalTotal)}.`)
    } catch (e) { fail(e) }
  }

  function loanLbs(loanId: string): number {
    return loanBales.filter((x) => x.loan_id === loanId).reduce((s, x) => s + Number(baleById.get(x.bale_id)?.net_weight_lbs ?? 0), 0)
  }

  async function redeemLoan(loan: CccLoan) {
    const awpS = prompt(`Redeem ${loan.loan_number ?? 'loan'} — enter the AWP ($/lb) at redemption:`, latestAwp ? (Number(latestAwp.awp_cents) / 100).toFixed(4) : '')
    if (awpS == null) return
    const awpV = parseCottonPriceInput(awpS)
    if (awpV == null || awpV <= 0) { setErr('Enter the AWP in $/lb, e.g. 0.5143.'); return }
    const lbsV = loanLbs(loan.id)
    const o = redemptionOutcome({ principalTotal: Number(loan.principal_total), lbs: lbsV, loanRateBaseCents: Number(loan.loan_rate_base_cents), awpCents: awpV })
    if (!confirm(`Redeem at AWP ${cents(awpV)}:\n\nPayoff: ${usd(o.payoffTotal)}\nMarketing loan gain: ${usd(o.mlgTotal)} (${cents(o.mlgRateCents)}/lb${o.mlgTotal > 0 ? ', interest waived' : ''})\n\nBales return to Held.`)) return
    try {
      const { error } = await supabase.from('ccc_loans').update({
        status: 'redeemed', outcome_date: todayIso(), awp_at_outcome_cents: awpV,
        redemption_payoff_total: o.payoffTotal, mlg_total: o.mlgTotal,
      }).eq('id', loan.id)
      if (error) throw new Error(error.message)
      await setBaleDispositions(loanBales.filter((x) => x.loan_id === loan.id).map((x) => x.bale_id), { disposition: 'held' })
      await done(`Loan redeemed — MLG ${usd(o.mlgTotal)} banked; bales back to Held.`)
    } catch (e) { fail(e) }
  }

  // Equity sale: inline panel (equity ¢/lb + buyer via the shared picker with
  // inline "Add new buyer…" — same component as the grain contract form).
  const [equityFor, setEquityFor] = useState<{ loanId: string; cents: string; buyerId: string } | null>(null)

  async function confirmEquitySale() {
    if (!equityFor) return
    const loan = loans.find((l) => l.id === equityFor.loanId)
    if (!loan) return
    const eq = parseCottonPriceInput(equityFor.cents, { centsThreshold: 0.25 })
    if (eq == null || eq < 0) { setErr('Enter the equity in $/lb, e.g. 0.0800.'); return }
    const lbsV = loanLbs(loan.id)
    const o = equityOutcome({ principalTotal: Number(loan.principal_total), lbs: lbsV, equityCentsPerLb: eq })
    if (!confirm(`Equity sale at ${cents(eq)}/lb on ${lbs0(lbsV)} lbs:\n\nEquity received: ${usd(o.equityTotal)}\nEffective sale price: ${cents(o.effectiveCentsPerLb)}/lb (loan + equity)\n\nBales are final — the merchant owns them.`)) return
    try {
      const { error } = await supabase.from('ccc_loans').update({
        status: 'equity_sold', outcome_date: todayIso(), equity_cents_per_lb: eq,
        equity_total: o.equityTotal, buyer_id: equityFor.buyerId || null,
      }).eq('id', loan.id)
      if (error) throw new Error(error.message)
      setEquityFor(null)
      await done(`Equity sold — ${usd(o.equityTotal)} at an effective ${cents(o.effectiveCentsPerLb)}/lb.`)
    } catch (e) { fail(e) }
  }

  async function forfeitLoan(loan: CccLoan) {
    if (!confirm(`Forfeit ${loan.loan_number ?? 'loan'}? The CCC keeps the cotton; you keep the ${usd(Number(loan.principal_total))} principal.`)) return
    try {
      const { error } = await supabase.from('ccc_loans').update({ status: 'forfeited', outcome_date: todayIso() }).eq('id', loan.id)
      if (error) throw new Error(error.message)
      await done('Loan forfeited.')
    } catch (e) { fail(e) }
  }

  // ---------------- LDP ----------------
  async function saveLdp() {
    if (picked.size === 0) return
    const rate = ldpRateCents(DEFAULT_LOAN_RATE, Number(latestAwp?.awp_cents ?? DEFAULT_LOAN_RATE))
    const awpS = prompt(`LDP on ${picked.size} bales (${lbs0(pickedLbs)} lbs).\nAWP ($/lb):`, latestAwp ? (Number(latestAwp.awp_cents) / 100).toFixed(4) : '')
    if (awpS == null) return
    const awpV = parseCottonPriceInput(awpS)
    if (awpV == null || awpV <= 0) { setErr('Enter the AWP in $/lb, e.g. 0.5143.'); return }
    const r = ldpRateCents(DEFAULT_LOAN_RATE, awpV)
    void rate
    const total = Math.round(((r * pickedLbs) / 100) * 100) / 100
    if (r <= 0) { setErr(`AWP ${cents(awpV)} is at/above the ${cents(DEFAULT_LOAN_RATE)} loan rate — no LDP is payable.`); return }
    if (!confirm(`LDP rate = ${cents(DEFAULT_LOAN_RATE)} loan rate − ${cents(awpV)} AWP = ${cents(r)}/lb\nTotal payment: ${usd(total)}\n\nThese bales become CCC-loan-INELIGIBLE.`)) return
    try {
      const { data, error } = await supabase.from('cotton_ldp_records').insert({
        entity_id: entities.length === 1 ? entities[0].id : null, crop_year: cropYear,
        ldp_date: todayIso(), awp_cents: awpV, ldp_rate_cents: r, total_payment: total, status: 'received',
      }).select('id').single()
      if (error || !data) throw new Error(error?.message ?? 'insert failed')
      const { error: e2 } = await supabase.from('cotton_ldp_bales').insert([...picked].map((bale_id) => ({ ldp_id: (data as { id: string }).id, bale_id })))
      if (e2) throw new Error(e2.message)
      setPickFor(null); setPicked(new Set())
      await done(`LDP recorded — ${usd(total)} on ${lbs0(pickedLbs)} lbs.`)
    } catch (e) { fail(e) }
  }

  // Assign picked bales to a contract (delivery / spot sale).
  async function assignPickedToContract(contractId: string) {
    const c = contracts.find((x) => x.id === contractId)
    if (!c || picked.size === 0) return
    try {
      await setBaleDispositions([...picked], {
        disposition: c.contract_type === 'spot' ? 'sold_spot' : c.contract_type === 'pool' ? 'pool' : 'contract_delivery',
        contract_id: contractId,
      })
      setPickFor(null); setPicked(new Set())
      await done(`${picked.size} bales (${lbs0(pickedLbs)} lbs) assigned to ${c.contract_number ?? CONTRACT_TYPE_LABEL[c.contract_type]}.`)
    } catch (e) { fail(e) }
  }

  // ---------------- Fees & schedule ----------------
  const effSchedule: CottonFeeSchedule = useMemo(() => feeSchedule ?? {
    id: '', crop_year: cropYear, storage_per_bale_month: 2.85, receiving_per_bale: 6, classing_per_bale: 2.2,
    checkoff_per_bale: 1, checkoff_supplemental_pct: 0.005, loan_interest_apr: 0.05, updated_at: '',
  }, [feeSchedule, cropYear])

  async function saveSchedule(patch: Partial<CottonFeeSchedule>) {
    try {
      const { error } = await supabase.from('cotton_fee_schedule').upsert({
        crop_year: cropYear,
        storage_per_bale_month: effSchedule.storage_per_bale_month,
        receiving_per_bale: effSchedule.receiving_per_bale,
        classing_per_bale: effSchedule.classing_per_bale,
        checkoff_per_bale: effSchedule.checkoff_per_bale,
        checkoff_supplemental_pct: effSchedule.checkoff_supplemental_pct,
        loan_interest_apr: effSchedule.loan_interest_apr,
        ...patch,
      }, { onConflict: 'crop_year' })
      if (error) throw new Error(error.message)
      await done('Fee schedule saved.')
    } catch (e) { fail(e) }
  }

  // Projected fee accruals (shown; the user can post them as projected rows).
  const projections = useMemo(() => {
    const out: Array<{ label: string; amount: number; fee_type: CottonFee['fee_type']; basis: CottonFee['basis']; loan_id?: string; contract_id?: string }> = []
    if (bales.length > 0) {
      out.push({ label: `Warehouse receiving + classing (${bales.length} bales)`, amount: projectBaleHandlingFees(bales.length, effSchedule), fee_type: 'warehouse_receiving', basis: 'per_bale' })
    }
    for (const l of loans.filter((l) => l.status === 'open')) {
      const count = loanBales.filter((x) => x.loan_id === l.id).length
      if (count === 0) continue
      const f = projectLoanFees({ bales: count, principalTotal: Number(l.principal_total), entryDate: l.entry_date, asOf: todayIso(), schedule: effSchedule })
      out.push({ label: `Storage — ${l.loan_number ?? 'loan'} (${f.months} mo × ${count} bales)`, amount: f.storage, fee_type: 'storage_monthly', basis: 'per_bale_month', loan_id: l.id })
      out.push({ label: `Loan interest est. — ${l.loan_number ?? 'loan'}`, amount: f.interest, fee_type: 'loan_interest', basis: 'flat', loan_id: l.id })
    }
    for (const c of contracts) {
      const priced = contractPricedCents(c)
      const lbsOn = dispositions.filter((d) => d.contract_id === c.id).reduce((s, d) => s + Number(baleById.get(d.bale_id)?.net_weight_lbs ?? 0), 0)
      const balesOn = dispositions.filter((d) => d.contract_id === c.id).length
      if (priced == null || lbsOn <= 0) continue
      out.push({ label: `Checkoff — ${c.contract_number ?? CONTRACT_TYPE_LABEL[c.contract_type]}`, amount: projectSaleCheckoff({ bales: balesOn, valueDollars: (priced * lbsOn) / 100, schedule: effSchedule }), fee_type: 'checkoff', basis: 'per_bale', contract_id: c.id })
    }
    return out
  }, [bales, loans, loanBales, contracts, dispositions, baleById, effSchedule])

  async function postProjectedFees() {
    if (projections.length === 0) return
    if (!confirm(`Post ${projections.length} projected fee rows (total ${usd(projections.reduce((s, p) => s + p.amount, 0))})? Actual fees entered later replace them.`)) return
    try {
      // Replace prior projections wholesale so re-posting never duplicates.
      await supabase.from('cotton_fees').delete().eq('crop_year', cropYear).eq('status', 'projected')
      const { error } = await supabase.from('cotton_fees').insert(projections.map((p) => ({
        entity_id: entities.length === 1 ? entities[0].id : null, crop_year: cropYear,
        fee_type: p.fee_type, basis: p.basis, rate: null, loan_id: p.loan_id ?? null, contract_id: p.contract_id ?? null,
        amount_total: Math.round(p.amount * 100) / 100, status: 'projected', fee_date: todayIso(), notes: p.label,
      })))
      if (error) throw new Error(error.message)
      await done('Projected fees posted — enter actuals at settlement to replace them.')
    } catch (e) { fail(e) }
  }

  async function addActualFee() {
    const type = (prompt("Fee type: warehouse_receiving | storage_monthly | classing | checkoff | loan_interest | loan_servicing | pool_deduction | merchant_fee | other") ?? '').trim()
    if (!type) return
    const amount = num(prompt('Amount ($):') ?? '')
    if (amount == null) return
    const date = (prompt('Date (YYYY-MM-DD):', todayIso()) ?? '').trim()
    try {
      const { error } = await supabase.from('cotton_fees').insert({
        entity_id: entities.length === 1 ? entities[0].id : null, crop_year: cropYear,
        fee_type: type, basis: 'flat', amount_total: amount, status: 'actual', fee_date: date || null,
      })
      if (error) throw new Error(error.message)
      await done('Fee recorded.')
    } catch (e) { fail(e) }
  }

  // ---------------- AWP ----------------
  const [awpLookupBusy, setAwpLookupBusy] = useState(false)
  const [awpLookupResult, setAwpLookupResult] = useState<{ awpCents: number; weekEffective: string | null; sourceDescription: string | null; confidence: string } | null>(null)

  async function lookupAwp() {
    setAwpLookupBusy(true); setErr(null); setAwpLookupResult(null)
    try {
      const res = await fetch('/api/awp-lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.data) throw new Error(json?.error ?? 'Lookup failed')
      setAwpLookupResult(json.data)
    } catch (e) { fail(e) } finally { setAwpLookupBusy(false) }
  }

  async function saveAwp(weekEffective: string, awpCents: number, source: 'manual' | 'ai') {
    try {
      const { error } = await supabase.from('awp_weekly').upsert({ week_effective: weekEffective, awp_cents: awpCents, source }, { onConflict: 'week_effective' })
      if (error) throw new Error(error.message)
      setAwpLookupResult(null)
      await done(`AWP ${cents(awpCents)} saved for week of ${weekEffective}.`)
    } catch (e) { fail(e) }
  }
  const [awpManual, setAwpManual] = useState({ week: '', cents: '' })

  // ---------------- render ----------------
  const [boardOpen, setBoardOpen] = useState<CottonDisposition | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Cotton Marketing</h1>
        <label className="text-sm flex items-center gap-2">
          Crop year
          <input type="number" value={cropYear} onChange={(e) => setCropYear(Number(e.target.value) || cropYear)} className={`${inputCls} w-24`} />
        </label>
      </div>
      <p className="text-sm text-slate-600 max-w-3xl">
        Physical cotton: sales contracts, CCC loans (per-bale principal from classing loan values), LDP, equity sales,
        fees, and the weekly AWP. Everything here flows into the Marketing Dashboard, Revenue Projections, Cash Flow,
        and Income Sensitivity. LDP and marketing-loan gains count once, in cotton revenue — never in the government pool.
      </p>

      {banner && <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}
      {!loaded && <p className="text-sm text-slate-400">Loading…</p>}

      {/* ---- AI document intake: contracts, pool payments, CCC loans, LDP,
              equity confirmations, storage invoices ---- */}
      {loaded && (
        <MarketingDocImport
          cropYear={cropYear}
          entities={entities}
          buyers={buyers}
          contracts={contracts}
          loans={loans}
          bales={bales}
          gradeByBale={gradeByBale}
          dispositionByBale={dispositionKindByBale}
          loanedBaleIds={loanedBaleIds}
          ldpBaleIds={ldpBaleIds}
          fees={fees}
          latestAwpCents={latestAwp ? Number(latestAwp.awp_cents) : null}
          loanLbsFor={loanLbs}
          onBuyerCreated={(b) => setBuyers((xs) => [...xs, b].sort((a, z) => a.name.localeCompare(z.name)))}
          onSaved={done}
        />
      )}

      {/* ---- Disposition board ---- */}
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Bale disposition — where is my cotton</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {(Object.keys(DISPOSITION_LABEL) as CottonDisposition[]).map((d) => {
            const cell = board.byDisposition[d]
            return (
              <button key={d} type="button" onClick={() => setBoardOpen(boardOpen === d ? null : d)}
                className={`rounded-lg border p-3 text-left ${boardOpen === d ? 'border-green-600 bg-green-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                <div className="text-xs text-slate-500">{DISPOSITION_LABEL[d]}</div>
                <div className="text-xl font-bold tabular-nums">{cell.bales}</div>
                <div className="text-xs text-slate-500 tabular-nums">{lbs0(cell.lbs)} lbs</div>
              </button>
            )
          })}
        </div>
        <div className="text-xs text-slate-500 tabular-nums">
          Total: {board.totalBales} bales · {lbs0(board.totalLbs)} lbs
          {summary.awaitingCallLbs > 0 && <span className="text-amber-700"> · on-call awaiting futures: {lbs0(summary.awaitingCallLbs)} lbs</span>}
        </div>
        {boardOpen && (
          <div className="overflow-x-auto max-h-64 overflow-y-auto rounded border border-slate-100">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 sticky top-0"><tr>{['PBI #', 'Lbs', 'Receipt', 'Farm / Field', 'Linked to'].map((h) => <th key={h} className="text-left px-2 py-1.5">{h}</th>)}</tr></thead>
              <tbody>
                {bales.filter((b) => (dispByBale.get(b.id)?.disposition ?? 'held') === boardOpen).map((b) => {
                  const r = receiptById.get(b.gin_receipt_id)
                  const d = dispByBale.get(b.id)
                  const linked = d?.loan_id ? loans.find((l) => l.id === d.loan_id)?.loan_number ?? 'loan'
                    : d?.contract_id ? contracts.find((c) => c.id === d.contract_id)?.contract_number ?? 'contract' : '—'
                  return (
                    <tr key={b.id} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-mono">{b.pbi_number}</td>
                      <td className="px-2 py-1 tabular-nums">{lbs0(Number(b.net_weight_lbs))}</td>
                      <td className="px-2 py-1">{r?.receipt_number ?? '—'}</td>
                      <td className="px-2 py-1">{[farmName(r?.farm_id ?? null), fieldName(r?.field_id ?? null)].filter(Boolean).join(' / ') || '—'}</td>
                      <td className="px-2 py-1">{linked}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Sales contracts ---- */}
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold flex-1">Sales Contracts</h2>
          <button type="button" className={btnCls} onClick={() => setContractForm(emptyContract)}>+ New contract</button>
        </div>
        {contracts.length === 0 && <p className="text-sm text-slate-400">No cotton sales contracts for {cropYear}.</p>}
        {contracts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr>{['Type', '#', 'Buyer', 'Committed', 'Assigned', 'Price', 'Status', ''].map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {contracts.map((c) => {
                  const assigned = dispositions.filter((d) => d.contract_id === c.id)
                  const lbsOn = assigned.reduce((s, d) => s + Number(baleById.get(d.bale_id)?.net_weight_lbs ?? 0), 0)
                  const priced = contractPricedCents(c)
                  const pays = poolPayments.filter((p) => p.contract_id === c.id)
                  return (
                    <tr key={c.id} className="border-t border-slate-100 align-top">
                      <td className="px-2 py-1.5 whitespace-nowrap">{CONTRACT_TYPE_LABEL[c.contract_type]}</td>
                      <td className="px-2 py-1.5">{c.contract_number ?? '—'}</td>
                      <td className="px-2 py-1.5">{buyerName(c.buyer_id)}</td>
                      <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">
                        {c.commitment_basis === 'bales' ? (c.committed_bales != null ? `${c.committed_bales} bales` : '—') : (c.committed_acres != null ? `${c.committed_acres} ac` : '—')}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{assigned.length > 0 ? `${assigned.length} bales · ${lbs0(lbsOn)} lbs` : '—'}</td>
                      <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">
                        {c.contract_type === 'pool'
                          ? `${usd(pays.filter((p) => p.status === 'received').reduce((s, p) => s + Number(p.amount), 0))} received`
                          : c.contract_type === 'on_call'
                            ? priced != null
                              ? `${cents(priced)} (basis ${cents(Number(c.basis_cents ?? 0))} + ${cents(Number(c.futures_fixed_cents ?? 0))})`
                              : `basis ${c.basis_cents != null ? cents(Number(c.basis_cents)) : '—'} vs ${c.futures_month ?? '—'}`
                            : priced != null ? cents(priced) : '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className={`text-xs rounded-full px-2 py-0.5 whitespace-nowrap ${c.pricing_status === 'fully_priced' ? 'bg-green-100 text-green-800' : c.pricing_status === 'awaiting_futures' ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>
                          {c.pricing_status === 'fully_priced' ? 'Priced' : c.pricing_status === 'awaiting_futures' ? 'Awaiting futures' : 'Pool open'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap space-x-2 text-xs">
                        {c.contract_type === 'on_call' && c.pricing_status === 'awaiting_futures' && (
                          <button type="button" className="text-green-700 font-semibold" onClick={() => fixFutures(c)}>Fix futures</button>
                        )}
                        {c.contract_type === 'pool' && (
                          <button type="button" className="text-brand-deep" onClick={() => addPoolPayment(c.id)}>+ Payment</button>
                        )}
                        <button type="button" className="text-brand-deep" onClick={() => { setPickFor({ kind: 'contract', id: c.id }); setPicked(new Set()) }}>Assign bales</button>
                        <button type="button" className="text-slate-600" onClick={() => setContractForm({
                          id: c.id, entity_id: c.entity_id ?? '', buyer_id: c.buyer_id ?? '', contract_type: c.contract_type,
                          contract_number: c.contract_number ?? '', contract_date: c.contract_date ?? '', commitment_basis: c.commitment_basis,
                          committed_bales: c.committed_bales != null ? String(c.committed_bales) : '', committed_acres: c.committed_acres != null ? String(c.committed_acres) : '',
                          price_cents_per_lb: c.price_cents_per_lb != null ? (Number(c.price_cents_per_lb) / 100).toFixed(4) : '', basis_cents: c.basis_cents != null ? (Number(c.basis_cents) / 100).toFixed(4) : '',
                          futures_month: c.futures_month ?? 'DEC 26', delivery_start: c.delivery_start ?? '', delivery_end: c.delivery_end ?? '', notes: c.notes ?? '',
                        })}>Edit</button>
                        <button type="button" className="text-red-600" onClick={() => deleteContract(c)}>Delete</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {contractForm && (
          <div className="rounded-lg border border-slate-300 p-3 space-y-2">
            <div className="font-semibold text-sm">{contractForm.id ? 'Edit contract' : 'New contract'}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <label className="flex flex-col gap-1">Type
                <select value={contractForm.contract_type} onChange={(e) => cf('contract_type', e.target.value as CottonContractType)} className={inputCls}>
                  {(Object.keys(CONTRACT_TYPE_LABEL) as CottonContractType[]).map((t) => <option key={t} value={t}>{CONTRACT_TYPE_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">Contract #
                <input value={contractForm.contract_number} onChange={(e) => cf('contract_number', e.target.value)} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">Buyer / merchant / pool
                <BuyerPicker
                  value={contractForm.buyer_id}
                  onChange={(id) => cf('buyer_id', id)}
                  buyers={buyers}
                  onCreated={(b) => setBuyers((xs) => [...xs, b].sort((a, z) => a.name.localeCompare(z.name)))}
                  className={inputCls}
                />
              </label>
              {entities.length > 1 && (
                <label className="flex flex-col gap-1">Entity
                  <select value={contractForm.entity_id} onChange={(e) => cf('entity_id', e.target.value)} className={inputCls}>
                    <option value="">— entity —</option>
                    {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">Date
                <input type="date" value={contractForm.contract_date} onChange={(e) => cf('contract_date', e.target.value)} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">Commitment
                <select value={contractForm.commitment_basis} onChange={(e) => cf('commitment_basis', e.target.value as 'bales' | 'acres')} className={inputCls}>
                  <option value="bales">Bales</option><option value="acres">Acres</option>
                </select>
              </label>
              {contractForm.commitment_basis === 'bales' ? (
                <label className="flex flex-col gap-1">Committed bales
                  <input type="number" value={contractForm.committed_bales} onChange={(e) => cf('committed_bales', e.target.value)} className={inputCls} />
                </label>
              ) : (
                <label className="flex flex-col gap-1">Committed acres
                  <input type="number" step="0.01" value={contractForm.committed_acres} onChange={(e) => cf('committed_acres', e.target.value)} className={inputCls} />
                </label>
              )}
              {(contractForm.contract_type === 'spot' || contractForm.contract_type === 'fixed_price') && (
                <label className="flex flex-col gap-1">Price ($/lb)
                  <input type="text" inputMode="decimal" value={contractForm.price_cents_per_lb} onChange={(e) => cf('price_cents_per_lb', e.target.value)} className={inputCls} placeholder="0.7400" />
                </label>
              )}
              {contractForm.contract_type === 'on_call' && (
                <>
                  <label className="flex flex-col gap-1">Basis ($/lb, +/-)
                    <input type="text" inputMode="decimal" value={contractForm.basis_cents} onChange={(e) => cf('basis_cents', e.target.value)} className={inputCls} placeholder="-0.0250" />
                  </label>
                  <label className="flex flex-col gap-1">Futures month
                    <input value={contractForm.futures_month} onChange={(e) => cf('futures_month', e.target.value)} className={inputCls} placeholder="DEC 26" />
                  </label>
                </>
              )}
              <label className="flex flex-col gap-1">Delivery start
                <input type="date" value={contractForm.delivery_start} onChange={(e) => cf('delivery_start', e.target.value)} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">Delivery end
                <input type="date" value={contractForm.delivery_end} onChange={(e) => cf('delivery_end', e.target.value)} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 col-span-2">Notes
                <input value={contractForm.notes} onChange={(e) => cf('notes', e.target.value)} className={inputCls} />
              </label>
            </div>
            {contractForm.contract_type === 'on_call' && (
              <p className="text-xs text-slate-500">On-call: cash = basis + futures once fixed. Use the “Fix futures” action when you price the futures leg — until then these lbs stay out of the priced buckets.</p>
            )}
            {contractForm.contract_type === 'pool' && (
              <p className="text-xs text-slate-500">Pool: record advances/progress/final settlements with “+ Payment”; the marketing value is dollars received plus the pool estimate for the rest.</p>
            )}
            <div className="flex gap-2">
              <button type="button" className={btnCls} onClick={saveContract}>Save contract</button>
              <button type="button" className={btnGray} onClick={() => setContractForm(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ---- CCC loans ---- */}
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold flex-1">CCC Loans</h2>
          <button type="button" className={btnCls} onClick={() => {
            setLoanForm({ entity_id: entities.length === 1 ? entities[0].id : '', loan_number: '', entry_date: todayIso(), rate: String(DEFAULT_LOAN_RATE) })
            setPickFor({ kind: 'loan' }); setPicked(new Set())
          }}>+ New loan</button>
        </div>
        {loans.length === 0 && <p className="text-sm text-slate-400">No CCC loans for {cropYear}.</p>}
        {loans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr>{['Loan #', 'Entered', 'Matures', 'Bales', 'Lbs', 'Principal', 'Status', 'Outcome', ''].map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {loans.map((l) => {
                  const count = loanBales.filter((x) => x.loan_id === l.id).length
                  const lbsV = loanLbs(l.id)
                  return (
                    <tr key={l.id} className="border-t border-slate-100">
                      <td className="px-2 py-1.5">{l.loan_number ?? '—'}{l.pending_classing && <span className="ml-1 text-[10px] rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5">pending classing</span>}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{l.entry_date}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{l.maturity_date ?? '—'}</td>
                      <td className="px-2 py-1.5 tabular-nums">{count}</td>
                      <td className="px-2 py-1.5 tabular-nums">{lbs0(lbsV)}</td>
                      <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{usd(Number(l.principal_total))}{lbsV > 0 && <span className="text-xs text-slate-400"> ({cents((Number(l.principal_total) * 100) / lbsV)}/lb)</span>}</td>
                      <td className="px-2 py-1.5">
                        <span className={`text-xs rounded-full px-2 py-0.5 ${l.status === 'open' ? 'bg-indigo-100 text-indigo-800' : l.status === 'redeemed' ? 'bg-green-100 text-green-800' : l.status === 'equity_sold' ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-600'}`}>
                          {l.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                        {l.status === 'redeemed' && `MLG ${usd(Number(l.mlg_total ?? 0))} · payoff ${usd(Number(l.redemption_payoff_total ?? 0))}`}
                        {l.status === 'equity_sold' && `equity ${usd(Number(l.equity_total ?? 0))} @ ${cents(Number(l.equity_cents_per_lb ?? 0))} · ${buyerName(l.buyer_id)}`}
                        {l.status === 'forfeited' && `kept ${usd(Number(l.principal_total))}`}
                        {l.status === 'open' && (l.outcome_date ?? '—')}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap space-x-2 text-xs">
                        {l.pending_classing && <button type="button" className="text-amber-700 font-semibold" onClick={() => recomputeLoan(l)}>Recompute</button>}
                        {l.status === 'open' && (
                          <>
                            <button type="button" className="text-green-700 font-semibold" onClick={() => redeemLoan(l)}>Redeem</button>
                            <button type="button" className="text-teal-700 font-semibold" onClick={() => setEquityFor({ loanId: l.id, cents: '', buyerId: l.buyer_id ?? '' })}>Equity sale</button>
                            <button type="button" className="text-slate-500" onClick={() => forfeitLoan(l)}>Forfeit</button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {equityFor && (() => {
          const loan = loans.find((l) => l.id === equityFor.loanId)
          if (!loan) return null
          const lbsV = loanLbs(loan.id)
          const eq = parseCottonPriceInput(equityFor.cents, { centsThreshold: 0.25 })
          const preview = eq != null && eq >= 0 ? equityOutcome({ principalTotal: Number(loan.principal_total), lbs: lbsV, equityCentsPerLb: eq }) : null
          return (
            <div className="rounded-lg border border-teal-300 bg-teal-50/40 p-3 space-y-2">
              <div className="font-semibold text-sm">Equity sale — {loan.loan_number ?? 'loan'} ({lbs0(lbsV)} lbs banked at {usd(Number(loan.principal_total))})</div>
              <div className="flex flex-wrap items-end gap-2 text-xs">
                <label className="flex flex-col gap-1">Equity ($/lb over the loan)
                  <input type="text" inputMode="decimal" value={equityFor.cents}
                    onChange={(e) => setEquityFor((f) => f && { ...f, cents: e.target.value })} className={inputCls} placeholder="0.0800" />
                </label>
                <label className="flex flex-col gap-1">Equity purchaser
                  <BuyerPicker
                    value={equityFor.buyerId}
                    onChange={(id) => setEquityFor((f) => f && { ...f, buyerId: id })}
                    buyers={buyers}
                    onCreated={(b) => setBuyers((xs) => [...xs, b].sort((a, z) => a.name.localeCompare(z.name)))}
                    className={inputCls}
                  />
                </label>
                {preview && (
                  <span className="text-sm tabular-nums pb-1">
                    → equity <strong>{usd(preview.equityTotal)}</strong> · effective <strong>{cents(preview.effectiveCentsPerLb)}/lb</strong>
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" className={btnCls} disabled={eq == null || eq < 0} onClick={confirmEquitySale}>Confirm equity sale</button>
                <button type="button" className={btnGray} onClick={() => setEquityFor(null)}>Cancel</button>
              </div>
            </div>
          )
        })()}
        {loanForm && (
          <div className="rounded-lg border border-slate-300 p-3 space-y-2">
            <div className="font-semibold text-sm">New CCC loan — pick the bale group below</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <label className="flex flex-col gap-1">Loan #
                <input value={loanForm.loan_number} onChange={(e) => setLoanForm((f) => f && { ...f, loan_number: e.target.value })} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">Entry date
                <input type="date" value={loanForm.entry_date} onChange={(e) => setLoanForm((f) => f && { ...f, entry_date: e.target.value })} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">Base loan rate ($/lb)
                <input type="text" inputMode="decimal" value={loanForm.rate} onChange={(e) => setLoanForm((f) => f && { ...f, rate: e.target.value })} className={inputCls} placeholder="0.5500" />
              </label>
              {entities.length > 1 && (
                <label className="flex flex-col gap-1">Entity
                  <select value={loanForm.entity_id} onChange={(e) => setLoanForm((f) => f && { ...f, entity_id: e.target.value })} className={inputCls}>
                    <option value="">— entity —</option>
                    {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            {loanPrincipalPreview && picked.size > 0 && (
              <p className="text-sm tabular-nums">
                {picked.size} bales · {lbs0(loanPrincipalPreview.lbs)} lbs → principal <strong>{usd(loanPrincipalPreview.principalTotal)}</strong>
                {loanPrincipalPreview.pendingClassing && <span className="text-amber-700"> — some bales unclassed: base rate used, recompute after grades import</span>}
              </p>
            )}
            <p className="text-xs text-slate-500">Maturity defaults to entry + 9 months. Per-bale principal = classing loan value × net lbs (509 lbs @ $0.5510/lb → $280.46).</p>
            <div className="flex gap-2">
              <button type="button" className={btnCls} disabled={picked.size === 0} onClick={saveLoan}>Enter loan ({picked.size} bales)</button>
              <button type="button" className={btnGray} onClick={() => { setLoanForm(null); setPickFor(null); setPicked(new Set()) }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ---- LDP ---- */}
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold flex-1">LDP <span className="font-normal text-sm text-slate-500">(loan deficiency payments — rate = loan rate − AWP, zero-floored)</span></h2>
          <button type="button" className={btnCls} onClick={() => { setPickFor({ kind: 'ldp' }); setPicked(new Set()) }}>+ New LDP</button>
        </div>
        {ldps.length === 0 && <p className="text-sm text-slate-400">No LDP records for {cropYear}. LDP&apos;d bales become CCC-loan-ineligible (and vice versa).</p>}
        {ldps.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Date', 'Bales', 'AWP', 'Rate', 'Payment', 'Status'].map((h) => <th key={h} className="text-left px-2 py-2">{h}</th>)}</tr></thead>
            <tbody>
              {ldps.map((l) => (
                <tr key={l.id} className="border-t border-slate-100 tabular-nums">
                  <td className="px-2 py-1.5">{l.ldp_date}</td>
                  <td className="px-2 py-1.5">{ldpBales.filter((x) => x.ldp_id === l.id).length}</td>
                  <td className="px-2 py-1.5">{cents(Number(l.awp_cents))}</td>
                  <td className="px-2 py-1.5">{cents(Number(l.ldp_rate_cents))}/lb</td>
                  <td className="px-2 py-1.5">{usd(Number(l.total_payment))}</td>
                  <td className="px-2 py-1.5">{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pickFor?.kind === 'ldp' && (
          <div className="flex gap-2">
            <button type="button" className={btnCls} disabled={picked.size === 0} onClick={saveLdp}>Record LDP ({picked.size} bales · {lbs0(pickedLbs)} lbs)</button>
            <button type="button" className={btnGray} onClick={() => { setPickFor(null); setPicked(new Set()) }}>Cancel</button>
          </div>
        )}
      </div>

      {/* ---- Bale picker (shared) ---- */}
      {pickFor && (
        <div className="bg-white rounded-xl shadow p-4 space-y-2 border-2 border-green-600">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="font-semibold flex-1">
              Pick bales — {pickFor.kind === 'loan' ? 'CCC loan group' : pickFor.kind === 'ldp' ? 'LDP' : `assign to ${contracts.find((c) => c.id === pickFor.id)?.contract_number ?? 'contract'}`}
              <span className="ml-2 text-sm font-normal text-slate-500 tabular-nums">{picked.size} picked · {lbs0(pickedLbs)} lbs</span>
            </h2>
            <select value={pickReceipt} onChange={(e) => setPickReceipt(e.target.value)} className={inputCls}>
              <option value="">All receipts</option>
              {receipts.map((r) => <option key={r.id} value={r.id}>{r.receipt_number} — {[farmName(r.farm_id), fieldName(r.field_id)].filter(Boolean).join(' / ')}</option>)}
            </select>
            <button type="button" className={btnGray} onClick={() => setPicked(new Set(pickableBales.map((b) => b.id)))}>Select all shown</button>
            <button type="button" className={btnGray} onClick={() => setPicked(new Set())}>Clear</button>
            {pickFor.kind === 'contract' && pickFor.id && (
              <button type="button" className={btnCls} disabled={picked.size === 0} onClick={() => assignPickedToContract(pickFor.id!)}>Assign {picked.size} bales</button>
            )}
          </div>
          <p className="text-xs text-slate-500">Held bales only{pickFor.kind !== 'contract' ? ' — bales that ever took a loan or LDP are excluded (mutually exclusive programs)' : ''}. Filter by gin receipt to pick a farm/field group.</p>
          {/* Bulk assignment: a CSV/text bale list or an AI-read recap sheet
              fills the same picked set — the confirmed save below stays the
              single batch write. */}
          <BaleFileAssign
            target={pickFor.kind}
            bales={bales}
            dispositionByBale={dispositionKindByBale}
            loanedBaleIds={loanedBaleIds}
            ldpBaleIds={ldpBaleIds}
            onAddMatches={(ids) => setPicked((s) => new Set([...s, ...ids]))}
          />
          <div className="overflow-x-auto max-h-72 overflow-y-auto rounded border border-slate-100">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 sticky top-0"><tr>{['', 'PBI #', 'Lbs', 'Loan value', 'Receipt'].map((h) => <th key={h} className="text-left px-2 py-1.5">{h}</th>)}</tr></thead>
              <tbody>
                {pickableBales.map((b) => {
                  const g = gradeByBale.get(b.id)
                  const r = receiptById.get(b.gin_receipt_id)
                  const on = picked.has(b.id)
                  return (
                    <tr key={b.id} className="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onClick={() => setPicked((s) => { const n = new Set(s); if (on) n.delete(b.id); else n.add(b.id); return n })}>
                      <td className="px-2 py-1"><input type="checkbox" checked={on} readOnly /></td>
                      <td className="px-2 py-1 font-mono">{b.pbi_number}</td>
                      <td className="px-2 py-1 tabular-nums">{lbs0(Number(b.net_weight_lbs))}</td>
                      <td className="px-2 py-1 tabular-nums">{g?.loan_value_cents_per_lb != null ? `${cents(Number(g.loan_value_cents_per_lb))}/lb` : <span className="text-amber-700">unclassed</span>}</td>
                      <td className="px-2 py-1">{r?.receipt_number ?? '—'}</td>
                    </tr>
                  )
                })}
                {pickableBales.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-slate-400">No eligible held bales{pickReceipt ? ' on this receipt' : ''}.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Fees ---- */}
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold flex-1">Fees</h2>
          <button type="button" className={btnGray} onClick={addActualFee}>+ Actual fee</button>
          <button type="button" className={btnCls} disabled={projections.length === 0} onClick={postProjectedFees}>Post projected fees</button>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-600 font-medium">Fee schedule (defaults for projections)</summary>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mt-2 text-xs">
            {([
              ['storage_per_bale_month', 'Storage $/bale/mo'],
              ['receiving_per_bale', 'Receiving $/bale'],
              ['classing_per_bale', 'Classing $/bale'],
              ['checkoff_per_bale', 'Checkoff $/bale'],
              ['checkoff_supplemental_pct', 'Checkoff suppl. (0.005 = 0.5%)'],
              ['loan_interest_apr', 'Loan interest APR'],
            ] as Array<[keyof CottonFeeSchedule, string]>).map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1">{label}
                <input type="number" step="0.001" defaultValue={Number(effSchedule[k])}
                  onBlur={(e) => { const v = num(e.target.value); if (v != null && v !== Number(effSchedule[k])) saveSchedule({ [k]: v } as Partial<CottonFeeSchedule>) }}
                  className={inputCls} />
              </label>
            ))}
          </div>
        </details>
        {projections.length > 0 && (
          <div className="text-sm space-y-0.5">
            <div className="text-xs uppercase tracking-wide text-slate-400">Projected accruals (as of today)</div>
            {projections.map((p, i) => (
              <div key={i} className="flex justify-between gap-3 tabular-nums"><span className="text-slate-600">{p.label}</span><span>{usd(p.amount)}</span></div>
            ))}
            <div className="flex justify-between gap-3 font-semibold border-t border-slate-200 pt-1 tabular-nums"><span>Total projected</span><span>{usd(projections.reduce((s, p) => s + p.amount, 0))}</span></div>
          </div>
        )}
        {fees.length > 0 && (
          <div className="text-sm space-y-0.5">
            <div className="text-xs uppercase tracking-wide text-slate-400">Recorded fees (actuals replace projections in the same slot)</div>
            {fees.map((f) => (
              <div key={f.id} className="flex justify-between gap-3 tabular-nums">
                <span className="text-slate-600">{f.fee_date ?? '—'} · {f.fee_type.replace(/_/g, ' ')}{f.notes ? ` — ${f.notes}` : ''}
                  <span className={`ml-2 text-[10px] rounded-full px-1.5 py-0.5 ${f.status === 'actual' ? 'bg-green-100 text-green-800' : 'bg-sky-100 text-sky-800'}`}>{f.status}</span>
                </span>
                <span>{usd(Number(f.amount_total))}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 font-semibold border-t border-slate-200 pt-1 tabular-nums"><span>Net fees (marketing revenue subtracts this)</span><span>{usd(summary.feeDollars)}</span></div>
          </div>
        )}
      </div>

      {/* ---- AWP ---- */}
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold flex-1">Adjusted World Price <span className="font-normal text-sm text-slate-500">(announced Thursdays, effective Fri–Thu — drives LDP, MLG, redemption payoffs)</span></h2>
          <button type="button" className={btnGray} disabled={awpLookupBusy} onClick={lookupAwp}>{awpLookupBusy ? 'Searching…' : 'AI lookup (current AWP)'}</button>
        </div>
        {awpLookupResult && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm flex items-center gap-3 flex-wrap">
            <span>Found: <strong>{cents(awpLookupResult.awpCents)}</strong>{awpLookupResult.weekEffective ? ` effective ${awpLookupResult.weekEffective}` : ''} <span className="text-xs text-slate-500">({awpLookupResult.confidence} confidence{awpLookupResult.sourceDescription ? ` — ${awpLookupResult.sourceDescription}` : ''})</span></span>
            <button type="button" className={btnCls} onClick={() => saveAwp(awpLookupResult.weekEffective ?? todayIso(), awpLookupResult.awpCents, 'ai')}>Confirm &amp; save</button>
            <button type="button" className={btnGray} onClick={() => setAwpLookupResult(null)}>Discard</button>
          </div>
        )}
        <div className="flex items-end gap-2 flex-wrap text-xs">
          <label className="flex flex-col gap-1">Week effective (Friday)
            <input type="date" value={awpManual.week} onChange={(e) => setAwpManual((s) => ({ ...s, week: e.target.value }))} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">AWP ($/lb)
            <input type="text" inputMode="decimal" value={awpManual.cents} onChange={(e) => setAwpManual((s) => ({ ...s, cents: e.target.value }))} className={inputCls} placeholder="0.5143" />
          </label>
          <button type="button" className={btnCls} disabled={!awpManual.week || parseCottonPriceInput(awpManual.cents) == null}
            onClick={() => { const v = parseCottonPriceInput(awpManual.cents); if (v != null) { saveAwp(awpManual.week, v, 'manual'); setAwpManual({ week: '', cents: '' }) } }}>
            Add
          </button>
          {latestAwp && (
            <span className="text-sm text-slate-600 ml-2">
              Current: <strong>{cents(Number(latestAwp.awp_cents))}</strong> (week of {latestAwp.week_effective})
              {' '}· LDP/MLG rate vs {cents(DEFAULT_LOAN_RATE)} loan: <strong>{cents(ldpRateCents(DEFAULT_LOAN_RATE, Number(latestAwp.awp_cents)))}</strong>
            </span>
          )}
        </div>
        {awp.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs text-slate-500">
            {awp.slice(0, 8).map((a) => <span key={a.id} className="rounded bg-slate-100 px-2 py-0.5 tabular-nums">{a.week_effective}: {cents(Number(a.awp_cents))}{a.source === 'ai' ? ' (ai)' : ''}</span>)}
          </div>
        )}
        <p className="text-[11px] text-slate-400">Redemption and LDP prompts default to the latest week on file.</p>
      </div>
    </div>
  )
}
