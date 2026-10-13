'use client'

// A saved settlement's sale assignments (094): "Re-read contract
// assignments" sends the stored PDF back through the settlement reader and
// pairs what it prints under each contract block with the saved lines; the
// same review as the New Settlement screen (ours vs the buyer's per matched
// load, link-to-contract for a number not on file) then applies to the
// loads. Without a stored copy — or to fix a read — every line has a sale
// select (this buyer's contracts / Spot / Price later) that applies the
// same way. New lines are never added here; this only assigns sales.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { AppModal, NoticeDialog } from '@/components/app-dialog'
import { reportError } from '@/lib/friendly-error'
import { fmtDate } from '@/lib/format-date'
import { fmtInt } from '@/components/reports/report-kit'
import { isMissingRelation, saleAllocations, writeManyLoadSales, type LoadSale, type SaleType } from '@/lib/load-sales'
import type { SaleLine } from '@/lib/settlement-sales'
import { buildApplyPlan, buildSaleReview, resolveContractText, type ReviewContract, type SaleChoice } from '@/lib/settlement-sale-review'
import { fetchStoredPdf, pairRereadLines, rereadSettlementFile } from '@/lib/settlement-reread'
import SettlementSaleReview, { SaleChip } from '@/components/settlement-sale-review'

export type SavedSaleLine = {
  id: string
  ticket_number: string | null
  load_id: string | null
  net_bushels: number | null
  gross_revenue: number | null
  sale_type: string | null
  contract_number_text: string | null
  contract_id: string | null
}

export type SaleLoadInfo = {
  id: string
  date: string
  ticket_number: string | null
  dryBu: number
  crop_id: string | null
  contract_id: string | null
}

type WorkingLine = SaleLine & {
  /** The saved line this working line writes to (null = a re-read line
   *  with no saved partner — it only informs a split). */
  savedId: string | null
}

export default function SettlementSaleActions({
  settlementId, sourcePdfUrl, buyerName, headerContractNumber, lines, loads, loadSales, contracts, canEdit,
}: {
  settlementId: string
  sourcePdfUrl: string | null
  buyerName: string
  headerContractNumber: string | null
  lines: SavedSaleLine[]
  loads: SaleLoadInfo[]
  loadSales: LoadSale[]
  contracts: ReviewContract[]
  canEdit: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [working, setWorking] = useState<WorkingLine[]>([])
  const [reread, setReread] = useState(false)
  const [choices, setChoices] = useState<Map<string, SaleChoice>>(new Map())
  const [links, setLinks] = useState<Map<string, string>>(new Map())
  const [applying, setApplying] = useState(false)

  const loadById = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads])
  const savedById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines])
  const ours = useMemo(() => saleAllocations(loads.map((l) => ({ id: l.id, contract_id: l.contract_id, to_type: 'buyer' as const, dryBu: l.dryBu })), loadSales), [loads, loadSales])
  const contractNumberById = (id: string) => contracts.find((c) => c.id === id)?.contract_number ?? null
  const cropId = loads[0]?.crop_id ?? null

  const fromSaved = (l: SavedSaleLine): WorkingLine => ({
    savedId: l.id,
    ticket_number: l.ticket_number,
    net_bushels: l.net_bushels,
    gross_revenue: l.gross_revenue,
    discounts: null,
    contract_number: l.contract_number_text ?? headerContractNumber,
    sale_type: l.sale_type === 'spot' || l.sale_type === 'price_later' ? l.sale_type : null,
  })

  function openManual() {
    setErr(null); setReread(false); setChoices(new Map()); setLinks(new Map())
    setWorking(lines.map(fromSaved))
    setOpen(true)
  }

  async function openReread() {
    if (!sourcePdfUrl) { openManual(); return }
    setErr(null); setChoices(new Map()); setLinks(new Map())
    setOpen(true)
    setStage('Fetching the saved statement…')
    try {
      const file = await fetchStoredPdf(sourcePdfUrl)
      const result = await rereadSettlementFile(file, setStage)
      if (result.lines.length === 0) {
        setWorking(lines.map(fromSaved)); setReread(false)
        setErr('Turnrow couldn’t read ticket lines from the saved copy. Pick each line’s sale below instead.')
        return
      }
      const pairing = pairRereadLines(lines, result.lines)
      const next: WorkingLine[] = result.lines.map((li, i) => ({
        savedId: pairing.savedIdByIndex.get(i) ?? null,
        ticket_number: li.ticket_number,
        net_bushels: li.net_bushels,
        gross_revenue: li.gross_revenue,
        discounts: li.discounts ?? null,
        contract_number: li.contract_number != null ? String(li.contract_number) : headerContractNumber,
        sale_type: null,
      }))
      for (const id of pairing.unpairedSavedIds) { const s = savedById.get(id); if (s) next.push(fromSaved(s)) }
      setWorking(next)
      setReread(true)
      if (result.warning) setErr(result.warning)
    } catch (e: any) {
      setWorking(lines.map(fromSaved)); setReread(false)
      setErr(reportError(e, { action: 're-read the saved statement', noun: 'document' }) + ' Pick each line’s sale below instead.')
    } finally {
      setStage(null)
    }
  }

  const review = useMemo(() => buildSaleReview({
    lines: working,
    loadIdForLine: (i) => { const id = working[i]?.savedId; return id ? savedById.get(id)?.load_id ?? null : null },
    oursByLoad: ours,
    contracts,
    links,
    cropId,
  }), [working, savedById, ours, contracts, links, cropId])

  // The per-line select's value: an explicit spot / price-later, else the
  // contract the text resolves to, else '' (text not on file).
  const selectValue = (l: WorkingLine): string => {
    if (l.sale_type === 'spot' || l.sale_type === 'price_later') return l.sale_type
    const id = resolveContractText(l.contract_number, contracts, links, cropId)
    if (id) return `contract:${id}`
    const auto = review.flatMap((g) => g.lines).find((x) => working[x.index] === l)
    return auto?.sale_type === 'spot' || auto?.sale_type === 'price_later' ? auto.sale_type : ''
  }
  function setLineSale(i: number, value: string) {
    setWorking((ws) => ws.map((w, j) => {
      if (j !== i) return w
      if (value === 'spot' || value === 'price_later') return { ...w, sale_type: value as SaleType }
      if (value.startsWith('contract:')) {
        const c = contracts.find((x) => x.id === value.slice('contract:'.length))
        return c ? { ...w, sale_type: 'contract', contract_number: c.contract_number } : w
      }
      return { ...w, sale_type: null }
    }))
  }
  function confirmSpot(indexes: number[]) {
    const set = new Set(indexes)
    setWorking((ws) => ws.map((w, i) => (set.has(i) ? { ...w, sale_type: 'spot' } : w)))
  }

  async function apply() {
    if (applying) return
    setApplying(true); setErr(null)
    const lineIds = new Map<number, string>()
    working.forEach((w, i) => { if (w.savedId) lineIds.set(i, w.savedId) })
    const plan = buildApplyPlan(review, choices, lineIds)
    try {
      for (const u of plan.lineUpdates) {
        const id = lineIds.get(u.index)
        if (!id) continue
        const { error } = await supabase.from('settlement_lines').update({ sale_type: u.sale_type, contract_number_text: u.contract_number_text, contract_id: u.contract_id }).eq('id', id)
        if (error) throw error
      }
      if (plan.loadWrites.length > 0) {
        try {
          await writeManyLoadSales(supabase, plan.loadWrites)
        } catch (e: any) {
          if (!isMissingRelation(e?.message)) throw e
        }
      }
      setOpen(false)
      const blocked = plan.blockedLoadIds.length
      if (blocked > 0) setNotice(`Applied. ${blocked} load${blocked === 1 ? ' keeps its current sale because its contract number isn’t linked yet' : 's keep their current sale because their contract numbers aren’t linked yet'}.`)
      router.refresh()
    } catch (e: any) {
      setErr(reportError(e, { action: 'apply the sale assignments', noun: 'settlement' }))
    } finally {
      setApplying(false)
    }
  }

  if (!canEdit) return null

  const btn = 'text-sm rounded-lg px-3 min-h-11 disabled:opacity-50'
  const setCount = lines.filter((l) => l.sale_type || l.contract_number_text || l.contract_id).length
  const loadLabel = (id: string) => { const ld = loadById.get(id); return ld ? `${fmtDate(ld.date)} · ${ld.ticket_number ? '#' + ld.ticket_number : 'no ticket'} · ${fmtInt(ld.dryBu)} bu` : '' }

  return (
    <div className="bg-white rounded-xl shadow p-3 flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-slate-700 mr-1">Sales</span>
      <span className="text-sm text-slate-500">{setCount === 0 ? 'No sale recorded on these lines yet.' : `${setCount} of ${lines.length} line${lines.length === 1 ? '' : 's'} carry a sale.`}</span>
      {sourcePdfUrl ? (
        <button type="button" onClick={() => void openReread()} disabled={stage != null} className={`${btn} bg-brand hover:bg-brand-deep text-white font-semibold`}>
          {stage ?? 'Re-read contract assignments'}
        </button>
      ) : (
        <span className="text-xs text-slate-500">This settlement has no saved copy of the statement to re-read.</span>
      )}
      <button type="button" onClick={openManual} disabled={stage != null} className={`${btn} bg-white border border-slate-300`}>Assign sales by hand</button>

      <AppModal open={open} title={reread ? 'Contract assignments from the statement' : 'Assign sales'} onClose={() => { if (!applying) setOpen(false) }} size="lg" initialFocus="none">
        <div className="space-y-3 text-sm">
          {stage && <p className="text-slate-600" role="status">{stage}</p>}
          {err && <p className="text-red-700" role="alert">{err}</p>}
          {!stage && working.length > 0 && (
            <>
              <p className="text-xs text-slate-500">
                {reread ? 'What the statement printed under each contract block, line by line. Change any line that reads wrong.' : 'Pick how each line was sold.'} Applying updates the matched loads.
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>{['Ticket', 'Net bu', 'Sale', ''].map((h, i) => <th key={i} className={`px-2 py-2 text-left whitespace-nowrap ${h === 'Net bu' ? 'text-right' : ''}`}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {working.map((w, i) => {
                      const rl = review.flatMap((g) => g.lines).find((x) => x.index === i)
                      return (
                        <tr key={i} className={`border-t border-slate-100 ${w.savedId ? '' : 'bg-slate-50 text-slate-500'}`}>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">{w.ticket_number ?? '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtInt(Number(w.net_bushels ?? 0))}</td>
                          <td className="px-2 py-1">
                            {w.savedId ? (
                              <select value={selectValue(w)} onChange={(e) => setLineSale(i, e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 min-h-11 text-sm max-w-[20rem]" aria-label={`Sale for ticket ${w.ticket_number ?? ''}`}>
                                <option value="">{w.contract_number ? `Contract ${w.contract_number} (not on file)` : 'Sale not set'}</option>
                                {contracts.map((c) => <option key={c.id} value={`contract:${c.id}`}>Contract #{c.contract_number}{c.crop_year != null ? ` · ${c.crop_year} crop` : ''}</option>)}
                                <option value="spot">Spot</option>
                                <option value="price_later">Price later</option>
                              </select>
                            ) : (
                              <span className="flex flex-wrap items-center gap-1">{rl && <SaleChip line={rl} />}<span className="text-xs">not a line on this settlement — only used to work out the split</span></span>
                            )}
                          </td>
                          <td className="px-2 py-1">{rl && w.savedId && <SaleChip line={rl} />}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <SettlementSaleReview
                groups={review}
                contracts={contracts}
                contractNumberById={contractNumberById}
                buyerName={buyerName}
                choices={choices}
                onChoice={(key, choice) => setChoices((m) => new Map(m).set(key, choice))}
                links={links}
                onLink={(key, id) => setLinks((m) => { const next = new Map(m); if (id) next.set(key, id); else next.delete(key); return next })}
                onConfirmSpot={confirmSpot}
                newContractHref="/contracts/new"
                loadLabel={loadLabel}
              />
              <div className="flex flex-wrap gap-2 items-center pt-1">
                <button type="button" onClick={() => void apply()} disabled={applying} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">{applying ? 'Applying…' : 'Apply'}</button>
                <button type="button" onClick={() => setOpen(false)} disabled={applying} className="rounded-lg bg-white border border-slate-300 px-4 min-h-11 text-sm">Cancel</button>
              </div>
            </>
          )}
        </div>
      </AppModal>
      <NoticeDialog open={notice != null} title="Sales applied" body={<p>{notice}</p>} onClose={() => setNotice(null)} />
    </div>
  )
}
