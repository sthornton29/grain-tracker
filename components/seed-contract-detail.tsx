'use client'

// Seed production contract detail (077): the pricing-elections ledger with
// cumulative % priced, the staged-payments ledger, the expected-outcome
// selector, linked fields, and the computed effective price walk.

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import ContractActions from '@/app/contracts/[id]/contract-actions'
import {
  SEED_ELECTION_INCREMENTS, SEED_OUTCOME_LABEL, SEED_PAYMENT_TYPE_LABEL,
  SEED_PREMIUM_TEMPLATE, cumulativePricedPct, effectivePriceWalk,
  missingPremiumRows, validateElectionPct,
} from '@/lib/seed-contracts'
import type {
  SeedContractDetails, SeedContractPayment, SeedContractPremium,
  SeedOutcome, SeedPaymentType, SeedPricingElection,
} from '@/lib/seed-contracts'

const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d })
const usd = (n: number) => (n < 0 ? `($${fmt(Math.abs(n))})` : `$${fmt(n)}`)

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[2])}/${m[3]}/${m[1]}` : iso
}

type LinkedPlanting = {
  id: string
  fieldName: string
  farmName: string | null
  plantedAcres: number
  irrigatedAcres: number
}

export default function SeedContractDetail(props: {
  contract: {
    id: string
    contract_number: string
    buyerName: string | null
    cropName: string | null
    entityName: string | null
    crop_year: number | null
    completed_at: string | null
    notes: string | null
  }
  details: SeedContractDetails | null
  premiums: SeedContractPremium[]
  elections: SeedPricingElection[]
  payments: SeedContractPayment[]
  linkedPlantings: LinkedPlanting[]
  /** Assumed futures + assumed basis for the crop year (the unpriced proxy). */
  referencePlusBasis: number | null
  deliveredBu: number
  loadCount: number
}) {
  const { contract, details, premiums, elections, payments, linkedPlantings } = props
  const supabase = createClient()
  const router = useRouter()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const totalAcres = linkedPlantings.reduce((s, p) => s + p.plantedAcres, 0)
  const irrAcres = linkedPlantings.reduce((s, p) => s + p.irrigatedAcres, 0)
  // Acre share from the linked fields; the agreement's own acres as fallback.
  const irrigatedShare = totalAcres > 0 ? irrAcres / totalAcres : 0

  const pricedPct = Math.min(100, cumulativePricedPct(elections))
  const walk = useMemo(
    () =>
      details
        ? effectivePriceWalk({
            details, premiums, elections,
            referencePlusBasis: props.referencePlusBasis,
            irrigatedShare,
          })
        : null,
    [details, premiums, elections, props.referencePlusBasis, irrigatedShare],
  )
  const committedBu = details != null ? Number(details.estimated_bushels) : 0

  // --- election entry state -------------------------------------------------
  const remainingPct = 100 - pricedPct
  const [ePct, setEPct] = useState<number>(25)
  const [ePrice, setEPrice] = useState('')
  const [eDate, setEDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [eMethod, setEMethod] = useState<'market' | 'target'>('market')
  const [eNotes, setENotes] = useState('')

  async function addElection() {
    setErr('')
    const problem = validateElectionPct(elections, ePct)
    if (problem) { setErr(problem); return }
    const price = Number(ePrice)
    if (!(price > 0)) { setErr('Enter the elected price per bushel.'); return }
    setBusy(true)
    const { error } = await supabase.from('seed_pricing_elections').insert({
      contract_id: contract.id, election_date: eDate, pct_of_bushels: ePct,
      price_per_bu: price, method: eMethod, notes: eNotes.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setEPrice(''); setENotes('')
    router.refresh()
  }

  async function deleteElection(id: string) {
    if (!confirm('Remove this pricing election?')) return
    const { error } = await supabase.from('seed_pricing_elections').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    router.refresh()
  }

  // --- payment entry state --------------------------------------------------
  const [pType, setPType] = useState<SeedPaymentType>('base_80')
  const [pAmount, setPAmount] = useState('')
  const [pDate, setPDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [pStatus, setPStatus] = useState<'projected' | 'received'>('received')
  const [pNotes, setPNotes] = useState('')

  async function addPayment() {
    setErr('')
    const amount = Number(pAmount)
    if (!Number.isFinite(amount) || amount === 0) { setErr('Enter the payment amount (the usage fee as a negative).'); return }
    setBusy(true)
    const { error } = await supabase.from('seed_contract_payments').insert({
      contract_id: contract.id, payment_type: pType, amount,
      payment_date: pDate, status: pStatus, notes: pNotes.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setPAmount(''); setPNotes('')
    router.refresh()
  }

  async function deletePayment(id: string) {
    if (!confirm('Remove this payment entry?')) return
    const { error } = await supabase.from('seed_contract_payments').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    router.refresh()
  }

  async function setOutcome(outcome: SeedOutcome) {
    if (!details) return
    const { error } = await supabase
      .from('seed_contract_details')
      .update({ expected_outcome: outcome })
      .eq('id', details.id)
    if (error) { setErr(error.message); return }
    router.refresh()
  }

  // --- premium schedule editing --------------------------------------------
  type PremiumDraft = { outcome: SeedOutcome; component: string; amount: string; applies_to: 'all' | 'irrigated_only' }
  const emptyPremiumDraft: PremiumDraft = { outcome: 'accepted', component: '', amount: '', applies_to: 'all' }
  const [premiumDraft, setPremiumDraft] = useState<PremiumDraft>(emptyPremiumDraft)
  const [editingPremiumId, setEditingPremiumId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<PremiumDraft>(emptyPremiumDraft)

  function premiumPayload(d: PremiumDraft) {
    return {
      outcome: d.outcome,
      component: d.component.trim(),
      amount_per_bu: Number(d.amount),
      applies_to: d.applies_to,
    }
  }
  function premiumDraftProblem(d: PremiumDraft): string | null {
    if (!d.component.trim()) return 'Name the premium.'
    const n = Number(d.amount)
    if (!Number.isFinite(n) || n < 0) return 'Enter the premium $/bu.'
    return null
  }

  async function addPremium() {
    setErr('')
    const problem = premiumDraftProblem(premiumDraft)
    if (problem) { setErr(problem); return }
    setBusy(true)
    const { error } = await supabase.from('seed_contract_premiums').insert({
      contract_id: contract.id, ...premiumPayload(premiumDraft), sort_order: premiums.length,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setPremiumDraft(emptyPremiumDraft)
    router.refresh()
  }

  async function savePremiumEdit(id: string) {
    setErr('')
    const problem = premiumDraftProblem(editDraft)
    if (problem) { setErr(problem); return }
    setBusy(true)
    const { error } = await supabase.from('seed_contract_premiums').update(premiumPayload(editDraft)).eq('id', id)
    setBusy(false)
    if (error) { setErr(error.message); return }
    setEditingPremiumId(null)
    router.refresh()
  }

  async function deletePremium(id: string) {
    if (!confirm('Remove this premium row?')) return
    const { error } = await supabase.from('seed_contract_premiums').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    router.refresh()
  }

  // Replace the whole schedule with the standard Bayer Southern template
  // (all four outcomes, full component stack) after explicit confirmation.
  async function applyStandardSchedule() {
    const msg = premiums.length > 0
      ? `Replace the current ${premiums.length} premium row${premiums.length === 1 ? '' : 's'} with the standard Bayer Southern schedule (all four outcomes)?`
      : 'Apply the standard Bayer Southern premium schedule (all four outcomes)?'
    if (!confirm(msg)) return
    setErr('')
    setBusy(true)
    const del = await supabase.from('seed_contract_premiums').delete().eq('contract_id', contract.id)
    if (del.error) { setBusy(false); setErr(del.error.message); return }
    const { error } = await supabase.from('seed_contract_premiums').insert(
      SEED_PREMIUM_TEMPLATE.map((p) => ({ contract_id: contract.id, ...p })),
    )
    setBusy(false)
    if (error) { setErr(error.message); return }
    router.refresh()
  }

  const receivedTotal = payments.filter((p) => p.status === 'received').reduce((s, p) => s + Number(p.amount), 0)
  const finalReceived = payments.some((p) => p.payment_type === 'base_final' && p.status === 'received')

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center gap-3 flex-wrap no-print">
        <Link href="/contracts" className="text-brand-deep hover:underline text-sm">← Back to contracts</Link>
        <div className="flex-1" />
        <Link
          href={`/contracts/seed/${contract.id}/edit`}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Edit
        </Link>
        <ContractActions
          contractId={contract.id}
          contractNumber={contract.contract_number}
          isManuallyComplete={contract.completed_at != null}
          isAutoComplete={finalReceived}
        />
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

      <div className="bg-white rounded-xl shadow p-5 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-2xl font-bold">Seed contract #{contract.contract_number}</h1>
          <span className="text-xs rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5">Seed production</span>
          {(contract.completed_at != null || finalReceived) && (
            <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Complete</span>
          )}
        </div>
        <p className="text-slate-600">
          {contract.buyerName ?? '—'} · {contract.cropName ?? '—'} · {contract.crop_year ?? '—'} crop
          {contract.entityName ? ` · ${contract.entityName}` : ''}
        </p>
      </div>

      {!details && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This seed contract has no terms saved yet. Use Edit to enter the agreement&rsquo;s acres, premiums, and payment terms.
        </div>
      )}

      {details && (
        <>
          {/* Effective price walk */}
          <div className="bg-white rounded-xl shadow p-5">
            <h2 className="font-semibold text-lg mb-2">Expected price</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="text-slate-500">Base price ({pricedPct}% priced)</div>
                <div className="text-xl font-semibold">
                  {walk?.blendedBase != null ? `$${walk.blendedBase.toFixed(4)}` : walk?.electedPrice != null ? `$${walk.electedPrice.toFixed(4)} elected` : '—'}
                </div>
                {walk != null && walk.unpricedPct > 0 && (
                  <div className="text-xs text-amber-700">
                    {walk.unpricedPct}% unpriced{walk.unpricedPrice != null ? ` at $${walk.unpricedPrice.toFixed(2)} (seed est.)` : ' — no reference price yet'}
                  </div>
                )}
              </div>
              {missingPremiumRows(premiums, details.expected_outcome) ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <div className="text-amber-800">+ Expected premiums</div>
                  <div className="text-sm font-semibold text-amber-800">
                    No premium rows for &ldquo;{SEED_OUTCOME_LABEL[details.expected_outcome]}&rdquo; — add them below or apply the standard schedule.
                  </div>
                  <button
                    type="button"
                    onClick={applyStandardSchedule}
                    disabled={busy}
                    className="mt-1.5 rounded-lg border border-amber-400 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50 no-print"
                  >
                    Apply standard schedule
                  </button>
                </div>
              ) : (
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-slate-500">+ Expected premiums</div>
                  <div className="text-xl font-semibold text-green-700">+${walk?.premium.weighted.toFixed(4) ?? '0.0000'}</div>
                  <div className="text-xs text-slate-500">
                    {SEED_OUTCOME_LABEL[details.expected_outcome]} · irrigated ${walk?.premium.irrigatedRate.toFixed(2)} / dryland ${walk?.premium.drylandRate.toFixed(2)}
                    {details.premium_cap_per_bu != null ? ` · cap $${Number(details.premium_cap_per_bu).toFixed(2)}` : ''}
                  </div>
                </div>
              )}
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="text-slate-500">− Usage fee</div>
                <div className="text-xl font-semibold text-red-700">−${Number(details.usage_fee_per_bu).toFixed(4)}</div>
              </div>
              <div className="rounded-lg bg-emerald-50 p-3">
                <div className="text-slate-500">= Expected net</div>
                <div className="text-xl font-bold">
                  {walk?.expectedNetPerBu != null ? `$${walk.expectedNetPerBu.toFixed(4)}/bu` : '—'}
                </div>
                {walk?.expectedNetPerBu != null && committedBu > 0 && (
                  <div className="text-xs text-slate-500">≈ {usd(walk.expectedNetPerBu * committedBu)} on {fmt(committedBu, 0)} bu (est.)</div>
                )}
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Premiums are an assumption until the seed company settles the crop — the outcome below drives what the reports project.
            </p>
            <div className="mt-2 flex items-center gap-2 no-print">
              <label className="text-sm text-slate-600">Expected outcome:</label>
              <select
                value={details.expected_outcome}
                onChange={(e) => setOutcome(e.target.value as SeedOutcome)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {(Object.keys(SEED_OUTCOME_LABEL) as SeedOutcome[]).map((o) => (
                  <option key={o} value={o}>{SEED_OUTCOME_LABEL[o]}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Agreement terms */}
          <div className="bg-white rounded-xl shadow p-5">
            <h2 className="font-semibold text-lg mb-2">Agreement</h2>
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-sm">
              {([
                ['Production site', details.production_site ?? '—'],
                ['Brand / variety', [details.brand, details.variety].filter(Boolean).join(' ') || '—'],
                ['Contract acres', `${fmt(Number(details.contract_acres), 1)} ac`],
                ['Forecast yield', `${fmt(Number(details.forecast_bu_per_acre), 1)} bu/ac`],
                ['Estimated quantity', `${fmt(committedBu, 0)} bu`],
                ['Local market for pricing', details.local_market_elevator ?? '—'],
                ['Price everything by', fmtDate(details.pricing_deadline)],
                ['Premium cap', details.premium_cap_per_bu != null ? `$${Number(details.premium_cap_per_bu).toFixed(2)}/bu` : '—'],
                ['Storage pay', details.storage_pay_per_bu_month != null ? `$${Number(details.storage_pay_per_bu_month).toFixed(3)}/bu/month from ${fmtDate(details.storage_pay_start_date)}` : '—'],
                ['Usage fee', `$${Number(details.usage_fee_per_bu).toFixed(2)}/bu`],
                ['Final settlement (est.)', fmtDate(details.final_settlement_date)],
                ['Notes', details.notes ?? contract.notes ?? '—'],
              ] as Array<[string, React.ReactNode]>).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-slate-100 py-1">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Premium schedule — editable in place, so an incomplete schedule
              can be repaired without re-importing the agreement. */}
          <div className="bg-white rounded-xl shadow p-5 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="font-semibold text-lg">Premium schedule</h2>
              <button
                type="button"
                onClick={applyStandardSchedule}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 no-print"
              >
                Apply standard schedule
              </button>
            </div>
            {premiums.length === 0 ? (
              <p className="text-sm text-amber-800 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                No premium schedule on file — projections show the base price only. Add rows below or apply the standard schedule.
              </p>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="text-left px-3 py-2">If the crop is…</th>
                    <th className="text-left px-3 py-2">Premium</th>
                    <th className="text-right px-3 py-2">$/bu</th>
                    <th className="text-left px-3 py-2">Applies to</th>
                    <th className="px-3 py-2 no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {premiums.map((p, i) => {
                    const id = p.id ?? String(i)
                    if (editingPremiumId === id) {
                      return (
                        <tr key={id} className="border-t border-slate-100 bg-slate-50">
                          <td className="px-3 py-2">
                            <select value={editDraft.outcome} onChange={(e) => setEditDraft((d) => ({ ...d, outcome: e.target.value as SeedOutcome }))} className="rounded-lg border border-slate-300 px-2 py-1.5">
                              {(Object.keys(SEED_OUTCOME_LABEL) as SeedOutcome[]).map((o) => (
                                <option key={o} value={o}>{SEED_OUTCOME_LABEL[o]}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input value={editDraft.component} onChange={(e) => setEditDraft((d) => ({ ...d, component: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-2 py-1.5" />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input inputMode="decimal" value={editDraft.amount} onChange={(e) => setEditDraft((d) => ({ ...d, amount: e.target.value }))} className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-right" />
                          </td>
                          <td className="px-3 py-2">
                            <select value={editDraft.applies_to} onChange={(e) => setEditDraft((d) => ({ ...d, applies_to: e.target.value as 'all' | 'irrigated_only' }))} className="rounded-lg border border-slate-300 px-2 py-1.5">
                              <option value="all">All bushels</option>
                              <option value="irrigated_only">Irrigated only</option>
                            </select>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap no-print">
                            <button onClick={() => savePremiumEdit(id)} disabled={busy} className="text-xs font-semibold text-brand-deep hover:underline disabled:opacity-50">Save</button>
                            <button onClick={() => setEditingPremiumId(null)} className="ml-2 text-xs text-slate-500 hover:underline">Cancel</button>
                          </td>
                        </tr>
                      )
                    }
                    return (
                      <tr key={id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{SEED_OUTCOME_LABEL[p.outcome]}</td>
                        <td className="px-3 py-2">{p.component}</td>
                        <td className="px-3 py-2 text-right font-mono">${Number(p.amount_per_bu).toFixed(2)}</td>
                        <td className="px-3 py-2">{p.applies_to === 'irrigated_only' ? 'Irrigated bushels only' : 'All bushels'}</td>
                        <td className="px-3 py-2 whitespace-nowrap no-print">
                          {p.id && (
                            <>
                              <button
                                onClick={() => {
                                  setEditingPremiumId(p.id!)
                                  setEditDraft({ outcome: p.outcome, component: p.component, amount: String(Number(p.amount_per_bu)), applies_to: p.applies_to })
                                }}
                                className="text-xs text-brand-deep hover:underline"
                              >Edit</button>
                              <button onClick={() => deletePremium(p.id!)} className="ml-2 text-xs text-red-700 hover:underline">Remove</button>
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <div className="flex items-end gap-2 flex-wrap no-print">
              <label className="text-sm">
                <span className="block text-slate-500 text-xs">If the crop is…</span>
                <select value={premiumDraft.outcome} onChange={(e) => setPremiumDraft((d) => ({ ...d, outcome: e.target.value as SeedOutcome }))} className="rounded-lg border border-slate-300 px-3 py-2">
                  {(Object.keys(SEED_OUTCOME_LABEL) as SeedOutcome[]).map((o) => (
                    <option key={o} value={o}>{SEED_OUTCOME_LABEL[o]}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm flex-1 min-w-[10rem]">
                <span className="block text-slate-500 text-xs">Premium</span>
                <input value={premiumDraft.component} onChange={(e) => setPremiumDraft((d) => ({ ...d, component: e.target.value }))} placeholder="Production premium" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              </label>
              <label className="text-sm">
                <span className="block text-slate-500 text-xs">$/bu</span>
                <input inputMode="decimal" value={premiumDraft.amount} onChange={(e) => setPremiumDraft((d) => ({ ...d, amount: e.target.value }))} className="w-24 rounded-lg border border-slate-300 px-3 py-2" />
              </label>
              <label className="text-sm">
                <span className="block text-slate-500 text-xs">Applies to</span>
                <select value={premiumDraft.applies_to} onChange={(e) => setPremiumDraft((d) => ({ ...d, applies_to: e.target.value as 'all' | 'irrigated_only' }))} className="rounded-lg border border-slate-300 px-3 py-2">
                  <option value="all">All bushels</option>
                  <option value="irrigated_only">Irrigated only</option>
                </select>
              </label>
              <button onClick={addPremium} disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
                Add premium row
              </button>
            </div>
          </div>
        </>
      )}

      {/* Pricing elections ledger */}
      <div className="bg-white rounded-xl shadow p-5 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold text-lg">Pricing elections</h2>
          <span className="text-sm text-slate-500">{pricedPct}% of the bushels priced</span>
        </div>
        <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
          <div className="h-2 bg-emerald-500" style={{ width: `${pricedPct}%` }} />
        </div>
        {elections.length === 0
          ? <p className="text-sm text-slate-500">Nothing priced yet. Elections lock a share of the bushels at the local market or your target price.</p>
          : (
            <ul className="divide-y divide-slate-100 text-sm">
              {elections.map((e) => (
                <li key={e.id} className="py-2 flex items-center gap-3">
                  <span className="font-medium">
                    Price {Number(e.pct_of_bushels)}% at ${Number(e.price_per_bu).toFixed(2)}
                  </span>
                  <span className="text-slate-500">
                    — elected {fmtDate(e.election_date)} ({e.method === 'target' ? 'target order' : 'market price'})
                  </span>
                  {e.notes && <span className="text-xs text-slate-400">{e.notes}</span>}
                  <button onClick={() => deleteElection(e.id)} className="ml-auto text-xs text-red-700 hover:underline no-print">Remove</button>
                </li>
              ))}
            </ul>
          )}
        {remainingPct > 0 && (
          <div className="flex items-end gap-2 flex-wrap no-print">
            <label className="text-sm">
              <span className="block text-slate-500 text-xs">Portion</span>
              <select value={ePct} onChange={(e) => setEPct(Number(e.target.value))} className="rounded-lg border border-slate-300 px-3 py-2">
                {SEED_ELECTION_INCREMENTS.filter((p) => p <= remainingPct).map((p) => (
                  <option key={p} value={p}>{p}%</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-slate-500 text-xs">Price $/bu</span>
              <input inputMode="decimal" value={ePrice} onChange={(e) => setEPrice(e.target.value)} placeholder="10.42" className="w-24 rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-500 text-xs">Date</span>
              <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-slate-500 text-xs">How</span>
              <select value={eMethod} onChange={(e) => setEMethod(e.target.value as 'market' | 'target')} className="rounded-lg border border-slate-300 px-3 py-2">
                <option value="market">Market price</option>
                <option value="target">Target order filled</option>
              </select>
            </label>
            <label className="text-sm flex-1 min-w-[10rem]">
              <span className="block text-slate-500 text-xs">Notes</span>
              <input value={eNotes} onChange={(e) => setENotes(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <button onClick={addElection} disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
              Record election
            </button>
          </div>
        )}
      </div>

      {/* Payments ledger */}
      <div className="bg-white rounded-xl shadow p-5 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold text-lg">Payments</h2>
          <span className="text-sm text-slate-500">{usd(receivedTotal)} received</span>
        </div>
        {payments.length === 0
          ? <p className="text-sm text-slate-500">No payments recorded yet. The agreement pays 80% after delivery and pricing, the rest with premiums at final settlement.</p>
          : (
            <ul className="divide-y divide-slate-100 text-sm">
              {payments.map((p) => (
                <li key={p.id} className="py-2 flex items-center gap-3">
                  <span className="font-medium">{SEED_PAYMENT_TYPE_LABEL[p.payment_type]}</span>
                  <span className={`font-mono ${Number(p.amount) < 0 ? 'text-red-700' : ''}`}>{usd(Number(p.amount))}</span>
                  <span className="text-slate-500">{fmtDate(p.payment_date)}</span>
                  <span className={`text-xs rounded-full px-2 py-0.5 ${p.status === 'received' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}>
                    {p.status}
                  </span>
                  {p.notes && <span className="text-xs text-slate-400">{p.notes}</span>}
                  <button onClick={() => deletePayment(p.id)} className="ml-auto text-xs text-red-700 hover:underline no-print">Remove</button>
                </li>
              ))}
            </ul>
          )}
        <div className="flex items-end gap-2 flex-wrap no-print">
          <label className="text-sm">
            <span className="block text-slate-500 text-xs">Type</span>
            <select value={pType} onChange={(e) => setPType(e.target.value as SeedPaymentType)} className="rounded-lg border border-slate-300 px-3 py-2">
              {(Object.keys(SEED_PAYMENT_TYPE_LABEL) as SeedPaymentType[]).map((t) => (
                <option key={t} value={t}>{SEED_PAYMENT_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 text-xs">Amount $ (fee as negative)</span>
            <input inputMode="decimal" value={pAmount} onChange={(e) => setPAmount(e.target.value)} className="w-28 rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 text-xs">Date</span>
            <input type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 text-xs">Status</span>
            <select value={pStatus} onChange={(e) => setPStatus(e.target.value as 'projected' | 'received')} className="rounded-lg border border-slate-300 px-3 py-2">
              <option value="received">Received</option>
              <option value="projected">Projected</option>
            </select>
          </label>
          <label className="text-sm flex-1 min-w-[10rem]">
            <span className="block text-slate-500 text-xs">Notes</span>
            <input value={pNotes} onChange={(e) => setPNotes(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <button onClick={addPayment} disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">
            Record payment
          </button>
        </div>
      </div>

      {/* Linked fields */}
      <div className="bg-white rounded-xl shadow p-5 space-y-2">
        <h2 className="font-semibold text-lg">Committed fields</h2>
        {linkedPlantings.length === 0
          ? <p className="text-sm text-slate-500">No fields linked yet — link the planted fields under Edit so the reports count their production as committed to this contract.</p>
          : (
            <>
              <ul className="divide-y divide-slate-100 text-sm">
                {linkedPlantings.map((p) => (
                  <li key={p.id} className="py-2 flex items-center gap-3">
                    <span className="font-medium">{p.fieldName}</span>
                    {p.farmName && <span className="text-slate-500">{p.farmName}</span>}
                    <span className="ml-auto text-slate-600">
                      {fmt(p.plantedAcres, 1)} ac{p.irrigatedAcres > 0 ? ` (${fmt(p.irrigatedAcres, 1)} irr)` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-slate-600">
                {fmt(totalAcres, 1)} acres linked{details ? ` of ${fmt(Number(details.contract_acres), 1)} contracted` : ''} ·{' '}
                everything these fields produce is committed to this contract.
              </p>
            </>
          )}
        {props.loadCount > 0 && (
          <p className="text-sm text-slate-500">
            {fmt(props.deliveredBu, 0)} bu delivered on {props.loadCount} load{props.loadCount === 1 ? '' : 's'} against this contract.
          </p>
        )}
      </div>
    </div>
  )
}
