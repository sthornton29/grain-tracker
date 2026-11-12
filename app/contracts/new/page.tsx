'use client'

// New grain contract — the one-at-a-time form the tracker's "New Contract"
// button opens. Same fields as the editor. A contract PDF or photo can be
// read in to fill the form (the document attaches on save); Settings →
// Contracts keeps the bulk spreadsheet import.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { reportError } from '@/lib/friendly-error'
import {
  ContractFields,
  contractFormToPayload,
  validateContractFields,
  emptyContractForm,
  type ContractFieldErrors,
  type ContractFormState,
} from '@/components/contract-form'
import { MAX_PDF_BYTES, PdfTooLargeError } from '@/lib/pdf-upload'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { contractExtractionToForm, readContractDocument, attachContractDocument } from '@/components/contract-document'
import type { Buyer, Crop, DeliveryLocation, Entity, FieldPlanting } from '@/lib/types'

export default function NewContractPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [form, setForm] = useState<ContractFormState>(emptyContractForm)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<ContractFieldErrors>({})

  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [locations, setLocations] = useState<DeliveryLocation[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  // Contract document read in by AI: prefills the form, attaches on save.
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [aiStage, setAiStage] = useState<string | null>(null)
  const [aiBanner, setAiBanner] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [b, k, l, en, pl] = await Promise.all([
        supabase.from('buyers').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('delivery_locations').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('field_plantings').select('season_year').order('id').range(f, t)),
      ])
      if (cancelled) return
      setBuyers((b.data as Buyer[]) || [])
      setCrops((k.data as Crop[]) || [])
      setLocations((l.data as DeliveryLocation[]) || [])
      setEntities((en.data as Entity[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
    })()
    return () => { cancelled = true }
  }, [supabase])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year)),
    [plantings],
  )

  async function onSource(src: DocumentSource) {
    setErr(null); setAiBanner(null)
    if (src.kind === 'pdf' && src.file.size > MAX_PDF_BYTES) { setErr('That PDF is larger than 20 MB. Please use a smaller file.'); return }
    setAiStage('Reading contract…')
    try {
      const { data: x, warning } = await readContractDocument(src, setAiStage)
      setForm(contractExtractionToForm(x, buyers, crops, form.entity_id))
      setFieldErrors({})
      setSource(src)
      if (warning) setErr(warning)
      setAiBanner('Filled in from the document. Check each field, then Save contract — the document attaches to the contract.')
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(reportError(e, { action: 'read this contract' }))
    } finally {
      setAiStage(null)
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    // A double tap on Save must never create two contracts.
    if (savingRef.current) return
    const problems = validateContractFields(form)
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0) { setErr('A few things need filling in — see the highlighted fields.'); return }
    savingRef.current = true
    setSaving(true)
    setErr(null)
    const { data, error } = await supabase.from('contracts').insert(contractFormToPayload(form)).select('id').single()
    if (error || !data) {
      savingRef.current = false
      setSaving(false)
      setErr(reportError(error, { action: 'save this contract', noun: 'contract', name: form.contract_number.trim() }))
      return
    }
    const id = (data as { id: string }).id
    if (source) await attachContractDocument(supabase, id, source)
    router.push(`/contracts/${id}`)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/contracts" className="text-sm text-brand-deep">← Back to contracts</Link>
        <h1 className="text-2xl font-bold flex-1">New contract</h1>
      </div>
      <p className="text-sm text-slate-600 max-w-3xl">
        A grain sale to a buyer. Have the buyer&rsquo;s contract? Upload the PDF or a photo and the form fills in for you.
        Several to enter from a spreadsheet?{' '}
        <Link href="/settings/contracts" className="text-brand-deep underline">Settings → Contracts</Link> imports them.
      </p>

      <form onSubmit={onSave} className="bg-white p-4 rounded-xl shadow space-y-3">
        <div className="flex items-center gap-3 flex-wrap border-b border-slate-100 pb-3">
          <DocumentCapture
            onSource={onSource}
            busy={aiStage != null}
            stageLabel={aiStage}
            pdfLabel="Upload contract PDF or photo"
          />
          {source ? (
            <span className="text-xs text-slate-600">
              {source.kind === 'pdf'
                ? `“${source.file.name}” will attach on save`
                : `${source.images.length} photo${source.images.length === 1 ? '' : 's'} will attach on save`}{' '}·{' '}
              <button type="button" onClick={() => { setSource(null); setAiBanner(null) }} className="text-red-600 underline">clear</button>
            </span>
          ) : (
            <span className="text-xs text-slate-500">or fill in the form below</span>
          )}
        </div>
        {aiBanner && <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900">{aiBanner}</div>}
        <ContractFields
          value={form}
          onChange={(f) => { setForm(f); if (Object.keys(fieldErrors).length) setFieldErrors(validateContractFields(f)) }}
          buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions}
          errors={fieldErrors}
          onBuyerCreated={(b) => setBuyers((xs) => [...xs, b].sort((a, z) => a.name.localeCompare(z.name)))}
          onLocationCreated={(l) => setLocations((xs) => [...xs, l].sort((a, z) => a.name.localeCompare(z.name)))}
        />
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
            {saving ? 'Saving…' : 'Save contract'}
          </button>
          <Link href="/contracts" className="rounded-lg border border-slate-300 px-4 min-h-11 inline-flex items-center font-semibold">Cancel</Link>
        </div>
      </form>
    </div>
  )
}
