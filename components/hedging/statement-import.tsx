'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from './position-form'
import PdfViewer from '@/components/pdf-viewer'
import {
  MAX_PDF_BYTES,
  PdfTooLargeError,
  parseDocument,
  type BrokerageStatementExtraction,
} from '@/lib/pdf-upload'
import {
  buildContractSymbol,
  normalizeCommodity,
  fmtPrice,
  fmtPnl,
  bushelsFor,
  COMMODITY_SPECS,
  type Commodity,
  type Side,
} from '@/lib/hedging'
import type { Entity, FuturesPosition } from '@/lib/types'

function cropYearOptions(): number[] {
  const y = new Date().getFullYear()
  return [y - 1, y, y + 1, y + 2]
}
function priceEq(a: number, b: number) {
  return Math.abs(a - b) < 1e-4
}
function up(s: string) {
  return s.trim().toUpperCase()
}

// Freeze the Commodity and Month columns when the review tables scroll
// horizontally, so each row stays identifiable while reaching Side/Price/Crop
// Yr. Commodity is a fixed 130px (fits "Chicago Wheat") so Month's left offset
// lines up exactly. Header cells sit above body cells (z-20 vs z-10) and carry
// solid backgrounds so scrolling cells pass cleanly underneath.
const STICKY_HEAD_1 = 'sticky left-0 z-20 bg-slate-100 w-[130px] min-w-[130px]'
const STICKY_HEAD_2 = 'sticky left-[130px] z-20 bg-slate-100'
const STICKY_CELL_1 = 'sticky left-0 z-10 bg-white w-[130px] min-w-[130px]'
const STICKY_CELL_2 = 'sticky left-[130px] z-10 bg-white'

type OpenRow = {
  commodity: Commodity
  contract_month: string
  side: Side
  num_contracts: number
  trade_date: string
  trade_price: number
  unrealized_pnl: number | null
  crop_year: string
  include: boolean
  existing: boolean
}
type ClosedRow = {
  commodity: Commodity
  contract_month: string
  side: Side
  num_contracts: number
  open_trade_date: string
  close_trade_date: string
  open_price: number
  close_price: number
  realized_pnl: number
  matchedOpenId: string | null
  crop_year: string
  include: boolean
}

type Props = {
  entities: Entity[]
  existingPositions: FuturesPosition[]
  onClose: () => void
  onImported: (summary: { inserted: number; closed: number }) => void
}

export default function StatementImport({ entities, existingPositions, onClose, onImported }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [file, setFile] = useState<File | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [extraction, setExtraction] = useState<BrokerageStatementExtraction | null>(null)
  const [openRows, setOpenRows] = useState<OpenRow[]>([])
  const [closedRows, setClosedRows] = useState<ClosedRow[]>([])
  const [tab, setTab] = useState<'open' | 'closed' | 'summary'>('open')
  const [importEntityId, setImportEntityId] = useState('')
  const [bulkCropYear, setBulkCropYear] = useState('')
  const [saving, setSaving] = useState(false)

  function buildOpenRow(p: NonNullable<BrokerageStatementExtraction['open_positions']>[number]): OpenRow | null {
    const commodity = normalizeCommodity(p.commodity)
    if (!commodity || !p.contract_month || p.side == null || p.num_contracts == null || p.trade_price == null || !p.trade_date) {
      return null
    }
    const existing = existingPositions.some(
      (ex) =>
        ex.commodity === commodity &&
        up(ex.contract_month) === up(p.contract_month!) &&
        ex.side === p.side &&
        ex.trade_date === p.trade_date &&
        priceEq(ex.trade_price, p.trade_price!),
    )
    return {
      commodity,
      contract_month: up(p.contract_month),
      side: p.side,
      num_contracts: p.num_contracts,
      trade_date: p.trade_date,
      trade_price: p.trade_price,
      unrealized_pnl: p.unrealized_pnl ?? null,
      crop_year: '',
      include: !existing,
      existing,
    }
  }

  function buildClosedRow(t: NonNullable<BrokerageStatementExtraction['closed_trades']>[number]): ClosedRow | null {
    const commodity = normalizeCommodity(t.commodity)
    if (
      !commodity || !t.contract_month || t.side == null || t.num_contracts == null ||
      t.open_price == null || t.close_price == null || !t.open_trade_date || !t.close_trade_date
    ) {
      return null
    }
    const match = existingPositions.find(
      (ex) =>
        ex.status === 'open' &&
        ex.commodity === commodity &&
        up(ex.contract_month) === up(t.contract_month!) &&
        ex.side === t.side &&
        ex.trade_date === t.open_trade_date &&
        priceEq(ex.trade_price, t.open_price!),
    )
    return {
      commodity,
      contract_month: up(t.contract_month),
      side: t.side,
      num_contracts: t.num_contracts,
      open_trade_date: t.open_trade_date,
      close_trade_date: t.close_trade_date,
      open_price: t.open_price,
      close_price: t.close_price,
      realized_pnl: t.realized_pnl ?? 0,
      matchedOpenId: match?.id ?? null,
      crop_year: match?.crop_year != null ? String(match.crop_year) : '',
      include: true,
    }
  }

  async function onPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setErr(null)
    if (f.size > MAX_PDF_BYTES) {
      setErr('That PDF is larger than 20 MB. Please use a smaller file.')
      return
    }
    setFile(f)
    setStage('Reading document…')
    try {
      await new Promise((r) => setTimeout(r, 200))
      setStage('Extracting positions…')
      const data = await parseDocument(f, 'brokerage_statement')
      setExtraction(data)
      const open = (data.open_positions ?? []).map(buildOpenRow).filter((r): r is OpenRow => r !== null)
      const closed = (data.closed_trades ?? []).map(buildClosedRow).filter((r): r is ClosedRow => r !== null)
      setOpenRows(open)
      setClosedRows(closed)
      setTab(open.length > 0 ? 'open' : closed.length > 0 ? 'closed' : 'summary')
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(e?.message ? `Couldn't read this statement: ${e.message}.` : "Couldn't read this statement.")
      setFile(null)
    } finally {
      setStage(null)
    }
  }

  function setOpen(i: number, patch: Partial<OpenRow>) {
    setOpenRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }
  function setClosed(i: number, patch: Partial<ClosedRow>) {
    setClosedRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }
  function applyBulkCropYear() {
    if (!bulkCropYear) return
    setOpenRows((rs) => rs.map((r) => (r.existing ? r : { ...r, crop_year: bulkCropYear })))
    setClosedRows((rs) => rs.map((r) => (r.matchedOpenId ? r : { ...r, crop_year: bulkCropYear })))
  }
  function applyBulkSide(side: Side) {
    setOpenRows((rs) => rs.map((r) => ({ ...r, side })))
    setClosedRows((rs) => rs.map((r) => ({ ...r, side })))
  }

  const newOpen = openRows.filter((r) => r.include && !r.existing)
  const closesMatched = closedRows.filter((r) => r.include && r.matchedOpenId)
  const closedToImport = closedRows.filter((r) => r.include && !r.matchedOpenId)

  async function save() {
    setErr(null)
    if (newOpen.some((r) => !r.crop_year)) return setErr('Set a crop year on every new open position before saving.')
    if (closedToImport.some((r) => !r.crop_year)) return setErr('Set a crop year on every closed trade you are importing.')
    if (newOpen.length === 0 && closesMatched.length === 0 && closedToImport.length === 0) {
      return setErr('Nothing selected to import.')
    }
    setSaving(true)

    const inserts = [
      ...newOpen.map((r) => ({
        entity_id: importEntityId || null,
        commodity: r.commodity,
        contract_month: r.contract_month,
        contract_symbol: buildContractSymbol(r.commodity, r.contract_month),
        crop_year: Number(r.crop_year),
        side: r.side,
        num_contracts: r.num_contracts,
        trade_price: r.trade_price,
        trade_date: r.trade_date,
        status: 'open' as const,
        commission: 0,
        notes: null,
        source: 'statement_import' as const,
      })),
      ...closedToImport.map((r) => ({
        entity_id: importEntityId || null,
        commodity: r.commodity,
        contract_month: r.contract_month,
        contract_symbol: buildContractSymbol(r.commodity, r.contract_month),
        crop_year: Number(r.crop_year),
        side: r.side,
        num_contracts: r.num_contracts,
        trade_price: r.open_price,
        trade_date: r.open_trade_date,
        status: 'closed' as const,
        close_price: r.close_price,
        close_date: r.close_trade_date,
        realized_pnl: r.realized_pnl,
        commission: 0,
        notes: null,
        source: 'statement_import' as const,
      })),
    ]

    if (inserts.length > 0) {
      const { error } = await supabase.from('futures_positions').insert(inserts)
      if (error) { setSaving(false); setErr(`Insert failed: ${error.message}`); return }
    }

    let closedCount = 0
    for (const r of closesMatched) {
      const { error } = await supabase
        .from('futures_positions')
        .update({
          status: 'closed',
          close_price: r.close_price,
          close_date: r.close_trade_date,
          realized_pnl: r.realized_pnl,
        })
        .eq('id', r.matchedOpenId!)
      if (error) { setSaving(false); setErr(`Closing matched position failed: ${error.message}`); return }
      closedCount++
    }

    setSaving(false)
    onImported({ inserted: inserts.length, closed: closedCount })
  }

  const summary = extraction?.account_summary
  const tabCls = (active: boolean) =>
    `px-3 py-2 text-sm font-semibold border-b-2 ${active ? 'border-green-700 text-green-800' : 'border-transparent text-slate-500'}`
  const cellInput = 'rounded border border-slate-300 px-2 py-1 text-sm w-full bg-white'

  return (
    <Modal onClose={onClose} title="Import Brokerage Statement" wide>
      {!extraction && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Upload a daily statement PDF (R.J. O’Brien or similar). The AI extracts open positions and closed trades for
            Corn, Soybeans, and Wheat — cotton and other commodities are ignored. You’ll review and assign crop years before anything is saved.
          </p>
          <label className={`inline-block text-sm rounded-lg px-4 py-2 cursor-pointer text-white ${stage ? 'bg-slate-400 cursor-wait' : 'bg-green-700'}`}>
            {stage ?? 'Choose Statement PDF'}
            <input type="file" accept="application/pdf,.pdf" onChange={onPdf} disabled={stage != null} className="hidden" />
          </label>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}

      {extraction && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-sm">
              <div className="text-slate-500">Statement date</div>
              <div className="font-semibold">{extraction.statement_date ?? '—'}</div>
            </div>
            <label className="text-sm text-slate-700">
              Account entity (applied to imported positions)
              <select value={importEntityId} onChange={(e) => setImportEntityId(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 bg-white">
                <option value="">— none —</option>
                {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select>
            </label>
            <label className="text-sm text-slate-700">
              Quick-fill crop year <span className="text-xs text-slate-400">optional shortcut</span>
              <div className="mt-1 flex gap-2">
                <select value={bulkCropYear} onChange={(e) => setBulkCropYear(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 bg-white">
                  <option value="">—</option>
                  {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <button type="button" onClick={applyBulkCropYear} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Apply to all</button>
              </div>
            </label>
            <label className="text-sm text-slate-700">
              Set all sides <span className="text-xs text-slate-400">if the import read them wrong</span>
              <div className="mt-1 flex gap-2">
                <button type="button" onClick={() => applyBulkSide('short')} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">All Short</button>
                <button type="button" onClick={() => applyBulkSide('long')} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">All Long</button>
              </div>
            </label>
            <div className="flex-1" />
            <button type="button" onClick={() => { setExtraction(null); setFile(null); setOpenRows([]); setClosedRows([]) }} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
              Start over
            </button>
          </div>

          <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900">
            Set a <b>crop year for each contract</b> in the <b>Crop Yr</b> column below — different contracts on the same
            statement can be for different crop years. The Quick-fill above is just a shortcut; you can still change any row
            afterward. Every imported contract needs a crop year before you can save.
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="min-w-0">
              <div className="flex gap-1 border-b border-slate-200 mb-3">
                <button className={tabCls(tab === 'open')} onClick={() => setTab('open')}>Open Positions ({openRows.length})</button>
                <button className={tabCls(tab === 'closed')} onClick={() => setTab('closed')}>Closed Trades ({closedRows.length})</button>
                <button className={tabCls(tab === 'summary')} onClick={() => setTab('summary')}>Account Summary</button>
              </div>

              {tab === 'open' && (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 text-slate-700">
                      <tr>{['', 'Status', 'Commodity', 'Month', 'Symbol', 'Side', '#', 'Trade date', 'Price', 'Crop Yr *'].map((h, idx) => <th key={h} className={`text-left px-2 py-2 whitespace-nowrap ${idx === 2 ? STICKY_HEAD_1 : idx === 3 ? STICKY_HEAD_2 : ''}`}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {openRows.length === 0 && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">No open positions found.</td></tr>}
                      {openRows.map((r, i) => (
                        <tr key={i} className={`border-t border-slate-100 align-top ${r.existing ? 'opacity-60' : ''}`}>
                          <td className="px-2 py-1">
                            <input type="checkbox" checked={r.include} disabled={r.existing} onChange={(e) => setOpen(i, { include: e.target.checked })} />
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {r.existing
                              ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Already exists</span>
                              : <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">New</span>}
                          </td>
                          <td className={`px-2 py-1 whitespace-nowrap ${STICKY_CELL_1}`}>{r.commodity}</td>
                          <td className={`px-2 py-1 whitespace-nowrap ${STICKY_CELL_2}`}>{r.contract_month}</td>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">{buildContractSymbol(r.commodity, r.contract_month)}</td>
                          <td className="px-2 py-1" style={{ minWidth: 92 }}>
                            <select value={r.side} onChange={(e) => setOpen(i, { side: e.target.value as Side })} className={cellInput}>
                              <option value="short">Short</option>
                              <option value="long">Long</option>
                            </select>
                          </td>
                          <td className="px-2 py-1 text-right">{r.num_contracts}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{r.trade_date}</td>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtPrice(r.trade_price)}</td>
                          <td className={`px-2 py-1 ${!r.existing && r.include && !r.crop_year ? 'bg-amber-50' : ''}`} style={{ minWidth: 90 }}>
                            {r.existing ? <span className="text-slate-400 text-xs">—</span> : (
                              <select value={r.crop_year} onChange={(e) => setOpen(i, { crop_year: e.target.value })} className={cellInput}>
                                <option value="">— pick —</option>
                                {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                              </select>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'closed' && (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 text-slate-700">
                      <tr>{['', 'Match', 'Commodity', 'Month', 'Side', '#', 'Open', 'Close', 'Open $', 'Close $', 'Realized', 'Crop Yr *'].map((h, idx) => <th key={h} className={`text-left px-2 py-2 whitespace-nowrap ${idx === 2 ? STICKY_HEAD_1 : idx === 3 ? STICKY_HEAD_2 : ''}`}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {closedRows.length === 0 && <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-400">No closed trades found.</td></tr>}
                      {closedRows.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100 align-top">
                          <td className="px-2 py-1"><input type="checkbox" checked={r.include} onChange={(e) => setClosed(i, { include: e.target.checked })} /></td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {r.matchedOpenId
                              ? <span className="text-xs rounded-full bg-sky-100 text-sky-800 px-2 py-0.5">Closes open position</span>
                              : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Import as closed</span>}
                          </td>
                          <td className={`px-2 py-1 whitespace-nowrap ${STICKY_CELL_1}`}>{r.commodity}</td>
                          <td className={`px-2 py-1 whitespace-nowrap ${STICKY_CELL_2}`}>{r.contract_month}</td>
                          <td className="px-2 py-1" style={{ minWidth: 92 }}>
                            <select value={r.side} onChange={(e) => setClosed(i, { side: e.target.value as Side })} className={cellInput}>
                              <option value="short">Short</option>
                              <option value="long">Long</option>
                            </select>
                          </td>
                          <td className="px-2 py-1 text-right">{r.num_contracts}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{r.open_trade_date}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{r.close_trade_date}</td>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtPrice(r.open_price)}</td>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtPrice(r.close_price)}</td>
                          <td className={`px-2 py-1 font-mono whitespace-nowrap ${r.realized_pnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(r.realized_pnl)}</td>
                          <td className={`px-2 py-1 ${!r.matchedOpenId && r.include && !r.crop_year ? 'bg-amber-50' : ''}`} style={{ minWidth: 90 }}>
                            {r.matchedOpenId ? <span className="text-slate-400 text-xs">existing</span> : (
                              <select value={r.crop_year} onChange={(e) => setClosed(i, { crop_year: e.target.value })} className={cellInput}>
                                <option value="">— pick —</option>
                                {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                              </select>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'summary' && (
                <div className="text-sm">
                  {summary ? (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 max-w-md">
                      {[
                        ['Beginning balance', summary.beginning_balance],
                        ['Ending balance', summary.ending_balance],
                        ['Open trade equity', summary.open_trade_equity],
                        ['Total equity', summary.total_equity],
                        ['Margin requirement', summary.margin_requirement],
                        ['Excess equity', summary.excess_equity],
                      ].map(([label, val]) => (
                        <div key={label as string} className="contents">
                          <dt className="text-slate-500">{label as string}</dt>
                          <dd className="text-right font-mono">{val == null ? '—' : fmtPnl(Number(val))}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : <p className="text-slate-400">No account summary found.</p>}
                  <p className="text-xs text-slate-400 mt-2">For reference only — account balances change daily and are not stored.</p>
                </div>
              )}
            </div>

            {file && (
              <div className="lg:sticky lg:top-3 self-start h-[60vh] min-h-[360px]">
                <div className="text-xs text-slate-500 mb-1">Source statement — cross-reference while reviewing</div>
                <PdfViewer file={file} className="h-full" title="Brokerage statement" />
              </div>
            )}
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
            <div className="text-sm text-slate-600 flex-1">
              Will import <b>{newOpen.length}</b> new open · close <b>{closesMatched.length}</b> matched · import <b>{closedToImport.length}</b> closed
            </div>
            <button type="button" onClick={save} disabled={saving} className="rounded-xl bg-green-700 text-white font-semibold py-2.5 px-5 disabled:opacity-60">
              {saving ? 'Saving…' : 'Save Import'}
            </button>
            <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-2.5 text-sm">Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
