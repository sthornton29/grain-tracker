'use client'

// Cotton → Trust Protocol (0102): register this crop year's bales with the
// U.S. Cotton Trust Protocol straight from Turnrow, stamped with the Field
// Partner's U.S. Regen program, then check what the Protocol says about each
// bale. Owner-only (the rail hides it for gin logins; the route guard blocks
// the path). Every record is built by lib/ctp-bales buildCtpRows — the same
// seam the server routes rebuild from, so the preview IS what goes out. The
// API key never reaches this page: /api/ctp/settings stores it server-side
// and the client reads only its last four characters.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { usePersistentState } from '@/lib/use-persistent-state'
import { reportError } from '@/lib/friendly-error'
import { fmtDateTime } from '@/lib/format-date'
import { useDialogs } from '@/components/use-dialogs'
import { EmptyState, InfoTip, SummaryCards, fmtInt, theadCls, type SummaryCardData } from '@/components/reports/report-kit'
import { CottonPageHeader, CottonSection } from '@/components/cotton/cotton-page-header'
import {
  CTP_PLATFORM_URL, CTP_STATE_LABEL, buildCtpRows, ctpCsv, ctpFileName, ctpFixedWidth, ctpRowReady, ctpRowRegen, ctpRowState,
  summarizeCtpRows, type CtpBaleRow, type CtpProducer, type CtpRowState,
} from '@/lib/ctp-bales'
import type { CottonBale, CtpBaleRegistration, CtpBaleUpload, CtpSettings, Entity, Farm, Gin, GinReceipt } from '@/lib/types'

const btn = 'rounded-lg bg-brand hover:bg-brand-deep text-white px-3 min-h-11 text-sm font-semibold disabled:opacity-50'
const btnGray = 'rounded-lg bg-white border border-slate-300 hover:bg-slate-50 px-3 min-h-11 text-sm disabled:opacity-50'
const btnDanger = 'rounded-lg bg-white border border-red-300 text-red-700 hover:bg-red-50 px-3 min-h-11 text-sm disabled:opacity-50'
const input = 'rounded-lg border border-slate-300 px-3 min-h-11 text-base sm:text-sm bg-white'

const STATE_TONE: Record<CtpRowState, string> = {
  not_sent: 'bg-slate-100 text-slate-600',
  sent: 'bg-sky-100 text-sky-800',
  registered: 'bg-green-100 text-green-800',
  pending: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-800',
  removed: 'bg-slate-200 text-slate-600',
}

type Filter = 'all' | 'ready' | 'blocked' | 'sent' | 'registered' | 'attention'

async function postJson<T>(url: string, body: unknown): Promise<T & { error?: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok && !json.error) json.error = 'Something went wrong — try again, or contact support.'
  return json
}

function download(text: string, filename: string, type: string) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function TrustProtocolPage() {
  const supabase = useMemo(() => createClient(), [])
  const { confirm, dialogs } = useDialogs()
  const [cropYear, setCropYear] = usePersistentState<number>('cotton:cropYear', new Date().getFullYear())
  const [loaded, setLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [settings, setSettings] = useState<CtpSettings | null>(null)
  const [bales, setBales] = useState<CottonBale[]>([])
  const [allYears, setAllYears] = useState<number[]>([])
  const [receipts, setReceipts] = useState<GinReceipt[]>([])
  const [gins, setGins] = useState<Gin[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [registrations, setRegistrations] = useState<CtpBaleRegistration[]>([])
  const [uploads, setUploads] = useState<CtpBaleUpload[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Connection card state.
  const [keyInput, setKeyInput] = useState('')
  const [programInput, setProgramInput] = useState('')
  const [producers, setProducers] = useState<CtpProducer[] | null>(null)
  const [producerErr, setProducerErr] = useState<string | null>(null)
  const [protocolIds, setProtocolIds] = useState<Record<string, string>>({})

  // List state.
  const [filter, setFilter] = useState<Filter>('all')
  const [entityFilter, setEntityFilter] = useState('')
  const [ginFilter, setGinFilter] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sendRegen, setSendRegen] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const refresh = useCallback(async () => {
    const [s, b, y, r, g, f, e, reg, up] = await Promise.all([
      supabase.from('ctp_settings').select('org_id, api_key_hint, regen_program, updated_at').limit(1).maybeSingle(),
      fetchAllRows<CottonBale>((from, to) => supabase.from('cotton_bales').select('id, gin_receipt_id, crop_year, pbi_number, net_weight_lbs, created_at').eq('crop_year', cropYear).order('pbi_number').order('id').range(from, to)),
      supabase.from('cotton_bales').select('crop_year').order('crop_year', { ascending: false }).limit(1000),
      fetchAllRows<GinReceipt>((from, to) => supabase.from('gin_receipts').select('id, gin_id, receipt_number, receipt_date, entity_id, farm_id, field_id, crop_year, gin_code, statement_number').eq('crop_year', cropYear).order('id').range(from, to)),
      supabase.from('gins').select('*').order('name'),
      supabase.from('farms').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      fetchAllRows<CtpBaleRegistration>((from, to) => supabase.from('ctp_bale_registrations').select('*').eq('crop_year', cropYear).order('id').range(from, to)),
      supabase.from('ctp_bale_uploads').select('*').eq('crop_year', cropYear).order('uploaded_at', { ascending: false }).limit(50),
    ])
    if (s.error || reg.error || up.error) { setUnavailable(true); setLoaded(true); return }
    const row = (s.data as CtpSettings | null) ?? null
    setSettings(row)
    setProgramInput(row?.regen_program ?? '')
    setBales(b.data)
    setAllYears(Array.from(new Set(((y.data as Array<{ crop_year: number }> | null) ?? []).map((x) => x.crop_year))))
    setReceipts(r.data)
    setGins((g.data as Gin[]) ?? [])
    setFarms((f.data as Farm[]) ?? [])
    const ents = (e.data as Entity[]) ?? []
    setEntities(ents)
    setProtocolIds(Object.fromEntries(ents.map((x) => [x.id, x.ctp_protocol_id ?? ''])))
    setRegistrations(reg.data)
    setUploads((up.data as CtpBaleUpload[]) ?? [])
    setLoaded(true)
  }, [supabase, cropYear])
  useEffect(() => { void refresh() }, [refresh])

  const rows = useMemo(() => buildCtpRows({ bales, receipts, gins, farms, entities, registrations }), [bales, receipts, gins, farms, entities, registrations])
  const summary = useMemo(() => summarizeCtpRows(rows), [rows])
  const years = useMemo(() => Array.from(new Set([cropYear, new Date().getFullYear(), ...allYears])).sort((a, b) => b - a), [allYears, cropYear])
  const liveEntities = useMemo(() => entities.filter((e) => !e.archived_at), [entities])

  const visible = useMemo(() => {
    const q = search.trim().replace(/\D/g, '')
    return rows.filter((r) => {
      if (entityFilter && r.entityId !== entityFilter) return false
      if (ginFilter && r.ginId !== ginFilter) return false
      if (q && !r.pbi.replace(/\D/g, '').includes(q)) return false
      const state = ctpRowState(r.registration)
      switch (filter) {
        case 'ready': return state === 'not_sent' && ctpRowReady(r)
        case 'blocked': return !ctpRowReady(r)
        case 'sent': return state === 'sent'
        case 'registered': return state === 'registered'
        case 'attention': return state === 'error' || state === 'pending'
        default: return true
      }
    })
  }, [rows, filter, entityFilter, ginFilter, search])
  const shown = showAll ? visible : visible.slice(0, 200)

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.baleId)), [rows, selected])
  const selectedReady = selectedRows.filter(ctpRowReady)
  const selectedUnsent = selectedReady.filter((r) => ctpRowState(r.registration) === 'not_sent')
  const selectedSent = selectedReady.filter((r) => ctpRowState(r.registration) !== 'not_sent')
  const hasKey = !!settings?.api_key_hint
  const program = settings?.regen_program ?? null

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const selectReady = () => setSelected(new Set(rows.filter((r) => ctpRowReady(r) && ctpRowState(r.registration) === 'not_sent').map((r) => r.baleId)))
  const selectVisible = () => setSelected(new Set(visible.map((r) => r.baleId)))
  const clearSelection = () => setSelected(new Set())

  // ---- Connection -----------------------------------------------------------

  async function saveKey() {
    const key = keyInput.trim()
    if (!key) return
    setBusy('key'); setErr(null); setMsg(null)
    try {
      const r = await postJson<{ ok?: boolean }>('/api/ctp/settings', { api_key: key })
      if (r.error) { setErr(r.error); return }
      setKeyInput('')
      setMsg('API key saved. Use “Look up producers” to confirm the Protocol accepts it.')
      await refresh()
    } finally { setBusy(null) }
  }
  async function clearKey() {
    if (!(await confirm({ title: 'Remove the API key?', body: 'Bales can’t be sent or checked until a key is saved again. Nothing already registered changes.', confirmLabel: 'Remove key', danger: true }))) return
    setBusy('key'); setErr(null)
    try {
      const r = await postJson<{ ok?: boolean }>('/api/ctp/settings', { api_key: null })
      if (r.error) { setErr(r.error); return }
      setProducers(null)
      await refresh()
    } finally { setBusy(null) }
  }
  async function saveProgram() {
    setBusy('program'); setErr(null); setMsg(null)
    try {
      const r = await postJson<{ ok?: boolean }>('/api/ctp/settings', { regen_program: programInput })
      if (r.error) { setErr(r.error); return }
      setMsg(programInput.trim() ? `Regen program ${programInput.trim().toUpperCase()} saved.` : 'Regen program cleared — bales will be sent as Protocol bales only.')
      await refresh()
    } finally { setBusy(null) }
  }
  async function lookupProducers() {
    setBusy('producers'); setProducerErr(null); setErr(null)
    try {
      const res = await fetch(`/api/ctp/producers?year=${cropYear}`)
      const json = (await res.json().catch(() => ({}))) as { error?: string; producers?: CtpProducer[] }
      if (!res.ok || json.error) { setProducerErr(json.error ?? 'Could not reach the Protocol.'); setProducers(null); return }
      setProducers(json.producers ?? [])
      // The Protocol tells us the program code it has the producers under.
      const fromProtocol = (json.producers ?? []).map((p) => p.fppRegenProgram).find(Boolean)
      if (fromProtocol && !program) setProgramInput(fromProtocol)
    } finally { setBusy(null) }
  }
  async function saveProtocolId(entityId: string) {
    const raw = (protocolIds[entityId] ?? '').trim().toUpperCase()
    if (raw && !/^[A-Z0-9]{8}$/.test(raw)) { setErr('A Protocol ID is exactly 8 letters or digits.'); return }
    setBusy(`pid-${entityId}`); setErr(null)
    try {
      const { error } = await supabase.from('entities').update({ ctp_protocol_id: raw || null }).eq('id', entityId)
      if (error) { setErr(reportError(error, { action: 'save the Protocol ID', noun: 'entity' })); return }
      await refresh()
    } finally { setBusy(null) }
  }

  // ---- Sending ----------------------------------------------------------------

  async function send(action: 'register' | 'correct' | 'remove', target: CtpBaleRow[]) {
    if (target.length === 0) return
    const regen = action !== 'remove' && sendRegen && !!program
    const what = action === 'register' ? `Send ${fmtInt(target.length)} bale${target.length === 1 ? '' : 's'} to the Protocol?`
      : action === 'correct' ? `Send a correction for ${fmtInt(target.length)} bale${target.length === 1 ? '' : 's'}?`
      : `Remove ${fmtInt(target.length)} bale${target.length === 1 ? '' : 's'} from the Protocol?`
    const body = action === 'remove'
      ? 'The Protocol will drop these bales from your registrations. You can register them again later.'
      : regen ? `They will be registered as Protocol bales and designated U.S. Regen under program ${program}.`
      : 'They will be registered as Protocol bales with no Regen designation.'
    if (!(await confirm({ title: what, body, confirmLabel: action === 'remove' ? 'Remove' : 'Send', danger: action === 'remove' }))) return
    setBusy('send'); setErr(null); setMsg(null)
    try {
      const r = await postJson<{ ok?: boolean; sent?: number; failed?: number; results?: Array<{ error: string | null; accepted: number }>; blocked?: Array<{ pbi: string; problems: string[] }> }>('/api/ctp/upload', {
        crop_year: cropYear, bale_ids: target.map((t) => t.baleId), action, regen,
      })
      if (r.error) {
        setErr(r.blocked?.length ? `${r.error} ${r.blocked.slice(0, 3).map((b) => `${b.pbi}: ${b.problems[0]}`).join(' · ')}` : r.error)
        await refresh()
        return
      }
      const failed = (r.results ?? []).find((x) => x.error)
      if (r.sent) setMsg(`${fmtInt(r.sent)} bale${r.sent === 1 ? '' : 's'} ${action === 'remove' ? 'removed' : 'sent'}. The Protocol checks each bale on its side — use “Check status” in a few minutes to see the result.${failed ? ` One batch was refused: ${failed.error}` : ''}`)
      else setErr(failed?.error ?? 'The Protocol did not accept the bales.')
      clearSelection()
      await refresh()
    } finally { setBusy(null) }
  }

  async function checkStatus(target: CtpBaleRow[] | null) {
    setBusy('check'); setErr(null); setMsg(null)
    try {
      const r = await postJson<{ ok?: boolean; checked?: number; found?: number; errors?: number; notFound?: number; message?: string | null }>('/api/ctp/inquiry', {
        crop_year: cropYear, bale_ids: target ? target.map((t) => t.baleId) : undefined,
      })
      if (r.error) { setErr(r.error); return }
      setMsg(`Checked ${fmtInt(r.checked ?? 0)} bale${r.checked === 1 ? '' : 's'}: ${fmtInt(r.found ?? 0)} on file with the Protocol, ${fmtInt(r.errors ?? 0)} with a problem, ${fmtInt(r.notFound ?? 0)} not found.${r.message ? ` ${r.message}` : ''}`)
      await refresh()
    } finally { setBusy(null) }
  }

  function downloadFile(ext: 'csv' | 'txt') {
    const target = (selectedReady.length ? selectedReady : rows.filter(ctpRowReady))
    if (target.length === 0) { setErr('No bale is ready to go in the file — fix what the list names first.'); return }
    const regen = sendRegen && program ? program : null
    download(ext === 'csv' ? ctpCsv(target, regen) : ctpFixedWidth(target, regen), ctpFileName(cropYear, ext), ext === 'csv' ? 'text/csv' : 'text/plain')
    setMsg(`${ctpFileName(cropYear, ext)} holds ${fmtInt(target.length)} bale${target.length === 1 ? '' : 's'} — upload it under Upload Log → Upload Grower Bales on the Protocol platform.`)
  }

  // ---- Render -----------------------------------------------------------------

  const cards: SummaryCardData[] = [
    { label: `${cropYear} bales`, value: fmtInt(summary.total), sub: 'from your gin receipts' },
    { label: 'Registered', value: fmtInt(summary.registered), sub: summary.sent ? `${fmtInt(summary.sent)} sent, awaiting a status check` : summary.registered ? 'confirmed by the Protocol' : 'none confirmed yet', tone: summary.registered ? 'favorable' : 'neutral' },
    { label: 'U.S. Regen', value: fmtInt(summary.regen), sub: program ? `program ${program}` : 'no program code saved', tone: summary.regen ? 'favorable' : 'muted' },
    { label: 'Ready to send', value: fmtInt(summary.ready), sub: summary.blocked ? `${fmtInt(summary.blocked)} need a fix first` : summary.ready ? 'tap Send below' : 'nothing waiting', tone: summary.blocked ? 'warning' : 'neutral' },
    ...(summary.pending + summary.errors ? [{ label: 'Needs attention', value: fmtInt(summary.pending + summary.errors), sub: `${fmtInt(summary.pending)} pending · ${fmtInt(summary.errors)} with a problem`, tone: 'unfavorable' as const }] : []),
  ]

  const filterChips: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: rows.length },
    { key: 'ready', label: 'Ready', count: summary.ready },
    { key: 'blocked', label: 'Needs a fix', count: summary.blocked },
    { key: 'sent', label: 'Sent', count: summary.sent },
    { key: 'registered', label: 'Registered', count: summary.registered },
    { key: 'attention', label: 'Attention', count: summary.pending + summary.errors },
  ]

  return (
    <div className="space-y-4">
      <CottonPageHeader
        title="U.S. Cotton Trust Protocol"
        sub="Register your bales with the Protocol straight from Turnrow, designated U.S. Regen, then see what the Protocol says about each one."
        cropYear={cropYear}
        years={years}
        onCropYear={setCropYear}
        actions={(
          <a href={CTP_PLATFORM_URL} target="_blank" rel="noreferrer" className={btnGray + ' inline-flex items-center'}>Open the Protocol platform ↗</a>
        )}
      />

      {unavailable && loaded && (
        <EmptyState message="The Trust Protocol link isn’t available on this operation yet." hint="Contact support to turn it on." />
      )}

      {err && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-sm">{err}</div>}
      {msg && <div role="status" className="rounded-lg border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-sm">{msg}</div>}

      {!unavailable && <SummaryCards cards={cards} />}

      {!unavailable && (
        <CottonSection title="Connection" sub="Your Protocol API key, your Regen program code, and each entity’s Protocol ID. Ask the Protocol help desk for an API key if you don’t have one.">
          <div className="p-4 grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">API key {hasKey && <span className="ml-1 rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-[11px] font-semibold">saved · ends in {settings?.api_key_hint}</span>}</label>
                <div className="flex gap-2">
                  <input type="password" autoComplete="off" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={hasKey ? 'Paste a new key to replace it' : 'Paste the key from the Protocol'} className={input + ' flex-1 min-w-0'} aria-label="Trust Protocol API key" />
                  <button type="button" className={btn} disabled={!keyInput.trim() || busy != null} onClick={() => void saveKey()}>{busy === 'key' ? 'Saving…' : 'Save'}</button>
                  {hasKey && <button type="button" className={btnDanger} disabled={busy != null} onClick={() => void clearKey()}>Remove</button>}
                </div>
                <p className="text-xs text-slate-500 mt-1">The key is kept on the server and never shown again.</p>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Regen program code <InfoTip label="?">The code the Protocol gave your Field Partner program (up to 10 characters). Bales sent with “designate U.S. Regen” on carry it; leave it blank to register bales as Protocol bales only. “Look up producers” fills it in when the Protocol reports one.</InfoTip></label>
                <div className="flex gap-2">
                  <input value={programInput} onChange={(e) => setProgramInput(e.target.value.toUpperCase())} maxLength={10} placeholder="e.g. REGEN26" className={input + ' flex-1 min-w-0 font-mono'} aria-label="Regen program code" />
                  <button type="button" className={btn} disabled={busy != null || (programInput.trim().toUpperCase() === (program ?? ''))} onClick={() => void saveProgram()}>{busy === 'program' ? 'Saving…' : 'Save'}</button>
                </div>
              </div>
              <div>
                <button type="button" className={btnGray} disabled={!hasKey || busy != null} onClick={() => void lookupProducers()}>{busy === 'producers' ? 'Asking the Protocol…' : 'Look up producers'}</button>
                <span className="ml-2 text-xs text-slate-500">Tests the key and lists the producers the Protocol has under your program for {cropYear}.</span>
                {producerErr && <p className="text-sm text-red-700 mt-1">{producerErr}</p>}
                {producers && producers.length === 0 && <p className="text-sm text-slate-600 mt-1">The key works, but the Protocol lists no producers under your program for {cropYear} — add your growers to the program on the platform first.</p>}
                {producers && producers.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {producers.map((p) => (
                      <li key={p.protocolId} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                        <span className="font-mono font-semibold">{p.protocolId}</span>
                        <span>{p.name}</span>
                        {p.uploadEligible && <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${/^y/i.test(p.uploadEligible) ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{/^y/i.test(p.uploadEligible) ? 'upload eligible' : 'not upload eligible'}</span>}
                        {p.fppRegenProgram && <span className="rounded-full bg-fuchsia-100 text-fuchsia-800 px-2 py-0.5 text-[11px] font-semibold">Regen {p.fppRegenProgram}</span>}
                        {p.gins.length > 0 && <span className="text-xs text-slate-500">gins {p.gins.map((g) => g.ginCode ?? g.name).filter(Boolean).join(', ')}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">Protocol ID per entity <InfoTip label="?">The producer’s 8-character Protocol ID — on the first page of the enrollment packet, or in the producer list above. Every bale is registered under the entity on its gin receipt (or the receipt’s farm).</InfoTip></div>
              <table className="min-w-full text-sm">
                <thead className={theadCls}><tr><th className="text-left px-2 py-1">Entity</th><th className="text-left px-2 py-1">Protocol ID</th><th className="px-2 py-1" /></tr></thead>
                <tbody>
                  {liveEntities.map((e) => {
                    const saved = e.ctp_protocol_id ?? ''
                    const cur = protocolIds[e.id] ?? ''
                    return (
                      <tr key={e.id} className="border-t border-slate-100">
                        <td className="px-2 py-1">{e.name}</td>
                        <td className="px-2 py-1">
                          <div className="flex gap-1">
                            <input list={producers?.length ? 'ctp-producers' : undefined} value={cur} maxLength={8} onChange={(ev) => setProtocolIds((m) => ({ ...m, [e.id]: ev.target.value.toUpperCase() }))} className={input + ' w-36 font-mono'} aria-label={`Protocol ID for ${e.name}`} placeholder="8 characters" />
                          </div>
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button type="button" className={btn} disabled={busy != null || cur.trim().toUpperCase() === saved} onClick={() => void saveProtocolId(e.id)}>{busy === `pid-${e.id}` ? 'Saving…' : 'Save'}</button>
                        </td>
                      </tr>
                    )
                  })}
                  {liveEntities.length === 0 && <tr><td colSpan={3} className="px-2 py-3 text-slate-500">No entities yet — add them under Settings → Entities.</td></tr>}
                </tbody>
              </table>
              {producers && producers.length > 0 && (
                <datalist id="ctp-producers">{producers.map((p) => <option key={p.protocolId} value={p.protocolId}>{p.name}</option>)}</datalist>
              )}
            </div>
          </div>
        </CottonSection>
      )}

      {!unavailable && (
        <CottonSection
          title="Bales"
          sub="Each bale as the Protocol will receive it: your entity’s Protocol ID, the gin code, the 7-digit gin tag, the crop year and the weight. Pick bales and send, or download the file for the platform’s upload screen."
        >
          <div className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div role="tablist" aria-label="Show" className="flex flex-wrap gap-1">
                {filterChips.map((c) => (
                  <button key={c.key} type="button" role="tab" aria-selected={filter === c.key} onClick={() => setFilter(c.key)}
                    className={`rounded-full px-3 min-h-9 text-xs font-semibold ${filter === c.key ? 'bg-brand text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
                    {c.label} <span className="tabular-nums opacity-80">{fmtInt(c.count)}</span>
                  </button>
                ))}
              </div>
              {liveEntities.length > 1 && (
                <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} className={input} aria-label="Entity">
                  <option value="">All entities</option>
                  {liveEntities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              )}
              {gins.length > 1 && (
                <select value={ginFilter} onChange={(e) => setGinFilter(e.target.value)} className={input} aria-label="Gin">
                  <option value="">All gins</option>
                  {gins.map((g) => <option key={g.id} value={g.id}>{g.name}{g.gin_code ? ` (${g.gin_code})` : ''}</option>)}
                </select>
              )}
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a PBI #" inputMode="numeric" className={input + ' w-36'} aria-label="Find a PBI number" />
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 p-2">
              <span className="text-sm tabular-nums"><strong>{fmtInt(selected.size)}</strong> selected{selected.size > 0 && selectedReady.length < selected.size ? ` · ${fmtInt(selected.size - selectedReady.length)} need a fix` : ''}</span>
              <button type="button" className={btnGray} onClick={selectReady} disabled={summary.ready === 0}>Select all ready ({fmtInt(summary.ready)})</button>
              <button type="button" className={btnGray} onClick={selectVisible} disabled={visible.length === 0}>Select shown</button>
              <button type="button" className={btnGray} onClick={clearSelection} disabled={selected.size === 0}>Clear</button>
              <label className="flex items-center gap-2 text-sm ml-auto min-h-11">
                <input type="checkbox" checked={sendRegen && !!program} disabled={!program} onChange={(e) => setSendRegen(e.target.checked)} className="h-5 w-5 accent-brand" />
                Designate U.S. Regen{program ? ` (${program})` : ' — save a program code first'}
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} disabled={!hasKey || busy != null || selectedUnsent.length === 0} onClick={() => void send('register', selectedUnsent)}>
                {busy === 'send' ? 'Sending…' : `Send ${fmtInt(selectedUnsent.length)} to the Protocol`}
              </button>
              <button type="button" className={btnGray} disabled={!hasKey || busy != null || selectedSent.length === 0} onClick={() => void send('correct', selectedSent)}>
                Resend {fmtInt(selectedSent.length)} as a correction
                <InfoTip label="?" className="ml-1">For bales the Protocol already has — registered earlier, or by your gin or merchant. A correction sets the Regen designation and the weight to what Turnrow holds.</InfoTip>
              </button>
              <button type="button" className={btnDanger} disabled={!hasKey || busy != null || selectedSent.length === 0} onClick={() => void send('remove', selectedSent)}>Remove {fmtInt(selectedSent.length)}</button>
              <span className="flex-1" />
              <button type="button" className={btnGray} disabled={!hasKey || busy != null || rows.length === 0} onClick={() => void checkStatus(selected.size ? selectedRows : null)}>
                {busy === 'check' ? 'Checking…' : selected.size ? `Check status of ${fmtInt(selected.size)}` : `Check status of all ${cropYear} bales`}
              </button>
              <button type="button" className={btnGray} disabled={rows.length === 0} onClick={() => downloadFile('csv')}>Download .csv</button>
              <button type="button" className={btnGray} disabled={rows.length === 0} onClick={() => downloadFile('txt')}>Download .txt</button>
            </div>
            {!hasKey && loaded && <p className="text-xs text-amber-700">Save your API key above to send or check bales from here. The downloads work without it.</p>}

            {loaded && rows.length === 0 ? (
              <EmptyState message={`No ${cropYear} bales yet.`} hint="Bales come from gin receipts — enter or upload the Statements of Ginning first." linkHref="/cotton/receipts" linkLabel="Go to Gin Receipts" />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className="px-2 py-2 w-8"><span className="sr-only">Select</span></th>
                      <th className="text-left px-2 py-2">PBI #</th>
                      <th className="text-left px-2 py-2">Gin tag</th>
                      <th className="text-left px-2 py-2">Gin code</th>
                      <th className="text-left px-2 py-2">Entity · Protocol ID</th>
                      <th className="text-right px-2 py-2">Lbs</th>
                      <th className="text-left px-2 py-2">Receipt</th>
                      <th className="text-left px-2 py-2">Protocol status</th>
                      <th className="text-left px-2 py-2">Regen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const state = ctpRowState(r.registration)
                      const ready = ctpRowReady(r)
                      const regen = ctpRowRegen(r.registration)
                      return (
                        <tr key={r.baleId} className={`border-t border-slate-100 ${selected.has(r.baleId) ? 'bg-green-50/60' : ''}`}>
                          <td className="px-2 py-1.5"><input type="checkbox" checked={selected.has(r.baleId)} onChange={() => toggle(r.baleId)} className="h-5 w-5 accent-brand" aria-label={`Select bale ${r.pbi}`} /></td>
                          <td className="px-2 py-1.5 font-mono">{r.pbi}</td>
                          <td className="px-2 py-1.5 font-mono">{r.ginTag ?? <span className="text-red-700">—</span>}</td>
                          <td className="px-2 py-1.5 font-mono">{r.ginCode ?? <span className="text-red-700">—</span>}{r.ginName && <span className="block text-[11px] text-slate-500 font-sans">{r.ginName}</span>}</td>
                          <td className="px-2 py-1.5">{r.entityName ?? <span className="text-red-700">no entity</span>}{r.protocolId ? <span className="block font-mono text-[11px] text-slate-500">{r.protocolId}</span> : r.entityName ? <span className="block text-[11px] text-red-700">no Protocol ID</span> : null}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{r.weight != null ? fmtInt(r.weight) : <span className="text-red-700">{fmtInt(Number(bales.find((b) => b.id === r.baleId)?.net_weight_lbs ?? 0))}</span>}</td>
                          <td className="px-2 py-1.5 text-slate-600">{r.receiptNumber ?? '—'}</td>
                          <td className="px-2 py-1.5">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${ready || state !== 'not_sent' ? STATE_TONE[state] : 'bg-red-100 text-red-800'}`}>{state === 'not_sent' && !ready ? 'Needs a fix' : CTP_STATE_LABEL[state]}</span>
                            {r.registration?.registration_status && state !== 'error' && <span className="block text-[11px] text-slate-500">{r.registration.registration_status}{r.registration.checked_at ? ` · checked ${fmtDateTime(r.registration.checked_at)}` : ''}</span>}
                            {r.registration?.inquiry_error && <span className="block text-[11px] text-red-700">{r.registration.inquiry_error}</span>}
                            {!ready && r.problems.map((p, i) => <span key={i} className="block text-[11px] text-red-700">{p}</span>)}
                            {state === 'sent' && r.registration?.sent_at && <span className="block text-[11px] text-slate-500">sent {fmtDateTime(r.registration.sent_at)}</span>}
                          </td>
                          <td className="px-2 py-1.5">{regen ? <span className="rounded-full bg-fuchsia-100 text-fuchsia-800 px-2 py-0.5 text-[11px] font-semibold">{regen}</span> : state === 'registered' ? <span className="text-xs text-slate-400">none</span> : ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {visible.length > shown.length && (
                  <div className="p-2 text-sm text-slate-600">Showing the first {fmtInt(shown.length)} of {fmtInt(visible.length)}. <button type="button" className="text-brand-deep underline min-h-11" onClick={() => setShowAll(true)}>Show all</button></div>
                )}
                {visible.length === 0 && rows.length > 0 && <div className="p-3 text-sm text-slate-500">No bales match this view.</div>}
              </div>
            )}
          </div>
        </CottonSection>
      )}

      {!unavailable && uploads.length > 0 && (
        <CottonSection title="What was sent" sub="Every batch sent from Turnrow this crop year and the Protocol’s immediate answer. Validation happens on the Protocol’s side afterwards — the status column above shows it after a check.">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className={theadCls}>
                <tr><th className="text-left px-3 py-2">When</th><th className="text-left px-3 py-2">What</th><th className="text-right px-3 py-2">Bales</th><th className="text-left px-3 py-2">Regen</th><th className="text-left px-3 py-2">Protocol answer</th></tr>
              </thead>
              <tbody>
                {uploads.map((u) => (
                  <tr key={u.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 whitespace-nowrap">{fmtDateTime(u.uploaded_at)}</td>
                    <td className="px-3 py-1.5">{u.action === 'register' ? 'Registration' : u.action === 'correct' ? 'Correction' : 'Removal'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(u.bale_count)}</td>
                    <td className="px-3 py-1.5">{u.regen_program ?? <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-1.5">
                      {u.has_errors
                        ? <span className="text-red-700">{u.error ?? 'Refused'}</span>
                        : <span className="text-green-700">Accepted{u.ctp_bale_count != null ? ` · ${fmtInt(u.ctp_bale_count)} bales for processing` : ''}{u.ctp_upload_id ? ` · upload #${u.ctp_upload_id}` : ''}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CottonSection>
      )}
      {dialogs}
    </div>
  )
}
