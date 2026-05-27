'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CsvImport from '@/components/csv-import'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import {
  ContractFields,
  contractToForm,
  contractFormToPayload,
  validateContractForm,
  emptyContractForm,
  type ContractFormState,
} from '@/components/contract-form'
import { CONTRACT_TYPE_LABEL, PRICING_STATUS_LABEL, basisFromCashFutures } from '@/lib/contracts'
import { MAX_PDF_BYTES, PdfTooLargeError, parseDocument, uploadFileToStorage, type ContractExtraction } from '@/lib/pdf-upload'
import { findBestMatch } from '@/lib/fuzzy'
import type { Buyer, Contract, Crop, DeliveryLocation, Entity, FieldPlanting } from '@/lib/types'

// Map an AI contract extraction onto the editable form. Buyer/crop are fuzzy-
// matched to existing records; everything is editable before saving.
function contractExtractionToForm(x: ContractExtraction, buyers: Buyer[], crops: Crop[], baseEntityId: string): ContractFormState {
  const buyer = x.buyer_name ? findBestMatch(x.buyer_name, buyers, (b) => b.name) : null
  const crop = x.crop ? findBestMatch(x.crop, crops, (c) => c.name) : null
  const fee = x.service_fee ?? 0
  // When the contract gives both a futures and a cash price, derive the basis
  // (cash − futures + fee) so it's internally consistent — the AI sometimes
  // flips the basis sign. Otherwise keep whatever basis was extracted.
  const basisStr = x.futures_price != null && x.cash_price != null
    ? String(basisFromCashFutures(x.cash_price, x.futures_price, fee))
    : x.basis != null ? String(x.basis) : ''
  return {
    ...emptyContractForm,
    entity_id: baseEntityId,
    contract_number: x.contract_number ?? '',
    buyer_id: buyer?.id ?? '',
    crop_id: crop?.id ?? '',
    contract_type: x.contract_type ?? 'forward',
    contract_month: x.contract_month ? x.contract_month.toUpperCase() : '',
    crop_year: x.crop_year != null ? String(x.crop_year) : '',
    contracted_bushels: x.contracted_bushels != null ? String(x.contracted_bushels) : '',
    futures_price: x.futures_price != null ? String(x.futures_price) : '',
    basis: basisStr,
    cash_price: x.cash_price != null ? String(x.cash_price) : '',
    service_fee: x.service_fee != null ? String(x.service_fee) : '',
    delivery_type: x.delivery_type ?? 'pickup',
    delivery_start_date: x.delivery_start_date ?? '',
    delivery_end_date: x.delivery_end_date ?? '',
    notes: x.notes ?? '',
  }
}

export default function ContractsSettingsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [locations, setLocations] = useState<DeliveryLocation[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [rows, setRows] = useState<Contract[]>([])
  const [form, setForm] = useState<ContractFormState>(emptyContractForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<ContractFormState>(emptyContractForm)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  // AI contract upload (prefills the add form; the PDF is attached on save).
  const [aiFile, setAiFile] = useState<File | null>(null)
  const [aiStage, setAiStage] = useState<string | null>(null)
  const [aiBanner, setAiBanner] = useState<string | null>(null)

  async function refresh() {
    const [b, c, k, l, en, pl] = await Promise.all([
      supabase.from('buyers').select('*').order('name'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('contracts').select('*').order('contract_number'),
      supabase.from('delivery_locations').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('field_plantings').select('season_year'),
    ])
    setBuyers((b.data as Buyer[]) || [])
    setCrops((c.data as Crop[]) || [])
    setRows((k.data as Contract[]) || [])
    setLocations((l.data as DeliveryLocation[]) || [])
    setEntities((en.data as Entity[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year)),
    [plantings],
  )

  // Default the new-contract form's entity to the most recent contract's entity.
  useEffect(() => {
    if (rows.length === 0) return
    const latest = [...rows].filter((r) => r.entity_id).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0]
    if (!latest?.entity_id) return
    setForm((f) => (f.entity_id === '' ? { ...f, entity_id: latest.entity_id! } : f))
  }, [rows])

  async function onContractPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr(null); setAiBanner(null)
    if (file.size > MAX_PDF_BYTES) { setErr('That PDF is larger than 20 MB. Please use a smaller file.'); return }
    setAiStage('Reading contract…')
    try {
      await new Promise((r) => setTimeout(r, 200))
      setAiStage('Extracting…')
      const x = await parseDocument(file, 'contract')
      setForm(contractExtractionToForm(x, buyers, crops, form.entity_id))
      setAiFile(file)
      setAiBanner('AI filled in the contract from the PDF. Review and edit anything below, then Add Contract — the PDF attaches automatically.')
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(e?.message ? `Couldn't read this contract: ${e.message}.` : "Couldn't read this contract.")
    } finally {
      setAiStage(null)
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const v = validateContractForm(form)
    if (v) { setErr(v); return }
    const { data, error } = await supabase.from('contracts').insert(contractFormToPayload(form)).select('id').single()
    if (error) { setErr(error.message); return }
    // Auto-attach the AI-uploaded PDF to the new contract (best-effort).
    if (aiFile && data?.id) {
      try {
        const { publicUrl, path } = await uploadFileToStorage(supabase, aiFile, 'contract-attachments')
        await supabase.from('contract_attachments').insert({
          contract_id: (data as { id: string }).id,
          file_url: publicUrl, file_path: path, file_name: aiFile.name,
          mime_type: aiFile.type || null, file_size: aiFile.size,
        })
      } catch { /* contract saved; attachment is best-effort */ }
    }
    setForm(emptyContractForm); setAiFile(null); setAiBanner(null); setErr(null); refresh()
  }

  async function save(id: string) {
    const v = validateContractForm(editForm)
    if (v) { setErr(v); return }
    const { error } = await supabase.from('contracts').update(contractFormToPayload(editForm)).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditingId(null); setErr(null); refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this contract?')) return
    const { error } = await supabase.from('contracts').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const buyerName = (id: string | null) => buyers.find((b) => b.id === id)?.name ?? ''
  const cropName = (id: string | null) => crops.find((c) => c.id === id)?.name ?? ''
  const locName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? ''
  const entityName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? ''

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Contracts</h1>

      <CsvImport
        config={{
          tableName: 'contracts',
          uniqueKey: 'contract_number',
          columns: [
            { key: 'contract_number', required: true },
            { key: 'buyer_id', label: 'buyer', fk: { table: 'buyers', matchColumn: 'name' } },
            { key: 'crop_id', label: 'crop', fk: { table: 'crops', matchColumn: 'name' } },
            { key: 'entity_id', label: 'entity', fk: { table: 'entities', matchColumn: 'name' } },
            { key: 'crop_year', type: 'number' },
            { key: 'contracted_bushels', type: 'number' },
            { key: 'price_per_bushel', type: 'number' },
            { key: 'cash_price', type: 'number' },
            { key: 'contract_month' },
            { key: 'delivery_type', enum: ['pickup', 'delivered'], default: 'pickup' },
            { key: 'delivery_location_id', label: 'delivery_location', fk: { table: 'delivery_locations', matchColumn: 'name', scopeKey: 'buyer_id' } },
            { key: 'delivery_start_date', type: 'date' },
            { key: 'delivery_end_date', type: 'date' },
            { key: 'notes' },
          ],
        }}
        onImported={refresh}
      />

      <form onSubmit={add} className="space-y-2 bg-white p-4 rounded-xl shadow">
        <div className="flex items-center gap-3 flex-wrap border-b border-slate-100 pb-2">
          <label className={`text-sm rounded-lg px-3 py-2 cursor-pointer text-white ${aiStage ? 'bg-slate-400 cursor-wait' : 'bg-sky-700'}`}>
            {aiStage ?? 'Upload Contract PDF (AI)'}
            <input type="file" accept="application/pdf,.pdf" onChange={onContractPdf} disabled={aiStage != null} className="hidden" />
          </label>
          {aiFile && (
            <span className="text-xs text-slate-600">
              “{aiFile.name}” will attach on save ·{' '}
              <button type="button" onClick={() => { setAiFile(null); setAiBanner(null) }} className="text-red-600 underline">clear</button>
            </span>
          )}
          <span className="text-xs text-slate-400">or fill the form manually below</span>
        </div>
        {aiBanner && <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900">{aiBanner}</div>}
        <ContractFields value={form} onChange={setForm} buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions} />
        <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add Contract</button>
      </form>

      {err && <p className="text-sm text-red-600">{err}</p>}

      {(() => { const visible = rows.filter((c) => {
        if (!q) return true
        const hay = [c.contract_number, buyerName(c.buyer_id), cropName(c.crop_id), entityName(c.entity_id), String(c.crop_year ?? ''), c.notes ?? ''].join(' ').toLowerCase()
        return hay.includes(q.toLowerCase())
      }); return (
      <>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="search" placeholder="Search contract #, buyer, crop, year, notes…" value={q} onChange={(e) => setQ(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 flex-1 min-w-[12rem]" />
        {visible.length > 0 && (
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={visible.every((c) => selected.has(c.id))}
              onChange={() => {
                const allOn = visible.every((c) => selected.has(c.id))
                setSelected((s) => {
                  if (allOn) { const next = new Set(s); visible.forEach((c) => next.delete(c.id)); return next }
                  const next = new Set(s); visible.forEach((c) => next.add(c.id)); return next
                })
              }} />
            Select all
          </label>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <span className="font-semibold">{selected.size} selected</span>
          <button
            onClick={async () => {
              if (!confirm(`Delete ${selected.size} contract${selected.size === 1 ? '' : 's'}? This cannot be undone.`)) return
              const ids = [...selected]
              const CHUNK = 50
              for (let i = 0; i < ids.length; i += CHUNK) {
                const batch = ids.slice(i, i + CHUNK)
                const { error } = await supabase.from('contracts').delete().in('id', batch)
                if (error) { setErr(`Failed after ${i} of ${ids.length}: ${error.message}`); refresh(); return }
              }
              setSelected(new Set()); refresh()
            }}
            className="rounded-lg bg-red-600 text-white px-3 py-1.5 text-sm font-semibold"
          >
            Delete selected
          </button>
          <button onClick={() => setSelected(new Set())} className="text-slate-600">Clear</button>
        </div>
      )}

      <ul className="bg-white rounded-xl shadow divide-y">
        {visible.length === 0 && <li className="px-4 py-6 text-center text-slate-400">{rows.length === 0 ? 'No contracts yet.' : 'No contracts match.'}</li>}
        {visible.map((c) => (
          <li key={c.id} className={`px-4 py-3 space-y-2 ${selected.has(c.id) ? 'bg-sky-50' : ''}`}>
            {editingId === c.id ? (
              <>
                <ContractFields value={editForm} onChange={setEditForm} buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions} />
                <div className="flex gap-2">
                  <button onClick={() => save(c.id)} className="text-green-700 font-semibold">Save</button>
                  <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n })} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold flex items-center gap-2">
                    #{c.contract_number}
                    <span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']}</span>
                    {c.pricing_status !== 'fully_priced' && (
                      <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">{PRICING_STATUS_LABEL[c.pricing_status]}</span>
                    )}
                  </div>
                  <div className="text-sm text-slate-500">
                    {buyerName(c.buyer_id)} · {cropName(c.crop_id)}
                    {c.contract_month && <> · {c.contract_month}</>}
                    {c.entity_id && <> · {entityName(c.entity_id)}</>}
                    {c.crop_year != null && <> · {c.crop_year} crop</>}
                    {' · '}{Number(c.contracted_bushels).toLocaleString()} bu
                    {c.cash_price != null ? <> · ${Number(c.cash_price).toFixed(4)}/bu</>
                      : c.pricing_status === 'awaiting_basis' ? <> · futures ${Number(c.futures_price ?? 0).toFixed(4)}</>
                      : c.pricing_status === 'awaiting_futures' ? <> · basis {Number(c.basis ?? 0).toFixed(4)}</> : null}
                    {' · '}
                    {c.delivery_type === 'delivered' ? <>Delivered → {locName(c.delivery_location_id) || '—'}</> : 'Pickup'}
                    {(c.delivery_start_date || c.delivery_end_date) && <> · {c.delivery_start_date ?? '?'} → {c.delivery_end_date ?? '?'}</>}
                  </div>
                  {c.notes && <div className="text-xs text-slate-400">{c.notes}</div>}
                </div>
                <button onClick={() => { setEditingId(c.id); setEditForm(contractToForm(c)) }} className="text-sky-700">Edit</button>
                <button onClick={() => remove(c.id)} className="text-red-600">Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      </>
      ) })()}
    </div>
  )
}
